#!/usr/bin/env node
/**
 * v15 验证：真双层开启 / 关闭时，SDR 8bit 路径的高光亮度必须一致。
 *
 * 背景：旧 applyDetailLayer 把 base 先压到 cap-0.015、再压一次到 cap，
 * 导致 0.94 以上出现两级压缩 —— 白点从 0.993 掉到 0.953，高光层次塌成一条线，
 * 观感是「开双层反而更暗、亮部没有细节」。
 *
 * 本脚本用真实 WebGPU 渲染 copy 着色器（真实 LUT、local 模式），
 * 对同一输入分别开关双层，比较输出亮度：
 *   - 每个灰阶的 |on - off| 应 <= 0.003（半精度 + OKLab 往返误差）
 *   - 白色输出应 >= 0.985（证明没有被预压到 0.95）
 *
 * 用法：node tools/check-dual-output.js
 * 退出码：0 = 通过，1 = 不一致 / 环境不支持
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'content', 'shaders.js');
const PORT = 9418;
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
    '\nthis.out = { shader: videoShaderCodeCopy,' +
    ' shaderNoFuse: videoShaderCodeCopy.replace("const FUSED_BASE_ENABLED = true;", "const FUSED_BASE_ENABLED = false;"),' +
    ' fields: UNIFORM_FIELDS, lut: HdrToneMath.buildDualLut({ targetWhite: 1.4, targetMid: 0.5, saturation: 1.1 }, 256) };',
    ctx
  );
  return ctx.out;
}

function buildPage(spec) {
  return `<!DOCTYPE html><html><body><pre id="out">pending</pre><script type="module">
const shader = ${JSON.stringify(spec.shader)};
const shaderNoFuse = ${JSON.stringify(spec.shaderNoFuse)};
const FIELDS = ${JSON.stringify(spec.fields)};
const LUT = new Uint16Array(${JSON.stringify(Array.from(spec.lut))});
const U = Object.fromEntries(FIELDS.map((n, i) => [n, i]));
const W = 32, H = 32;

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

    // P0-2：关闭融合开关的对照管线，用于逐像素验证采样复用没有改变输出
    const modB = device.createShaderModule({ code: shaderNoFuse, label: 'copy-no-fuse' });
    const pipeB = device.createRenderPipeline({
      layout,
      vertex: { module: modB, entryPoint: 'vertexMain' },
      fragment: { module: modB, entryPoint: 'fragmentMain', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });

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
    u[U.exposureMultiplier] = 1;
    u[U.saturation] = 1;
    u[U.peakBrightness] = 1.4;
    u[U.bt2446aBoost] = 1;
    u[U.pHDR] = 2.0;
    u[U.logPHDR] = Math.log(2.0);
    u[U.useBT2446a] = 1;
    u[U.useLUT] = 1;
    u[U.debandEnabled] = 0;
    u[U.sharpenEnabled] = 0;
    u[U.outputIsHDR] = 0;
    u[U.outputGain] = 1;
    u[U.outputLinear] = 0;
    u[U.highlightCeiling] = 1.2;
    u[U.canvasWidth] = W;
    u[U.canvasHeight] = H;
    u[U.texelWidth] = 1 / W;
    u[U.texelHeight] = 1 / H;
    u[U.uvScaleX] = 1;
    u[U.uvScaleY] = 1;
    u[U.dualLayerMode] = 1;   // local
    u[U.dualLayerRadius] = 12;
    u[U.dualLayerDetail] = 1.0;
    u[U.dualLayerSplit] = 0.5;
    u[U.dualLayerSoft] = 0.15;

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
    const readBuf = device.createBuffer({ size: 256 * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    function half(h) {
      const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
      if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
      if (e === 31) return m ? NaN : s * Infinity;
      return s * Math.pow(2, e - 15) * (1 + m / 1024);
    }

    const pixels = new Uint8Array(W * H * 4);
    async function render(dualOn, values, useNoFuse) {
      for (let i = 0; i < W * H; i++) {
        const v = values[i];
        pixels[i * 4] = v;
        pixels[i * 4 + 1] = v;
        pixels[i * 4 + 2] = v;
        pixels[i * 4 + 3] = 255;
      }
      device.queue.writeTexture({ texture: srcTex }, pixels,
        { bytesPerRow: W * 4, rowsPerImage: H }, { width: W, height: H });
      u[U.dualLayerEnabled] = dualOn ? 1 : 0;
      device.queue.writeBuffer(ub, 0, u);

      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{
        view: outTex.createView(), loadOp: 'clear', storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }] });
      pass.setPipeline(useNoFuse ? pipeB : pipe);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
      enc.copyTextureToBuffer({ texture: outTex }, { buffer: readBuf, bytesPerRow: 256 },
        { width: W, height: H, depthOrArrayLayers: 1 });
      device.queue.submit([enc.finish()]);
      await readBuf.mapAsync(GPUMapMode.READ);
      const u16 = new Uint16Array(readBuf.getMappedRange().slice(0, W * H * 8));
      readBuf.unmap();
      const out = [];
      for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        out.push(0.2126 * half(u16[j]) + 0.7152 * half(u16[j + 1]) + 0.0722 * half(u16[j + 2]));
      }
      return out;
    }

    const levels = [128, 230, 240, 245, 252, 255];
    let maxDiff = 0, whiteOn = 0;
    for (const v of levels) {
      const flat = new Array(W * H).fill(v);
      const off = (await render(false, flat))[0];
      const on = (await render(true, flat))[0];
      const diff = Math.abs(on - off);
      maxDiff = Math.max(maxDiff, diff);
      if (v === 255) whiteOn = on;
      log.push('  输入 ' + v + '/255  off=' + off.toFixed(5) + '  on=' + on.toFixed(5) +
        '  Δ=' + diff.toExponential(2));
    }
    log.push('最大 |on-off|: ' + maxDiff.toExponential(3));
    log.push('双层开启时白点: ' + whiteOn.toFixed(5));

    // 8px 正弦光栅（232±20）：双边核不会把它当硬边拒掉，base 保持在均值附近，
    // 用来确认「detail 仍然生效」且不越界。
    // 注意：高光 detail 只能吃剩余 headroom，亮峰增量本就很小（+0.004 量级），
    // 不能用「暗谷必须更暗」做断言——base 由邻域决定，方向并非单像素可控。
    const grating = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        grating.push(Math.round(232 + 20 * Math.sin(2 * Math.PI * x / 8)));
      }
    }
    const gOff = await render(false, grating);
    const gOn = await render(true, grating);
    // 8px 正弦：取首行最大值/最小值的位置
    const firstRow = grating.slice(0, W);
    const peakIdx = firstRow.indexOf(Math.max(...firstRow));
    const troughIdx = firstRow.indexOf(Math.min(...firstRow));
    const peakOff = gOff[peakIdx], peakOn = gOn[peakIdx];
    const troughOff = gOff[troughIdx], troughOn = gOn[troughIdx];
    log.push('光栅 亮峰 off=' + peakOff.toFixed(5) + '  on=' + peakOn.toFixed(5) +
      '  Δ=' + (peakOn - peakOff).toFixed(5));
    log.push('光栅 暗谷 off=' + troughOff.toFixed(5) + '  on=' + troughOn.toFixed(5) +
      '  Δ=' + (troughOn - troughOff).toFixed(5));
    const active = Math.abs(peakOn - peakOff) > 0.002 || Math.abs(troughOn - troughOff) > 0.002;
    const detailOk = active && peakOn <= 1.0001 && troughOn >= 0;

    // P0-2：deband 与双边 base 复用 12px 环后，必须与原来的 9-tap 路径逐像素一致。
    // 覆盖平坦（走满 4 环）、光栅与三种半径边界之外的情况；早退分支也要走到。
    u[U.debandEnabled] = 1;
    u[U.debandThreshold] = 0.008;
    u[U.dualLayerEnabled] = 1;
    u[U.dualLayerRadius] = 12;
    const gradient = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) gradient.push(Math.round(160 + x * 2));
    }
    let fusedMax = 0;
    for (const values of [new Array(W * H).fill(200), grating, gradient]) {
      const a = await render(true, values, false);
      const b = await render(true, values, true);
      for (let i = 0; i < a.length; i++) fusedMax = Math.max(fusedMax, Math.abs(a[i] - b[i]));
    }
    log.push('融合/原路径逐像素最大差: ' + fusedMax.toExponential(3));
    const fusedOk = fusedMax <= 1e-6;
    log.push(fusedOk ? '采样复用一致（PASS）' : '采样复用不一致（FAIL）');

    const ok = maxDiff <= 0.003 && whiteOn >= 0.985 && detailOk && fusedOk;
    log.push(ok ? '亮度一致（PASS）' : '亮度不一致（FAIL）');
    return log.join('\\n');
  } catch (e) {
    return '验证失败: ' + (e && e.stack ? e.stack : String(e));
  }
};
</script></body></html>`;
}

async function main() {
  const chromePath = findChrome();
  const spec = extract();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrvision-dual-'));
  const page = path.join(tmp, 'check.html');
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
      throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    }
    const text = (r.result && r.result.result && r.result.result.value) || '';
    console.log(text);
    process.exitCode = /亮度一致（PASS）/.test(text) ? 0 : 1;
  } finally {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
      else chrome.kill();
    } catch { /* ignore */ }
    await sleep(200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error('检查失败:', e.message); process.exitCode = 1; });
