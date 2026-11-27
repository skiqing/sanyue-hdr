'use strict';
// HDR Vision — utils.js（从 content-script.js 拆出，Phase 3 / P3-4）

// Windows 上 Chrome 会忽略 requestAdapter 的 powerPreference，并向控制台输出
// "The powerPreference option is currently ignored…"（crbug.com/369219127）。
// 只在真正生效的平台传这个提示，避免每个视频页都往扩展错误面板刷一条 warning。
const ADAPTER_OPTIONS = (() => {
  try {
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    if (/^win/i.test(platform)) return undefined;
    return { powerPreference: 'high-performance' };
  } catch {
    return undefined;
  }
})();

function isSameOriginUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true;
    return parsed.origin === location.origin;
  } catch {
    return false;
  }
}

// ============ 源探测（HDR 判定 / 传输函数 / 色域）============  // 结果缓存到 video 元素上：new VideoFrame() 在 10bit 硬件解码帧上是真实拷贝，
// 每帧调用会明显掉帧，所以只在元数据变化时重新探测。
const HDR_TRANSFER = { pq: 1, smpte2084: 1, hlg: 2, 'arib-std-b67': 2 };

function probeSource(video) {
  const empty = {
    ok: false, transfer: 0, isHDR: false, bt2020: false,
    format: '', primaries: '', transferName: '', fullRange: false, error: null,
    codedWidth: 0, codedHeight: 0, visibleWidth: 0, visibleHeight: 0, visibleTop: 0, padded: false,
  };
  if (!video) return empty;
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return empty;

  const srcKey = `${video.currentSrc || video.src || ''}|${video.videoWidth}x${video.videoHeight}`;
  const cached = video.__hdrVisionProbe;
  if (cached && cached.srcKey === srcKey) return cached;

  const info = { ...empty, srcKey };
  try {
    const frame = new VideoFrame(video);
    const cs = frame.colorSpace;
    info.format = frame.format || '';
    // ★ AV1/HEVC 的解码帧常常补齐到 16 的倍数（1080 → 1088），visibleRect 才是真正画面。
    //   external 纹理在这类帧上会把补齐的填充条也读进来（表现为顶部一条绿边）。
    try {
      const vr = frame.visibleRect;
      info.codedWidth = frame.codedWidth || 0;
      info.codedHeight = frame.codedHeight || 0;
      info.visibleWidth = vr ? Math.round(vr.width) : info.codedWidth;
      info.visibleHeight = vr ? Math.round(vr.height) : info.codedHeight;
      info.visibleTop = vr ? Math.round(vr.top || 0) : 0;
      info.padded = !!(info.codedWidth && info.codedHeight &&
        (info.codedHeight > info.visibleHeight || info.codedWidth > info.visibleWidth));
    } catch (e) {
      info.padded = false;
    }
    if (cs) {
      info.primaries = cs.primaries || '';
      info.transferName = cs.transfer || '';
      info.fullRange = cs.fullRange === true;
      const key = String(cs.transfer || '').toLowerCase();
      info.transfer = HDR_TRANSFER[key] || 0;
      info.bt2020 = /2020/.test(String(cs.primaries || ''));
    }
    frame.close();
    info.ok = true;
    info.isHDR = info.transfer > 0;
  } catch (e) {
    info.error = String(e && e.message ? e.message : e);
  }
  video.__hdrVisionProbe = info;
  return info;
}

// 设置 + 探测结果 → 实际传输函数（0 = 不走 HDR 专线）
function resolveHDRMode(settings, probe) {
  const mode = settings?.hdrSourceMode || 'auto';
  if (mode === 'off') return 0;
  if (mode === 'sdr') return 0;   // 强制按 SDR 处理：不信任色彩标记，但仍渲染
  if (mode === 'pq') return 1;
  if (mode === 'hlg') return 2;
  return probe?.transfer || 0;
}

// 色调求解由 src/shared/tone-math.js 提供（与弹窗共用同一份实现）
// 每帧都会调用，缓存「同一 bt 对象 + 目标值 + 画布能力」的结果，避免重复的字符串指纹与查表
const toneCache = { bt: null, w: NaN, m: NaN, hdr: null, result: null };
function resolveToneTargets(bt, hdrCanvas) {
  const w = bt && bt.targetWhite;
  const m = bt && bt.targetMid;
  if (toneCache.result && toneCache.bt === bt && toneCache.w === w &&
      toneCache.m === m && toneCache.hdr === hdrCanvas) {
    return toneCache.result;
  }
  const result = typeof HdrToneMath !== 'undefined'
    ? HdrToneMath.resolveTargets(bt, hdrCanvas)
    : { white: 1.2, mid: 0.5, lift: 0.78 };  // 共享文件未加载时的兜底
  toneCache.bt = bt;
  toneCache.w = w;
  toneCache.m = m;
  toneCache.hdr = hdrCanvas;
  toneCache.result = result;
  return result;
}

// 只有「不处理（原画直通）」才跳过 HDR 源
function shouldSkipHDRSource(settings) {
  return (settings?.hdrSourceMode || 'auto') === 'off';
}

// ★ 跨域污染检测：某些站点（如斗鱼）用无 CORS 头的直链播放，
//   <video> 会被标记为 tainted，WebGPU 完全读不到像素（importExternalTexture /
//   copyExternalImageToTexture 全部拒绝）。这种情况只能识别并安静跳过。
function isVideoPixelReadable(video) {
  if (!video || !video.videoWidth || video.readyState < 2) return true; // 还没法判断，先放行
  const srcKey = (video.currentSrc || video.src || '').slice(0, 96);
  if (typeof video.__hdrVisionReadable === 'boolean' && video.__hdrVisionReadableSrc === srcKey) {
    return video.__hdrVisionReadable;
  }
  let readable = true;
  try {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, 1, 1);
    ctx.getImageData(0, 0, 1, 1);   // 被污染时抛 SecurityError
  } catch (e) {
    readable = false;
  }
  video.__hdrVisionReadable = readable;
  video.__hdrVisionReadableSrc = srcKey;
  return readable;
}

function isTaintError(e) {
  const msg = String((e && (e.message || e)) || '');
  return /tainted|cross-origin|cross origin/i.test(msg);
}

// P1-5：EME 受保护媒体（Widevine / PlayReady）。Chrome 对这类媒体 drawImage
// 通常不抛 SecurityError，而是画成黑帧 —— isVideoPixelReadable 会误判为「可读」，
// 于是扩展接管后把黑帧盖在原视频上，表现为整块黑屏。
// mediaKeys 非空说明该元素已挂 DRM（Chrome 用 mediaKeys，旧 WebKit 用 webkitKeys）。
function isDRMProtected(video) {
  try {
    return !!(video && (video.mediaKeys || video.webkitKeys));
  } catch (e) {
    return false;
  }
}

// float16 解码（校准探测回读用）
function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + m / 1024);
}

// P2-8：第三方 overlay 选择器集中配置，避免散落在通用渲染器里。
const nijiConfig = {
  selectors: [
    '[data-nijilucid-overlay-canvas-host] canvas',
    '[data-nijilucid-overlay-slot^="nijilucid-"] canvas',
  ],
};

function findNijiLucidCanvas() {
  for (const selector of nijiConfig.selectors) {
    try {
      const canvas = document.querySelector(selector);
      if (canvas && canvas.width > 0 && canvas.height > 0) return canvas;
    } catch { /* 选择器非法时跳过 */ }
  }
  return null;
}

// P2-8：每 500ms 只做一次全文档查询，结果广播给所有订阅的视频渲染器。
// 旧实现是每个 renderer 在 _updateCanvasSize 里各自查，N 个视频就是 N 次查询。
const nijiSubscribers = new Set();
let nijiCanvas = null;
let nijiLastCheck = 0;
let nijiTimer = null;

function pollNijiLucid(force = false) {
  const now = performance.now();
  if (!force && now - nijiLastCheck < 500) return nijiCanvas;
  nijiLastCheck = now;
  const found = findNijiLucidCanvas();
  if (found !== nijiCanvas) {
    nijiCanvas = found;
    if (found) {
      console.info('[HDR Vision] 检测到第三方 overlay canvas，切换到 copy 路径');
    }
    for (const cb of nijiSubscribers) {
      try { cb(found); } catch (e) { console.warn('[HDR Vision] niji notify error:', e); }
    }
  }
  return nijiCanvas;
}

function startNijiPolling() {
  if (nijiTimer) return;
  pollNijiLucid(true);
  nijiTimer = setInterval(() => pollNijiLucid(), 500);
}

function stopNijiPolling() {
  if (nijiTimer) {
    clearInterval(nijiTimer);
    nijiTimer = null;
  }
}

// P2-6：容器 position 的引用计数，多个视频共享容器时不会提前还原
const containerPositionRefs = new WeakMap();
function acquireRelativeContainer(container) {
  if (!container || window.getComputedStyle(container).position !== 'static') return false;
  let ref = containerPositionRefs.get(container);
  if (!ref) {
    ref = { count: 0, original: container.style.position };
    containerPositionRefs.set(container, ref);
  }
  if (ref.count === 0) container.style.position = 'relative';
  ref.count++;
  return true;
}
function releaseRelativeContainer(container) {
  if (!container) return;
  const ref = containerPositionRefs.get(container);
  if (!ref) return;
  ref.count--;
  if (ref.count <= 0) {
    container.style.position = ref.original;
    containerPositionRefs.delete(container);
  }
}

// pHDR 计算缓存（pow + log）：峰值不变时每帧直接复用
const curvePeakCache = { peak: NaN, pHDR: 0, logPHDR: 0 };

// P2-5：合成 uniform 时的兜底范围来自 settings-schema 的 RANGES（与 popup、
// normalizeSettings 同一张表）。这里的夹紧是最后一道防线 —— storage 可能被
// 旧版本迁移、导入快照或手工编辑写入越界值，而 Math.pow(2, 1e9) = Infinity
// 会直接把整屏刷白。
function clampUnit(name, value, fallback) {
  const n = Number(value);
  if (!isFinite(n)) return fallback;
  const range = (typeof HDRSettings !== 'undefined' && HDRSettings && HDRSettings.RANGES)
    ? HDRSettings.RANGES[name]
    : null;
  return range ? Math.min(Math.max(n, range.min), range.max) : n;
}

// ★ 输出长度由 UNIFORM_FIELDS 决定（见 shaders.js / UNIFORM_FLOATS），此处不写死数量
function computeUniformData(
  settings,
  canvasWidth,
  canvasHeight,
  texelW,
  texelH,
  frameSeed,
  uvParams,
  out,
  extra
) {
  const isBT = settings.mappingMode === 'bt2446a';
  const pc = settings.powerCurve;
  const bt = settings.bt2446a;
  const group = isBT ? bt : pc;

  const exposure = clampUnit('exposure', group.exposure ?? 0, 0);
  const saturation = clampUnit('saturation', group.saturation ?? 1.0, 1.0);
  const exposureMultiplier = Math.pow(2, exposure);
  const skipSaturation = Math.abs(saturation - 1.0) < 0.001 ? 1.0 : 0.0;

  const skipBoost = !isBT && (pc.maxBoost ?? 1.4) <= 1.001 ? 1.0 : 0.0;
  const skipShadow = !isBT && (pc.shadowCrush ?? 0) < 0.001 ? 1.0 : 0.0;
  const useBT2446aFlag = isBT ? 1.0 : 0.0;

  // ★ 目标驱动：输入「目标白点 / 目标中调」，曲线参数（peak / lift）由求解器反解。
  //   - 白点会先按画布能力收敛（8bit 没有超过 SDR 白的余量），避免"抬上去再压回来"
  //   - 中调由反解保证，不再需要用户手动补偿 boost / midToneLift
  const hdrCanvas = extra?.outputIsHDR === true;
  let peakBrightness;
  let boost;
  let midToneLift;
  if (isBT) {
    const tone = resolveToneTargets(bt, hdrCanvas);
    peakBrightness = tone.white;
    boost = 1.0;
    midToneLift = tone.lift;
  } else {
    peakBrightness = clampUnit('peakBrightness', pc.peakBrightness ?? 10.0, 10.0);
    boost = 1.0;
    midToneLift = 0.0;
  }

  // pHDR 只依赖峰值，每帧重算 pow+log 是纯浪费；参数不变时命中缓存
  if (peakBrightness !== curvePeakCache.peak) {
    const maxL = Math.max(peakBrightness, 1.0) * 100.0;
    curvePeakCache.peak = peakBrightness;
    curvePeakCache.pHDR = 1.0 + 32.0 * Math.pow(maxL / 10000.0, 1.0 / 2.4);
    curvePeakCache.logPHDR = Math.log(curvePeakCache.pHDR);
  }
  const pHDR = curvePeakCache.pHDR;
  const logPHDR = curvePeakCache.logPHDR;

  out[U.exposureMultiplier] = exposureMultiplier;
  out[U.saturation] = saturation;
  out[U.peakBrightness] = peakBrightness;
  out[U.skipSaturation] = skipSaturation;
  out[U.brightnessThreshold] = clampUnit('brightnessThreshold', pc.brightnessThreshold ?? 0.75, 0.75);
  out[U.maxBoost] = clampUnit('maxBoost', pc.maxBoost ?? 1.4, 1.4);
  out[U.shadowThreshold] = clampUnit('shadowThreshold', pc.shadowThreshold ?? 0.15, 0.15);
  out[U.shadowCrush] = clampUnit('shadowCrush', pc.shadowCrush ?? 0.0, 0.0);
  out[U.skipBoost] = skipBoost;
  out[U.skipShadow] = skipShadow;
  out[U.useBT2446a] = useBT2446aFlag;
  out[U.bt2446aBoost] = boost;
  out[U.pHDR] = pHDR;
  out[U.logPHDR] = logPHDR;
  out[U.midToneLift] = midToneLift;
  out[U.debandThreshold] = settings.deband.enabled
    ? clampUnit('debandThreshold', settings.deband.threshold ?? 0.012, 0.012)
    : 0.0;
  out[U.debandEnabled] = settings.deband.enabled ? 1.0 : 0.0;
  // useLUT：共享库缺失、LUT 上传失败或用户关闭时，一律退回 legacy 曲线，避免采样空纹理黑屏
  out[U.useLUT] = (settings.useToneLut === false || extra?.lutReady === false ||
    typeof HdrToneMath === 'undefined') ? 0.0 : 1.0;
  out[U._pad3] = 0.0;  // _pad3（原 ditherStrength）
  out[U.frameSeed] = frameSeed;
  out[U.canvasWidth] = canvasWidth;
  out[U.canvasHeight] = canvasHeight;
  out[U.texelWidth] = texelW;
  out[U.texelHeight] = texelH;
  out[U.uvScaleX] = uvParams?.scaleX ?? 1.0;
  out[U.uvScaleY] = uvParams?.scaleY ?? 1.0;
  out[U.uvOffsetX] = uvParams?.offsetX ?? 0.0;
  out[U.uvOffsetY] = uvParams?.offsetY ?? 0.0;
  out[U.sharpenEnabled] = settings.sharpen?.enabled ? 1.0 : 0.0;
  out[U.sharpenStrength] = clampUnit('sharpenStrength', settings.sharpen?.strength ?? 0.5, 0.5);

  // ---- HDR 源（AV1 / HEVC 10bit）----
  // hdrMode: 0 = 不处理（旧的「源已是 HDR」跳过行为），1 = PQ，2 = HLG
  const hdrMode = extra?.hdrMode ?? 0;
  const sliderPct = clampUnit('sdrSliderPercent', settings.sdrSliderPercent ?? 35, 35);
  const sliderNits = (typeof HDRSettings !== 'undefined' && HDRSettings && HDRSettings.sliderToNits)
    ? HDRSettings.sliderToNits(sliderPct) : 80 + sliderPct * 4;
  const refWhiteNits = extra?.refWhiteNits ?? Math.max(80, sliderNits);
  const displayPeak = clampUnit('hdrPeakNits', settings.hdrPeakNits ?? 1000, 1000);

  out[U.outputIsHDR] = extra?.outputIsHDR ? 1.0 : 0.0;
  out[U.inputTransfer] = hdrMode;
  out[U.inputBT2020] = extra?.inputBT2020 ? 1.0 : 0.0;
  out[U.refWhiteNits] = refWhiteNits;
  out[U.displayPeakNits] = displayPeak;
  out[U.hdrSourceMode] = hdrMode > 0 ? 1.0 : 0.0;

  // 末端整体强度
  out[U.outputGain] = clampUnit('outputGain', extra?.outputGain ?? settings.outputGain ?? 1.0, 1.0);
  // 保留占位：uniform 布局偏移不变，避免下游索引整体移动
  out[U._pad9] = 0.0;
  // 画布编码：1 = 输出线性值（Chrome 把 extended 画布按 scRGB 线性解释时用）
  out[U.outputLinear] = extra?.outputLinear ? 1.0 : 0.0;
  // 高光软上限（相对 SDR 白），只压高光、不动中间调。
  // ★ 上限不能超过显示器的真实余量：余量 = 峰值 ÷ SDR 白（后者由系统滑块决定）。
  //   申请一个做不到的亮度只会被显示器硬裁，反而丢失高光层次。
  const headroom = displayPeak / Math.max(refWhiteNits, 1);
  out[U.highlightCeiling] = Math.min(
    clampUnit('highlightCeiling', settings.highlightCeiling ?? 1.2, 1.2),
    Math.max(1.0, Math.min(2.0, headroom))
  );
  // V1.2.3 双层合成：40=开关 41=分界亮度 42=过渡宽度
  const dual = settings.dualLayer || {};
  out[U.dualLayerEnabled] = dual.enabled ? 1.0 : 0.0;
  out[U.dualLayerSplit] = clampUnit('dualSplit', dual.split ?? 0.5, 0.5);
  out[U.dualLayerSoft] = clampUnit('dualSoft', dual.soft ?? 0.15, 0.15);
  // V1.2.5 真双层：43=算法(1=base/detail 局部) 44=邻域半径(显示像素) 45=细节增益
  // 老配置没有 mode 字段 → 默认走真双层（模式为 'zone' 时才回退旧算法）
  out[U.dualLayerMode] = dual.mode === 'zone' ? 0.0 : 1.0;
  out[U.dualLayerRadius] = clampUnit('dualRadius', dual.radius ?? 12, 12);
  out[U.dualLayerDetail] = clampUnit('dualDetail', dual.detail ?? 1.0, 1.0);
}
// ============ 1D 色调 LUT（阶段 2）============
// r16float 纹理，6 行：0/1 单层 SDR/HDR，2/3 8bit 双层，4/5 16float 双层。
// 指纹不变时不写 GPU；上传失败时返回 false，调用方退回 legacy 曲线避免黑屏。
