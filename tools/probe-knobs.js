#!/usr/bin/env node
/**
 * 参数手册数据源：实测「整体强度(outputGain)」与「细节增益(dualLayerDetail)」的真实作用。
 *
 * 用真实 WebGPU + 真实 LUT 渲染 copy 着色器，输出三组数据：
 *   A. 整体强度：SDR 路径下 0.4/0.8/1.0/1.2/1.6 对 4 档灰阶的输出（验证纯乘法、无中间夹紧）
 *   B. 细节增益：中间调 / 高光两组正弦光栅，0.4/1.0/1.5/2.0 的局部振幅
 *   C. HDR 源直通：hdrSourceMode=1 时细节增益是否还有效（预期完全无效）、整体强度的效果
 *
 * 用法：node tools/probe-knobs.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'content', 'shaders.js');
const PORT = 9419;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* continue */ }
  }
  throw new Error('找不到 Chrome/Edge，可用 CHROME_PATH 指定');
}

function extract() {
  const src = fs.readFileSync(SRC, 'utf8');
  const start = src.indexOf('const UNIFORM_FIELDS = [');
  const imgIdx = src.indexOf('const imageShaderCode = `');
  const end = src.indexOf('\n`;', imgIdx) + 4;
  if (start < 0 || end < 4) throw new Error('未找到着色器定义');
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/shared/tone-math.js'), 'utf8'), ctx);
  vm.runInContext(
    src.slice(start, end) +
    '\nthis.out = { shader: videoShaderCodeCopy, fields: UNIFORM_FIELDS, lut: HdrToneMath.buildDualLut({ targetWhite: 1.4, targetMid: 0.5, saturation: 1.1 }, 256) };',
    ctx
  );
  return ctx.out;
}

function buildPage(spec) {
  return `<!DOCTYPE html><html><body><pre id="out">pending</pre><script type="module">
const shader = ${JSON.stringify(spec.shader)};
const FIELDS = ${JSON.stringify(spec.fields)};
const LUT = new Uint16Array(${JSON.stringify(Array.from(spec.lut))});
const U = Object.fromEntries(FIELDS.map((n, i) => [n, i]));
const W = 48, H = 48;

// PQ 编码：nits -> 0..1
function pqEncode(nits) {
  const m1 = 2610 / 16384, m2 = 2523 / 4096 * 128;
  const c1 = 3424 / 4096, c2 = 2413 / 4096 * 32, c3 = 2392 / 4096 * 32;
  const y = Math.pow(nits / 10000, m1);
  return Math.pow((c1 + c2 * y) / (1 + c3 * y), m2);
}

window.__run = async function () {
  const log = [];
  try {
    if (!navigator.gpu) throw new Error('navigator.gpu 不存在');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('requestAdapter 返回 null');
    const device = await adapter.requestDevice();
    device.addEventListener('uncapturederror', (e) => { log.push('GPU error: ' + e.error.message); });

    const bgl = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ] });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

    device.pushErrorScope('validation');
    const mod = device.createShaderModule({ code: shader, label: 'copy' });
    const pipe = device.createRenderPipeline({
      layout,
      vertex: { module: mod, entryPoint: 'vertexMain' },
      fragment: { module: mod, entryPoint: 'fragmentMain', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });
    const err = await device.popErrorScope();
    if (err) throw new Error('pipeline 创建失败: ' + err.message);

    const srcTex = device.createTexture({
      size: [W, H, 1], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const lutTex = device.createTexture({
      size: [256, 6, 1], format: 'r16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: lutTex }, LUT,
      { bytesPerRow: 256 * 2, rowsPerImage: 6 }, { width: 256, height: 6 });

    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const ub = device.createBuffer({ size: 48 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const u = new Float32Array(48);

    const base = {
      exposureMultiplier: 1, saturation: 1, peakBrightness: 1.4,
      bt2446aBoost: 1, pHDR: 2.0, logPHDR: Math.log(2.0),
      useBT2446a: 1, useLUT: 1, debandEnabled: 0, sharpenEnabled: 0,
      outputIsHDR: 0, outputGain: 1, outputLinear: 0, highlightCeiling: 1.2,
      canvasWidth: W, canvasHeight: H, texelWidth: 1 / W, texelHeight: 1 / H,
      uvScaleX: 1, uvScaleY: 1, dualLayerMode: 1, dualLayerRadius: 12,
      dualLayerDetail: 1.0, dualLayerSplit: 0.5, dualLayerSoft: 0.15,
      dualLayerEnabled: 0, hdrSourceMode: 0, inputTransfer: 0, inputBT2020: 0,
      refWhiteNits: 220, displayPeakNits: 1000,
    };

    const bg = device.createBindGroup({ layout: bgl, entries: [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: ub } },
      { binding: 3, resource: lutTex.createView() },
      { binding: 4, resource: sampler },
    ] });

    const outTex = device.createTexture({
      size: [W, H, 1], format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    // copyTextureToBuffer 的 bytesPerRow 必须是 256 的倍数：48px×8B=384 不合法，用 512 补齐
    const ROW_BYTES = 512;
    const readBuf = device.createBuffer({ size: ROW_BYTES * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    function half(h) {
      const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
      if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
      if (e === 31) return m ? NaN : s * Infinity;
      return s * Math.pow(2, e - 15) * (1 + m / 1024);
    }

    const pixels = new Uint8Array(W * H * 4);
    async function render(over, values) {
      const cfg = Object.assign({}, base, over);
      for (const k of Object.keys(cfg)) {
        if (U[k] !== undefined) u[U[k]] = cfg[k];
      }
      for (let i = 0; i < W * H; i++) {
        const v = values[i];
        pixels[i * 4] = v; pixels[i * 4 + 1] = v; pixels[i * 4 + 2] = v; pixels[i * 4 + 3] = 255;
      }
      device.queue.writeTexture({ texture: srcTex }, pixels,
        { bytesPerRow: W * 4, rowsPerImage: H }, { width: W, height: H });
      device.queue.writeBuffer(ub, 0, u);

      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{
        view: outTex.createView(), loadOp: 'clear', storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }] });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
      enc.copyTextureToBuffer({ texture: outTex }, { buffer: readBuf, bytesPerRow: ROW_BYTES },
        { width: W, height: H, depthOrArrayLayers: 1 });
      device.queue.submit([enc.finish()]);
      await readBuf.mapAsync(GPUMapMode.READ);
      const u16 = new Uint16Array(readBuf.getMappedRange().slice(0, ROW_BYTES * H));
      readBuf.unmap();
      const out = [];
      const stride = ROW_BYTES / 2;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const j = y * stride + x * 4;
          out.push(0.2126 * half(u16[j]) + 0.7152 * half(u16[j + 1]) + 0.0722 * half(u16[j + 2]));
        }
      }
      return out;
    }

    // ---------- A. 整体强度 ----------
    log.push('A. 整体强度 outputGain（SDR 路径，双层关闭）');
    const gains = [0.4, 0.8, 1.0, 1.2, 1.6];
    const levels = [64, 128, 192, 255];
    const tableA = {};
    for (const lv of levels) {
      tableA[lv] = [];
      for (const g of gains) {
        const r = await render({ outputGain: g }, new Array(W * H).fill(lv));
        tableA[lv].push(r[0]);
      }
    }
    log.push('输入  ' + gains.map((g) => 'g=' + g.toFixed(2)).join('   '));
    for (const lv of levels) {
      log.push(String(lv).padStart(4) + '  ' + tableA[lv].map((v) => v.toFixed(4)).join('  '));
    }
    const r128 = tableA[128].map((v) => v / tableA[128][2]);
    log.push('128 灰阶 相对 g=1.00 的比值: ' + r128.map((v) => v.toFixed(3)).join(' / '));

    // ---------- B. 细节增益 ----------
    log.push('');
    log.push('B. 细节增益 dualLayerDetail（真双层开启，SDR 路径，8px 正弦光栅）');
    function grating(mean, amp) {
      const a = [];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) a.push(Math.round(mean + amp * Math.sin(2 * Math.PI * x / 8)));
      }
      return a;
    }
    function amplitude(out) {
      // 每行取最大/最小，跨行取中位数，规避单点噪声
      const rowAmp = [];
      for (let y = 0; y < H; y++) {
        const row = out.slice(y * W, y * W + W);
        rowAmp.push(Math.max(...row) - Math.min(...row));
      }
      rowAmp.sort((a, b) => a - b);
      return rowAmp[Math.floor(rowAmp.length / 2)];
    }
    for (const [label, mean, amp] of [['中间调 128±30', 128, 30], ['高光 232±15', 232, 15]]) {
      const g = grating(mean, amp);
      const off = await render({ dualLayerEnabled: 0 }, g);
      const baseAmp = amplitude(off);
      const rows = [];
      for (const d of [0.4, 1.0, 1.5, 2.0]) {
        const out = await render({ dualLayerEnabled: 1, dualLayerDetail: d }, g);
        rows.push({ d, amp: amplitude(out), mean: out.reduce((s, v) => s + v, 0) / out.length });
      }
      log.push('[' + label + '] 双层关闭时振幅=' + baseAmp.toFixed(5) +
        '  平均亮度=' + (off.reduce((s, v) => s + v, 0) / off.length).toFixed(5));
      for (const r of rows) {
        log.push('  detail=' + r.d.toFixed(2) + '  振幅=' + r.amp.toFixed(5) +
          '  ×' + (r.amp / baseAmp).toFixed(2) + '  平均亮度=' + r.mean.toFixed(5));
      }
    }

    // ---------- C. HDR 源直通 ----------
    log.push('');
    log.push('C. HDR 源直通（hdrSourceMode=1, PQ, 16float 画布, SDR 白 220 nits）');
    for (const nits of [100, 203, 1000]) {
      const code = Math.round(pqEncode(nits) * 255);
      const vals = new Array(W * H).fill(code);
      const rows = [];
      for (const g of [0.8, 1.0, 1.2]) {
        const out = await render({ hdrSourceMode: 1, inputTransfer: 1, outputIsHDR: 1, outputGain: g, dualLayerEnabled: 0 }, vals);
        rows.push({ g, v: out[0] });
      }
      const d1 = await render({ hdrSourceMode: 1, inputTransfer: 1, outputIsHDR: 1, outputGain: 1, dualLayerEnabled: 1, dualLayerDetail: 0.4 }, vals);
      const d2 = await render({ hdrSourceMode: 1, inputTransfer: 1, outputIsHDR: 1, outputGain: 1, dualLayerEnabled: 1, dualLayerDetail: 2.0 }, vals);
      log.push(nits + ' nits (PQ 码值 ' + code + '):  g0.8=' + rows[0].v.toFixed(4) +
        '  g1.0=' + rows[1].v.toFixed(4) + '  g1.2=' + rows[2].v.toFixed(4) +
        '  | detail0.4=' + d1[0].toFixed(4) + '  detail2.0=' + d2[0].toFixed(4) +
        '  Δdetail=' + Math.abs(d2[0] - d1[0]).toExponential(1));
    }

    return log.join('\\n');
  } catch (e) {
    return '探测失败: ' + (e && e.stack ? e.stack : String(e));
  }
};
</script></body></html>`;
}

async function main() {
  const chromePath = findChrome();
  const spec = extract();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrvision-probe-'));
  const page = path.join(tmp, 'probe.html');
  fs.writeFileSync(page, buildPage(spec), 'utf8');

  const chrome = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(tmp, 'profile'),
    '--enable-unsafe-webgpu',
    '--use-angle=d3d11',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); ready = true; break; }
      catch { await sleep(300); }
    }
    if (!ready) throw new Error('Chrome 调试端口未就绪');
    const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')));
    });
    const send = (method, params = {}) => new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
    await send('Page.enable');
    await send('Page.navigate', { url: 'file:///' + page.replace(/\\/g, '/') });
    await sleep(2000);
    const r = await send('Runtime.evaluate', {
      expression: 'window.__run()',
      awaitPromise: true,
      returnByValue: true,
      timeout: 60000,
    });
    if (r.result && r.result.exceptionDetails) {
      throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails));
    }
    console.log(r.result.result.value);
  } finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    setTimeout(() => { try { chrome.kill('SIGKILL'); } catch { /* ignore */ } }, 1500).unref();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
