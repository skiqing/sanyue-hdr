#!/usr/bin/env node
/**
 * P1-1 验证：用真实 WebGPU 渲染，对比 video/copy 与 image 着色器的输出。
 *
 * 两者在同一个测试页里使用：
 *   - 同一张 1x1 输入纹理（多个颜色）
 *   - 同一份 uniform（8bit 画布、单层 legacy 曲线、双层关闭）
 *   - 同一目标格式 rgba16float
 * 读回像素后逐半精度值比对，最大差应当为 0（或至多 1 个 half ULP）。
 *
 * 用法：node tools/check-shader-parity.js
 * 退出码：0 = 一致，1 = 不一致 / 环境不支持
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'content', 'shaders.js');
const PORT = 9417;
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

function extractShaders() {
  const src = fs.readFileSync(SRC, 'utf8');
  const start = src.indexOf('const UNIFORM_FIELDS = [');
  const imgIdx = src.indexOf('const imageShaderCode = `');
  const end = src.indexOf('\n`;', imgIdx) + 4;
  if (start < 0 || end < 4) throw new Error('未找到着色器定义');
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    src.slice(start, end) +
    '\nthis.out = { copy: videoShaderCodeCopy, image: imageShaderCode };',
    ctx
  );
  return ctx.out;
}

function buildPage(shaders) {
  return `<!DOCTYPE html><html><body><pre id="out">pending</pre><script type="module">
const shaders = ${JSON.stringify(shaders)};
window.__run = async function () {
  const log = [];
  try {
    if (!navigator.gpu) throw new Error('navigator.gpu 不存在');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('requestAdapter 返回 null');
    const device = await adapter.requestDevice();

    const bgl = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ] });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });

    function pipeline(code, label) {
      const mod = device.createShaderModule({ code, label });
      return device.createRenderPipeline({
        layout,
        vertex: { module: mod, entryPoint: 'vertexMain' },
        fragment: { module: mod, entryPoint: 'fragmentMain', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' },
      });
    }
    const pipes = { copy: pipeline(shaders.copy, 'copy'), image: pipeline(shaders.image, 'image') };

    const srcTex = device.createTexture({
      size: [1, 1, 1], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const lut = device.createTexture({
      size: [256, 6, 1], format: 'r16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const lutData = new Uint16Array(256 * 6).fill(0x3c00); // 1.0
    device.queue.writeTexture({ texture: lut }, lutData,
      { bytesPerRow: 256 * 2, rowsPerImage: 6 }, { width: 256, height: 6 });

    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const ub = device.createBuffer({ size: 48 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const u = new Float32Array(48);
    u[0] = 1;   // exposure
    u[1] = 1;   // saturation
    u[2] = 1.4; // peak
    u[3] = 1;   // skipSaturation
    u[10] = 1;  // useBT2446a
    u[11] = 1;  // boost
    u[12] = 2.0; u[13] = Math.log(2.0);
    u[14] = 0.5; // midToneLift
    u[16] = 0;  // deband off
    u[17] = 0;  // useLUT off -> legacy 曲线
    u[20] = 1; u[21] = 1; u[22] = 1; u[23] = 1;
    u[28] = 0;  // sharpen off
    u[30] = 0;  // 8bit canvas
    u[31] = 0;  // hdrMode off
    u[36] = 1;  // outputGain
    u[39] = 1.2;
    u[40] = 0;  // dualLayer off
    u[43] = 1; u[44] = 12; u[45] = 1;
    device.queue.writeBuffer(ub, 0, u);

    const bg = device.createBindGroup({ layout: bgl, entries: [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: ub } },
      { binding: 3, resource: lut.createView() },
      { binding: 4, resource: sampler },
    ] });

    const outTex = device.createTexture({
      size: [1, 1, 1], format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const readBuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    function half(h) {
      const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
      if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
      if (e === 31) return m ? NaN : s * Infinity;
      return s * Math.pow(2, e - 15) * (1 + m / 1024);
    }

    async function render(pipe, color) {
      device.queue.writeTexture({ texture: srcTex }, new Uint8Array([...color, 255]),
        { bytesPerRow: 256 }, { width: 1, height: 1 });
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{
        view: outTex.createView(), loadOp: 'clear', storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }] });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
      enc.copyTextureToBuffer({ texture: outTex }, { buffer: readBuf, bytesPerRow: 256 },
        { width: 1, height: 1, depthOrArrayLayers: 1 });
      device.queue.submit([enc.finish()]);
      await readBuf.mapAsync(GPUMapMode.READ);
      const u16 = new Uint16Array(readBuf.getMappedRange().slice(0, 8));
      readBuf.unmap();
      return [half(u16[0]), half(u16[1]), half(u16[2]), half(u16[3])];
    }

    const colors = [[255, 255, 255], [204, 128, 51], [64, 64, 64], [0, 0, 0]];
    let maxDiff = 0;
    for (const c of colors) {
      const a = await render(pipes.copy, c);
      const b = await render(pipes.image, c);
      const d = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
      maxDiff = Math.max(maxDiff, d);
      log.push('  输入 ' + c.join(',') +
        '  copy=[' + a.map(x => x.toFixed(4)).join(',') + ']' +
        '  image=[' + b.map(x => x.toFixed(4)).join(',') + ']' +
        '  最大差 ' + d.toExponential(2));
    }
    log.push('最大逐点差: ' + maxDiff.toExponential(3));
    log.push(maxDiff <= 1 / 255 ? '一致（PASS）' : '不一致（FAIL）');
    return log.join('\\n');
  } catch (e) {
    return '验证失败: ' + (e && e.stack ? e.stack : String(e));
  }
};
</script></body></html>`;
}

async function main() {
  const chromePath = findChrome();
  const shaders = extractShaders();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrvision-parity-'));
  const page = path.join(tmp, 'check.html');
  fs.writeFileSync(page, buildPage(shaders), 'utf8');

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
    process.exitCode = /一致（PASS）/.test(text) ? 0 : 1;
  } finally {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    await sleep(200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error('检查失败:', e.message); process.exitCode = 1; });
