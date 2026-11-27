#!/usr/bin/env node
/**
 * WGSL 编译自检：把 shaders.js 里的三份着色器真实编译一遍。
 *
 * 为什么需要它：createShaderModule 不抛异常，一个保留字（例如 target）写错，
 * 只会让所有管线静默变 null —— 表现是「开关没反应、状态一直未激活」，
 * 控制台里也只有 Tint 的英文警告。静态检查（括号配对、字段计数）完全抓不到。
 *
 * 用法：
 *   node tools/check-wgsl.js
 *   CHROME_PATH="C:/.../chrome.exe" node tools/check-wgsl.js
 *
 * 依赖：本机已装 Chrome / Edge（需要支持 WebGPU 的版本），无 npm 依赖。
 * 退出码：0 = 全部通过，1 = 有编译或管线错误。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'content', 'shaders.js');

// P3-9：每次取空闲端口，避免固定端口被占用导致检查假失败
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

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
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 继续找 */ }
  }
  throw new Error('找不到 Chrome/Edge，可用 CHROME_PATH 指定');
}

// 与运行时完全同源的提取方式：执行 shader 模板字符串所在的代码段
function extractShaders() {
  const src = fs.readFileSync(SRC, 'utf8');
  const start = src.indexOf('const UNIFORM_FIELDS = [');
  const imgIdx = src.indexOf('const imageShaderCode = `');
  if (start < 0 || imgIdx < 0) throw new Error('未找到着色器定义，内容脚本结构可能已变');
  const end = src.indexOf('\n`;', imgIdx) + 4;
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    src.slice(start, end) +
      '\nthis.__out = { video: videoShaderCode, copy: videoShaderCodeCopy, image: imageShaderCode };',
    ctx
  );
  return ctx.__out;
}

function buildPage(shaders) {
  const json = JSON.stringify(shaders);
  return `<!DOCTYPE html><html><body><pre id="out">pending</pre><script type="module">
const shaders = ${json};
window.__run = async function () {
  const out = [];
  let adapter = null;
  try {
    if (!navigator.gpu) throw new Error('navigator.gpu 不存在');
    adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('requestAdapter 返回 null（该环境不支持 WebGPU）');
    const i = adapter.info || {};
    out.push('adapter: ' + [i.vendor, i.architecture].filter(Boolean).join(' / '));
  } catch (e) { return 'GPU 初始化失败: ' + e.message; }

  const device = await adapter.requestDevice();
  let bad = 0;

  for (const [name, code] of Object.entries(shaders)) {
    const mod = device.createShaderModule({ code, label: name });
    const info = await mod.getCompilationInfo();
    const errs = info.messages.filter((m) => m.type === 'error');
    const warns = info.messages.filter((m) => m.type === 'warning');
    out.push('=== ' + name + ': ' + (errs.length ? errs.length + ' 个错误' : '编译通过') +
      '（警告 ' + warns.length + '）===');
    for (const m of errs) { out.push('  [E] 行' + m.lineNum + ':' + m.linePos + '  ' + m.message); bad++; }
    for (const m of warns.slice(0, 4)) out.push('  [W] 行' + m.lineNum + ':' + m.linePos + '  ' + m.message);
    if (errs.length) continue;

    const isExternal = name === 'video';
    for (const format of ['rgba16float', 'bgra8unorm', 'rgba8unorm']) {
      try {
        device.pushErrorScope('validation');
        const entries = [];
        if (isExternal) entries.push({ binding: 0, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} });
        else entries.push({ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } });
        entries.push({ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } });
        entries.push({ binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } });
        entries.push({ binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } });
        entries.push({ binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } });
        const bgl = device.createBindGroupLayout({ entries });
        device.createRenderPipeline({
          layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
          vertex: { module: mod, entryPoint: 'vertexMain' },
          fragment: { module: mod, entryPoint: 'fragmentMain', targets: [{ format }] },
          primitive: { topology: 'triangle-list' },
        });
        const err = await device.popErrorScope();
        if (err) bad++;
        out.push('  pipeline @' + format + ': ' + (err ? '失败 → ' + err.message.split('\\n')[0] : '成功'));
      } catch (e) { bad++; out.push('  pipeline @' + format + ' 抛异常: ' + e.message); }
    }
  }
  out.push('');
  out.push(bad === 0 ? '全部通过' : '失败项合计: ' + bad);
  return out.join('\\n');
};
</script></body></html>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chromePath = findChrome();
  const shaders = extractShaders();
  console.log('着色器行数:', Object.entries(shaders).map(([k, v]) => k + '=' + v.split('\n').length).join('  '));

  // P3-9：Node 侧校验 uniform 布局，防止字段数变化后缓冲大小与 struct 不一致
  const structBlock = (shaders.copy.match(/struct Uniforms \{([\s\S]*?)\}/) || [])[1] || '';
  const fieldCount = (structBlock.match(/^\s*\w+: f32,$/gm) || []).length;
  console.log('uniform 字段数:', fieldCount, '(期望 48)');
  if (fieldCount !== 48) {
    console.error('uniform 字段数异常，跳过 GPU 编译');
    process.exitCode = 1;
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdrvision-wgsl-'));
  const pagePath = path.join(tmpDir, 'check.html');
  fs.writeFileSync(pagePath, buildPage(shaders), 'utf8');
  const profileDir = path.join(tmpDir, 'profile');
  const port = await freePort();

  const chrome = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profileDir,
    '--enable-unsafe-webgpu',
    '--use-angle=d3d11',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); ready = true; break; }
      catch { await sleep(300); }
    }
    if (!ready) throw new Error('Chrome 调试端口未就绪');

    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
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
    await send('Page.navigate', { url: 'file:///' + pagePath.replace(/\\/g, '/') });
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
    const text = r.result && r.result.result ? r.result.result.value : '';
    console.log('\n' + (text || '(无输出)'));
    const failed = !text || /失败|错误|初始化失败/.test(text);
    process.exitCode = failed ? 1 : 0;
  } finally {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    // P3-9：Windows 上 chrome.kill() 只杀父进程，子进程会残留
    try {
      if (process.platform === 'win32' && chrome.pid) {
        spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        chrome.kill();
      }
    } catch { /* ignore */ }
    await sleep(200);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error('检查失败:', e.message);
  process.exitCode = 1;
});
