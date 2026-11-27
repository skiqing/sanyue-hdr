'use strict';
// HDR Vision — shaders.js（从 content-script.js 拆出，Phase 3 / P3-4）

const UNIFORM_FIELDS = [
  'exposureMultiplier', 'saturation', 'peakBrightness', 'skipSaturation', 'brightnessThreshold', 'maxBoost', 'shadowThreshold', 'shadowCrush', 'skipBoost', 'skipShadow', 'useBT2446a', 'bt2446aBoost', 'pHDR', 'logPHDR', 'midToneLift', 'debandThreshold', 'debandEnabled', 'useLUT', '_pad3', 'frameSeed', 'canvasWidth', 'canvasHeight', 'texelWidth', 'texelHeight', 'uvScaleX', 'uvScaleY', 'uvOffsetX', 'uvOffsetY', 'sharpenEnabled', 'sharpenStrength', 'outputIsHDR', 'inputTransfer', 'inputBT2020', 'refWhiteNits', 'displayPeakNits', 'hdrSourceMode', 'outputGain', '_pad9', 'outputLinear', 'highlightCeiling', 'dualLayerEnabled', 'dualLayerSplit', 'dualLayerSoft', 'dualLayerMode', 'dualLayerRadius', 'dualLayerDetail', '_padA', '_padB'
];
const U = Object.fromEntries(UNIFORM_FIELDS.map((name, i) => [name, i]));
const LUT_SIZE = 256;
const LUT_ROWS = (typeof HdrToneMath !== 'undefined' && HdrToneMath.DUAL_ROWS) || 6;
const lutV = (row) => ((row + 0.5) / LUT_ROWS).toFixed(7);

const uniformsDecl = `
struct Uniforms {
${UNIFORM_FIELDS.map((name) => '  ' + name + ': f32,').join('\n')}
}
`;


// ★ 单一口径：uniform 缓冲大小直接由结构体字段数推导。
//   手改字段却忘了改缓冲大小，会导致绑定尺寸不符、整条管线失效 → 整屏黑。
const UNIFORM_FLOATS = UNIFORM_FIELDS.length;
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;
if (UNIFORM_FLOATS < 36 || UNIFORM_FLOATS > 64) {
  console.error('[HDR Vision] uniform 字段数异常:', UNIFORM_FLOATS);
}

// ★ 着色器编译诊断：createShaderModule 本身不抛错，一个保留字写错只会让整条管线
//   悄悄变 null，表现为「开关没反应、状态一直未激活」，控制台里也只有 Tint 的英文警告。
//   这里主动取 getCompilationInfo，把行号和原因打到控制台。
function reportShaderErrors(module, label) {
  if (!module || typeof module.getCompilationInfo !== 'function') return;
  module.getCompilationInfo().then((info) => {
    const errs = (info && info.messages ? info.messages : []).filter((m) => m.type === 'error');
    if (!errs.length) return;
    console.error('[HDR Vision] WGSL 编译失败（' + label + '），共 ' + errs.length + ' 处：');
    for (const m of errs.slice(0, 8)) {
      console.error('  行 ' + m.lineNum + ':' + m.linePos + '  ' + m.message);
    }
    reportGpuSetupError(label + '/shader', errs[0].message);
  }).catch(() => { /* 旧版浏览器无此 API，忽略 */ });
}

// ★ P1-6：着色器编译与 pipeline 校验都是异步错误。
//   以前 try/catch 抓不到，表现为「开关没反应」，popup 还显示未激活/无视频。
const invalidPipelines = new WeakSet();
let pipelineErrorHandler = null;

function reportGpuSetupError(label, detail) {
  const text = label + '：' + detail;
  console.error('[HDR Vision] 渲染管线不可用（' + text + '）');
  if (typeof pipelineErrorHandler === 'function') {
    try { pipelineErrorHandler(label, text); } catch (e) { /* 忽略回调异常 */ }
  }
}

function createPipelineChecked(device, descriptor, label) {
  let pipeline = null;
  try {
    device.pushErrorScope('validation');
    pipeline = device.createRenderPipeline(descriptor);
    device.popErrorScope().then((err) => {
      if (!err) return;
      if (pipeline) invalidPipelines.add(pipeline);
      reportGpuSetupError(label, err.message || String(err));
    }).catch(() => { /* 旧浏览器无 error scope API */ });
  } catch (e) {
    reportGpuSetupError(label, e && e.message ? e.message : String(e));
    return null;
  }
  return pipeline;
}

// P4-1：异步版 pipeline 创建。createRenderPipeline 在 Chrome 上会同步完成
// 着色器编译并阻塞渲染主线程 —— 冷启动首次进入视频页时，这条路径能卡住数百毫秒。
// createRenderPipelineAsync 把编译移出主线程，页面播放/滚动不再被冻结。
async function createPipelineCheckedAsync(device, descriptor, label) {
  if (typeof device.createRenderPipelineAsync !== 'function') {
    return createPipelineChecked(device, descriptor, label);
  }
  // 不用 error scope：createRenderPipelineAsync 失败会直接 reject，
  // 而并行编译时交错 push/pop 会打乱作用域栈，导致错误归错标签。
  try {
    return await device.createRenderPipelineAsync(descriptor);
  } catch (e) {
    reportGpuSetupError(label, e && e.message ? e.message : String(e));
    return null;
  }
}

const vertexShader = `@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
var positions = array<vec2<f32>, 3>(
  vec2<f32>(-1.0, -1.0),
  vec2<f32>(3.0, -1.0),
  vec2<f32>(-1.0, 3.0)
);
return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}
`;

const commonFunctions = `
fn luminance(color: vec3<f32>) -> f32 {
return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// ★ 阶段 2：1D LUT 替代实时 BT 曲线。纹理 256×6，行0/1 为单层 SDR/HDR。
//   只烘焙逆映射 + midToneLift；高光压缩仍在 OKLab 之后，管线顺序不变。
fn bt2446aViaLUT(color: vec3<f32>) -> vec3<f32> {
let luma = luminance(color);
let lc = clamp(luma, 0.0, 1.0);
if (lc < 1e-5) { return color; }
let u = (lc * ${LUT_SIZE - 1}.0 + 0.5) / ${LUT_SIZE}.0;
// V1.2.4：纹理 6 行，单层仍用行0/行1，中心 v 随行数变化
//   行0 中心 = 0.5/6，行1 中心 = 1.5/6
let v = select(${lutV(0)}, ${lutV(1)}, uniforms.outputIsHDR > 0.5);
let mapped = textureSampleLevel(toneLutTexture, toneLutSampler, vec2<f32>(u, v), 0.0).r;
return color * (mapped / lc);
}

// V1.2.4 双层合成：按亮度把画面拆成暗部层与亮部层，平滑混合。
// split = 分界亮度，soft = 过渡宽度；w=0 全暗部层，w=1 全亮部层。
// 纹理 6 行：行2/3 = 8bit 画布（亮部白点收敛到 1.25），行4/5 = 16float 画布。
fn bt2446aDualLayer(color: vec3<f32>) -> vec3<f32> {
let luma = luminance(color);
let lc = clamp(luma, 0.0, 1.0);
if (lc < 1e-5) { return color; }
let u = (lc * ${LUT_SIZE - 1}.0 + 0.5) / ${LUT_SIZE}.0;
// 行中心：2.5/6、3.5/6、4.5/6、5.5/6
let darkRow = select(${lutV(2)}, ${lutV(4)}, uniforms.outputIsHDR > 0.5);
let brightRow = select(${lutV(3)}, ${lutV(5)}, uniforms.outputIsHDR > 0.5);
let darkMapped = textureSampleLevel(toneLutTexture, toneLutSampler, vec2<f32>(u, darkRow), 0.0).r;
let brightMapped = textureSampleLevel(toneLutTexture, toneLutSampler, vec2<f32>(u, brightRow), 0.0).r;
let soft = max(uniforms.dualLayerSoft, 0.01);
let w = smoothstep(uniforms.dualLayerSplit - soft, uniforms.dualLayerSplit + soft, lc);
let mapped = mix(darkMapped, brightMapped, w);
return color * (mapped / lc);
}

// ★ V1.2.5 真双层（base/detail）三件套。
//   背景：单层直接 LUT(luma) 在非压缩区其实是「放大」局部对比的（高光段斜率 1.3~1.9），
//   真正把对比压死的是末端 compressSDRHeadroom —— 实测 x≥0.90 时增益掉到 0.09~0.20。
//   所以真双层不能简单地拿 detail 顶替单层，必须：
//     1) base 走完整色调映射（保留 LUT 的拉伸）
//     2) detail 叠加放在末端压缩之后（不被压平）
//     3) 叠加量按「base 处的总斜率」补偿：斜率>1 时跟着放大，斜率<1 时保持 1 倍
//   这样非压缩区与单层一致，压缩区把细节救回来。

// P3-2：标量软上限 —— toneAt 与末端 softCeiling 共用同一式，避免两处漂移
fn softCeilingScalar(l: f32, cap: f32) -> f32 {
if (l <= 1.0 || cap <= 1.001) { return l; }
return 1.0 + (cap - 1.0) * (1.0 - exp(-(l - 1.0) / (cap - 1.0)));
}

// 画布软膝（标量版，经 softCeilingScalar 与末端压缩共用公式）
fn toneAt(b: f32) -> f32 {
let bc = clamp(b, 0.0, 1.0);
let u = (bc * ${LUT_SIZE - 1}.0 + 0.5) / ${LUT_SIZE}.0;
let v = select(${lutV(0)}, ${lutV(1)}, uniforms.outputIsHDR > 0.5);
var t = textureSampleLevel(toneLutTexture, toneLutSampler, vec2<f32>(u, v), 0.0).r;
if (uniforms.outputIsHDR < 0.5) {
  if (t > 0.95) {
    let xx = (t - 0.95) / 0.05;
    t = 0.95 + 0.05 * (xx / (1.0 + xx));
  }
} else {
  t = softCeilingScalar(t, uniforms.highlightCeiling);
}
return t;
}

// 按 base 查表（输出亮度精确等于 LUT(base)，不掺 detail）
fn bt2446aByBase(color: vec3<f32>, base: f32) -> vec3<f32> {
let luma = luminance(color);
if (luma < 1e-5) { return color; }
let bc = clamp(base, 0.0, 1.0);
let u = (bc * ${LUT_SIZE - 1}.0 + 0.5) / ${LUT_SIZE}.0;
let v = select(${lutV(0)}, ${lutV(1)}, uniforms.outputIsHDR > 0.5);
let mapped = textureSampleLevel(toneLutTexture, toneLutSampler, vec2<f32>(u, v), 0.0).r;
return color * (mapped / luma);
}

// ★ detail 叠加：必须在 compressSDRHeadroom / softCeiling 之后调用，
//   否则 detail 会和 base 一起被压平（实测 ±0.03 只剩 15%）。
// ★ v15 修复「亮部只剩一片白、关掉反而更亮」：
//   旧实现先把 base 软压到 cap-0.015，再连同 detail 软压一次到 cap ——
//   0.94 以上被两级压缩，高光 base 全塌到 ~0.952（比单层暗 4%），
//   0.94~1.0 的层次只剩约 1.3%，观感就是「只有暗部有细节」。
//   现在不预压 base：base 与单层完全一致，只在叠加正向 detail 时
//   按剩余 headroom 平滑饱和（room*d/(d+room)），负向 detail 不衰减。
fn applyDetailLayer(color: vec3<f32>, base: f32, origLuma: f32) -> vec3<f32> {
let l = luminance(color);
if (l < 1e-5) { return color; }
let bc = clamp(base, 0.0, 1.0);

// base 处的总斜率（含末端压缩）：非压缩区 >1，压缩区 <1
let e = 0.01;
let b0 = max(bc - e, 0.0);
let b1 = min(bc + e, 1.0);
let slope = (toneAt(b1) - toneAt(b0)) / max(b1 - b0, 1e-4);

// 压缩区不许把 detail 一起压平 → 下限锁 1；非压缩区跟着 LUT 一起拉伸
let gain = max(slope, 1.0) * uniforms.dualLayerDetail;

// detail 软限幅：强边缘 |d| 大，线性放大必出光晕；tanh 把过冲收敛
let d = origLuma - bc;
let dSoft = 0.12 * tanh(d / 0.12);

let cap = select(1.0, uniforms.highlightCeiling, uniforms.outputIsHDR > 0.5);
// 正向 detail 只能吃剩余 headroom：add = room*d/(d+room) 恒 < room，永不越 cap；
// 负向 detail 直接叠加（不会越界），暗部细节因此不被二次衰减。
// 白点与单层一致（SDR x=1.0 → 0.993），不再出现「开启后变暗」。
let room = max(cap - l, 0.0);
var add = dSoft * gain;
if (add > 0.0) {
  add = room * add / (add + room + 1e-5);
}
let targetL = clamp(l + add, 0.0, cap);
return color * (targetL / l);
}

fn processInOKLab(color: vec3<f32>, saturationFactor: f32) -> vec3<f32> {
let c = max(color, vec3<f32>(0.0));
let l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
let m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
let s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
let l_ = pow(max(l, 1e-8), 1.0 / 3.0);
let m_ = pow(max(m, 1e-8), 1.0 / 3.0);
let s_ = pow(max(s, 1e-8), 1.0 / 3.0);
var L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
var a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
var b = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
a *= saturationFactor;
b *= saturationFactor;
let l2_ = L + 0.3963377774 * a + 0.2158037573 * b;
let m2_ = L - 0.1055613458 * a - 0.0638541728 * b;
let s2_ = L - 0.0894841775 * a - 1.2914855480 * b;
let l2 = l2_ * l2_ * l2_;
let m2 = m2_ * m2_ * m2_;
let s2 = s2_ * s2_ * s2_;
return vec3<f32>(
   4.0767416621 * l2 - 3.3077115913 * m2 + 0.2309699292 * s2,
  -1.2684380046 * l2 + 2.6097574011 * m2 - 0.3413193965 * s2,
  -0.0041960863 * l2 - 0.7034186147 * m2 + 1.7076147010 * s2
);
}

fn boostHighlights(color: vec3<f32>, threshold: f32, maxBoost: f32) -> vec3<f32> {
let luma = luminance(color);
let p = 2.0 / max(1.0 - threshold, 0.05);
let lumaClamped = clamp(luma, 0.0, 1.0);
let s = pow(lumaClamped, p);
let gain = 1.0 + (maxBoost - 1.0) * s;
return color * gain;
}

fn crushShadows(color: vec3<f32>, threshold: f32, strength: f32) -> vec3<f32> {
let luma = luminance(color);
if (luma >= threshold) {
  return color;
}
if (luma < 1e-5) {
  return color;
}
let x = clamp(luma / threshold, 0.0, 1.0);
let exponent = 1.0 + strength * 2.0;
let y = pow(x, exponent);
let newLuma = threshold * y;
let scale = newLuma / luma;
return color * scale;
}

fn toneMapBrightness(color: vec3<f32>, peak: f32) -> vec3<f32> {
let luma = luminance(color);
if (luma <= 1.0) {
  return color;
}
let excess = luma - 1.0;
let compressed = 1.0 + excess * (peak - 1.0) / (excess + peak - 1.0);
return color * (compressed / luma);
}

fn bt2446aInverseWithLift(
color: vec3<f32>,
peakBrightness: f32,
boost: f32,
pHDR: f32,
logPHDR: f32,
midToneLift: f32
) -> vec3<f32> {
let luma = luminance(color);
let lumaClamped = clamp(luma, 0.0, 1.0);
if (lumaClamped < 1e-5) {
  return color;
}

var Yp: f32;
if (lumaClamped <= 0.7969) {
  Yp = lumaClamped / 1.0770;
} else if (lumaClamped >= 0.99545) {
  Yp = 2.0 * lumaClamped - 1.0;
} else {
  let a = 1.1510;
  let b = -2.7811;
  let c = 0.6302 + lumaClamped;
  let disc = b * b - 4.0 * a * c;
  let sqrtDisc = sqrt(max(disc, 0.0));
  Yp = (-b - sqrtDisc) / (2.0 * a);
}

let Y = (exp(Yp * logPHDR) - 1.0) / (pHDR - 1.0);
var outputLuma = Y * peakBrightness * boost;
let gain = outputLuma / lumaClamped;
var result = color * gain;

let maxOut = 5.0;
if (outputLuma > maxOut) {
  let excess = outputLuma - maxOut;
  let compressed = maxOut + excess / (1.0 + excess / maxOut);
  result = result * (compressed / outputLuma);
  outputLuma = compressed;
}

if (midToneLift > 0.001 && outputLuma > 1e-5) {
  let effectivePeak = min(peakBrightness * boost, 5.0);
  let norm = clamp(outputLuma / effectivePeak, 0.0, 1.0);
  let gamma = 1.0 / (1.0 + midToneLift * 0.7);
  let liftedNorm = pow(norm, gamma);
  let newLuma = liftedNorm * effectivePeak;
  let lumaScale = max(newLuma / outputLuma, 1.0);
  result = result * lumaScale;
}

return result;
}

fn applyColorPipeline(color: vec3<f32>, coords: vec2<f32>, base: f32) -> vec3<f32> {
var c = color * uniforms.exposureMultiplier;
if (uniforms.useBT2446a > 0.5) {
  if (uniforms.useLUT > 0.5) {
    // V1.2.5：双层开关下再分算法——mode 1 走真双层（base/detail），0 回退分区混合
    if (uniforms.dualLayerEnabled > 0.5) {
      if (uniforms.dualLayerMode > 0.5) {
        // 只做 base 的色调映射；detail 由 fragmentMain 在末端压缩之后叠加
        c = bt2446aByBase(c, base);
      } else {
        c = bt2446aDualLayer(c);
      }
    } else {
      c = bt2446aViaLUT(c);
    }
  } else {
    // legacy：保留曲线实现作为回滚开关（settings.useToneLut = false）
    c = bt2446aInverseWithLift(
      c,
      uniforms.peakBrightness,
      uniforms.bt2446aBoost,
      uniforms.pHDR,
      uniforms.logPHDR,
      uniforms.midToneLift
    );
  }
} else {
  if (uniforms.skipShadow < 0.5) {
    c = crushShadows(c, uniforms.shadowThreshold, uniforms.shadowCrush);
  }
  if (uniforms.skipBoost < 0.5) {
    c = boostHighlights(c, uniforms.brightnessThreshold, uniforms.maxBoost);
  }
  c = toneMapBrightness(c, uniforms.peakBrightness);
}
if (uniforms.skipSaturation < 0.5) {
  c = processInOKLab(c, uniforms.saturation);
}
return c;
}

// ★ 高光软上限：中间调（<=1.0）原样通过，超过 1.0 的部分平滑收敛到 cap
fn softCeiling(c: vec3<f32>, cap: f32) -> vec3<f32> {
let l = max(luminance(c), 1e-6);
if (l <= 1.0 || cap <= 1.001) { return c; }
return c * (softCeilingScalar(l, cap) / l);
}

fn srgbDecodeVec(c: vec3<f32>) -> vec3<f32> {
return vec3<f32>(srgbDecode1(c.r), srgbDecode1(c.g), srgbDecode1(c.b));
}

// ★ SDR 画布防过曝：按亮度做软膝压缩，保留色相（避免逐通道硬裁剪产生霓虹色）
fn compressSDRHeadroom(cIn: vec3<f32>) -> vec3<f32> {
let knee = 0.95;
let l = max(luminance(cIn), 1e-6);
if (l <= knee) { return cIn; }
let x = (l - knee) / (1.0 - knee);
let mappedL = knee + (1.0 - knee) * (x / (1.0 + x));
return cIn * (mappedL / l);
}

// ★ P1-1：视频与图片共用的末端阶段。
//   顺序固定：8bit 软膝 / HDR 高光上限 → 真双层 detail → 线性编码 → 整体增益。
//   在此之前图片着色器漏掉了这整段，导致「整体强度」「高光上限」「线性编码」
//   对图片无效，且 8bit 下高光被硬裁剪。
fn applyOutputStage(colorIn: vec3<f32>, base: f32, origLuma: f32) -> vec3<f32> {
var color = colorIn;
if (uniforms.outputIsHDR < 0.5) {
  color = compressSDRHeadroom(color);
} else {
  color = softCeiling(color, uniforms.highlightCeiling);
}
if (uniforms.dualLayerEnabled > 0.5 && uniforms.dualLayerMode > 0.5) {
  color = applyDetailLayer(color, base, origLuma);
}
if (uniforms.outputLinear > 0.5) {
  color = srgbDecodeVec(color);
}
return color * uniforms.outputGain;
}

// ================= HDR 源（PQ / HLG）解码 =================
// 说明：AV1 / HEVC 的 10bit HDR 帧经 importExternalTexture 进入 shader 时，
// 数值仍是「编码后」的 PQ / HLG 信号（不是 sRGB）。若直接套用 SDR 曲线，
// 会得到发灰、发白、对比度崩塌的画面 —— 这也是 AMD 上 AV1/HEVC HDR 异常的主因。
fn srgbDecode1(x: f32) -> f32 {
if (x <= 0.04045) { return x / 12.92; }
return pow((x + 0.055) / 1.055, 2.4);
}

fn srgbEncode1(x: f32) -> f32 {
if (x <= 0.0031308) { return x * 12.92; }
return 1.055 * pow(max(x, 0.0), 1.0 / 2.4) - 0.055;
}

// SMPTE ST 2084 (PQ) EOTF：返回 0..1，1.0 = 10000 nits
fn pqToLinear(v: f32) -> f32 {
let m1 = 2610.0 / 16384.0;
let m2 = 2523.0 / 4096.0 * 128.0;
let c1 = 3424.0 / 4096.0;
let c2 = 2413.0 / 4096.0 * 32.0;
let c3 = 2392.0 / 4096.0 * 32.0;
let p = pow(clamp(v, 0.0, 1.0), 1.0 / m2);
return pow(max(p - c1, 0.0) / max(c2 - c3 * p, 1e-6), 1.0 / m1);
}

// ARIB STD-B67 (HLG) OETF 反变换：返回 0..1 场景线性
fn hlgToLinear(v: f32) -> f32 {
let a = 0.17883277;
let b = 1.0 - 4.0 * a;
let c = 0.5 - a * log(4.0 * a);
let x = clamp(v, 0.0, 1.0);
if (x <= 0.5) { return x * x / 3.0; }
return (exp((x - c) / a) + b) / 12.0;
}

// BT.2020 → BT.709 线性矩阵（色域收敛，避免 HDR 源在广色域屏上发绿/发紫）
fn bt2020ToBt709(c: vec3<f32>) -> vec3<f32> {
let m = mat3x3<f32>(
   1.6605, -0.1246, -0.0182,
  -0.5876,  1.1329, -0.1006,
  -0.0728, -0.0083,  1.1187
);
return m * c;
}

// HDR 源主路径：解码 → 归一化到 SDR 参考白 → 输出（不套逆色调映射，避免二次映射）
fn decodeHDRSource(cIn: vec3<f32>) -> vec3<f32> {
var lin: vec3<f32>;
if (uniforms.inputTransfer < 1.5) {
  // PQ：0..1 → 0..10000 nits
  lin = vec3<f32>(pqToLinear(cIn.r), pqToLinear(cIn.g), pqToLinear(cIn.b)) * 10000.0;
} else {
  // HLG：场景线性 → 显示线性（系统伽马 1.2）→ 0..1000 nits
  let e = vec3<f32>(hlgToLinear(cIn.r), hlgToLinear(cIn.g), hlgToLinear(cIn.b));
  lin = vec3<f32>(
    pow(max(e.r, 0.0), 1.2),
    pow(max(e.g, 0.0), 1.2),
    pow(max(e.b, 0.0), 1.2)
  ) * 1000.0;
}

if (uniforms.inputBT2020 > 0.5) {
  lin = bt2020ToBt709(lin);
}

let refWhite = max(uniforms.refWhiteNits, 1.0);
lin = max(lin, vec3<f32>(0.0)) * uniforms.exposureMultiplier / refWhite;

let peakRatio = max(uniforms.displayPeakNits, refWhite) / refWhite;

var outc: vec3<f32>;
if (uniforms.outputIsHDR > 0.5) {
  // HDR 画布（rgba16float + extended）：>1.0 直接作为高光输出，仅做软限幅
  let l = max(luminance(lin), 1e-6);
  if (l > peakRatio) {
    let k = peakRatio + (l - peakRatio) / (1.0 + (l - peakRatio) / peakRatio);
    lin = lin * (k / l);
  }
  outc = vec3<f32>(srgbEncode1(lin.r), srgbEncode1(lin.g), srgbEncode1(lin.b));
} else {
  // SDR 画布：高光软膝压缩到 0..1，避免整屏发灰
  let l = max(luminance(lin), 1e-6);
  var mapped = l;
  if (l > 0.8) {
    let x = (l - 0.8) / 0.8;
    mapped = 0.8 + 0.2 * (x / (1.0 + x));
  }
  lin = lin * (mapped / l);
  outc = vec3<f32>(
    srgbEncode1(clamp(lin.r, 0.0, 1.0)),
    srgbEncode1(clamp(lin.g, 0.0, 1.0)),
    srgbEncode1(clamp(lin.b, 0.0, 1.0))
  );
}

if (uniforms.skipSaturation < 0.5) {
  outc = processInOKLab(max(outc, vec3<f32>(0.0)), uniforms.saturation);
}
return outc;
}
`;

// ★ 去色带 + CAS 公共实现：两个 video shader 共用，避免两份副本各自漂移。
//   注意：不放入 commonFunctions，因为 image shader 没有 videoTexture 绑定。
const videoQualityFunctions = `
struct RingResult {
avg: vec3<f32>,
variance: f32,
samples: array<vec3<f32>, 8>,
}

// P0-2：编译期开关。测试工具把它改成 false 即可得到「不复用」的对照管线，
// 用于逐像素验证融合路径与原路径完全等价。
const FUSED_BASE_ENABLED = true;

// ★ 8 方向环形采样：同时返回平均值和方差
fn sampleRingWithStats(uv: vec2<f32>, radius: f32) -> RingResult {
let t = vec2<f32>(uniforms.texelWidth * radius, uniforms.texelHeight * radius);
let s0 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(t.x, 0.0)).rgb;
let s1 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv - vec2<f32>(t.x, 0.0)).rgb;
let s2 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(0.0, t.y)).rgb;
let s3 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv - vec2<f32>(0.0, t.y)).rgb;
let s4 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + t).rgb;
let s5 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv - t).rgb;
let s6 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(t.x, -t.y)).rgb;
let s7 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(-t.x, t.y)).rgb;

let avg = (s0 + s1 + s2 + s3 + s4 + s5 + s6 + s7) * 0.125;

let d0 = abs(s0.r - avg.r) + abs(s0.g - avg.g) + abs(s0.b - avg.b);
let d1 = abs(s1.r - avg.r) + abs(s1.g - avg.g) + abs(s1.b - avg.b);
let d2 = abs(s2.r - avg.r) + abs(s2.g - avg.g) + abs(s2.b - avg.b);
let d3 = abs(s3.r - avg.r) + abs(s3.g - avg.g) + abs(s3.b - avg.b);
let d4 = abs(s4.r - avg.r) + abs(s4.g - avg.g) + abs(s4.b - avg.b);
let d5 = abs(s5.r - avg.r) + abs(s5.g - avg.g) + abs(s5.b - avg.b);
let d6 = abs(s6.r - avg.r) + abs(s6.g - avg.g) + abs(s6.b - avg.b);
let d7 = abs(s7.r - avg.r) + abs(s7.g - avg.g) + abs(s7.b - avg.b);
let variance = (d0 + d1 + d2 + d3 + d4 + d5 + d6 + d7) * 0.125;

var r: RingResult;
r.avg = avg;
r.variance = variance;
r.samples = array<vec3<f32>, 8>(s0, s1, s2, s3, s4, s5, s6, s7);
return r;
}

// ★ 三级 8 方向自适应多尺度 deband（保留原版效果 + 四尺度细节保护）
struct DebandResult {
color: vec3<f32>,
ring12: array<vec3<f32>, 8>,
hasRing12: f32,
}

fn applyDeband(uv: vec2<f32>, centerColor: vec3<f32>, threshold: f32) -> DebandResult {
// P2-5：先只算 3px 尺度。细纹理丰富的区域原本就会因 detailMask≈1 而几乎不平滑，
// 此时早退可省掉后三个尺度的 24 次采样；用 r3.avg 做近似混合，观感连续。
let r3  = sampleRingWithStats(uv, 3.0);    // 细纹理检测
let d3  = smoothstep(threshold * 0.5, threshold * 3.0, r3.variance);
if (d3 > 0.9) {
  // 早退没采 r12，base 只能走原来的 9-tap 路径
  var early: DebandResult;
  early.color = mix(centerColor, r3.avg, (1.0 - d3) * 0.92);
  early.ring12 = array<vec3<f32>, 8>(
    vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0),
    vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0));
  early.hasRing12 = 0.0;
  return early;
}

let r8  = sampleRingWithStats(uv, 8.0);    // 中等纹理检测
let r12 = sampleRingWithStats(uv, 12.0);   // 亮带边缘检测
let r28 = sampleRingWithStats(uv, 28.0);   // 大范围色带检测

// 细节掩码：3 / 8 / 12 尺度中任意一个检测到纹理 → 保护
let d8  = smoothstep(threshold * 0.5, threshold * 3.0, r8.variance);
let d12 = smoothstep(threshold * 0.5, threshold * 3.0, r12.variance);
let detailMask = max(max(d3, d8), d12);

// 大范围平坦度：28px 方差小 = 是大范围平滑区域
let flatLarge = 1.0 - smoothstep(threshold * 0.5, threshold * 2.5, r28.variance);

// 最终强度
let strength = flatLarge * (1.0 - detailMask) * 0.92;

// 三级加权平滑：3px 处理残余，12px 主力，28px 处理超宽色带
let smoothValue = r3.avg * 0.2 + r12.avg * 0.5 + r28.avg * 0.3;

var res: DebandResult;
res.color = mix(centerColor, smoothValue, strength);
res.ring12 = r12.samples;
res.hasRing12 = 1.0;
return res;
}

// ★ P0-2：用 deband 已采到的 r12 环算双边 base，公式与 computeLocalBase 逐字一致。
//   只有当半径恰好 12 时采样坐标才相同，调用方负责这个前提。
fn baseFromRing12(s: array<vec3<f32>, 8>, centerColor: vec3<f32>) -> f32 {
let e = uniforms.exposureMultiplier;
let inv = 1.0 / (2.0 * 0.10 * 0.10);
let Lc = luminance(centerColor) * e;
let L0 = luminance(s[0]) * e;
let L1 = luminance(s[1]) * e;
let L2 = luminance(s[2]) * e;
let L3 = luminance(s[3]) * e;
let L4 = luminance(s[4]) * e;
let L5 = luminance(s[5]) * e;
let L6 = luminance(s[6]) * e;
let L7 = luminance(s[7]) * e;
let d0 = L0 - Lc;
let d1 = L1 - Lc;
let d2 = L2 - Lc;
let d3 = L3 - Lc;
let d4 = L4 - Lc;
let d5 = L5 - Lc;
let d6 = L6 - Lc;
let d7 = L7 - Lc;
let w0 = exp(-d0 * d0 * inv);
let w1 = exp(-d1 * d1 * inv);
let w2 = exp(-d2 * d2 * inv);
let w3 = exp(-d3 * d3 * inv);
let w4 = exp(-d4 * d4 * inv);
let w5 = exp(-d5 * d5 * inv);
let w6 = exp(-d6 * d6 * inv);
let w7 = exp(-d7 * d7 * inv);
var acc = Lc;
var wsum = 1.0;
acc += L0 * w0; wsum += w0;
acc += L1 * w1; wsum += w1;
acc += L2 * w2; wsum += w2;
acc += L3 * w3; wsum += w3;
acc += L4 * w4; wsum += w4;
acc += L5 * w5; wsum += w5;
acc += L6 * w6; wsum += w6;
acc += L7 * w7; wsum += w7;
return acc / wsum;
}

// ★ CAS（Contrast Adaptive Sharpening）—— 找回去色带造成的细节损失
fn applyCAS(uv: vec2<f32>, centerRGB: vec3<f32>, strength: f32) -> vec3<f32> {
if (strength < 0.01) {
  return centerRGB;
}

let tx = uniforms.texelWidth;
let ty = uniforms.texelHeight;

// 1 像素近邻（8 方向）
let cN  = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(0.0, -ty)).rgb;
let cS  = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(0.0, ty)).rgb;
let cE  = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(tx, 0.0)).rgb;
let cW  = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(-tx, 0.0)).rgb;
let cNE = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(tx, -ty)).rgb;
let cNW = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(-tx, -ty)).rgb;
let cSE = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(tx, ty)).rgb;
let cSW = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(-tx, ty)).rgb;

let lumaW = vec3<f32>(0.2126, 0.7152, 0.0722);
let centerLuma = dot(centerRGB, lumaW);

let lumaN = dot(cN, lumaW);
let lumaS = dot(cS, lumaW);
let lumaE = dot(cE, lumaW);
let lumaW_ = dot(cW, lumaW);
let lumaNW = dot(cNW, lumaW);
let lumaNE = dot(cNE, lumaW);
let lumaSW = dot(cSW, lumaW);
let lumaSE = dot(cSE, lumaW);

// 局部 min/max（近邻）
let lumaMin = min(min(min(lumaN, lumaS), min(lumaE, lumaW_)),
                  min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
let lumaMax = max(max(max(lumaN, lumaS), max(lumaE, lumaW_)),
                  max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));

// 软钳制
let range = max(lumaMax - lumaMin, 1e-5);
let softMin = max(0.0, lumaMin - range * 0.25);
let softMax = min(2.0, lumaMax + range * 0.25);

// 8 邻居加权平均
let avg = (cN + cS + cE + cW) * 0.125 + (cNE + cNW + cSE + cSW) * 0.0625;
let avgLuma = dot(avg, lumaW);

// 小尺度方差
let varN = abs(lumaN - avgLuma);
let varS = abs(lumaS - avgLuma);
let varE = abs(lumaE - avgLuma);
let varW = abs(lumaW_ - avgLuma);
let localVar = (varN + varS + varE + varW) * 0.25;

// 噪点掩码
let noiseMask = smoothstep(0.005, 0.03, localVar);

// P2-5：平坦区域 noiseMask=0，原本强度就是 0，远邻 8 次采样纯属浪费。
// 早退时保留原有的亮度软钳制，避免与未早退路径出现边界跳变。
if (noiseMask < 0.01) {
  let l0 = max(dot(centerRGB, lumaW), 1e-6);
  return centerRGB * (clamp(l0, softMin, softMax) / l0);
}

// ★ 16 像素远邻（检测大范围平坦度）
let t16 = vec2<f32>(tx * 16.0, ty * 16.0);
let fN16 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(0.0, -t16.y)).rgb;
let fS16 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(0.0, t16.y)).rgb;
let fE16 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(t16.x, 0.0)).rgb;
let fW16 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(-t16.x, 0.0)).rgb;

// ★ 32 像素超远邻（跨色带检测）
let t32 = vec2<f32>(tx * 32.0, ty * 32.0);
let fN32 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(0.0, -t32.y)).rgb;
let fS32 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(0.0, t32.y)).rgb;
let fE32 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(t32.x, 0.0)).rgb;
let fW32 = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv + vec2<f32>(-t32.x, 0.0)).rgb;

// ★ 大尺度对比度：16 + 32 像素双重检测，取较小值（要求两个尺度都确认）
let f16Avg = (dot(fN16, lumaW) + dot(fS16, lumaW) + dot(fE16, lumaW) + dot(fW16, lumaW)) * 0.25;
let f32Avg = (dot(fN32, lumaW) + dot(fS32, lumaW) + dot(fE32, lumaW) + dot(fW32, lumaW)) * 0.25;
let farContrast16 = abs(centerLuma - f16Avg);
let farContrast32 = abs(centerLuma - f32Avg);
let farContrast = min(farContrast16, farContrast32);

// ★ 真边缘掩码（阈值大幅提高）
// - 色带：大范围对比度 < 0.02 → 不锐化
// - 真边缘：大范围对比度 > 0.05 → 完全锐化
let trueEdgeMask = smoothstep(0.02, 0.05, farContrast);

// 综合强度
let effectiveStrength = strength * noiseMask * trueEdgeMask;

// 锐化
let detail = centerRGB - avg;
let sharpened = centerRGB + detail * effectiveStrength;

// 软钳制（只对亮度）
let outLuma = dot(sharpened, lumaW);
let clampedLuma = clamp(outLuma, softMin, softMax);
let lumaScale = clampedLuma / max(outLuma, 1e-6);

return sharpened * lumaScale;
}
`;

// ★ V1.2.5 真双层：9-tap 双边估计低频亮度 base。
//   空间核固定在半径 r 的 8 方向 + 中心（与 deband 的环形采样同构），
//   亮度核 exp(-ΔL²/2σr²) 让跨边缘的邻居权重趋近 0，这样 base 不会把阶跃抹平，
//   detail 里就不会出现「一半正一半负」的大值——这是抑制 halo 的第一道闸。
//   纹理绑定名三份 shader 各不相同，故用工厂函数生成。
const makeLocalBaseFn = (tex, samp) => `
// ★ 真双层：base = 双边滤波后的低频亮度（结果已乘 exposure，与管线同域）
fn computeLocalBase(uv: vec2<f32>) -> f32 {
let e = uniforms.exposureMultiplier;
let r = max(uniforms.dualLayerRadius, 1.0);
let t = vec2<f32>(uniforms.texelWidth * r, uniforms.texelHeight * r);

let c0 = textureSampleBaseClampToEdge(${tex}, ${samp}, uv).rgb;
let Lc = luminance(c0) * e;

// σr = 0.10（编码域）：亮度差 0.10 时权重降到 e^-0.5≈0.61，0.30 时降到 0.011
let inv = 1.0 / (2.0 * 0.10 * 0.10);

let a0 = textureSampleBaseClampToEdge(${tex}, ${samp}, uv + vec2<f32>( t.x, 0.0)).rgb;
let a1 = textureSampleBaseClampToEdge(${tex}, ${samp}, uv + vec2<f32>(-t.x, 0.0)).rgb;
let a2 = textureSampleBaseClampToEdge(${tex}, ${samp}, uv + vec2<f32>(0.0,  t.y)).rgb;
let a3 = textureSampleBaseClampToEdge(${tex}, ${samp}, uv + vec2<f32>(0.0, -t.y)).rgb;
let a4 = textureSampleBaseClampToEdge(${tex}, ${samp}, uv + t).rgb;
let a5 = textureSampleBaseClampToEdge(${tex}, ${samp}, uv - t).rgb;
let a6 = textureSampleBaseClampToEdge(${tex}, ${samp}, uv + vec2<f32>( t.x, -t.y)).rgb;
let a7 = textureSampleBaseClampToEdge(${tex}, ${samp}, uv + vec2<f32>(-t.x,  t.y)).rgb;

let L0 = luminance(a0) * e;
let L1 = luminance(a1) * e;
let L2 = luminance(a2) * e;
let L3 = luminance(a3) * e;
let L4 = luminance(a4) * e;
let L5 = luminance(a5) * e;
let L6 = luminance(a6) * e;
let L7 = luminance(a7) * e;

let d0 = L0 - Lc;
let d1 = L1 - Lc;
let d2 = L2 - Lc;
let d3 = L3 - Lc;
let d4 = L4 - Lc;
let d5 = L5 - Lc;
let d6 = L6 - Lc;
let d7 = L7 - Lc;

let w0 = exp(-d0 * d0 * inv);
let w1 = exp(-d1 * d1 * inv);
let w2 = exp(-d2 * d2 * inv);
let w3 = exp(-d3 * d3 * inv);
let w4 = exp(-d4 * d4 * inv);
let w5 = exp(-d5 * d5 * inv);
let w6 = exp(-d6 * d6 * inv);
let w7 = exp(-d7 * d7 * inv);

var acc = Lc;
var wsum = 1.0;
acc += L0 * w0; wsum += w0;
acc += L1 * w1; wsum += w1;
acc += L2 * w2; wsum += w2;
acc += L3 * w3; wsum += w3;
acc += L4 * w4; wsum += w4;
acc += L5 * w5; wsum += w5;
acc += L6 * w6; wsum += w6;
acc += L7 * w7; wsum += w7;
return acc / wsum;
}
`;

// ★ 视频着色器：新增色度 deband + CAS 锐化
// P3-1：video / copy 两条路径的 fragmentMain 完全相同（只有 binding 0 类型不同），
// 收敛为一份模板，避免改管线顺序时必须改两处。
const videoFragment = `
@fragment
fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
let canvasDims = vec2<f32>(uniforms.canvasWidth, uniforms.canvasHeight);
let uvRaw = position.xy / canvasDims;
// ★ object-fit 适配：cover 时需要裁掉超出部分，contain/fill 时 scale=1/offset=0
let uv = vec2<f32>(
  uvRaw.x * uniforms.uvScaleX + uniforms.uvOffsetX,
  uvRaw.y * uniforms.uvScaleY + uniforms.uvOffsetY
);
// ★ P0-2：保留未增强的中心像素，融合路径算 base 时要用它（与原 9-tap 的中心一致）
let rawColor = textureSampleBaseClampToEdge(videoTexture, videoSampler, uv).rgb;
var color = rawColor;
var ring12Samples = array<vec3<f32>, 8>(
  vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0),
  vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0));
var hasRing12 = 0.0;

// ★ HDR 源：走 PQ/HLG 解码专线，跳过逆色调映射与 deband/CAS
if (uniforms.hdrSourceMode > 0.5) {
  var hdrOut = decodeHDRSource(color);
  if (uniforms.outputLinear > 0.5) { hdrOut = srgbDecodeVec(hdrOut); }
  return vec4<f32>(hdrOut * uniforms.outputGain, 1.0);
}

if (uniforms.debandEnabled > 0.5) {
  let debanded = applyDeband(uv, color, uniforms.debandThreshold);
  color = debanded.color;
  // r12 环只在未早退时采到；带出来给下面的双边 base 复用
  ring12Samples = debanded.ring12;
  hasRing12 = debanded.hasRing12;
}

if (uniforms.sharpenEnabled > 0.5) {
  color = applyCAS(uv, color, uniforms.sharpenStrength);
}

// P1-2：base 只在真双层开启时计算。此前无条件执行 9 次双边采样，
// 默认配置（双层关闭）每像素白付这 9 次，占默认路径 43 次采样的 21%。
// 条件是 uniform，整个 draw 的控制流一致，可安全放入分支。
var dualBase = 0.0;
var origLuma = 0.0;
if (uniforms.dualLayerEnabled > 0.5 && uniforms.dualLayerMode > 0.5) {
  // P0-2：只有半径恰好 12 时 deband 的 r12 环才与原 9-tap 采样坐标一致；
  // 两个条件都是 uniform，整 draw 一致，不会造成 WGSL 非均匀控制流。
  let canFuse = FUSED_BASE_ENABLED && uniforms.debandEnabled > 0.5 &&
                hasRing12 > 0.5 && abs(uniforms.dualLayerRadius - 12.0) < 0.01;
  if (canFuse) {
    dualBase = baseFromRing12(ring12Samples, rawColor);
  } else {
    dualBase = computeLocalBase(uv);
  }
  origLuma = luminance(color * uniforms.exposureMultiplier);
}
color = applyColorPipeline(color, position.xy, dualBase);

// ★ P1-1：与图片共用同一末端阶段（软膝/高光上限/detail/线性编码/整体增益）
color = applyOutputStage(color, dualBase, origLuma);
return vec4<f32>(color, 1.0);
}

`;

const videoShaderCode = `
${uniformsDecl}
@group(0) @binding(0) var videoTexture: texture_external;
@group(0) @binding(1) var videoSampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;
@group(0) @binding(3) var toneLutTexture: texture_2d<f32>;
@group(0) @binding(4) var toneLutSampler: sampler;
${vertexShader}
${commonFunctions}

${videoQualityFunctions}
${makeLocalBaseFn('videoTexture', 'videoSampler')}
${videoFragment}`;

// ★ copy 路径专用 shader（用于 NijiLucid canvas 接力）
const videoShaderCodeCopy = `
${uniformsDecl}
@group(0) @binding(0) var videoTexture: texture_2d<f32>;
@group(0) @binding(1) var videoSampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;
@group(0) @binding(3) var toneLutTexture: texture_2d<f32>;
@group(0) @binding(4) var toneLutSampler: sampler;
${vertexShader}
${commonFunctions}

${videoQualityFunctions}
${makeLocalBaseFn('videoTexture', 'videoSampler')}
${videoFragment}`;

const imageShaderCode = `
${uniformsDecl}
@group(0) @binding(0) var imageTexture: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;
@group(0) @binding(3) var toneLutTexture: texture_2d<f32>;
@group(0) @binding(4) var toneLutSampler: sampler;
${vertexShader}
${commonFunctions}
${makeLocalBaseFn('imageTexture', 'imageSampler')}
@fragment
fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
let canvasDims = vec2<f32>(uniforms.canvasWidth, uniforms.canvasHeight);
let uv = position.xy / canvasDims;
let sampleUV = vec2<f32>(
  uniforms.uvScaleX * uv.x + uniforms.uvOffsetX,
  uniforms.uvScaleY * uv.y + uniforms.uvOffsetY
);
let sampled = textureSample(imageTexture, imageSampler, sampleUV);
// P2-4：object-fit: contain 的留白区直接透明，避免 clamp-to-edge 拉边。
// 判断必须在采样之后，否则 textureSample 会落在非均匀控制流里导致 WGSL 编译失败。
if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) {
  return vec4<f32>(0.0);
}
// P1-2：图片同样只在真双层开启时做 9-tap base
var imgBase = 0.0;
var imgOrigLuma = 0.0;
if (uniforms.dualLayerEnabled > 0.5 && uniforms.dualLayerMode > 0.5) {
  imgBase = computeLocalBase(sampleUV);
  imgOrigLuma = luminance(sampled.rgb * uniforms.exposureMultiplier);
}
var color = applyColorPipeline(sampled.rgb, position.xy, imgBase);
// P1-1：与视频共用同一末端（8bit 软膝 / HDR 高光上限 / detail / 线性编码 / 整体增益）
color = applyOutputStage(color, imgBase, imgOrigLuma);
let a = sampled.a;
return vec4<f32>(color * a, a);
}
`;
