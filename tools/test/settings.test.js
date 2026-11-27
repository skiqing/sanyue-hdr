'use strict';
/**
 * Phase 0 回归测试：设置单一来源、P0-1 不回写、P0-4 保存判定。
 * 运行：node --test tools/test/*.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadShared() {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('src/shared/tone-math.js'), ctx);
  vm.runInContext(read('src/shared/settings-schema.js'), ctx);
  return ctx;
}

const ctx = loadShared();
const S = ctx.HDRSettings;
const sw = read('src/background/service-worker.js');
const popup = read('src/popup/popup.js');
const popupHtml = read('src/popup/popup.html');
const content = [
  'core.js', 'shaders.js', 'utils.js', 'tone-lut.js',
  'shared-resources.js', 'renderers.js', 'managers.js', 'controller.js',
].map((name) => read('src/content/' + name)).join('\n');
const manifest = JSON.parse(read('manifest.json'));

// ---------- P0-2：单一来源 ----------
test('schema 版本与默认值自洽', () => {
  assert.equal(S.CURRENT_SETTINGS_VERSION, 15);
  assert.equal(S.DEFAULT_SETTINGS._version, 15);
  assert.equal(S.DEFAULT_SETTINGS.presetByMode.bt2446a, 'highDynamic');
  assert.equal(S.DEFAULT_SETTINGS.bt2446a.targetWhite, 1.4);
  assert.equal(S.DEFAULT_SETTINGS.outputGain, 1.0);
});

test('默认 BT 参数直接来自 highDynamic 预设', () => {
  const preset = S.BT2446A_PRESETS.highDynamic.settings;
  assert.equal(S.DEFAULT_SETTINGS.bt2446a.targetWhite, preset.targetWhite);
  assert.equal(S.DEFAULT_SETTINGS.bt2446a.targetMid, preset.targetMid);
  assert.equal(S.DEFAULT_SETTINGS.bt2446a.saturation, preset.saturation);
  assert.deepEqual(S.DEFAULT_SETTINGS.powerCurve, S.POWER_PRESETS.standard.settings);
});

test('三端不再重复定义默认值 / 预设 / normalize / migrate', () => {
  assert.ok(!/const DEFAULT_SETTINGS\s*=\s*\{/.test(sw));
  assert.ok(!/function migrateSettings\(/.test(sw));
  assert.ok(!/function deepMerge\(/.test(sw));
  assert.ok(!/const POWER_PRESETS\s*=\s*\{/.test(popup));
  assert.ok(!/const BT2446A_PRESETS\s*=\s*\{/.test(popup));
  assert.ok(!/function normalize\(raw\)/.test(popup));
  assert.ok(/importScripts\('\.\.\/shared\/settings-schema\.js'\)/.test(sw));
  assert.ok(/const normalize = HDRSettings\.normalizeSettings;/.test(popup));
});

test('manifest / popup 加载顺序正确', () => {
  const js = manifest.content_scripts[0].js;
  const idx = (name) => js.findIndex((x) => x.includes(name));
  assert.ok(idx('settings-schema.js') >= 0);
  assert.ok(idx('settings-schema.js') < idx('tone-math.js'));
  assert.ok(idx('tone-math.js') < idx('controller.js'));
  const s = popupHtml.indexOf('settings-schema.js');
  const p = popupHtml.indexOf('popup.js');
  assert.ok(s > 0 && p > s);
});

// ---------- 迁移链 ----------
test('v12 → v13：旧默认 sdr / 被夹过的 1.25 被修正', () => {
  const s = S.migrateSettings({
    _version: 12,
    canvasMode: 'sdr',
    presetByMode: { power: 'standard', bt2446a: 'highDynamic' },
    bt2446a: { targetWhite: 1.25, targetMid: 0.50, saturation: 1.10, exposure: 0 },
  });
  assert.equal(s.canvasMode, 'auto');
  assert.equal(s.bt2446a.targetWhite, 1.4);
  assert.equal(s.bt2446a.targetMid, 0.50);
  assert.equal(s._version, 15);
});

test('v12 → v13：手调过的白点不被覆盖', () => {
  const s = S.migrateSettings({
    _version: 12,
    canvasMode: 'sdr',
    presetByMode: { bt2446a: 'highDynamic' },
    bt2446a: { targetWhite: 1.35, targetMid: 0.52, saturation: 1.05 },
  });
  assert.equal(s.canvasMode, 'auto');
  assert.equal(s.bt2446a.targetWhite, 1.35);
});

test('v12 → v13：cinema / faithful 预设白点不动', () => {
  for (const preset of ['cinema', 'faithful']) {
    const s = S.migrateSettings({
      _version: 12,
      canvasMode: 'sdr',
      presetByMode: { bt2446a: preset },
      bt2446a: { targetWhite: 1.15, targetMid: 0.46, saturation: 1.0 },
    });
    assert.equal(s.bt2446a.targetWhite, 1.15);
    assert.equal(s.canvasMode, 'auto');
  }
});

test('缺 canvasMode 也补成 auto', () => {
  const s = S.migrateSettings({ _version: 12, presetByMode: {} });
  assert.equal(s.canvasMode, 'auto');
});

test('v5 老配置链式迁移到当前版本且幂等', () => {
  const once = S.migrateSettings({
    _version: 5,
    canvasMode: 'sdr',
    presetByMode: { bt2446a: 'faithful' },
    bt2446a: { peakBrightness: 1.7, boost: 1, midToneLift: 0.35 },
  });
  assert.equal(once._version, 15);
  const twice = S.migrateSettings(once);
  assert.deepEqual(twice, once);
});

// ---------- v14：twoLayer 预设下线 ----------
test('v13 → v14：twoLayer 指针改指 highDynamic，观感值原样保留', () => {
  const s = S.migrateSettings({
    _version: 13,
    presetByMode: { power: 'standard', bt2446a: 'twoLayer' },
    bt2446a: { exposure: 0, saturation: 1.12, targetWhite: 1.45, targetMid: 0.48 },
  });
  assert.equal(s._version, 15);
  assert.equal(s.presetByMode.bt2446a, 'highDynamic');
  assert.equal(s.presetByMode.power, 'standard', '另一个模式的指针不应被动');
  assert.equal(s.bt2446a.targetWhite, 1.45, '观感应保留，不回灌 1.40');
  assert.equal(s.bt2446a.targetMid, 0.48);
  assert.equal(s.bt2446a.saturation, 1.12);
});

test('twoLayer 已从预设与 locale 中移除', () => {
  assert.equal(S.BT2446A_PRESETS.twoLayer, undefined);
  for (const loc of ['en', 'zh_CN']) {
    const messages = JSON.parse(read('_locales/' + loc + '/messages.json'));
    assert.equal(messages.presetTwoLayer, undefined, loc + ' 仍残留 presetTwoLayer');
    assert.equal(messages.presetTwoLayerDesc, undefined, loc + ' 仍残留 presetTwoLayerDesc');
  }
});

test('normalize 兜底：配置快照里的 twoLayer 指针不产生幽灵高亮', () => {
  const n = S.normalizeSettings({ presetByMode: { bt2446a: 'twoLayer' } });
  assert.equal(n.presetByMode.bt2446a, 'highDynamic');
});

// ---------- P0-1：normalize 与 render 不按画布夹紧 ----------
test('normalize 不按画布夹紧用户目标值，也不修改入参', () => {
  const raw = {
    canvasMode: 'sdr',
    bt2446a: { targetWhite: 1.4, targetMid: 0.60, saturation: 1.1, exposure: 0 },
  };
  const n = S.normalizeSettings(raw);
  assert.equal(n.bt2446a.targetWhite, 1.4, 'SDR 配置不应把 1.4 改成 1.25');
  assert.equal(n.bt2446a.targetMid, 0.60);
  assert.equal(raw.bt2446a.targetWhite, 1.4, '入参不应被修改');
});

test('normalize 只按用户可输入域夹紧', () => {
  const n = S.normalizeSettings({
    bt2446a: { targetWhite: 3.0, targetMid: 0.10, saturation: 1.0, exposure: 0 },
  });
  assert.equal(n.bt2446a.targetWhite, 2.0);
  assert.equal(n.bt2446a.targetMid, 0.30);
});

test('normalize 补齐缺失的 dualLayer / outputGain', () => {
  const n = S.normalizeSettings({ canvasMode: 'auto' });
  assert.equal(n.dualLayer.enabled, false);
  assert.equal(n.dualLayer.mode, 'local');
  assert.equal(n.outputGain, 1.0);
});

test('popup.render 不再写回 settings.bt2446a', () => {
  const renderBody = popup.match(/ {2}function render\(\) \{([\s\S]*?)\n {2}\}/)[1];
  assert.ok(!/settings\.bt2446a\.\w+\s*=/.test(renderBody), 'render 内不得给 settings.bt2446a 赋值');
  assert.ok(/shownWhite/.test(renderBody));
  assert.ok(/desiredWhite/.test(renderBody));
  assert.ok(/target-mid/.test(popupHtml));
  // P2-5：范围改由 data-range 注入，HTML 不再写死数字
  assert.ok(/id="target-mid"[^>]*data-range="targetMid"/.test(popupHtml));
});

// ---------- P0-4：保存失败判定 ----------
test('save 只认 success:true，且失败保留脏标记', () => {
  assert.ok(/response && response\.success === true/.test(popup));
  const flush = popup.match(/ {2}async function flushSave\(\) \{([\s\S]*?)\n {2}\}/)[1];
  assert.ok(!/advancedDirty = false/.test(flush), 'flushSave 不得在保存前清脏');
  assert.ok(!/saveTimeout/.test(popup), '废弃的 saveTimeout 应清理干净');
  assert.ok(/settingsLoadFailed/.test(popup));
});

test('SW 对 handleMessage 异常回传错误响应', () => {
  const listener = sw.match(/chrome\.runtime\.onMessage\.addListener\([\s\S]*?\n\}\);/)[0];
  assert.ok(/\.catch\(\(e\) => \{/.test(listener));
  assert.ok(/sendResponse\(\{ error:/.test(listener));
});

test('保存前状态提示使用 error 样式', () => {
  assert.ok(/\.advanced-save-bar\.error/.test(read('src/popup/popup.css')));
});

// ---------- 行为级：直接驱动保存状态机 ----------
function makeSaveContext(response, shouldReject = false) {
  const start = popup.indexOf('  function setSaveState(state, message) {');
  const end = popup.indexOf('  async function fetchStatus() {');
  assert.ok(start > 0 && end > start, '保存状态机代码块未找到');
  const block = popup.slice(start, end);

  const hint = { textContent: '' };
  const btn = { disabled: false };
  let sent = 0;
  const ctx = {
    console,
    Promise,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: {
        sendMessage: async () => {
          sent++;
          if (shouldReject) throw new Error('port closed');
          return response;
        },
      },
    },
    el: {
      advancedSaveBar: { classList: { remove() {}, add() {} } },
      advancedSaveHint: hint,
      advancedSave: btn,
    },
    MESSAGE_TYPES: { SET_SETTINGS: 'SET_SETTINGS' },
    HDRSettings: S,
    t: (key, fallback) => fallback,
    clampByRange: (key, v, fallback) => v,
    sdrSliderRelevant: () => false,
    settings: { enabled: true },
    advancedDirty: true,
    settingsLoadFailed: false,
    render() {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.api = { save, flushSave };', ctx);
  return { ctx, hint, btn, sentCount: () => sent };
}

test('保存成功：清脏并显示已保存', async () => {
  const c = makeSaveContext({ success: true });
  assert.equal(await c.ctx.api.save(), true);
  assert.equal(c.ctx.advancedDirty, false);
  assert.equal(c.hint.textContent, '已保存');
  assert.equal(c.btn.disabled, true);
  assert.equal(c.sentCount(), 1);
});

test('保存失败(error)：保留脏标记并显示原因', async () => {
  const c = makeSaveContext({ error: 'storage quota' });
  assert.equal(await c.ctx.api.save(), false);
  assert.equal(c.ctx.advancedDirty, true);
  assert.match(c.hint.textContent, /保存失败：storage quota/);
  assert.equal(c.btn.disabled, false);
});

test('保存超时：与失败同等处理，不清脏', async () => {
  const c = makeSaveContext({ timeout: true });
  assert.equal(await c.ctx.api.save(), false);
  assert.equal(c.ctx.advancedDirty, true);
  assert.match(c.hint.textContent, /保存超时/);
});

test('sendMessage 抛异常：不清脏且保留改动', async () => {
  const c = makeSaveContext(null, true);
  assert.equal(await c.ctx.api.save(), false);
  assert.equal(c.ctx.advancedDirty, true);
  assert.match(c.hint.textContent, /port closed/);
});

test('读取失败时禁止写盘，避免覆盖已有配置', async () => {
  const c = makeSaveContext({ success: true });
  c.ctx.settingsLoadFailed = true;
  assert.equal(await c.ctx.api.flushSave(), false);
  assert.equal(c.sentCount(), 0, '读取失败时不应发送 SET_SETTINGS');
  assert.equal(c.ctx.advancedDirty, true);
});

// ---------- Phase 1：设置即时生效 / 图片末端 / pipeline 可见 / 画布移除 ----------
test('P0-3：视频对缩放/取帧/裁切变化做 diff 并重新应用', () => {
  const vr = content.indexOf('class VideoRenderer {');
  const s0 = content.indexOf('updateSettings(settings) {', vr);
  const s1 = content.indexOf('_uniformExtra() {', s0);
  const videoBlock = content.slice(s0, s1);
  for (const key of ['renderScale', 'capturePath', 'cropTopPx', 'canvasMode']) {
    assert.ok(videoBlock.includes(key), '视频 updateSettings 应处理 ' + key);
  }
  assert.ok(videoBlock.includes('_updateCanvasSize()'));
  assert.ok(videoBlock.includes('_configureCanvas()'));
  assert.ok(videoBlock.includes('_cropDetected = false'));
  const ir = content.indexOf('class ImageRenderer {');
  const i0 = content.indexOf('updateSettings(settings) {', ir);
  const i1 = content.indexOf('_createTexture(width, height) {', i0);
  const imgBlock = content.slice(i0, i1);
  assert.ok(imgBlock.includes('_configureCanvas()'));
  assert.ok(imgBlock.includes('_updateCanvasSize()'));
});

test('P1-1：三份 shader 共用 applyOutputStage，图片不再单独叠 detail', () => {
  assert.equal((content.match(/fn applyOutputStage\(/g) || []).length, 1);
  // P3-1：video/copy 共用 videoFragment，所以调用点由 3 降为 2
  assert.equal((content.match(/color = applyOutputStage\(/g) || []).length, 2);
  assert.equal((content.match(/\$\{videoFragment\}/g) || []).length, 2);
  const img = content.match(/const imageShaderCode = `([\s\S]*?)`;/)[1];
  assert.ok(img.includes('applyOutputStage('));
  assert.ok(!img.includes('applyDetailLayer('));
  assert.ok(img.includes('applyOutputStage(color, imgBase, imgOrigLuma)'));

  const ir0 = content.indexOf('class ImageRenderer {');
  const ir1 = content.indexOf('class ImageManager {', ir0);
  const imgRenderer = content.slice(ir0, ir1);
  assert.ok(imgRenderer.includes("this.settings?.canvasMode !== 'sdr'"));
  assert.ok(imgRenderer.includes('outputLinear: this.canvasFormat === \'rgba16float\''));
});

test('v15：detail 不再预压 base，正向 detail 按剩余 headroom 饱和', () => {
  const sh = read('src/content/shaders.js');
  assert.ok(!/fn softLimit\(/.test(sh), 'softLimit（双层预压）应已删除');
  assert.ok(!/cap - 0\.015/.test(sh), '不应再有 cap-0.015 预压');
  assert.ok(/let room = max\(cap - l, 0\.0\);/.test(sh), '应改用剩余 headroom');
  assert.ok(/add = room \* add \/ \(add \+ room \+ 1e-5\);/.test(sh), '正向 detail 应平滑饱和');
  assert.ok(/let targetL = clamp\(l \+ add, 0\.0, cap\);/.test(sh), 'base 保持单层结果，不再二次压缩');
});

test('P1-6：pipeline 校验 / HDR 回退 / shader_error 状态齐备', () => {
  assert.ok(content.includes('SHADER_ERROR: \'shader_error\''));
  assert.ok(content.includes('if (this._pipelineError) return STATUS.SHADER_ERROR;'));
  assert.ok(popup.includes("case 'shader_error':"));
  assert.ok(content.includes('createPipelineChecked('));
  assert.ok(content.includes('invalidPipelines.has(p)'));
  const getters = content.match(/getExternalPipeline\(format\) \{[\s\S]*?\n {4}\}/)[0];
  assert.ok(!/return this\.pipelineSDRExt;\s*\n\s*\}/.test(getters),
    'HDR pipeline 不可用不得回退到格式不匹配的 SDR pipeline');
  assert.ok(content.includes('渲染资源初始化失败'));
});

test('P1-6 行为：pipeline validation error 触发错误上报', async () => {
  const start = content.indexOf('const invalidPipelines = new WeakSet();');
  const end = content.indexOf('const vertexShader = `');
  assert.ok(start > 0 && end > start);
  const block = content.slice(start, end);
  const seen = [];
  const ctx = { console: { error() {}, warn() {}, log() {} } };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    block + '\nthis.api = { createPipelineChecked, setHandler: (h) => { pipelineErrorHandler = h; } };',
    ctx
  );
  ctx.api.setHandler((label, text) => seen.push({ label, text }));
  const fakePipeline = {};
  const device = {
    pushErrorScope() {},
    popErrorScope: async () => ({ message: 'validation failed' }),
    createRenderPipeline: () => fakePipeline,
  };
  const p = ctx.api.createPipelineChecked(device, {}, 'test/pipeline');
  assert.equal(p, fakePipeline);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].label, 'test/pipeline');
  assert.match(seen[0].text, /validation failed/);
});

test('P1-7：视频与图片都有画布连接性心跳', () => {
  assert.equal((content.match(/_startCanvasWatch\(\) \{/g) || []).length, 2);
  assert.equal((content.match(/_stopCanvasWatch\(\) \{/g) || []).length, 2);
  assert.ok(content.includes('this.canvas.isConnected'));
  assert.ok(content.includes("this.video.insertAdjacentElement('afterend', this.canvas)"));
  assert.ok(content.includes("this.image.insertAdjacentElement('afterend', this.canvas)"));
});

test('P2-10：deband/sharpen 互斥在 normalize 与 SW 出口都成立', () => {
  const n = S.normalizeSettings({
    deband: { enabled: true, threshold: 0.012 },
    sharpen: { enabled: true, strength: 0.5 },
  });
  assert.equal(n.deband.enabled, true);
  assert.equal(n.sharpen.enabled, false);
  const body = sw.match(/async function getSettings\(\) \{([\s\S]*?)\n\}/)[1];
  assert.ok(!/return deepMerge\(DEFAULT_SETTINGS, stored\)/.test(body));
  assert.ok(body.includes('normalizeSettings(deepMerge(DEFAULT_SETTINGS, stored))'));
});

// ---------- Phase 2：采样开销 / 懒初始化 / 资源 / 回收 ----------
test('P1-2：computeLocalBase 只在双层分支内，视频侧是融合失败时的回退', () => {
  // 图片 shader 没有 deband，仍直接在双层分支里算 9-tap
  assert.ok(/if \(uniforms\.dualLayerEnabled > 0\.5 && uniforms\.dualLayerMode > 0\.5\) \{[\s\S]{0,160}?computeLocalBase\(/.test(content));
  // P0-2：视频侧优先复用 deband 的 r12 环，只有不能融合时才补 9-tap
  assert.match(content, /if \(canFuse\) \{\s*\n\s*dualBase = baseFromRing12\([^)]*\);\s*\n\s*\} else \{\s*\n\s*dualBase = computeLocalBase\(uv\);/);
  assert.ok(!content.includes('let dualBase = computeLocalBase('));
  assert.ok(!content.includes('let imgBase = computeLocalBase('));
});

test('P2-5：deband / CAS 都有早退，远邻采样移到噪声判断之后', () => {
  assert.ok(content.includes('if (d3 > 0.9)'));
  assert.ok(content.includes('if (noiseMask < 0.01)'));
  const casStart = content.indexOf('fn applyCAS(');
  const iNoise = content.indexOf('noiseMask = smoothstep', casStart);
  const iFar = content.indexOf('let fN16 =', casStart);
  assert.ok(iNoise > 0 && iFar > iNoise, '16px 远邻采样必须在 noiseMask 早退之后');
});

test('P1-3 / P2-2：先读设置再建 GPU，优先高性能适配器，图片懒创建', () => {
  const init = content.match(/[ \t]*async _init\(\) \{([\s\S]*?)\n[ \t]*\}\n\n[ \t]*\/\/ P1-3 \/ P2-2/)[1];
  const iLoad = init.indexOf('await this.loadSettings();');
  const iDevice = init.indexOf('this._requestDevice()');
  assert.ok(iLoad > 0 && iDevice > iLoad, 'loadSettings 必须早于 GPU 申请');
  assert.ok(init.indexOf('if (!this.settings?.enabled)') < iDevice);
  const e0 = content.indexOf('_ensureManagers() {');
  const e1 = content.indexOf('// P0-1：为一个 device 注册错误与 lost 监听', e0);
  const ensure = content.slice(e0, e1);
  assert.ok(ensure.includes('this.settings?.enhanceImages && !this.imageManager'));
  const q0 = content.indexOf('async _requestDevice() {');
  const q1 = content.indexOf('// P1-3：manager 懒创建', q0);
  const req = content.slice(q0, q1);
  assert.ok(req.includes('requestAdapter(ADAPTER_OPTIONS)'));
  assert.ok(!req.includes("powerPreference: 'high-performance'"), 'powerPreference 不应写死在调用点');
  assert.ok(req.includes('this._deviceGeneration++'));
  // Windows 上 Chrome 忽略该选项并告警（crbug.com/369219127），必须按平台跳过
  const utilsSrc = read('src/content/utils.js');
  assert.ok(utilsSrc.includes('ADAPTER_OPTIONS'));
  assert.ok(utilsSrc.includes('/^win/i.test(platform)'));
});

test('P1-4：shared / device / probe 资源都有释放路径', () => {
  for (const cls of ['ToneLutManager', 'SharedVideoResources', 'SharedImageResources']) {
    const block = content.match(new RegExp('class ' + cls + ' \\{[\\s\\S]*?\\n\\}'));
    assert.ok(block && /destroy\(\) \{/.test(block[0]), cls + ' 缺少 destroy()');
  }
  const c0 = content.indexOf('class HDRController {');
  const d0 = content.indexOf('destroy() {', c0);
  const d1 = content.indexOf('\n}', d0);
  const ctrlDestroy = content.slice(d0, d1);
  assert.ok(ctrlDestroy.includes('this.device?.destroy()'));
  assert.ok(content.includes('_watchDevice(device, generation)'));
  assert.ok(content.includes('generation !== this._deviceGeneration'));
});

test('P1-5 / P1-8：管理器回收与错误归属', () => {
  assert.equal((content.match(/renderer\.onDestroyed = \(\) => \{/g) || []).length, 2);
  assert.equal((content.match(/if \(!el\.isConnected\) \{/g) || []).length, 2);
  const status = content.match(/[ \t]*getStatus\(\) \{([\s\S]*?)\n[ \t]*\}/)[1];
  assert.ok(status.includes('.some('));
  assert.ok(!content.includes("this.device.addEventListener('uncapturederror'"));
  // P2-7：错误预算改为时间窗 + 一次性延迟重建
  assert.ok(content.includes('GPU_ERROR_LIMIT'));
  assert.ok(content.includes('GPU_ERROR_WINDOW_MS'));
  assert.ok(content.includes('_onGpuErrorBudgetExceeded'));
});

test('P2-1 / P2-3：图片队列退避与显存预算', () => {
  const fm = content.indexOf('_flushPending() {');
  const fn = content.indexOf('_deactivate(img) {', fm);
  const flush = content.slice(fm, fn);
  assert.ok(flush.includes('IMAGE_TEXTURE_BUDGET_BYTES'));
  assert.ok(flush.includes('this._textureBytes + bytes'));
  assert.ok(flush.includes('IMAGE_PENDING_BACKOFF_MS'));
  assert.ok(!/if \(this\.pending\.size > 0 && this\.isEnabled\) this\._scheduleFlush\(\);/.test(flush));
});

// ---------- Phase 3：架构整理 ----------
test('P3-3：死代码已清理', () => {
  assert.ok(!content.includes('rgbToYCbCr'));
  assert.ok(!content.includes('yCbCrToRgb'));
  assert.ok(!content.includes('NIJILUCID_CHECK_INTERVAL_MS'));
  assert.ok(!sw.includes('TOGGLE_HDR'));
  // 1.2.19 / P1-5：drm_protected 已由「无来源的死分支」变成真实状态，
  // 这条旧的「不存在」断言随之失效，改由 P1-5 用例正向校验。
  assert.ok(!popup.includes("case 'render_failed'"));
});

test('P3-1 / P3-2：fragment 与 uniform/LUT 单一来源', () => {
  assert.equal((content.match(/fn fragmentMain\(/g) || []).length, 2, 'videoFragment + image');
  assert.equal((content.match(/\$\{videoFragment\}/g) || []).length, 2);
  const fields = content.match(/const UNIFORM_FIELDS = \[([\s\S]*?)\];/)[1];
  assert.equal((fields.match(/'/g) || []).length / 2, 48);
  assert.ok(!/out\[\d+\]/.test(content));
  assert.ok(content.includes('out[U.outputGain]'));
  assert.ok(content.includes('${LUT_SIZE}.0'));
  assert.ok(content.includes('${lutV(5)}'));
  assert.ok(!content.includes('0.9166667'));
  const tm = read('src/shared/tone-math.js');
  assert.ok(tm.includes('DUAL_BRIGHT.targetWhite'));
});

test('P3-4：content script 已拆分且 manifest 按序加载', () => {
  const names = [
    'core.js', 'shaders.js', 'utils.js', 'tone-lut.js',
    'shared-resources.js', 'renderers.js', 'managers.js', 'controller.js',
  ];
  for (const name of names) {
    assert.ok(read('src/content/' + name).length > 100, name + ' 不应为空');
  }
  const js = manifest.content_scripts[0].js.filter((x) => x.includes('/content/'));
  assert.equal(js.length, names.length);
  assert.ok(js[js.length - 1].includes('controller.js'));
  // P3-1：兼容壳从未列入 manifest，且只有注释，已删除
  assert.equal(fs.existsSync(path.join(ROOT, 'src/content/content-script.js')), false);
});

test('P3-7 / P3-8：本地化与 manifest 整理', () => {
  const en = JSON.parse(read('_locales/en/messages.json'));
  const zh = JSON.parse(read('_locales/zh_CN/messages.json'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(en)) {
    assert.ok(en[key].message && zh[key].message, key + ' 缺少 message');
  }
  assert.notEqual(en.hdrActive.message, zh.hdrActive.message, 'en/zh 不应是同一份文案');
  assert.equal(manifest.default_locale, 'zh_CN');
  assert.ok(manifest.minimum_chrome_version);
  assert.ok(!manifest.permissions.includes('activeTab'));
});

test('P3-9：WGSL 自检工具使用动态端口', () => {
  const tool = read('tools/check-wgsl.js');
  assert.ok(tool.includes('freePort()'));
  assert.ok(tool.includes("'rgba8unorm'"));
  assert.ok(tool.includes('taskkill'));
});

test('P2-3 行为：超过显存预算的图片留在 pending 并退避', async () => {
  const a = content.indexOf('_flushPending() {');
  const b = content.indexOf('_deactivate(img) {', a);
  assert.ok(a > 0 && b > a);
  const block = content.slice(a, b).replace('_flushPending()', 'function _flushPending()');

  const ctx = {
    console,
    IMAGE_BATCH_PER_FRAME: 16,
    IMAGE_TEXTURE_BUDGET_BYTES: 256 * 1024 * 1024,
    IMAGE_PENDING_BACKOFF_MS: 250,
    setTimeout,
    clearTimeout,
    ImageRenderer: class {
      constructor(shared, img) { this.img = img; this.failed = false; }
      _render() {}
      destroy() { if (this.onDestroyed) this.onDestroyed(); }
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.fn = _flushPending;', ctx);

  const imgs = [0, 1, 2].map((i) => ({
    naturalWidth: 6000,
    naturalHeight: 4000,
    isConnected: true,
    id: i,
  }));
  const mgr = {
    pending: new Set(imgs),
    renderers: new Map(),
    settings: { renderScale: 1 },
    isEnabled: true,
    shaderReady: true,
    _textureBytes: 0,
    _pendingBackoff: null,
    observed: new WeakSet(),
    intersectionObserver: { unobserve() {} },
    _getTier: () => ({ max: 10 }),
    _countInTier: () => 0,
    _scheduleFlush() {},
  };
  ctx.fn.call(mgr);
  assert.equal(mgr.renderers.size, 2, '两张 96MB 图可容纳，第三张应被预算挡住');
  assert.equal(mgr.pending.size, 1);
  assert.equal(mgr._textureBytes, 2 * 6000 * 4000 * 4);

  ctx.fn.call(mgr); // 无进展的一轮应退避而不是继续 RAF
  assert.ok(mgr._pendingBackoff !== null);
  clearTimeout(mgr._pendingBackoff);
});

test('P4-1：pipeline 改异步编译，且只预编译当前取帧路径', () => {
  assert.ok(content.includes('async function createPipelineCheckedAsync'));
  const asyncFn = content.match(/async function createPipelineCheckedAsync[\s\S]*?\n\}/)[0];
  assert.ok(asyncFn.includes('device.createRenderPipelineAsync'));
  assert.ok(asyncFn.includes('createPipelineChecked(device, descriptor, label)'), '不支持 async 时需回退同步实现');
  // 并行编译时交错 push/pop 会打乱 error scope 栈，异步路径不得使用
  assert.ok(!asyncFn.includes('pushErrorScope'));
  assert.ok(content.includes('this.ready = this._buildPath(this.preferredPath)'));
  assert.ok(content.includes('this._built = { external: false, copy: false }'));
  // 另一条路径按需补建（统一经 _getPathPipeline → _ensurePathSync(path)）
  assert.ok(content.includes('this._ensurePathSync(path)'));
  assert.ok(content.includes('this._getPathPipeline(true, format)'));
  assert.ok(content.includes('this._getPathPipeline(false, format)'));
});

test('P4-1 行为：取帧方式决定预编译哪条路径', () => {
  const a = content.indexOf('_prepareShared() {');
  const b = content.indexOf('_createIntersectionObserver() {', a);
  assert.ok(a > 0 && b > a);
  const block = content.slice(a, b).replace('_prepareShared()', 'function _prepareShared()');

  const built = [];
  const ctx = {
    console,
    Promise,
    SharedVideoResources: class {
      constructor(device, path) { built.push(path); this.ready = Promise.resolve(); }
      preparePath(path) { built.push(path); return Promise.resolve(); }
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.fn = _prepareShared;', ctx);

  const make = (capturePath) => ({
    device: {}, settings: { capturePath }, shared: null, ready: null,
    isEnabled: false, _destroyed: false,
  });

  ctx.fn.call(make('snapshot'));
  assert.deepEqual(built, ['copy'], 'snapshot 走 2D 快照，应预编译 copy');
  ctx.fn.call(make('copy'));
  assert.deepEqual(built, ['copy', 'copy']);
  ctx.fn.call(make('import'));
  assert.deepEqual(built, ['copy', 'copy', 'external']);
  // P1-4：auto 两条路径都可能用到 —— external 为首选，copy 提前异步预取
  const auto = make('auto');
  ctx.fn.call(auto);
  assert.deepEqual(built, ['copy', 'copy', 'external', 'external', 'copy']);
  assert.ok(auto.ready && typeof auto.ready.then === 'function', 'ready 应等到两条路径都就绪');
});

test('P4-1：编译未完成时 manager 不建渲染器，就绪后重扫', () => {
  const vm0 = content.indexOf('_prepareShared() {');
  const vm1 = content.indexOf('_createIntersectionObserver() {', vm0);
  const prep = content.slice(vm0, vm1);
  assert.ok(prep.includes('this.shaderReady = true'));
  assert.ok(prep.includes('if (this.isEnabled) this.scan()'));

  const s0 = content.indexOf('class VideoManager {');
  const s1 = content.indexOf('_prepareShared() {', s0);
  const body = content.slice(s0, s1);
  assert.ok(body.includes('this.shaderReady = false'));
  assert.ok(body.includes('this.shared = null'));

  const scan = content.match(/[ \t]*scan\(\) \{\n[ \t]*if \(!this\.isEnabled\) return;[\s\S]*?\n[ \t]*\}/g) || [];
  assert.ok(scan.some((s) => s.includes('if (!this.shaderReady) return') || s.includes('!this.shaderReady')));
  const imgFlush = content.match(/[ \t]*_flushPending\(\) \{([\s\S]*?)\n[ \t]*\}/)[1];
  assert.ok(imgFlush.includes('if (!this.shaderReady) return'));
});

test('P4-1 行为：shared 只编译首选路径，另一条按需补建', async () => {
  const a = content.indexOf('class SharedVideoResources {');
  const b = content.indexOf('// ============ 共享图片资源 ============');
  assert.ok(a > 0 && b > a);
  const block = content.slice(a, b);

  const made = [];
  const ctx = {
    console,
    Promise,
    WeakSet,
    LUT_SIZE: 256,
    GPUShaderStage: { FRAGMENT: 1 },
    videoShaderCode: '',
    videoShaderCodeCopy: '',
    HDR_DISPLAY_AVAILABLE: false,
    invalidPipelines: new WeakSet(),
    reportGpuSetupError() {},
    reportShaderErrors() {},
    ToneLutManager: class { destroy() {} },
    navigator: { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } },
    createPipelineChecked(device, desc, label) { made.push(label); return { label }; },
    createPipelineCheckedAsync(device, desc, label) { made.push(label); return Promise.resolve({ label }); },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.Shared = SharedVideoResources;', ctx);

  const device = {
    createShaderModule: () => ({}),
    createSampler: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createTexture: () => ({ destroy() {} }),
    createBuffer: () => ({ destroy() {} }),
    queue: { writeTexture() {} },
  };

  const shared = new ctx.Shared(device, 'copy');
  await shared.ready;
  assert.deepEqual(made, ['video/copy/sdr'], '默认只编译 copy 路径的 SDR 管线');
  shared.getCopyPipeline('bgra8unorm');
  assert.deepEqual(made, ['video/copy/sdr'], '首选路径不应重复编译');
  shared.getExternalPipeline('bgra8unorm');
  assert.deepEqual(made, ['video/copy/sdr', 'video/external/sdr'], '另一条路径首次请求时才补建');
});

test('P4-2：没有媒体时不申请 GPU，出现后再启动', () => {
  const a = content.indexOf('_pageNeedsGpu() {');
  const b = content.indexOf('_watchForMedia() {', a);
  assert.ok(a > 0 && b > a);
  const block = content.slice(a, b).replace('_pageNeedsGpu()', 'function _pageNeedsGpu()');

  const has = new Set();
  const ctx = { document: { querySelector: (sel) => (has.has(sel) ? {} : null) } };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.fn = _pageNeedsGpu;', ctx);

  assert.equal(ctx.fn.call({ settings: { enhanceImages: false } }), false, '无媒体时不该启动 GPU');
  has.add('video');
  assert.equal(ctx.fn.call({ settings: { enhanceImages: false } }), true);
  has.delete('video');
  has.add('img');
  assert.equal(ctx.fn.call({ settings: { enhanceImages: false } }), false, '图片增强关闭时 img 不应触发 GPU');
  assert.equal(ctx.fn.call({ settings: { enhanceImages: true } }), true);

  assert.ok(content.includes('await this._startGpu()'), '初始化应统一走 _startGpu');
  assert.ok(content.includes('if (this._destroyed || this._recovering) return;'), '_startGpu 需幂等且不与恢复流程并发');
  assert.ok(content.includes("this._cleanupFns.push(() => {\n      this._videoWatch?.disconnect();"));
});

test('1.2.16：双层子项随开关置灰，文案与当前实现一致', () => {
  const fn = popup.match(/ {2}function updateDualState\(\) \{([\s\S]*?)\n {2}\}/);
  assert.ok(fn, 'updateDualState 应存在');
  assert.ok(/el\.dualDetail\.disabled = !on/.test(fn[1]), '双层关闭时细节增益应禁用');
  assert.ok(/el\.dualRadius\.disabled = !on/.test(fn[1]), '双层关闭时半径应禁用');
  assert.ok(/updateDualState\(\)/.test(popup.slice(popup.indexOf('function render()'))), 'render 应刷新双层子项状态');

  // 1.2.15 修复后 base 不再预压，白点不再下降 —— 旧文案必须删掉，否则前后矛盾
  assert.ok(!/白点会从 0\.99 降到约 0\.95/.test(popupHtml), '过期文案应移除');
  assert.ok(/base 与单层一致/.test(popupHtml));
  assert.ok(/只在「双层合成」开启时生效/.test(popupHtml), '细节增益需说明生效条件');
  assert.ok(/排在软膝\/高光上限之后/.test(popupHtml), '整体强度需说明作用位置');
});

test('1.2.17：SDR 提示不再冒充高光上限，上限行给出花费/额度读数', () => {
  const sdr = popup.match(/ {2}function updateSdrReadout\(\) \{([\s\S]*?)\n {2}\}/);
  assert.ok(sdr, 'updateSdrReadout 应存在');
  assert.ok(!/高光上限不会超过它/.test(popupHtml), '旧文案会让人以为与 HDR 峰值重复，必须移除');
  assert.ok(!/高光余量/.test(sdr[1]), 'SDR 提示只回答「1.0× 值多少 nits」，不承担余量说明');
  assert.ok(/1\.0× = \$\{nits\} nits/.test(sdr[1]), 'SDR 提示应给出参考白换算');
  assert.ok(/headroom < 2/.test(sdr[1]), '只有余量不足 2× 才提示夹紧');
  assert.ok(/会把高光上限压到/.test(sdr[1]), '余量不足时要说明具体压到多少');
  assert.ok(/updateCeilingReadout\(\)/.test(sdr[1]), 'SDR 刷新应联动高光上限读数');

  const ceil = popup.match(/ {2}function updateCeilingReadout\(\) \{([\s\S]*?)\n {2}\}/);
  assert.ok(ceil, 'updateCeilingReadout 应存在');
  assert.ok(/Math\.min\(2\.0, headroom\)/.test(ceil[1]), '额度计算需与 utils.js 的夹紧公式同源');
  assert.ok(/会被夹到/.test(ceil[1]), '超出额度时要说明当前值被夹紧');
  assert.ok(/HDR 源接管时不读取此值/.test(ceil[1]), 'HDR 源接管时需说明此项不参与');

  // 分组：高光上限属于「输出」，不再挂在「HDR 源」下
  const hdrStart = popupHtml.indexOf('HDR 源（AV1 / HEVC）');
  const outStart = popupHtml.indexOf('<div class="subsection-title">输出</div>');
  const baseStart = popupHtml.indexOf('<div class="subsection-title">基础参数</div>');
  assert.ok(hdrStart > 0 && outStart > hdrStart && baseStart > outStart, '分组顺序应为 HDR 源 → 输出 → 基础参数');
  assert.ok(!/id="highlight-ceiling"/.test(popupHtml.slice(hdrStart, outStart)), 'HDR 源分组不应再包含高光上限');
  assert.ok(popupHtml.indexOf('id="highlight-ceiling-hint"') > outStart, '读数行应在输出分组内');
  assert.ok(/SDR 高光上限/.test(popupHtml), '标题应改为 SDR 高光上限');
});

// ---------- 1.2.18 / P0-1：device 与 manager 必须同代 ----------
// 这组用例驱动真实方法体（vm 加载 HDRController 类），而不是断言源码字符串 ——
// 上一轮报告指出「静态正则锁实现」正是 P0-1 没被拦住的原因。
function loadControllerHarness(adapterBehaviour) {
  const a = content.indexOf('class HDRController {');
  const b = content.indexOf('const controller = new HDRController();');
  assert.ok(a > 0 && b > a, 'HDRController 类应可定位');

  const log = [];
  let seq = 0;
  const makeDevice = (tag) => ({
    tag,
    destroyed: false,
    listeners: {},
    destroy() { this.destroyed = true; log.push('device:destroy:' + tag); },
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
    lost: new Promise(() => {}),
  });

  // P2-7：可控时钟 —— 错误计数窗口与 2s 延迟重建都需要推进时间
  let clock = 0;
  const timers = [];
  const setTimeoutStub = (fn, ms) => {
    const t = { fn, at: clock + (ms || 0), id: timers.length + 1, cleared: false };
    timers.push(t);
    return t.id;
  };
  const clearTimeoutStub = (id) => {
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  };
  const advance = (ms) => {
    clock += ms;
    for (const t of timers) {
      if (!t.cleared && t.at <= clock) { t.cleared = true; t.fn(); }
    }
  };
  const fireDeviceEvent = (device, type, payload) => {
    for (const fn of (device.listeners && device.listeners[type]) || []) fn(payload);
  };

  const managerClass = (kind) => class {
    constructor(device) {
      this.device = device;
      this.kind = kind;
      this.isEnabled = false;
      this.settings = null;
      this.renderers = new Map();
      this.destroyed = false;
      log.push(kind + ':new:' + device.tag);
    }
    updateSettings(s) { this.settings = s; log.push(kind + ':update:' + (s && s.outputGain)); }
    setEnabled(v) { this.isEnabled = v; log.push(kind + ':enabled:' + v); }
    destroy() { this.destroyed = true; log.push(kind + ':destroy:' + this.device.tag); }
  };

  const VideoManager = managerClass('video');
  const ImageManager = managerClass('image');

  const ctx = {
    console,
    Promise,
    Map,
    WeakSet,
    STATUS: {
      INACTIVE: 'INACTIVE', NO_WEBGPU: 'NO_WEBGPU', SHADER_ERROR: 'SHADER_ERROR',
      ACTIVE: 'ACTIVE', SOURCE_HDR: 'SOURCE_HDR', CROSS_ORIGIN: 'CROSS_ORIGIN',
      CODEC_FAILED: 'CODEC_FAILED', NO_VIDEO: 'NO_VIDEO', DRM_PROTECTED: 'DRM_PROTECTED',
    },
    MESSAGE_TYPES: { GET_SETTINGS: 'GET_SETTINGS', SETTINGS_UPDATED: 'SETTINGS_UPDATED', GET_STATUS: 'GET_STATUS' },
    ADAPTER_OPTIONS: undefined,
    pipelineErrorHandler: null,
    CONTENT_DEPS_MISSING: [],  // P4-2：getDiagnostics 现在会带上依赖状态
    // P2-7：错误预算与延迟重建
    GPU_ERROR_LIMIT: 20,
    GPU_ERROR_WINDOW_MS: 10000,
    GPU_ERROR_RECOVERY_DELAY_MS: 2000,
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
    performance: { now: () => clock },
    // 页面必须有 video，_pageNeedsGpu() 才会放行（否则只会挂监听不启动 GPU）
    document: { querySelector: () => ({}) },
    navigator: {
      gpu: {
        requestAdapter: async () => adapterBehaviour({
          requestDevice: async () => makeDevice('new' + (++seq)),
        }),
      },
    },
    VideoManager,
    ImageManager,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(content.slice(a, b) + '\nthis.Ctrl = HDRController;', ctx);
  return { Ctrl: ctx.Ctrl, VideoManager, ImageManager, log, makeDevice, advance, timers, fireDeviceEvent };
}

test('P0-1 行为：device lost 后改设置，manager 必须重建到新 device 上', async () => {
  const h = loadControllerHarness(async (adapter) => adapter);
  const c = new h.Ctrl();
  const oldDevice = h.makeDevice('old');
  const oldVM = new h.VideoManager(oldDevice);
  oldVM.isEnabled = true;
  c.settings = { enabled: true, enhanceImages: false, outputGain: 1.0 };
  c.device = oldDevice;
  c.videoManager = oldVM;
  c._deviceLost = true;          // 首次自动恢复失败后的状态

  c._doUpdateSettings({ enabled: true, enhanceImages: false, outputGain: 1.35 });
  assert.ok(c._gpuStartPromise, '改设置应真的触发一次启动');
  await c._gpuStartPromise;
  await new Promise((r) => setTimeout(r, 0));   // 等 .then(_applySettings) 落地

  assert.equal(oldVM.destroyed, true, '绑在旧 device 上的 manager 必须被拆掉');
  assert.equal(oldDevice.destroyed, true, '失效 device 必须被释放');
  assert.ok(c.device && c.device !== oldDevice, '应换到新 device');
  assert.equal(c.videoManager.device, c.device, 'manager 必须绑定当前 device');
  assert.equal(c.videoManager.isEnabled, true, '新 manager 必须被启用');
  assert.equal(c.videoManager.settings.outputGain, 1.35, '新设置必须落到新 manager 上');
  assert.equal(c._deviceLost, false, '恢复成功后不得再标记为 lost');
});

test('P0-1 行为：_ensureManagers 发现 device 不同代时自动兜底重建', () => {
  const h = loadControllerHarness(async (adapter) => adapter);
  const c = new h.Ctrl();
  const oldDevice = h.makeDevice('old');
  const newDevice = h.makeDevice('new');
  const oldVM = new h.VideoManager(oldDevice);
  c.settings = { enabled: true, enhanceImages: false, outputGain: 1.1 };
  c.device = newDevice;
  c.videoManager = oldVM;
  c._deviceLost = false;

  assert.equal(c._ensureManagers(), true);
  assert.equal(oldVM.destroyed, true, '不同代的 manager 必须先销毁');
  assert.equal(c.videoManager.device, newDevice);
  assert.equal(c.videoManager.settings.outputGain, 1.1);
});

test('P0-1 行为：替换 device 释放旧的；申请失败时保留旧的', async () => {
  const h = loadControllerHarness(async (adapter) => adapter);
  const c = new h.Ctrl();
  const oldDevice = h.makeDevice('old');
  c.device = oldDevice;

  const next = await c._requestDevice();
  assert.ok(next && next !== oldDevice);
  assert.equal(oldDevice.destroyed, true, '旧 device 不能只被覆盖引用');

  const kept = h.makeDevice('keep');
  c.device = kept;
  const h2 = loadControllerHarness(async () => null);
  const c2 = new h2.Ctrl();
  const kept2 = h2.makeDevice('keep');
  c2.device = kept2;
  assert.equal(await c2._requestDevice(), null);
  assert.equal(c2.device, kept2, '申请失败时不能把还能用的 device 弄没');
  assert.equal(kept2.destroyed, false);
  assert.equal(c2._deviceLost, true);
});

test('P0-1 行为：恢复路径独立于「用户是否改设置」', async () => {
  const h = loadControllerHarness(async (adapter) => adapter);
  const c = new h.Ctrl();
  const oldDevice = h.makeDevice('old');
  const oldVM = new h.VideoManager(oldDevice);
  c.settings = { enabled: true, enhanceImages: false, outputGain: 1.0 };
  c.device = oldDevice;
  c.videoManager = oldVM;

  await c._handleDeviceLost({ reason: 'unknown', message: 'injected' });

  assert.ok(c.device && c.device !== oldDevice, '不依赖改设置也应换到新 device');
  assert.equal(c.videoManager.device, c.device);
  assert.equal(c._deviceLost, false);
  assert.equal(c._recovering, false, '恢复流程必须复位，否则后续再也不会重试');
});

test('P0-1：恢复失败后仍可重试，且状态不谎报 ACTIVE', async () => {
  const h = loadControllerHarness(async () => null);   // 拿不到 adapter
  const c = new h.Ctrl();
  const oldDevice = h.makeDevice('old');
  const oldVM = new h.VideoManager(oldDevice);
  c.settings = { enabled: true, enhanceImages: false, outputGain: 1.0 };
  c.device = oldDevice;
  c.videoManager = oldVM;

  await c._handleDeviceLost({ reason: 'unknown', message: 'injected' });
  assert.equal(c._deviceLost, true);
  assert.equal(c.videoManager, null, '恢复失败时不能留着继续用失效 device 的渲染器');
  assert.ok(c.getStatus() === 'NO_WEBGPU', '恢复失败不得报 ACTIVE');

  const ok = loadControllerHarness(async (adapter) => adapter);
  const c2 = new ok.Ctrl();
  c2.settings = { enabled: true, enhanceImages: false, outputGain: 1.0 };
  c2.device = ok.makeDevice('old');
  c2._deviceLost = true;
  c2._doUpdateSettings({ enabled: true, enhanceImages: false, outputGain: 1.0 });
  await c2._gpuStartPromise;
  assert.equal(c2._deviceLost, false, '后续任意一次触发都应能恢复');
  assert.ok(c2.videoManager && c2.videoManager.device === c2.device);
});

// ---------- 1.2.19 / Stage 1 P1：行为测试（驱动真实方法体，不锁源码字符串） ----------
function loadRenderRuntime() {
  const noop = () => {};
  class FakeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  const ctx = {
    console: { log: noop, info: noop, warn: noop, error: noop },
    Promise, Map, Set, WeakSet, WeakMap, Math, Object, Array, JSON,
    String, Number, Boolean, Error, TypeError, Float32Array, Uint16Array, Uint8Array, Date,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: {
      createElement: () => ({ style: {}, getContext: () => null }),
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: noop,
      body: null,
      documentElement: null,
    },
    window: {},
    navigator: { platform: 'Win32', gpu: null },
    MutationObserver: FakeObserver,
    IntersectionObserver: FakeObserver,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    GPUBufferUsage: {}, GPUShaderStage: {}, GPUMapMode: {},
    VideoFrame: class { close() {} },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // settings-schema 也进 bundle：utils 的 clampUnit 直接读 HDRSettings.RANGES，
  // 保证测试里跑的是与线上同一张范围表。
  const bundle = [
    '../shared/settings-schema.js', 'core.js', 'shaders.js', 'utils.js', 'tone-lut.js',
    'shared-resources.js', 'renderers.js', 'managers.js',
  ].map((name) => read('src/content/' + name)).join('\n');
  vm.runInContext(
    bundle + '\nthis.__R = { VideoRenderer, ImageRenderer, VideoManager, ImageManager, ' +
      'SharedVideoResources, SharedImageResources, isDRMProtected, STATUS, HDRSettings, ' +
      'computeUniformData, U, UNIFORM_FLOATS };',
    ctx
  );
  ctx.__R.ctx = ctx;
  return ctx.__R;
}

function makeVideoRendererStub(R, overrides) {
  const fake = Object.create(R.VideoRenderer.prototype);
  Object.assign(fake, {
    video: { currentSrc: 'https://a/1.mp4', src: '', readyState: 4, videoWidth: 1920, videoHeight: 1080 },
    settings: { capturePath: 'auto', cropTopPx: 0, hdrSourceMode: 'auto' },
    probe: { padded: false, isHDR: false, bt2020: false },
    hdrMode: 0,
    sourceIsHDR: false,
    failed: false,
    destroyed: false,
    // P2-6：vm 里不会跑 constructor，失败跟踪字段要显式补齐
    _consecutiveFailures: 0,
    _failureSince: 0,
    _backoffUntil: 0,
    _backoffCount: 0,
    _hasRenderedOnce: false,
    _manualCrop: 0,
    _cropTopPx: 0,
    _cropDetected: true,
    _cropSrcKey: 'https://a/1.mp4',
    _autoSnapshot: false,
    useExternalTexture: true,
    nijiLucidCanvas: null,
    _calibrated: true,
    _calibrationFallback: true,
    _calibrationAttempts: 2,
    _calibrationTimer: null,
    _calibrationRetryMs: 1,
    shared: { getExternalLayout: () => 'ext', getCopyLayout: () => 'copy' },
    _configureCanvas() {},
    _updateCanvasSize() {},
    _updateUniformBuffer() {},
    _detectTopGreenBand: () => 0,
    destroy() { this.destroyed = true; },
  }, overrides || {});
  return fake;
}

test('P1-1 行为：换集后重新检测，上一集的裁切与快照路径不会残留', () => {
  const R = loadRenderRuntime();
  const calls = [];
  const fake = makeVideoRendererStub(R, {
    // 上一集检出 8 行绿条：裁 8 行 + 强制快照路径
    _cropTopPx: 8,
    _autoSnapshot: true,
    useExternalTexture: false,
    _configureCanvas: () => calls.push('configure'),
    _updateCanvasSize: () => calls.push('size'),
    _updateUniformBuffer: () => calls.push('uniform'),
  });

  // 切集：新片源没有绿边
  fake.video.currentSrc = 'https://a/2.mp4';
  assert.equal(fake._syncSourceState(), true);
  assert.equal(fake._cropTopPx, 0, '新片源没有绿边时不能继续裁 8 行');
  assert.equal(fake._autoSnapshot, false, '裁切专用的快照路径要撤回');
  assert.equal(fake.useExternalTexture, true, '应回到零拷贝 external 路径');
  assert.equal(fake._cropSrcKey, 'https://a/2.mp4');
  assert.equal(fake._calibrated, false, '新片源需要重新校准');
  assert.equal(fake._calibrationFallback, false);
  assert.deepEqual(calls, ['configure', 'size', 'uniform']);

  // 同一片源的后续帧不应重复触发
  const before = calls.length;
  fake._syncSourceState();
  assert.equal(calls.length, before, '同源帧不得反复重配画布');
});

test('P1-1 行为：新片源自带绿边时重新裁切并切到快照路径', () => {
  const R = loadRenderRuntime();
  const fake = makeVideoRendererStub(R, {
    _detectTopGreenBand: () => 8,
    useExternalTexture: true,
  });
  fake.video.currentSrc = 'https://a/3.mp4';
  fake._syncSourceState();
  assert.equal(fake._cropTopPx, 8);
  assert.equal(fake._autoSnapshot, true);
  assert.equal(fake.useExternalTexture, false, '裁切只能在快照路径里做');
});

test('P1-2 行为：图片渲染失败必须走完整销毁并回调 manager', () => {
  const R = loadRenderRuntime();
  const released = [];
  const img = { style: { opacity: '1' }, removeEventListener() {} };
  const fake = Object.create(R.ImageRenderer.prototype);
  Object.assign(fake, {
    destroyed: false,
    failed: false,
    image: img,
    texture: null,
    canvas: null,
    context: null,
    uniformBuffer: null,
    container: null,
    resizeObserver: null,
    _positionAcquired: false,
    _canvasWatchTimer: null,
    _drawBindGroup: null,
    _drawBindGroupTexture: null,
    _drawUniformData: null,
    onDestroyed: (r) => released.push(r),
  });

  fake._fail();

  assert.equal(fake.failed, true);
  assert.equal(fake.destroyed, true, '失败必须真正销毁，否则 manager 永远拿不到 onDestroyed');
  assert.equal(released.length, 1, '必须且只能回调一次（预算/tier 名额靠它归还）');
  assert.equal(released[0], fake);
  assert.equal(img.style.opacity, '1', '原图片必须恢复可见');
  assert.equal(fake.onDestroyed, null, '回调后清空，避免重复归还');
});

test('P1-3 行为：共享探测排队执行，后来者不再被丢弃', async () => {
  const R = loadRenderRuntime();
  const shared = Object.create(R.SharedVideoResources.prototype);
  shared._probeChain = Promise.resolve();

  const order = [];
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = shared.withProbeLock(async () => {
    order.push('a:start');
    await gate;
    order.push('a:end');
  });
  const second = shared.withProbeLock(async () => { order.push('b:start'); });

  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(order, ['a:start'], '第二个探测必须等第一个完成，而不是直接放弃');

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start']);
});

test('P1-3 行为：探测没结论时退避重试，不会一次判死', async () => {
  const R = loadRenderRuntime();
  let calls = 0;
  const fake = makeVideoRendererStub(R, {
    hdrMode: 2,
    _calibrated: false,
    _calibrationFallback: false,
    _calibrationAttempts: 0,
    _probeFrameStats: async () => {
      calls++;
      return calls < 3 ? null : { above: 0.5 };
    },
  });

  await fake._calibrateHDRSource();
  assert.equal(fake._calibrated, false, '拿不到结论不能标记为已校准');

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 3);
  assert.equal(fake._calibrated, true);
  assert.equal(fake.hdrMode, 0, '50% 像素超出白点 → 回退 SDR');
  assert.equal(fake._calibrationFallback, true);
});

test('P1-3 行为：重试有上限，避免无限定时器', async () => {
  const R = loadRenderRuntime();
  let calls = 0;
  const fake = makeVideoRendererStub(R, {
    hdrMode: 2,
    _calibrated: false,
    _calibrationAttempts: 0,
    _probeFrameStats: async () => { calls++; return null; },
  });

  await fake._calibrateHDRSource();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 5, '首次 + CALIBRATION_MAX_RETRIES(4) 次重试后停止');
  assert.equal(fake._calibrated, true, '放弃时也要收敛，防止无限重试');
  assert.equal(fake._calibrationTimer, null);
});

test('P1-5 行为：DRM 视频不建渲染器，并计入 drmProtectedCount', () => {
  const R = loadRenderRuntime();
  const mgr = Object.create(R.VideoManager.prototype);
  Object.assign(mgr, {
    isEnabled: true,
    shaderReady: true,
    renderers: new Map(),
    observed: new WeakSet(),
    drmProtectedCount: 0,
    crossOriginCount: 0,
    failedCodecCount: 0,
    _loggedDRM: false,
    settings: { hdrSourceMode: 'auto' },
    shared: {},
    minArea: 1,
    intersectionObserver: { observe() {} },
  });

  const video = {
    mediaKeys: { keySystem: 'com.widevine.alpha' },
    videoWidth: 1920, videoHeight: 1080, readyState: 4,
    currentSrc: 'https://drm.example/a.mpd',
  };
  R.VideoManager.prototype._activate.call(mgr, video);

  assert.equal(mgr.drmProtectedCount, 1);
  assert.equal(mgr.crossOriginCount, 0, 'DRM 不应被误计为跨域');
  assert.equal(mgr.renderers.size, 0, '受保护内容不得创建渲染器（否则黑帧盖原视频）');
  assert.ok(mgr.observed.has(video));
  assert.equal(R.isDRMProtected({ mediaKeys: {} }), true);
  assert.equal(R.isDRMProtected({ mediaKeys: null }), false);
  assert.equal(R.isDRMProtected(null), false);
});

test('P1-5 行为：状态优先上报 drm_protected，而不是谎报未激活', () => {
  const h = loadControllerHarness(async (adapter) => adapter);
  const c = new h.Ctrl();
  c.settings = { enabled: true };
  c.device = h.makeDevice('d');
  c.videoManager = {
    renderers: new Map(),
    detectedVideoCount: 2,
    detectedHDRCount: 0,
    drmProtectedCount: 1,
    crossOriginCount: 0,
    failedCodecCount: 0,
  };
  c.imageManager = null;
  assert.equal(c.getStatus(), 'DRM_PROTECTED');

  c.videoManager.drmProtectedCount = 0;
  c.videoManager.crossOriginCount = 1;
  assert.equal(c.getStatus(), 'CROSS_ORIGIN');
});

test('P1-5 行为：播放中途出现 encrypted 事件会停止增强且只销毁一次', () => {
  const R = loadRenderRuntime();
  let destroyed = 0;
  const fake = Object.create(R.VideoRenderer.prototype);
  Object.assign(fake, {
    destroyed: false,
    drmProtected: false,
    destroy() { destroyed++; this.destroyed = true; },
  });

  fake._abortForDRM('encrypted 事件');
  assert.equal(fake.drmProtected, true);
  assert.equal(destroyed, 1, '必须立刻交回原视频，而不是继续盖黑帧');

  fake._abortForDRM('encrypted 事件');
  assert.equal(destroyed, 1, '已销毁后不得重复销毁');
});

// ---------- Stage 3（1.2.20）：性能 ----------
test('P1-4：默认取帧改为 auto，v14 配置迁移时同步抬升', () => {
  assert.equal(S.DEFAULT_SETTINGS.capturePath, 'auto');
  // v7 写入的 snapshot 是默认值而非用户选择，v15 统一抬到 auto
  const s = S.migrateSettings({
    _version: 14, capturePath: 'snapshot', cropTopPx: 0,
    presetByMode: { power: 'standard', bt2446a: 'highDynamic' },
    bt2446a: { targetWhite: 1.4, targetMid: 0.5, saturation: 1.1, exposure: 0 },
  });
  assert.equal(s.capturePath, 'auto');
  // 用户手选的兼容档位不能被覆盖
  for (const keep of ['copy', 'import']) {
    assert.equal(S.migrateSettings({ _version: 14, capturePath: keep }).capturePath, keep);
  }
  // 幂等：再迁一次仍是 auto
  assert.equal(S.migrateSettings(s).capturePath, 'auto');
});

test('P2-11 行为：快照按目标尺寸绘制，裁切与缩放同时生效', () => {
  const R = loadRenderRuntime();
  const draws = [];
  R.ctx.document.createElement = () => ({
    style: {}, width: 0, height: 0,
    getContext: () => ({ drawImage: (...args) => draws.push(args) }),
  });
  const video = { videoWidth: 3840, videoHeight: 2160 };
  const fake = makeVideoRendererStub(R, {
    video,
    settings: { capturePath: 'snapshot', cropTopPx: 0, renderScale: 0.5 },
    _cropTopPx: 0,
    nijiLucidCanvas: null,
  });

  const snap = fake._snapshotToCanvas();
  assert.deepEqual([snap.w, snap.h], [1920, 1080], '4K + 0.5 缩放应只分配 1080p 画布');
  assert.equal(fake._snapshotCanvas.width, 1920);
  assert.equal(draws.length, 1);
  // drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh)
  assert.deepEqual(draws[0].slice(1), [0, 0, 3840, 2160, 0, 0, 1920, 1080]);

  // 带顶部裁切时：源区域少 8 行，输出仍是目标尺寸
  fake._cropTopPx = 8;
  fake._snapshotToCanvas();
  assert.deepEqual(draws[1].slice(1), [0, 8, 3840, 2152, 0, 0, 1920, 1080]);
});

test('P2-11：estimateTextureBytes 只算自己分配的纹理', () => {
  const R = loadRenderRuntime();
  const video = { videoWidth: 3840, videoHeight: 2160 };
  const base = { video, settings: { capturePath: 'auto', renderScale: 1 }, nijiLucidCanvas: null };

  const external = makeVideoRendererStub(R, { ...base, useExternalTexture: true, hdrMode: 1 });
  assert.equal(external.estimateTextureBytes(), 0, 'external 零拷贝不占自有纹理');

  const snapSdr = makeVideoRendererStub(R, {
    ...base, useExternalTexture: false, hdrMode: 0, _autoSnapshot: true,
  });
  assert.equal(snapSdr.estimateTextureBytes(), 3840 * 2160 * 4, '快照 SDR 按目标尺寸 × 4B');

  const copyHdr = makeVideoRendererStub(R, {
    ...base, useExternalTexture: false, hdrMode: 2, _autoSnapshot: false,
  });
  assert.equal(copyHdr.estimateTextureBytes(), 3840 * 2160 * 8, '直拷 HDR 按源尺寸 × 8B');
});

test('P2-11 行为：纹理预算准入与拒绝后的退避', () => {
  const R = loadRenderRuntime();
  const MB = 1024 * 1024;
  const mgr = Object.create(R.VideoManager.prototype);
  Object.assign(mgr, {
    renderers: new Map(),
    _textureBytes: 0,
    observed: new WeakSet(),
    intersectionObserver: { unobserve() {} },
    _loggedBudget: false,
    _budgetRetryTimer: null,
    isEnabled: true,
    _scanDebounce: null,
    scheduleScan() { mgr.scanCalls = (mgr.scanCalls || 0) + 1; },
  });
  const mk = (bytes) => ({ estimateTextureBytes: () => bytes });

  assert.equal(mgr._admitRenderer(mk(400 * MB)), true, '空页面允许第一个超大视频');
  mgr.renderers.set('a', mk(300 * MB));
  assert.equal(mgr._recountTextureBytes(), 300 * MB);
  assert.equal(mgr._admitRenderer(mk(50 * MB)), false, '300+50 超 320MB 预算');
  assert.equal(mgr._admitRenderer(mk(10 * MB)), true);

  const video = {};
  let destroyed = 0;
  mgr._rejectForBudget(video, { destroy() { destroyed++; } });
  assert.equal(destroyed, 1);
  assert.equal(mgr.observed.has(video), false, '拒绝后必须退回观察队列，否则永不重试');
  assert.ok(video.__hdrBudgetUntil > Date.now(), '需留出退避时间，避免每轮扫描都建/拆一次');
  assert.ok(mgr._budgetRetryTimer, '应安排一次延迟重扫');
  clearTimeout(mgr._budgetRetryTimer);
});

test('P2-10 行为：未加载完的图片只挂一次 load 监听', () => {
  const R = loadRenderRuntime();
  const handlers = [];
  const imgs = [{
    complete: false,
    naturalWidth: 0,
    isConnected: true,
    addEventListener(type, fn) { if (type === 'load') handlers.push(fn); },
  }];
  R.ctx.document.querySelectorAll = () => imgs;

  const mgr = Object.create(R.ImageManager.prototype);
  Object.assign(mgr, {
    isEnabled: true,
    shaderReady: true,
    observed: new WeakSet(),
    renderers: new Map(),
    pending: new Set(),
    intersectionObserver: null,
    _maybeObserve() { mgr.observedCalls = (mgr.observedCalls || 0) + 1; },
  });

  mgr.scan();
  mgr.scan();
  mgr.scan();
  assert.equal(handlers.length, 1, '三次扫描只能挂一个 load 回调');

  handlers[0]();
  assert.equal(mgr.observedCalls, 1, 'load 后应尝试纳入观察');
  assert.equal(imgs[0].__hdrLoadHooked, false, '回调触发后释放标记');
});

test('P2-7 行为：GPU 校验错误超限后停用并延迟重建一次', async () => {
  const h = loadControllerHarness(async (adapter) => adapter);
  const c = new h.Ctrl();
  c.settings = { enabled: true, enhanceImages: true, outputGain: 1 };
  await c._startGpu();
  const device = c.device;
  assert.ok(device, '应先拿到 device');
  assert.equal(device.listeners.uncapturederror.length, 1, 'device 级错误只挂一个监听');

  const fire = () => h.fireDeviceEvent(device, 'uncapturederror', { error: { message: 'boom' } });

  // 时间窗内 19 次不该触发（预算是 20）
  for (let i = 0; i < 19; i++) fire();
  assert.equal(c.videoManager.isEnabled, true);
  assert.equal(c._pipelineError, null);

  fire();
  assert.equal(c._pipelineError, 'runtime：GPU 校验错误过多');
  assert.equal(c.videoManager.isEnabled, false, '超限后先整体停用，不再提交绘制');
  assert.equal(c.getStatus(), 'SHADER_ERROR', '状态要如实显示错误，而不是未激活');
  const pending = h.timers.filter((t) => !t.cleared);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].at, 2000, '延迟 2s 再重建');

  h.advance(2000);
  assert.equal(c._pipelineError, null, '重建成功后清掉错误');
  assert.ok(c.videoManager && c.videoManager.isEnabled, '重建后恢复增强');
  assert.equal(c.videoManager.device, device, '只重建管线，不换 device');

  // 同一 device 代际只自愈一次：再次超限就真正停用
  for (let i = 0; i < 20; i++) fire();
  assert.equal(c.videoManager.isEnabled, false);
  assert.equal(h.timers.length, 1, '不得再安排第二次重建');
});

test('P2-7 行为：错误计数按时间窗衰减，偶发错误不累积成停用', async () => {
  const h = loadControllerHarness(async (adapter) => adapter);
  const c = new h.Ctrl();
  c.settings = { enabled: true, enhanceImages: false, outputGain: 1 };
  await c._startGpu();
  const fire = () => h.fireDeviceEvent(c.device, 'uncapturederror', { error: { message: 'x' } });

  for (let i = 0; i < 19; i++) fire();
  h.advance(11000);          // 超出 10s 窗口 → 计数清零
  for (let i = 0; i < 19; i++) fire();
  assert.equal(c._pipelineError, null);
  assert.equal(c.videoManager.isEnabled, true, '跨窗口的偶发错误不应触发停用');
});

// ---------- Stage 2（1.2.21）：健壮性与一致性 ----------

function makeWild(seed) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  // 覆盖正负、0 附近与 1e9 量级
  return () => (rand() < 0.5 ? -1 : 1) * (rand() * 1e9 + rand());
}

test('P2-5：滑杆范围只来自 RANGES，HTML 不再硬编码 min/max', () => {
  assert.ok(S.RANGES && typeof S.clampField === 'function');
  assert.ok(!/(^|\s)(min|max|step)=/.test(popupHtml), 'popup.html 不得再写死 min/max/step');
  const keys = [...popupHtml.matchAll(/data-range="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(keys.length, 21, '21 个数值控件都应带 data-range（含推荐弹层两个输入）');
  for (const key of keys) assert.ok(S.RANGES[key], 'RANGES 缺少 ' + key);
  assert.ok(popup.includes('function applyRanges()'));
  // 必须在 render() 读 min/max 之前注入
  assert.ok(/async function init\(\) \{\s*applyRanges\(\);/.test(popup));
});

test('P2-5：默认值与预设都落在 RANGES 内', () => {
  const d = S.DEFAULT_SETTINGS;
  const pairs = [
    ['sdrSliderPercent', d.sdrSliderPercent], ['hdrPeakNits', d.hdrPeakNits],
    ['cropTopPx', d.cropTopPx], ['highlightCeiling', d.highlightCeiling],
    ['outputGain', d.outputGain], ['renderScale', d.renderScale],
    ['exposure', d.bt2446a.exposure], ['saturation', d.bt2446a.saturation],
    ['targetWhite', d.bt2446a.targetWhite], ['targetMid', d.bt2446a.targetMid],
    ['peakBrightness', d.powerCurve.peakBrightness], ['maxBoost', d.powerCurve.maxBoost],
    ['brightnessThreshold', d.powerCurve.brightnessThreshold],
    ['shadowThreshold', d.powerCurve.shadowThreshold],
    ['shadowCrush', d.powerCurve.shadowCrush],
    ['dualRadius', d.dualLayer.radius], ['dualDetail', d.dualLayer.detail],
    ['dualSplit', d.dualLayer.split], ['dualSoft', d.dualLayer.soft],
    ['debandThreshold', d.deband.threshold], ['sharpenStrength', d.sharpen.strength],
  ];
  for (const [key, value] of pairs) {
    const r = S.RANGES[key];
    assert.ok(value >= r.min && value <= r.max, key + ' 默认值越界: ' + value);
  }
  for (const [name, preset] of Object.entries(S.BT2446A_PRESETS)) {
    const st = preset.settings;
    for (const key of ['exposure', 'saturation', 'targetWhite', 'targetMid']) {
      const r = S.RANGES[key];
      assert.ok(st[key] >= r.min && st[key] <= r.max, name + '.' + key + ' 越界');
    }
  }
});

test('P2-4 属性：±1e9 随机输入归一化后必落在 RANGES 内', () => {
  const wild = makeWild(20261124);
  const reach = {
    renderScale: (n) => n.renderScale,
    sdrSliderPercent: (n) => n.sdrSliderPercent,
    hdrPeakNits: (n) => n.hdrPeakNits,
    cropTopPx: (n) => n.cropTopPx,
    highlightCeiling: (n) => n.highlightCeiling,
    outputGain: (n) => n.outputGain,
    exposure: (n) => n.bt2446a.exposure,
    saturation: (n) => n.bt2446a.saturation,
    targetWhite: (n) => n.bt2446a.targetWhite,
    targetMid: (n) => n.bt2446a.targetMid,
    peakBrightness: (n) => n.powerCurve.peakBrightness,
    maxBoost: (n) => n.powerCurve.maxBoost,
    brightnessThreshold: (n) => n.powerCurve.brightnessThreshold,
    shadowThreshold: (n) => n.powerCurve.shadowThreshold,
    shadowCrush: (n) => n.powerCurve.shadowCrush,
    dualRadius: (n) => n.dualLayer.radius,
    dualDetail: (n) => n.dualLayer.detail,
    dualSplit: (n) => n.dualLayer.split,
    dualSoft: (n) => n.dualLayer.soft,
    debandThreshold: (n) => n.deband.threshold,
    sharpenStrength: (n) => n.sharpen.strength,
  };

  for (let i = 0; i < 200; i++) {
    const n = S.normalizeSettings({
      renderScale: wild(),
      sdrSliderPercent: wild(),
      hdrPeakNits: wild(),
      cropTopPx: wild(),
      highlightCeiling: wild(),
      outputGain: wild(),
      powerCurve: {
        exposure: wild(), saturation: wild(), peakBrightness: wild(),
        brightnessThreshold: wild(), maxBoost: wild(),
        shadowThreshold: wild(), shadowCrush: wild(),
      },
      bt2446a: {
        exposure: wild(), saturation: wild(), targetWhite: wild(), targetMid: wild(),
      },
      dualLayer: { radius: wild(), detail: wild(), split: wild(), soft: wild() },
      deband: { threshold: wild() },
      sharpen: { strength: wild() },
    });

    for (const [key, get] of Object.entries(reach)) {
      const r = S.RANGES[key];
      const v = get(n);
      assert.ok(Number.isFinite(v), key + ' 必须是有限值，实际 ' + v);
      assert.ok(v >= r.min && v <= r.max, key + ' 越界: ' + v);
    }
    // 最危险的一条：exposure 1e9 → Math.pow(2, 1e9) = Infinity → 整屏白
    assert.ok(Number.isFinite(Math.pow(2, n.bt2446a.exposure)));
  }
});

test('P2-4：非数值 / NaN / 字符串一律退回默认值', () => {
  const d = S.DEFAULT_SETTINGS;
  const n = S.normalizeSettings({
    renderScale: 'huge',
    sdrSliderPercent: null,
    hdrPeakNits: NaN,
    powerCurve: { exposure: Infinity, maxBoost: '9', shadowCrush: -Infinity },
    dualLayer: { radius: undefined, detail: null },
    deband: { threshold: '0.5' },
    sharpen: { strength: NaN },
  });
  assert.equal(n.renderScale, d.renderScale);
  assert.equal(n.sdrSliderPercent, d.sdrSliderPercent);
  assert.equal(n.hdrPeakNits, d.hdrPeakNits);
  assert.equal(n.powerCurve.exposure, d.powerCurve.exposure);
  assert.equal(n.powerCurve.maxBoost, d.powerCurve.maxBoost);
  assert.equal(n.powerCurve.shadowCrush, d.powerCurve.shadowCrush);
  assert.equal(n.dualLayer.radius, d.dualLayer.radius);
  assert.equal(n.dualLayer.detail, d.dualLayer.detail);
  assert.equal(n.deband.threshold, d.deband.threshold);
  assert.equal(n.sharpen.strength, d.sharpen.strength);
});

test('P2-4 行为：computeUniformData 对越界值兜底夹紧', () => {
  const R = loadRenderRuntime();
  const settings = S.deepClone(S.DEFAULT_SETTINGS);
  settings.mappingMode = 'bt2446a';
  settings.bt2446a.exposure = 1e9;
  settings.bt2446a.saturation = 1e9;
  settings.powerCurve.maxBoost = 1e9;
  settings.powerCurve.peakBrightness = 1e9;
  settings.deband.threshold = 1e9;
  settings.dualLayer.radius = 1e9;
  settings.hdrPeakNits = 1e9;
  settings.outputGain = 1e9;

  const out = new Float32Array(R.UNIFORM_FLOATS);
  R.computeUniformData(settings, 1920, 1080, 1 / 1920, 1 / 1080, 0, null, out, {
    outputIsHDR: false, hdrMode: 0,
  });

  assert.equal(out[R.U.exposureMultiplier], 4, '2^1e9 必须夹到 2^2');
  assert.ok(Number.isFinite(out[R.U.peakBrightness]));
  // Float32Array 有精度损失（0.03 → 0.0299999993），用容差比较
  const near = (actual, expected, label) =>
    assert.ok(Math.abs(actual - expected) < 1e-6, label + ' 期望 ' + expected + '，实际 ' + actual);
  near(out[R.U.maxBoost], S.RANGES.maxBoost.max, 'maxBoost');
  near(out[R.U.debandThreshold], S.RANGES.debandThreshold.max, 'debandThreshold');
  near(out[R.U.dualLayerRadius], S.RANGES.dualRadius.max, 'dualRadius');
  near(out[R.U.displayPeakNits], S.RANGES.hdrPeakNits.max, 'hdrPeakNits');
  near(out[R.U.outputGain], S.RANGES.outputGain.max, 'outputGain');
  for (let i = 0; i < out.length; i++) {
    assert.ok(Number.isFinite(out[i]), 'uniform[' + i + '] 不能是 NaN/Infinity');
  }
});

test('P2-2 行为：管线编译失败回滚标记，最多重试一次', async () => {
  const R = loadRenderRuntime();
  let calls = 0;
  const fake = Object.create(R.SharedVideoResources.prototype);
  Object.assign(fake, {
    device: {
      createRenderPipelineAsync: async () => {
        calls++;
        throw new Error('driver reset');
      },
    },
    _sdrFormat: 'rgba8unorm',
    shaderModuleExternal: {}, shaderModuleCopy: {},
    pipelineLayoutExternal: {}, pipelineLayoutCopy: {},
    pipelineSDRExt: null, pipelineHDRExt: null,
    pipelineSDRCopy: null, pipelineHDRCopy: null,
    _built: { external: false, copy: false },
    _buildPromises: { external: null, copy: null },
    _buildRetries: { external: 0, copy: 0 },
    _disposed: false,
  });

  await fake._buildPath('external');
  assert.equal(calls, 1);
  assert.equal(fake._built.external, false, '首次失败必须回滚，否则该路径本页永久不可用');
  assert.equal(fake._buildPromises.external, null, '失败结果不得被缓存');
  assert.equal(fake._buildRetries.external, 1);

  await fake._buildPath('external');
  assert.equal(calls, 2, '第二次仍应尝试');
  assert.equal(fake._built.external, true, '两次都失败后停止重试');
  assert.equal(fake._buildRetries.external, 2);

  await fake._buildPath('external');
  assert.equal(calls, 2, '不得无限重编译');
});

test('P2-3 行为：图片 shared 销毁后异步编译结果不再落地', async () => {
  const R = loadRenderRuntime();
  const fake = Object.create(R.SharedImageResources.prototype);
  Object.assign(fake, {
    device: { createRenderPipelineAsync: async () => ({ tag: 'pipeline' }) },
    shaderModule: {},
    pipelineLayout: {},
    _sdrFormat: 'rgba8unorm',
    pipelineSDR: null,
    pipelineHDR: null,
    _disposed: true,
  });
  await fake._buildPipelines();
  assert.equal(fake.pipelineSDR, null, 'destroy 之后的编译结果必须被丢弃');
});

test('P2-12 行为：恢复原视频时写回站点自己的 opacity', () => {
  const R = loadRenderRuntime();
  const video = { style: { opacity: '0' }, removeEventListener() {} };
  const fake = makeVideoRendererStub(R, {
    video,
    isRendering: true,
    videoFrameCallbackId: null,
    animationFrameId: null,
    _isFramePending: false,
    _stopCanvasWatch() {},
    _originalOpacity: '0',
    _opacitySaved: true,
  });
  fake.stopRendering();
  assert.equal(video.style.opacity, '0', '站点本来隐藏的视频不得被强制显示');

  const site = { style: { opacity: '0.5' }, removeEventListener() {} };
  const untouched = makeVideoRendererStub(R, {
    video: site,
    isRendering: true,
    videoFrameCallbackId: null,
    animationFrameId: null,
    _isFramePending: false,
    _stopCanvasWatch() {},
    _originalOpacity: null,
    _opacitySaved: false,
  });
  untouched.stopRendering();
  assert.equal(site.style.opacity, '0.5', '没改过就不能动站点的内联样式');

  // 记录必须发生在第一次改写之前
  const block = content.match(/if \(!this\._hasRenderedOnce\) \{[\s\S]*?\n {6}\}/)[0];
  assert.ok(block.indexOf('_originalOpacity = this.video.style.opacity') > -1);
  assert.ok(block.indexOf('_originalOpacity = this.video.style.opacity') <
    block.indexOf("this.video.style.opacity = '0'"));
});

test('P2-12 行为：图片销毁同样还原原值', () => {
  const R = loadRenderRuntime();
  const img = { style: { opacity: '0' }, removeEventListener() {} };
  const fake = Object.create(R.ImageRenderer.prototype);
  Object.assign(fake, {
    destroyed: false,
    image: img,
    texture: null,
    canvas: null,
    context: null,
    uniformBuffer: null,
    container: null,
    resizeObserver: null,
    _positionAcquired: false,
    _opacitySaved: true,
    _originalOpacity: '0',
    _stopCanvasWatch() {},
    onDestroyed: null,
  });
  fake.destroy();
  assert.equal(img.style.opacity, '0');
  assert.equal(fake._opacitySaved, false);
});

test('P2-1 行为：hdrMode 变化时解除 copy 纹理格式锁', () => {
  const R = loadRenderRuntime();
  const fake = makeVideoRendererStub(R, {
    hdrMode: 0,
    _copyFormatLocked: 'rgba8unorm',
    _copyBindGroup: { tag: 'bind' },
    _copyBindGroupTexture: { tag: 'texture' },
    settings: {
      capturePath: 'auto', cropTopPx: 0, hdrSourceMode: 'off',
      canvasMode: 'auto', renderScale: 1, mappingMode: 'bt2446a',
    },
  });

  fake.updateSettings({ ...fake.settings, hdrSourceMode: 'pq' });
  assert.equal(fake.hdrMode, 1);
  assert.equal(fake._copyFormatLocked, null, '接管 PQ 后必须允许 rgba16float 承接 10bit');
  assert.equal(fake._copyBindGroup, null);

  // 反向也要解锁：16float 纹理在纯 SDR 下没必要继续占双倍显存
  fake._copyFormatLocked = 'rgba16float';
  fake.updateSettings({ ...fake.settings, hdrSourceMode: 'off' });
  assert.equal(fake.hdrMode, 0);
  assert.equal(fake._copyFormatLocked, null);
});

// ---------- Stage 2.5（1.2.22）：剩余健壮性项 ----------

function makeClockContext(R, start = 1000) {
  let now = start;
  R.ctx.Date = { now: () => now };
  return {
    advance: (ms) => { now += ms; },
    now: () => now,
  };
}

test('P2-6 行为：已成功过的视频需连续失败且超过 3s 才停止', () => {
  const R = loadRenderRuntime();
  const clock = makeClockContext(R);
  const fake = makeVideoRendererStub(R, { _hasRenderedOnce: true });

  for (let i = 0; i < 90; i++) assert.equal(fake._noteRenderFailure(), true);
  assert.equal(fake.destroyed, false, '90 帧但还在 3s 时间窗内，不应误杀');

  clock.advance(3001);
  assert.equal(fake._noteRenderFailure(), false);
  assert.equal(fake.destroyed, true, '连续失败超过 3s 才停止');
});

test('P2-6 行为：首帧前失败走指数退避，不是 1.5s 永久 destroy', () => {
  const R = loadRenderRuntime();
  const clock = makeClockContext(R);
  let uniformCalls = 0;
  const fake = makeVideoRendererStub(R, {
    _hasRenderedOnce: false,
    device: { queue: {} },
    context: {},
    pipeline: {},
    canvas: { width: 1920, height: 1080 },
    _updateUniformBuffer: () => { uniformCalls++; },
  });

  for (let i = 0; i < 90; i++) assert.equal(fake._noteRenderFailure(), true);
  assert.equal(fake.destroyed, false);
  assert.equal(fake._backoffCount, 1);
  assert.equal(fake._backoffUntil, clock.now() + 500, '首档退避 500ms');
  assert.equal(fake._consecutiveFailures, 45, '半开计数，避免每帧推高指数');

  const before = uniformCalls;
  assert.equal(fake._renderFrame(), false);
  assert.equal(uniformCalls, before, '退避窗口内不提交任何绘制');

  clock.advance(501);
  fake._renderFrame();
  assert.ok(uniformCalls > before, '退避结束后恢复尝试');

  // 六档之后才真正放弃
  for (let k = 0; k < 6; k++) {
    clock.advance(9000);
    fake._consecutiveFailures = 90;
    fake._failureSince = clock.now() - 4000;
    assert.equal(fake._noteRenderFailure(), k < 5);
  }
  assert.equal(fake.destroyed, true);
});

test('P2-6 行为：换源与成功后清空失败/退避状态', () => {
  const R = loadRenderRuntime();
  makeClockContext(R);
  const fake = makeVideoRendererStub(R, {
    _consecutiveFailures: 80,
    _failureSince: 1,
    _backoffUntil: 99999,
    _backoffCount: 3,
  });
  fake.video.currentSrc = 'https://a/2.mp4';
  fake._syncSourceState();
  assert.equal(fake._consecutiveFailures, 0);
  assert.equal(fake._failureSince, 0);
  assert.equal(fake._backoffUntil, 0);
  assert.equal(fake._backoffCount, 0);

  fake._consecutiveFailures = 70;
  fake._resetFailureTracker();
  assert.equal(fake._consecutiveFailures, 0);
});

function makeQueueSaveContext() {
  const start = popup.indexOf('  function setSaveState(state, message) {');
  const end = popup.indexOf('  async function fetchStatus() {');
  const block = popup.slice(start, end);
  assert.ok(start > 0 && end > start);

  const hint = { textContent: '' };
  const btn = { disabled: false };
  let inFlight = 0;
  let maxInFlight = 0;
  const sent = [];
  const ctx = {
    console,
    Promise,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: {
        sendMessage: async (msg) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          sent.push(msg.data.settings);
          // 第一次写故意慢，制造与第二次写并发的窗口
          if (sent.length === 1) await new Promise((r) => setTimeout(r, 20));
          inFlight--;
          return { success: true };
        },
      },
    },
    el: {
      advancedSaveBar: { classList: { remove() {}, add() {} } },
      advancedSaveHint: hint,
      advancedSave: btn,
    },
    MESSAGE_TYPES: { SET_SETTINGS: 'SET_SETTINGS' },
    settings: { v: 1 },
    advancedDirty: true,
    settingsLoadFailed: false,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.api = { save, flushSave, markDirty };', ctx);
  return { ctx, hint, sent, maxInFlight: () => maxInFlight };
}

test('P2-8 行为：并发保存串行化，后一次写带最新值', async () => {
  const c = makeQueueSaveContext();
  const p1 = c.ctx.api.save();
  // 等队列里的 saveNow 真正发出第一次消息，再模拟用户改动
  await Promise.resolve();
  assert.equal(c.sent.length, 1);
  c.ctx.settings = { v: 2 };
  c.ctx.api.markDirty();
  const p2 = c.ctx.api.save();

  assert.equal(await p1, true);
  assert.equal(await p2, true);
  assert.equal(c.maxInFlight(), 1, '两次 storage.set 不得同时在飞');
  assert.deepEqual(c.sent, [{ v: 1 }, { v: 2 }], '后写必须带最新值');
  assert.equal(c.ctx.advancedDirty, false, '最后一次写成功后才清脏');
  assert.equal(c.hint.textContent, '已保存');
});

test('P2-8 行为：写盘期间的新改动不会被误判为已保存', async () => {
  const c = makeQueueSaveContext();
  const p = c.ctx.api.save();
  await Promise.resolve();
  assert.equal(c.sent.length, 1);
  c.ctx.settings = { v: 3 };
  c.ctx.api.markDirty();
  assert.equal(await p, true);
  assert.deepEqual(c.sent, [{ v: 1 }]);
  assert.equal(c.ctx.advancedDirty, true, '旧版本写成功不能清掉新改动');
  assert.equal(c.hint.textContent, '有未保存的改动 · 点「保存设置」生效');
});

test('P2-8 源码：SW 侧写盘与广播整体排队，读取等队列排空', () => {
  assert.ok(sw.includes('let _settingsChain = Promise.resolve()'));
  assert.ok(sw.includes('function enqueueSettingsUpdate(settings)'));
  assert.ok(/await enqueueSettingsUpdate\(settings\);/.test(sw));
  assert.ok(/await _settingsChain;\s*\n\s*return \{ settings: await getSettings\(\) \}/.test(sw));
  assert.ok(popup.includes('  function save() {'));
  assert.ok(popup.includes('_saveChain.then(() => saveNow())'));
});

test('P2-8 SW 行为：写盘按到达顺序执行', async () => {
  const text = read('src/background/service-worker.js');
  const a = text.indexOf('async function saveSettings(settings) {');
  const b = text.indexOf('chrome.runtime.onMessage.addListener');
  assert.ok(a > 0 && b > a);
  const block = text.slice(a, b);

  const writes = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const ctx = {
    console,
    Promise,
    chrome: {
      storage: {
        local: {
          set: async (obj) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            writes.push(obj.hdr_vision_global.v);
            if (writes.length === 1) await new Promise((r) => setTimeout(r, 20));
            inFlight--;
          },
        },
      },
    },
    notifyContentScripts: async () => {},
    STORAGE_KEY: 'hdr_vision_global',
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.api = { enqueueSettingsUpdate };', ctx);

  const p1 = ctx.api.enqueueSettingsUpdate({ v: 1 });
  const p2 = ctx.api.enqueueSettingsUpdate({ v: 2 });
  await Promise.all([p1, p2]);
  assert.equal(maxInFlight, 1, 'SW 侧也不得并发写盘');
  assert.deepEqual(writes, [1, 2]);
});

function makeFetchStatusContext(sendImpl, queryImpl = async () => [{ id: 1 }]) {
  const start = popup.indexOf('  async function fetchStatus() {');
  const end = popup.indexOf('  function updateStatus(status) {');
  assert.ok(start > 0 && end > start);
  const block = popup.slice(start, end);

  const statuses = [];
  let cleared = 0;
  const ctx = {
    console,
    Promise,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => { cleared++; clearTimeout(id); },
    // 缩短到 30ms，避免测试真的等 2s
    STATUS_TIMEOUT_MS: 30,
    STATUS_SENTINEL_TIMEOUT: '__status_timeout__',
    MESSAGE_TYPES: { GET_STATUS: 'GET_STATUS' },
    chrome: {
      tabs: { query: queryImpl, sendMessage: sendImpl },
    },
    updateStatus: (s) => statuses.push(s),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.api = { fetchStatus };', ctx);
  return { ctx, statuses, cleared: () => cleared };
}

test('P2-9 行为：内容脚本不回包时 2s 内转为 no_receiver 并清定时器', async () => {
  const c = makeFetchStatusContext(() => new Promise(() => {}));
  const result = await c.ctx.api.fetchStatus();
  assert.equal(result, 'no_receiver');
  assert.deepEqual(c.statuses, ['no_receiver']);
  assert.equal(c.cleared(), 1, '超时后必须清掉定时器');
});

test('P2-9 行为：正常回包与无标签页不受超时影响', async () => {
  const ok = makeFetchStatusContext(async () => ({ status: 'active' }));
  assert.equal(await ok.ctx.api.fetchStatus(), 'active');
  assert.deepEqual(ok.statuses, ['active']);
  assert.equal(ok.cleared(), 1);

  const none = makeFetchStatusContext(async () => { throw new Error('no receiver'); }, async () => []);
  assert.equal(await none.ctx.api.fetchStatus(), 'unavailable');
  assert.deepEqual(none.statuses, ['unavailable']);
});

test('P2-9 行为：sendMessage 抛异常走 no_receiver', async () => {
  const c = makeFetchStatusContext(async () => { throw new Error('context invalidated'); });
  assert.equal(await c.ctx.api.fetchStatus(), 'no_receiver');
  assert.equal(c.cleared(), 1, '异常路径也要清定时器');
});

test('P2-13：去色带 / 锐化在 UI 与手册上标注为仅视频', () => {
  assert.ok(/data-i18n="debandVideoOnly"/.test(popupHtml));
  assert.ok(/data-i18n="sharpenVideoOnly"/.test(popupHtml));
  const zh = JSON.parse(read('_locales/zh_CN/messages.json'));
  const en = JSON.parse(read('_locales/en/messages.json'));
  for (const key of ['debandVideoOnly', 'sharpenVideoOnly']) {
    assert.match(zh[key].message, /仅视频/);
    assert.match(en[key].message, /Video only/i);
  }
  // 手册在工作区而不是扩展目录，存在时才校验（测试不依赖工作区路径）
  const manualPath = path.resolve(
    ROOT, '..', '..', 'WorkBuddy', '2026-11-19-23-14-19', 'HDR Vision 参数使用手册.html');
  if (fs.existsSync(manualPath)) {
    assert.match(fs.readFileSync(manualPath, 'utf8'), /去色带与 CAS 锐化不生效/);
  }
});

// ---------- Stage 4（1.2.23）：可维护性收口 ----------

test('P3-8 行为：导入 __proto__ 不会污染 powerCurve 原型', () => {
  const raw = JSON.parse('{"powerCurve":{"__proto__":{"polluted":true},"exposure":0.5}}');
  const n = S.normalizeSettings(raw);
  assert.equal({}.polluted, undefined, '原型不得被导入快照改写');
  // vm 里创建的对象的原型与宿主 realm 不是同一个引用，只检查「没被改成 null 原型」
  assert.notEqual(Object.getPrototypeOf(n.powerCurve), null);
  assert.equal(Object.prototype.hasOwnProperty.call(n.powerCurve, '__proto__'), false);
  assert.equal(n.powerCurve.exposure, 0.5);
});

test('P3-8 行为：normalizeSettings 幂等且不改动输入对象', () => {
  const raw = S.normalizeSettings({ _version: 15, renderScale: 0.5, powerCurve: { maxBoost: 2.5 } });
  const snapshot = JSON.stringify(raw);
  const once = S.normalizeSettings(raw);
  const twice = S.normalizeSettings(once);
  assert.equal(JSON.stringify(raw), snapshot, 'normalize 不得改写入参');
  assert.deepEqual(twice, once, '二次归一化必须是空操作');
});

test('P3-1 行为：v9 旧曲线迁移不再留下从未被读取的副本字段', () => {
  const s = S.migrateSettings({
    _version: 9,
    bt2446a: { peakBrightness: 1.25, boost: 1.2, midToneLift: 0.85, exposure: 0, saturation: 1 },
  });
  assert.equal('legacyBt2446a' in s, false);
  const n = S.normalizeSettings(s);
  assert.ok(n.bt2446a.targetWhite > 0 && n.bt2446a.targetMid > 0, '旧字段仍应参与目标反解');
});

test('P3-1 行为：无调用的 buildLut 已下线，双层 LUT 仍按 6 行生成', () => {
  const TM = loadShared().HdrToneMath;
  assert.equal(TM.buildLut, undefined);
  const lut = TM.buildDualLut({ targetWhite: 1.4, targetMid: 0.5 }, 32);
  assert.equal(lut.length, 32 * TM.DUAL_ROWS);
  assert.ok(TM.lutFingerprint({ targetWhite: 1.4, targetMid: 0.5 }).startsWith('L6|'));
});

test('P3-1 行为：PRESETS 聚合已删除但两张预设表仍可用', () => {
  assert.equal(S.PRESETS, undefined);
  assert.equal(S.BT2446A_PRESETS.highDynamic.settings.targetWhite, 1.4);
  assert.equal(S.POWER_PRESETS.standard.settings.maxBoost, 1.4);
  const n = S.normalizeSettings({ presetByMode: { bt2446a: 'twoLayer' } });
  assert.equal(n.presetByMode.bt2446a, 'highDynamic', 'v14 的旧指针兜底仍生效');
});

test('P3-2 行为：sliderToNits 单一来源与渲染端读数一致', () => {
  assert.equal(S.sliderToNits(35), 220);
  assert.equal(S.sliderToNits(0), 80);
  const R = loadRenderRuntime();
  const settings = S.deepClone(S.DEFAULT_SETTINGS);
  settings.sdrSliderPercent = 35;
  const out = new Float32Array(R.UNIFORM_FLOATS);
  R.computeUniformData(settings, 1920, 1080, 1 / 1920, 1 / 1080, 0, null, out, {
    outputIsHDR: false, hdrMode: 0,
  });
  assert.equal(out[R.U.refWhiteNits], S.sliderToNits(35));
});

test('P3-2 行为：视频与图片尺寸共用缩放，7680 上限仍生效', () => {
  const R = loadRenderRuntime();
  const video = makeVideoRendererStub(R, {
    video: { videoWidth: 16000, videoHeight: 9000, readyState: 4 },
    settings: { renderScale: 1 },
  });
  const size = video._getTargetSize();
  assert.equal(size.width / size.height, 16000 / 9000, '等比缩放');
  assert.ok(Math.max(size.width, size.height) <= 7680, '单边不得超过 7680');

  video.settings = { renderScale: 0.5 };
  const half = video._getTargetSize();
  assert.ok(Math.abs(half.width - size.width * 0.5) <= 1);

  const img = Object.create(R.ImageRenderer.prototype);
  Object.assign(img, {
    image: { naturalWidth: 4000, naturalHeight: 3000 },
    settings: { renderScale: 0.5 },
  });
  const imgSize = img._getTextureSize();
  assert.equal(imgSize.width, 2000);
  assert.equal(imgSize.height, 1500);
});

test('P3-2 行为：导入 zone 快照仍走旧双层分支，local 走真双层', () => {
  const R = loadRenderRuntime();
  const out = new Float32Array(R.UNIFORM_FLOATS);
  const settings = S.deepClone(S.DEFAULT_SETTINGS);
  settings.dualLayer.mode = 'zone';
  R.computeUniformData(settings, 1920, 1080, 1 / 1920, 1 / 1080, 0, null, out, {
    outputIsHDR: false, hdrMode: 0,
  });
  assert.equal(out[R.U.dualLayerMode], 0, 'zone 分支保留，避免老快照静默换算法');
  settings.dualLayer.mode = 'local';
  R.computeUniformData(settings, 1920, 1080, 1 / 1920, 1 / 1080, 0, null, out, {
    outputIsHDR: false, hdrMode: 0,
  });
  assert.equal(out[R.U.dualLayerMode], 1);
});

test('P3-2 行为：所有预设经 computeUniformData 后 uniform 全为有限值', () => {
  const R = loadRenderRuntime();
  const out = new Float32Array(R.UNIFORM_FLOATS);
  const groups = [];
  for (const [mode, table] of [['bt2446a', S.BT2446A_PRESETS], ['power', S.POWER_PRESETS]]) {
    for (const preset of Object.values(table)) {
      const settings = S.deepClone(S.DEFAULT_SETTINGS);
      settings.mappingMode = mode;
      const target = mode === 'bt2446a' ? settings.bt2446a : settings.powerCurve;
      Object.assign(target, preset.settings);
      groups.push(mode + '/' + JSON.stringify(preset.settings));
      R.computeUniformData(settings, 1920, 1080, 1 / 1920, 1 / 1080, 0, null, out, {
        outputIsHDR: false, hdrMode: 0,
      });
      for (let i = 0; i < out.length; i++) {
        assert.ok(Number.isFinite(out[i]), groups[groups.length - 1] + ' uniform[' + i + '] 非有限');
      }
    }
  }
  assert.ok(groups.length >= 7);
});

test('P3-4：HTML 静态 value 与 schema 默认值一致', () => {
  const d = S.DEFAULT_SETTINGS;
  const expected = {
    'sdr-slider': d.sdrSliderPercent,
    'hdr-peak': d.hdrPeakNits,
    'crop-top': d.cropTopPx,
    'highlight-ceiling': d.highlightCeiling,
    'output-gain': d.outputGain,
    'exposure': d.powerCurve.exposure,
    'saturation': d.powerCurve.saturation,
    'peak-brightness': d.powerCurve.peakBrightness,
    'target-white': d.bt2446a.targetWhite,
    'target-mid': d.bt2446a.targetMid,
    'brightness-threshold': d.powerCurve.brightnessThreshold * 100,
    'max-boost': d.powerCurve.maxBoost,
    'shadow-threshold': d.powerCurve.shadowThreshold * 100,
    'shadow-crush': d.powerCurve.shadowCrush,
    'dual-radius': d.dualLayer.radius,
    'dual-detail': d.dualLayer.detail,
    'deband-strength': d.deband.threshold,
    'sharpen-strength': d.sharpen.strength,
    'render-scale': d.renderScale,
  };
  for (const [id, value] of Object.entries(expected)) {
    const m = popupHtml.match(new RegExp('id="' + id + '"[^>]*value="([^"]+)"'));
    assert.ok(m, id + ' 缺少静态 value');
    const tolerance = Math.max(1e-4, Math.abs(value) * 1e-6);
    assert.ok(Math.abs(Number(m[1]) - value) <= tolerance,
      id + ' 静态值 ' + m[1] + ' 与 schema 默认 ' + value + ' 不一致');
  }
});

test('P3-5 行为：tf 插值本地化文案，缺键时退回中文', () => {
  const start = popup.indexOf('  function tf(key, fallback, vars) {');
  const end = popup.indexOf('\n  }', start) + 4;
  assert.ok(start > 0 && end > start);
  const ctx = {
    chrome: { i18n: { getMessage: (key) => ({ profileApplied: 'Applied "{name}"' })[key] || '' } },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(popup.slice(start, end) + '\nthis.fn = tf;', ctx);
  assert.equal(ctx.fn('profileApplied', '已应用「{name}」', { name: 'A' }), 'Applied "A"');
  assert.equal(ctx.fn('missingKey', '已应用「{name}」', { name: 'B' }), '已应用「B」');
});

test('P3-9 行为：依赖断言在齐全时通过，缺文件时点名', () => {
  const start = content.indexOf('function assertContentDependencies() {');
  const end = content.indexOf('const CONTENT_DEPS_MISSING', start);
  assert.ok(start > 0 && end > start);
  const block = content.slice(start, end);
  const names = [...block.matchAll(/^\s{4}(\w+): typeof/gm)].map((m) => m[1]);
  assert.ok(names.length >= 15, '断言应覆盖所有关键全局');

  const ctx = { console: { error() {} } };
  for (const name of names) ctx[name] = {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.fn = assertContentDependencies;', ctx);
  assert.equal(ctx.fn().length, 0);

  delete ctx.VideoRenderer;
  const missing = ctx.fn();
  assert.equal(missing.length, 1);
  assert.equal(missing[0], 'VideoRenderer', '缺哪个就报哪个');
});

test('P4-2 行为：合法取值为 undefined 的符号不得被判为依赖缺失（Windows 真机）', () => {
  const start = content.indexOf('function assertContentDependencies() {');
  const end = content.indexOf('const CONTENT_DEPS_MISSING', start);
  assert.ok(start > 0 && end > start, '依赖断言函数应存在');
  const block = content.slice(start, end);
  const names = [...block.matchAll(/^\s{4}(\w+): typeof/gm)].map((m) => m[1]);

  // 真机回归：1.2.42 把 ADAPTER_OPTIONS 放进表里，Windows 上该常量合法为
  // undefined，typeof 无法区分「声明为 undefined」与「未声明」，于是每台
  // Windows 机器都报「依赖缺失 · ADAPTER_OPTIONS」。这里直接复现该取值。
  assert.ok(!names.includes('ADAPTER_OPTIONS'),
    'ADAPTER_OPTIONS 在 Windows 上合法为 undefined，不能用 typeof 做存在性探针');
  const utilsSrc = read('src/content/utils.js');
  assert.match(utilsSrc, /const ADAPTER_OPTIONS = \(\(\) => \{/);
  assert.match(utilsSrc, /return undefined;/, 'utils.js 必须保留 Windows 分支返回 undefined');

  const ctx = { console: { error() {} } };
  for (const name of names) ctx[name] = {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext('const ADAPTER_OPTIONS = undefined;', ctx);
  vm.runInContext(block + '\nthis.fn = assertContentDependencies;', ctx);
  assert.equal(ctx.fn().length, 0, 'Windows 取值下不应报任何依赖缺失');

  // 探针本身不能失效：真正缺文件时仍要能点名
  delete ctx.VideoRenderer;
  assert.deepEqual([...ctx.fn()], ['VideoRenderer']);
});

test('P3-6：package.json 提供 lint/test/check 三个入口', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.lint, 'eslint src tools');
  assert.match(pkg.scripts.test, /node --test/);
  assert.match(pkg.scripts.check, /npm run lint/);
  assert.ok(pkg.devDependencies.eslint);
  const config = read('eslint.config.mjs');
  assert.match(config, /no-undef/);
  assert.match(config, /no-unused-vars/);
});

test('P3-7：行为测试占比达到出口标准 50%', () => {
  const source = read('tools/test/settings.test.js');
  const total = [...source.matchAll(/^test\(/gm)].length;
  const behavioral = [...source.matchAll(/^test\('[^']*行为/gm)].length;
  assert.ok(behavioral / total >= 0.5,
    '行为测试 ' + behavioral + '/' + total + ' = ' + (100 * behavioral / total).toFixed(1) + '%');
});

test('P3-7 行为：v7 旧配置的取帧方式经完整迁移链抬到 auto 且幂等', () => {
  const s = S.migrateSettings({ _version: 7, capturePath: 'snapshot', cropTopPx: 3 });
  assert.equal(s.capturePath, 'auto');
  assert.equal(s.cropTopPx, 3);
  const s2 = S.migrateSettings(s);
  assert.equal(s2.capturePath, 'auto');
  assert.equal(s._version, S.CURRENT_SETTINGS_VERSION);
});

test('P3-7 行为：非法枚举值退回默认，合法枚举值保留', () => {
  const bad = S.normalizeSettings({ hdrSourceMode: 'bogus', canvasMode: 'hdr', capturePath: 'foo' });
  assert.equal(bad.hdrSourceMode, S.DEFAULT_SETTINGS.hdrSourceMode);
  assert.equal(bad.canvasMode, S.DEFAULT_SETTINGS.canvasMode);
  assert.equal(bad.capturePath, S.DEFAULT_SETTINGS.capturePath);
  const ok = S.normalizeSettings({ hdrSourceMode: 'pq', canvasMode: 'sdr', capturePath: 'copy' });
  assert.equal(ok.hdrSourceMode, 'pq');
  assert.equal(ok.canvasMode, 'sdr');
  assert.equal(ok.capturePath, 'copy');
});

test('P3-7 行为：去色带与锐化互斥，导入同时开启时关掉锐化', () => {
  const n = S.normalizeSettings({ deband: { enabled: true }, sharpen: { enabled: true, strength: 0.8 } });
  assert.equal(n.deband.enabled, true);
  assert.equal(n.sharpen.enabled, false);
  const n2 = S.normalizeSettings({ deband: { enabled: false }, sharpen: { enabled: true } });
  assert.equal(n2.sharpen.enabled, true);
});

test('P3-7 行为：整体强度在 uniform 里保持严格线性', () => {
  const R = loadRenderRuntime();
  const out = new Float32Array(R.UNIFORM_FLOATS);
  const read = (gain) => {
    const settings = S.deepClone(S.DEFAULT_SETTINGS);
    settings.outputGain = gain;
    R.computeUniformData(settings, 1920, 1080, 1 / 1920, 1 / 1080, 0, null, out, {
      outputIsHDR: false, hdrMode: 0,
    });
    return out[R.U.outputGain];
  };
  const g08 = read(0.8);
  const g16 = read(1.6);
  assert.ok(Math.abs(g16 / g08 - 2) < 1e-5, '1.6 应为 0.8 的两倍');
});

test('P3-7 行为：高光上限按显示器物理余量夹紧', () => {
  const R = loadRenderRuntime();
  const out = new Float32Array(R.UNIFORM_FLOATS);
  const settings = S.deepClone(S.DEFAULT_SETTINGS);
  settings.highlightCeiling = 2.0;
  settings.hdrPeakNits = 400;
  settings.sdrSliderPercent = 35;      // 220 nits → 余量 1.82×
  R.computeUniformData(settings, 1920, 1080, 1 / 1920, 1 / 1080, 0, null, out, {
    outputIsHDR: true, hdrMode: 0,
  });
  const expected = 400 / 220;
  assert.ok(Math.abs(out[R.U.highlightCeiling] - expected) < 1e-5);
});

test('P3-7 行为：HDR 源模式写入 uniform 的 mode 字段', () => {
  const R = loadRenderRuntime();
  const out = new Float32Array(R.UNIFORM_FLOATS);
  for (const [mode, expected] of [['off', 0], ['pq', 1], ['hlg', 2]]) {
    const settings = S.deepClone(S.DEFAULT_SETTINGS);
    settings.hdrSourceMode = mode;
    R.computeUniformData(settings, 1920, 1080, 1 / 1920, 1 / 1080, 0, null, out, {
      outputIsHDR: false, hdrMode: expected,
    });
    assert.equal(out[R.U.inputTransfer], expected);
  }
});

test('P3-7 行为：DRM 识别覆盖 mediaKeys 与 webkitKeys', () => {
  const R = loadRenderRuntime();
  assert.equal(R.isDRMProtected({ mediaKeys: {} }), true);
  assert.equal(R.isDRMProtected({ webkitKeys: {} }), true);
  assert.equal(R.isDRMProtected({}), false);
  assert.equal(R.isDRMProtected(null), false);
});

test('P3-7 行为：renderScale 超界时按 RANGES 夹紧到 1.0', () => {
  const R = loadRenderRuntime();
  const video = makeVideoRendererStub(R, {
    video: { videoWidth: 1920, videoHeight: 1080, readyState: 4 },
    settings: { renderScale: 9 },
  });
  assert.deepEqual(
    [video._getTargetSize().width, video._getTargetSize().height], [1920, 1080]);
  video.settings = { renderScale: 0.01 };
  assert.equal(video._getTargetSize().width, Math.round(1920 * 0.25));
});

test('P3-7 行为：v14 twoLayer 预设下线但用户曲线值原样保留', () => {
  const s = S.migrateSettings({
    // v14 的迁移条件是从 <14 的版本升级，所以这里必须从 13 起
    _version: 13,
    presetByMode: { power: 'standard', bt2446a: 'twoLayer' },
    bt2446a: { targetWhite: 1.45, targetMid: 0.48, saturation: 1.12, exposure: 0 },
  });
  assert.equal(s.presetByMode.bt2446a, 'highDynamic');
  assert.equal(s.bt2446a.targetWhite, 1.45);
  assert.equal(s.bt2446a.targetMid, 0.48);
  assert.equal(s.bt2446a.saturation, 1.12);
});

test('P3-7 行为：deepClone 深拷贝不与源对象共享嵌套引用', () => {
  const src = { bt2446a: { targetWhite: 1.4 }, list: [1, 2] };
  const copy = S.deepClone(src);
  copy.bt2446a.targetWhite = 1.1;
  copy.list.push(3);
  assert.equal(src.bt2446a.targetWhite, 1.4);
  assert.equal(src.list.length, 2);
});

test('P3-7 行为：导入超大半径夹到滑块上限 32', () => {
  const n = S.normalizeSettings({ dualLayer: { radius: 40, detail: 5 } });
  assert.equal(n.dualLayer.radius, 32);
  assert.equal(n.dualLayer.detail, 2);
  const R = loadRenderRuntime();
  const out = new Float32Array(R.UNIFORM_FLOATS);
  R.computeUniformData(n, 1920, 1080, 1 / 1920, 1 / 1080, 0, null, out, {
    outputIsHDR: false, hdrMode: 0,
  });
  assert.equal(out[R.U.dualLayerRadius], 32);
});

test('P3-7 行为：deband / sharpen 互斥在 uniform 层同样成立', () => {
  const R = loadRenderRuntime();
  const n = S.normalizeSettings({ deband: { enabled: true, threshold: 0.02 }, sharpen: { enabled: true } });
  const out = new Float32Array(R.UNIFORM_FLOATS);
  R.computeUniformData(n, 1920, 1080, 1 / 1920, 1 / 1080, 0, null, out, {
    outputIsHDR: false, hdrMode: 0,
  });
  assert.equal(out[R.U.debandEnabled], 1);
  assert.equal(out[R.U.sharpenEnabled], 0);
});

test('P0-2：deband/双边 base 复用仅在半径 12 且两条链都开启时启用', () => {
  assert.match(content, /const FUSED_BASE_ENABLED = true;/);
  assert.match(content, /ring12 = r12\.samples;/);
  assert.match(content, /hasRing12 > 0\.5 && abs\(uniforms\.dualLayerRadius - 12\.0\) < 0\.01/);
  assert.match(content, /baseFromRing12\(ring12Samples, rawColor\)/);
  // 早退分支不带 r12 样本，必须保留原来的 9-tap 回退
  assert.match(content, /else \{\s*\n\s*dualBase = computeLocalBase\(uv\);/);
});

test('回归：HDR 开关等即时路径在未标脏时也必须真正写盘', async () => {
  const c = makeQueueSaveContext();
  // 开关 handler 只改 settings 并直接 save()，不经过 markDirty()
  c.ctx.advancedDirty = false;
  c.ctx.settings = { enabled: false };
  assert.equal(await c.ctx.api.save(), true);
  assert.equal(c.sent.length, 1, '未脏也不能跳过写盘，否则开关永远不生效');
  assert.deepEqual(c.sent[0], { enabled: false });
});

// ---------- 1.2.26：系统 SDR 亮度同步 ----------

test('SDR 同步行为：默认值只派生参考白与高光上限，其他设置原样保留', () => {
  const s = S.normalizeSettings({});
  const r = S.computeCalibration(s, 50);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.nits, 280);
  assert.equal(r.next.sdrSliderPercent, 50);
  assert.equal(r.next.highlightCeiling, 1.2);
  assert.equal(r.derived.sdrSliderPercent, 50);
  assert.equal(r.derived.highlightCeiling, 1.2);
  for (const key of ['targetWhite', 'targetMid', 'outputGain', 'hdrPeakNits',
                     'exposure', 'saturation', 'deband', 'dualLayer', 'presetByMode']) {
    assert.equal(JSON.stringify(r.next[key]), JSON.stringify(s[key]), key + ' 不应被同步覆盖');
  }
  assert.equal(r.next.calibration.sdrPercent, 50);
  assert.equal(r.next.calibration.nits, 280);
  assert.ok(r.next.calibration.appliedAt > 0);
  assert.equal(r.next.calibration.previous.sdrSliderPercent, 35);
});

test('SDR 同步行为：物理余量不足时高光上限降到 1.0 并给出警告', () => {
  const s = S.normalizeSettings({ hdrPeakNits: 400 });
  const r = S.computeCalibration(s, 95);   // 460 nits > 400 nits 峰值
  assert.equal(r.headroom < 1, true);
  assert.equal(r.next.highlightCeiling, 1.0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /低于系统参考白/);
});

test('SDR 同步行为：用户改过的高光上限不被覆盖，只记录 skipped', () => {
  const first = S.computeCalibration(S.normalizeSettings({}), 50);
  const custom = S.normalizeSettings(first.next);
  custom.highlightCeiling = 1.05;   // 用户手动改
  const second = S.computeCalibration(custom, 60);
  assert.equal(second.next.highlightCeiling, 1.05, '用户值必须保留');
  assert.equal(second.skipped.length, 1);
  assert.equal(second.skipped[0], 'highlightCeiling');
  assert.equal(second.next.calibration.previous.sdrSliderPercent, 50);
  assert.equal('highlightCeiling' in second.next.calibration.previous, false);
});

test('SDR 同步行为：用户把值改回校准写入值后重新获得所有权', () => {
  const first = S.computeCalibration(S.normalizeSettings({}), 50);   // ceiling 1.2
  const custom = S.normalizeSettings(first.next);
  custom.highlightCeiling = 1.05;
  const skipped = S.computeCalibration(custom, 55);
  assert.equal(skipped.skipped.length, 1);
  assert.equal(skipped.skipped[0], 'highlightCeiling');
  const restored = S.normalizeSettings(skipped.next);
  restored.highlightCeiling = 1.2;   // 改回我们上次写入的值
  const again = S.computeCalibration(restored, 60);
  assert.equal(again.skipped.length, 0);
  assert.equal(again.next.highlightCeiling, 1.2);
});

test('SDR 同步行为：相同百分比重复同步是 no-op 且不写盘', () => {
  const first = S.computeCalibration(S.normalizeSettings({}), 42);
  assert.equal(first.changed, true);
  const again = S.computeCalibration(first.next, 42);
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(again.next, first.next, 'no-op 应返回原对象引用');
  assert.match(again.reason, /无需调整/);
});

test('SDR 同步行为边界：非法输入一律拒绝且不产生 next', () => {
  const s = S.normalizeSettings({});
  for (const bad of [NaN, Infinity, -1, 101, '50', '', null, undefined, {}]) {
    const r = S.computeCalibration(s, bad);
    assert.equal(r.ok, false, String(bad) + ' 应被拒绝');
    assert.equal(r.next, null);
  }
  const edge0 = S.computeCalibration(s, 0);
  const edge100 = S.computeCalibration(s, 100);
  assert.equal(edge0.ok, true);
  assert.equal(edge0.nits, 80);
  assert.equal(edge100.ok, true);
  assert.equal(edge100.nits, 480);
  const frac = S.computeCalibration(s, 35.7);
  assert.equal(frac.next.sdrSliderPercent, 36, '百分比取整数');
});

test('SDR 同步行为兼容性：旧配置无 calibration 时按默认值处理，导出快照被校验', () => {
  const legacy = S.migrateSettings({ _version: 15, sdrSliderPercent: 35 });
  const normalized = S.normalizeSettings(legacy);
  assert.ok(normalized.calibration);
  const r = S.computeCalibration(normalized, 40);
  assert.equal(r.ok, true);

  const poisoned = S.normalizeSettings({
    calibration: {
      version: 1, sdrPercent: 999, nits: -1, appliedAt: 'x', source: 'evil',
      derived: { sdrSliderPercent: 999, outputGain: 99, __proto__: { polluted: true } },
      previous: { targetWhite: 99 },
    },
  });
  assert.equal(poisoned.calibration.sdrPercent, null);
  assert.equal(poisoned.calibration.nits, null);
  assert.equal(poisoned.calibration.appliedAt, 0);
  assert.equal(poisoned.calibration.source, 'manual');
  assert.equal(poisoned.calibration.derived.outputGain, undefined);
  assert.equal(poisoned.calibration.previous.targetWhite, undefined);
  assert.equal({}.polluted, undefined);

  const wrongVersion = S.normalizeSettings({ calibration: { version: 99, sdrPercent: 40 } });
  assert.equal(wrongVersion.calibration.sdrPercent, null);
});

test('保存前校准：同值不派生，改动时派生高光上限；写盘统一走 flushSave', async () => {
  const start = popup.indexOf('  // ★ 原「按此值同步系统亮度」按钮的实质工作合并到这里');
  const end = popup.indexOf('  function save() {');
  assert.ok(start > 0 && end > start);
  const block = popup.slice(start, end);

  let sent = 0;
  let failNext = false;
  const status = { textContent: '' };
  const ctx = {
    console,
    HDRSettings: S,
    settings: S.normalizeSettings({}),
    advancedDirty: true,
    el: { calibrationStatus: status },
    t: (key, fallback) => fallback,
    sdrSliderRelevant: () => true,
    clampByRange: (key, v, fallback) => v,
    render() { ctx.rendered = (ctx.rendered || 0) + 1; },
    save: async () => {
      sent++;
      if (failNext) { failNext = false; return false; }
      ctx.advancedDirty = false;
      return true;
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.apply = applySdrCalibration; this.flush = flushSave;', ctx);

  // 首次保存：建立校准记录，但校准函数本身不写盘
  let cal = ctx.apply();
  assert.equal(cal.changed, true);
  assert.equal(sent, 0, '校准函数不得自己写盘');
  cal = ctx.apply();
  assert.equal(cal.changed, false, '同值重复调用不派生');

  // 统一保存入口：写一次盘
  await ctx.flush();
  assert.equal(sent, 1);
  assert.equal(ctx.settings.calibration.sdrPercent, 35);

  // 改值后保存：ceiling 按余量派生，状态显示同步结果
  ctx.advancedDirty = true;
  ctx.settings.sdrSliderPercent = 50;
  await ctx.flush();
  assert.equal(sent, 2);
  assert.equal(ctx.settings.calibration.sdrPercent, 50);
  assert.equal(ctx.settings.calibration.nits, 280);
  assert.match(status.textContent, /已按 50%/);

  // 保存后不再脏：重复 flush 不写盘
  await ctx.flush();
  assert.equal(sent, 2);

  // 保存失败：滑块改动保留，但本次校准派生必须回滚
  ctx.advancedDirty = true;
  ctx.settings.sdrSliderPercent = 70;
  failNext = true;
  await ctx.flush();
  assert.equal(sent, 3);
  assert.equal(ctx.settings.sdrSliderPercent, 70);
  assert.equal(ctx.settings.calibration.sdrPercent, 50, '校准记录也应回滚');
  assert.match(status.textContent, /已恢复/);
});

// ---------- 1.2.26：canvas watch 区分「元素被替换」与「画布被删」 ----------

function makeCanvasWatchHarness(R, img = false) {
  const warnings = [];
  const infos = [];
  const ctx = R.ctx;
  const realConsole = ctx.console;
  ctx.console = {
    warn: (...a) => warnings.push(a.join(' ')),
    info: (...a) => infos.push(a.join(' ')),
    error: realConsole.error,
    log: realConsole.log,
  };
  const style = { opacity: '0' };
  const el = {
    isConnected: true,
    style,
    insertAdjacentElement(pos, node) { node.isConnected = true; },
    removeEventListener() {},
  };
  const canvas = { isConnected: true, remove() { this.isConnected = false; } };
  const Proto = img ? R.ImageRenderer.prototype : R.VideoRenderer.prototype;
  const fake = Object.create(Proto);
  Object.assign(fake, {
    destroyed: false,
    failed: false,
    isRendering: true,
    video: img ? null : el,
    image: img ? el : null,
    canvas,
    _canvasWatchTimer: null,
    _canvasMissingCount: 0,
    _canvasWasMissing: false,
    _opacitySaved: true,
    _originalOpacity: '0.5',
    _updateCanvasSize() {},
    _draw() {},
    stopRendering() { this.isRendering = false; if (this._opacitySaved) el.style.opacity = this._originalOpacity; },
    destroy() { this.destroyed = true; },
    _fail() { this.failed = true; el.style.opacity = this._originalOpacity; },
  });
  let tick = null;
  ctx.setInterval = (fn) => { tick = fn; return 1; };
  ctx.clearInterval = () => {};
  fake._startCanvasWatch();
  return { fake, el, canvas, warnings, infos, tick: () => tick && tick() };
}

test('canvas watch 行为：元素被站点替换时直接销毁，不误报画布被移除', () => {
  const R = loadRenderRuntime();
  const h = makeCanvasWatchHarness(R);
  h.el.isConnected = false;
  h.canvas.isConnected = false;
  h.tick();
  assert.equal(h.fake.destroyed, true, '站点换掉 video 后应销毁，让 manager 重扫');
  assert.equal(h.fake.isRendering, false);
  assert.equal(h.warnings.length, 0, '不应误报「画布被反复移除」');
  assert.match(h.infos.join(' '), /视频元素已被站点替换/);
  assert.equal(h.el.style.opacity, '0.5', '原视频 opacity 必须恢复');
});

test('canvas watch 行为：画布单独被删时立即恢复原视频可见，插回后重新隐藏', () => {
  const R = loadRenderRuntime();
  const h = makeCanvasWatchHarness(R);
  h.canvas.isConnected = false;
  h.tick();
  assert.equal(h.canvas.isConnected, true, '应尝试插回');
  assert.equal(h.el.style.opacity, '0', '插回成功后重新隐藏原视频');
  assert.equal(h.fake._canvasMissingCount, 0);
  assert.equal(h.fake.destroyed, false);
});

test('canvas watch 行为：插回失败时维持原视频可见，连续 3 次才恢复并告警', () => {
  const R = loadRenderRuntime();
  const h = makeCanvasWatchHarness(R);
  h.el.insertAdjacentElement = () => {};   // 站点拒绝插入
  h.canvas.isConnected = false;
  h.tick();
  assert.equal(h.el.style.opacity, '0.5', '空窗期不能黑屏');
  assert.equal(h.fake.destroyed, false);
  h.tick();
  assert.equal(h.el.style.opacity, '0.5');
  assert.equal(h.warnings.length, 0);
  h.tick();
  assert.equal(h.fake.isRendering, false);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /反复移除/);
});

test('canvas watch 行为：图片端同样区分元素替换与画布被删', () => {
  const R = loadRenderRuntime();
  const h = makeCanvasWatchHarness(R, true);
  h.el.isConnected = false;
  h.tick();
  assert.equal(h.fake.failed, true);
  assert.equal(h.warnings.length, 0);
  assert.match(h.infos.join(' '), /图片元素已被站点替换/);

  const h2 = makeCanvasWatchHarness(R, true);
  h2.canvas.isConnected = false;
  h2.tick();
  assert.equal(h2.canvas.isConnected, true);
  assert.equal(h2.el.style.opacity, '0');
  assert.equal(h2.fake.failed, false);
});

test('系统 SDR 滑块：不相关配置下禁用，提示不再提同步按钮', () => {
  const start = popup.indexOf('  // ★ 这个滑块在哪些配置下真的参与渲染');
  const end = popup.indexOf('  // ★ 高光上限的「花费 / 额度」读数');
  assert.ok(start > 0 && end > start);
  const block = popup.slice(start, end);

  let active = false;
  const slider = { value: 35, disabled: false };
  const item = { classList: { toggle() {} } };
  const hint = { textContent: '' };
  const ctx = {
    HDRSettings: S,
    settings: { sdrSliderPercent: 35, hdrPeakNits: 1000, hdrSourceMode: 'off', canvasMode: 'auto' },
    el: { sdrSlider: slider, sdrItem: item, sdrHint: hint,
          sdrSliderValue: { textContent: '' }, sdrNits: { textContent: '' } },
    t: (k, f) => f,
    clampByRange: (k, v, f) => v,
    hdrDisplayActive: () => active,
    updateCeilingReadout() {},
    updateCalibrationStatus() {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.fn = updateSdrReadout;', ctx);

  // 8bit 画布 + HDR 源跳过 → 不读取参考白 → 滑块禁用，文案不再指向同步按钮
  ctx.fn();
  assert.equal(slider.disabled, true);
  assert.doesNotMatch(hint.textContent, /同步按钮/);

  // 接管 HDR 源 → 参考白生效
  ctx.settings.hdrSourceMode = 'pq';
  ctx.fn();
  assert.equal(slider.disabled, false);
  assert.match(hint.textContent, /接管 HDR 源/);

  // 16float 画布 + HDR 源跳过 → 同样可用
  ctx.settings.hdrSourceMode = 'off';
  active = true;
  ctx.fn();
  assert.equal(slider.disabled, false);
});

// ---------- 1.2.32：推荐设置前的物理参数输入 ----------

test('推荐输入：峰值 / SDR 必须是范围内的整数', () => {
  const r = S.recommendedTargets(1000, 35);
  assert.equal(r.ok, true);
  assert.equal(r.nits, 220);
  assert.equal(r.targetWhite, 1.4);
  assert.equal(r.highlightCeiling, 1.2);
  assert.equal(r.outputGain, 1.05);

  for (const [peak, pct, field] of [
    ['1000', 35, 'peakNits'],
    [1000.5, 35, 'peakNits'],
    [401, 35, 'peakNits'],
    [399, 35, 'peakNits'],
    [2001, 35, 'peakNits'],
    [1000, '35', 'sdrPercent'],
    [1000, 35.5, 'sdrPercent'],
    [1000, -1, 'sdrPercent'],
    [1000, 101, 'sdrPercent'],
    [NaN, 35, 'peakNits'],
    [1000, Infinity, 'sdrPercent'],
  ]) {
    const bad = S.recommendedTargets(peak, pct);
    assert.equal(bad.ok, false, peak + '/' + pct + ' 应被拒绝');
    assert.equal(bad.field, field, peak + '/' + pct + ' 应指向 ' + field);
    assert.ok(bad.reason.length > 0);
  }
  assert.equal(S.recommendedTargets(450, 35).ok, true, '50 的倍数应通过');
});

test('推荐输入：按物理余量只降不升', () => {
  // 峰值 400 / SDR 80% = 参考白 400 → 余量 1.0，三个派生值都降到 1.0
  const edge = S.recommendedTargets(400, 80);
  assert.equal(edge.headroom, 1);
  assert.equal(edge.available, 1);
  assert.equal(edge.targetWhite, 1.0);
  assert.equal(edge.highlightCeiling, 1.0);
  assert.equal(edge.outputGain, 1.0);
  assert.equal(edge.tuned.targetWhite, true);
  assert.equal(edge.tuned.highlightCeiling, true);
  assert.equal(edge.tuned.outputGain, true);
  assert.equal(edge.warnings.length, 0);

  // 峰值低于参考白：允许应用但必须给警告
  const bad = S.recommendedTargets(400, 90);
  assert.equal(bad.ok, true);
  assert.ok(bad.headroom < 1);
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0], /低于系统参考白/);

  // 余量在 1.0–1.2：只有高光上限 / 强度收敛，白点仍在 1.40
  const limited = S.recommendedTargets(400, 70);
  assert.equal(limited.nits, 360);
  assert.equal(limited.targetWhite, 1.11);
  assert.equal(limited.highlightCeiling, 1.11);
  assert.equal(limited.outputGain, 1.05);

  // 余量充足时保持推荐的 1.40 / 1.20 / 1.05
  const full = S.recommendedTargets(1000, 35);
  assert.equal(full.targetWhite, 1.4);
  assert.equal(full.highlightCeiling, 1.2);
  assert.equal(full.outputGain, 1.05);
  assert.equal(full.tuned.targetWhite, false);
  assert.equal(full.tuned.highlightCeiling, false);
  assert.equal(full.tuned.outputGain, false);

  // 用户自定义的高光上限：低于余量时保留，高于余量时只降到余量
  const keep = S.recommendedTargets(1000, 35, 1.5);
  assert.equal(keep.highlightCeiling, 1.5, '余量充足时不得把 1.5 改回 1.2');
  assert.equal(keep.tuned.highlightCeiling, false);
  const clamped = S.recommendedTargets(400, 70, 1.5);
  assert.equal(clamped.highlightCeiling, 1.11, '超过余量时才下调');
  assert.equal(clamped.tuned.highlightCeiling, true);
});

test('推荐应用：覆盖全局组合、写入两个事实并记录 calibration', () => {
  const src = S.normalizeSettings({
    mappingMode: 'power',
    hdrPeakNits: 1400,
    sdrSliderPercent: 60,
    outputGain: 0.8,
    highlightCeiling: 1.5,
    dualLayer: { enabled: false },
    deband: { enabled: false },
    sharpen: { enabled: true, strength: 0.8 },
  });
  const before = JSON.stringify(src);
  const r = S.computeRecommended(src, 1000, 35);

  assert.equal(r.ok, true);
  assert.equal(r.next.mappingMode, 'bt2446a');
  assert.equal(r.next.presetByMode.bt2446a, 'highDynamic');
  assert.equal(r.next.hdrSourceMode, 'auto');
  assert.equal(r.next.canvasMode, 'auto');
  assert.equal(r.next.capturePath, 'auto');
  assert.equal(r.next.dualLayer.enabled, true);
  assert.equal(r.next.deband.enabled, true);
  assert.equal(r.next.sharpen.enabled, false, 'deband / sharpen 互斥');
  assert.equal(r.next.outputGain, 1.05);
  assert.equal(r.next.bt2446a.saturation, 1.10);
  assert.equal(r.next.bt2446a.targetWhite, 1.4);
  assert.equal(r.next.bt2446a.targetMid, 0.50);
  assert.equal(r.next.powerCurve.brightnessThreshold, 0.55,
    'presetByMode.power 指向 vivid 时，powerCurve 也必须是 vivid');
  assert.equal(r.next.powerCurve.maxBoost, 1.8);
  assert.equal(r.next.powerCurve.peakBrightness, 30);
  assert.equal(r.next.hdrPeakNits, 1000);
  assert.equal(r.next.sdrSliderPercent, 35);
  assert.equal(r.next.highlightCeiling, 1.5, '余量充足时保留用户的高光上限');
  assert.equal(r.next.calibration.sdrPercent, 35);
  assert.equal(r.next.calibration.nits, 220);
  assert.equal(r.next.calibration.derived.sdrSliderPercent, 35);
  assert.equal(r.next.calibration.derived.highlightCeiling, undefined,
    '未下调高光上限时不应标记为已调整');
  assert.equal('highlightCeiling' in r.next.calibration.previous, false,
    '没有下调时不应记录 previous');

  // 结果经过 normalize，写盘后读数与滑块域一致
  const normalized = S.normalizeSettings(r.next);
  assert.equal(normalized.hdrPeakNits, 1000);
  assert.equal(normalized.sdrSliderPercent, 35);
  assert.equal(normalized.calibration.sdrPercent, 35);
  assert.equal(JSON.stringify(src), before, '不得改写入参');

  // 最小对象也要能生成完整设置（powerCurve 不依赖入参已有该键）
  const minimal = S.computeRecommended({}, 1000, 35);
  assert.equal(minimal.ok, true);
  assert.equal(minimal.next.mappingMode, 'bt2446a');
  assert.equal(minimal.next.powerCurve.maxBoost, 1.8);
  // 用户手动选的 2D 快照是顶部绿边的兼容兜底，不得被推荐重置为 auto
  const withSnapshot = S.computeRecommended(
    S.normalizeSettings({ capturePath: 'snapshot' }), 1000, 35);
  assert.equal(withSnapshot.next.capturePath, 'snapshot');
  assert.equal(S.computeRecommended(S.normalizeSettings({}), 1000, 35).next.capturePath, 'auto');
});

test('推荐应用：低余量时结果收敛且仍在 RANGES 内', () => {
  const r = S.computeRecommended(S.normalizeSettings({}), 400, 80);
  assert.equal(r.targetWhite, 1.0);
  assert.equal(r.highlightCeiling, 1.0);
  assert.equal(r.outputGain, 1.0);
  assert.equal(r.next.bt2446a.targetWhite, 1.0);
  assert.equal(r.next.highlightCeiling, 1.0);
  for (const [key, value] of [
    ['hdrPeakNits', r.next.hdrPeakNits],
    ['sdrSliderPercent', r.next.sdrSliderPercent],
    ['highlightCeiling', r.next.highlightCeiling],
    ['outputGain', r.next.outputGain],
  ]) {
    const range = S.RANGES[key];
    assert.ok(value >= range.min && value <= range.max, key + ' 越界: ' + value);
  }

  // 用户原来 1.5，余量 1.11：需要下调并记录 derived / previous
  const clamped = S.computeRecommended(
    S.normalizeSettings({ highlightCeiling: 1.5 }), 400, 70);
  assert.equal(clamped.next.highlightCeiling, 1.11);
  assert.equal(clamped.next.calibration.derived.highlightCeiling, 1.11);
  assert.equal(clamped.next.calibration.previous.highlightCeiling, 1.5);
});

test('推荐输入步骤：弹层、取消与校验入口存在', () => {
  assert.match(popupHtml, /id="recommended-modal"/);
  assert.match(popupHtml, /id="recommended-peak"/);
  assert.match(popupHtml, /id="recommended-sdr"/);
  assert.match(popupHtml, /id="recommended-confirm"/);
  assert.match(popupHtml, /id="recommended-cancel"/);
  assert.match(popupHtml, /id="recommended-error"/);
  assert.match(popupHtml, /id="recommended-capture-note"/);
  assert.match(popupHtml, /data-i18n="capturePathGreenBandHint"/);
  assert.match(popup, /recommendedKeepSnapshot/);
  assert.match(popup, /recommendedAutoGreenBand/);
  assert.match(popup, /function readRecommendedInputs\(\)/);
  assert.match(popup, /function showRecommendedErrors\(errors\)/);
  assert.match(popup, /if \(e\.key === 'Escape'\)/);
  assert.match(popup, /recommendedCancel\.addEventListener\('click', closeRecommendedDialog\)/);
});

test('取帧方式：位于预设板块下方，且不在高级设置面板内', () => {
  const presets = popupHtml.indexOf('id="presets-section"');
  const captureSection = popupHtml.indexOf('id="capture-section"');
  const captureControl = popupHtml.indexOf('id="capture-path-list"');
  const advanced = popupHtml.indexOf('id="advanced-panel"');
  assert.ok(presets > 0 && captureSection > presets, '取帧区块应紧跟预设板块');
  assert.ok(captureControl > captureSection && captureControl < advanced,
    '取帧控件应在高级设置面板之外');
  assert.equal(/id="capture-path"/.test(popupHtml), false, '不应再有下拉框');
  assert.match(popupHtml, /class="preset-list" id="capture-path-list"/);
  assert.match(popup, /function renderCapturePath\(\)/);
});

test('取帧方式卡片：复用预设样式，选中态与点击行为正确', async () => {
  const start = popup.indexOf('  // 取帧方式卡片：与预设共用 .preset-item 样式');
  const end = popup.indexOf('  function applyPreset(key) {');
  assert.ok(start > 0 && end > start);
  const block = popup.slice(start, end);

  let children = [];
  const list = {
    set innerHTML(v) { if (v === '') children = []; },
    appendChild(btn) { children.push(btn); },
  };
  let saved = 0;
  let rendered = 0;
  const ctx = {
    document: {
      createElement() {
        const spans = {
          '.preset-name': { textContent: '' },
          '.preset-desc': { textContent: '' },
        };
        return {
          type: '', className: '', dataset: {}, innerHTML: '',
          querySelector(sel) { return spans[sel]; },
          addEventListener(evt, fn) { this._onClick = fn; },
        };
      },
    },
    el: { capturePathList: list, captureStatus: { textContent: '' } },
    settings: { capturePath: 'auto' },
    t: (key, fallback) => fallback,
    tf: (key, fallback) => fallback,
    render() { rendered++; },
    save() { saved++; return Promise.resolve(true); },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.fn = renderCapturePath;', ctx);

  ctx.fn();
  assert.equal(children.length, 4);
  assert.match(children[0].className, /preset-item/);
  assert.match(children[0].className, /active/, '默认 auto 应高亮');
  assert.equal(children[0].querySelector('.preset-name').textContent, '自动（零拷贝优先）');

  const snapshotBtn = children.find((b) => b.dataset.capture === 'snapshot');
  snapshotBtn._onClick();
  assert.equal(ctx.settings.capturePath, 'snapshot');
  assert.equal(saved, 1);
  assert.equal(rendered, 1);
  assert.match(ctx.el.captureStatus.textContent, /正在保存/, '点击后应立即给出保存中提示');
  await new Promise((r) => setTimeout(r, 0));
  assert.match(ctx.el.captureStatus.textContent, /已保存/, '保存成功后必须给出确认');

  ctx.fn();
  assert.match(children[1].className, /active/, '重新渲染后应高亮新选中的卡片');

  // 1.2.41：点当前已选中的卡片不再静默返回
  children[1]._onClick();
  assert.equal(saved, 1, '重复点当前项不应再次写盘');
  assert.match(ctx.el.captureStatus.textContent, /已是当前选择/);
});

test('系统 SDR 亮度：只保留一个写盘入口，同步按钮已移除', () => {
  assert.equal(/id="sdr-sync-btn"/.test(popupHtml), false, '不应再有同步按钮');
  assert.equal(/sdrSyncBtn|syncSystemSdr|sdrSyncButton/.test(popup), false,
    'popup.js 不应残留同步按钮逻辑');
  assert.match(popup, /function applySdrCalibration\(\)/);
  assert.match(popup, /const cal = applySdrCalibration\(\);/);
  assert.match(popup, /const ok = await save\(\);/);
});

test('推荐输入步骤：空值 / 非数字 / 越界分别给出字段错误', () => {
  const start = popup.indexOf('  function readRecommendedInputs() {');
  const end = popup.indexOf('  function showRecommendedErrors');
  assert.ok(start > 0 && end > start);
  const block = popup.slice(start, end);

  const ctx = {
    HDRSettings: S,
    el: { recommendedPeak: { value: '' }, recommendedSdr: { value: '' } },
    t: (k, f) => f,
    tf: (k, f, vars) => String(f).replace(/\{(\w+)\}/g,
      (m, key) => (vars && vars[key] !== undefined ? vars[key] : m)),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.fn = readRecommendedInputs;', ctx);

  let r = ctx.fn();
  assert.equal(r.ok, false);
  assert.match(r.errors.peak, /请输入显示器峰值/);
  assert.match(r.errors.sdr, /请输入系统 SDR 亮度/);

  ctx.el.recommendedPeak.value = 'abc';
  ctx.el.recommendedSdr.value = '35';
  r = ctx.fn();
  assert.equal(r.ok, false);
  assert.match(r.errors.peak, /整数/);

  ctx.el.recommendedPeak.value = '399';
  r = ctx.fn();
  assert.match(r.errors.peak, /400/);

  ctx.el.recommendedPeak.value = '401';
  r = ctx.fn();
  assert.match(r.errors.peak, /50/);

  ctx.el.recommendedPeak.value = '1000';
  ctx.el.recommendedSdr.value = '101';
  r = ctx.fn();
  assert.match(r.errors.sdr, /0.*100/);

  ctx.el.recommendedSdr.value = '35';
  r = ctx.fn();
  assert.equal(r.ok, true);
  assert.equal(r.peak, 1000);
  assert.equal(r.pct, 35);
});

// ---------- 1.2.31 / 1.2.32：全局应用推荐 ----------

test('全局推荐行为：字段覆盖完整，物理峰值与参考白来自输入', () => {
  const src = S.normalizeSettings({ hdrPeakNits: 1400, sdrSliderPercent: 60 });
  const before = JSON.stringify(src);
  const rec = S.GLOBAL_RECOMMENDED;

  for (const key of ['mappingMode', 'presetByMode', 'hdrSourceMode', 'canvasMode',
                     'capturePath', 'outputGain', 'dualLayer', 'deband', 'sharpen']) {
    assert.ok(key in rec, key + ' 应在全局推荐中');
  }
  assert.equal('hdrPeakNits' in rec, false, '显示器峰值不得被预设写死');
  assert.equal('sdrSliderPercent' in rec, false, '系统同步值不得被预设覆盖');
  assert.equal('calibration' in rec, false, '校准记录不得被预设清除');
  assert.equal(rec.mappingMode, 'bt2446a');
  assert.equal(rec.hdrSourceMode, 'auto');
  assert.equal(rec.dualLayer.enabled, true);
  assert.equal(rec.deband.enabled, true);
  assert.equal(rec.sharpen.enabled, false, 'deband 与 sharpen 互斥');
  assert.equal(S.GLOBAL_RECOMMENDED_SATURATION, 1.10);

  const applied = S.computeRecommended(src, 1000, 35).next;
  assert.equal(applied.hdrPeakNits, 1000);
  assert.equal(applied.sdrSliderPercent, 35);
  assert.equal(applied.hdrSourceMode, 'auto');
  assert.equal(applied.dualLayer.enabled, true);
  assert.equal(applied.deband.enabled, true);
  assert.equal(JSON.stringify(src), before, '不得改写入参');
});

test('全局推荐行为：应用后预设与曲线一致，saturation 不写入非法顶层字段', () => {
  const start = popup.indexOf('  // ★ 全局推荐设置：先让用户确认两个物理事实');
  const end = popup.indexOf('  // ★ 刷新 SDR 滑块的读数');
  assert.ok(start > 0 && end > start);
  const block = popup.slice(start, end);

  let fail = false;
  let saved = 0;
  const ctx = {
    HDRSettings: S,
    settings: S.normalizeSettings({ hdrPeakNits: 1200, sdrSliderPercent: 40, mappingMode: 'power' }),
    el: {
      applyRecommendedStatus: { textContent: '' },
      recommendedError: { textContent: '', hidden: true },
    },
    t: (k, f) => f,
    tf: (k, f, vars) => String(f).replace(/\{(\w+)\}/g,
      (m, key) => (vars && vars[key] !== undefined ? vars[key] : m)),
    activeGroup() { return ctx.settings[ctx.settings.mappingMode === 'bt2446a' ? 'bt2446a' : 'powerCurve']; },
    activePresets() { return ctx.settings.mappingMode === 'bt2446a' ? S.BT2446A_PRESETS : S.POWER_PRESETS; },
    render() {},
    save: async () => { saved++; return !fail; },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.fn = applyRecommended;', ctx);

  const p = ctx.fn(1000, 35).then((ok) => {
    assert.equal(ok, true);
    assert.equal(saved, 1);
    assert.equal(ctx.settings.hdrPeakNits, 1000);
    assert.equal(ctx.settings.sdrSliderPercent, 35);
    assert.equal(ctx.settings.mappingMode, 'bt2446a');
    assert.equal(ctx.settings.presetByMode.bt2446a, 'highDynamic');
    assert.equal(ctx.settings.bt2446a.targetWhite, 1.4, '预设值应写入当前曲线');
    assert.equal(ctx.settings.bt2446a.saturation, 1.10);
    assert.equal('saturation' in ctx.settings, false, '顶层不应出现无效 saturation 字段');
    assert.match(ctx.el.applyRecommendedStatus.textContent, /已应用/);
    assert.match(ctx.el.applyRecommendedStatus.textContent, /峰值 1000/);

    const snapshot = JSON.stringify(ctx.settings);
    fail = true;
    return ctx.fn(400, 90).then((ok2) => {
      assert.equal(ok2, false);
      assert.equal(JSON.stringify(ctx.settings), snapshot, '保存失败必须恢复原设置');
      assert.match(ctx.el.applyRecommendedStatus.textContent, /已恢复/);
      assert.match(ctx.el.recommendedError.textContent, /已恢复/);
    });
  });
  return p;
});

// ---------- 1.2.37：两条真机回归护栏 ----------

test('护栏①手工兼容字段白名单：真机逃生口不被全局推荐覆盖', () => {
  const guards = S.MANUAL_COMPAT_FIELDS;
  assert.equal(guards.length, 3);
  assert.equal(guards[0].field, 'capturePath');
  assert.equal(guards[1].field, 'canvasMode');
  assert.equal(guards[2].field, 'cropTopPx');

  // 只有明确的兼容态才被认领；默认值和非兼容态仍归推荐管
  const kept = S.manualCompatOverrides({
    capturePath: 'snapshot',
    canvasMode: 'sdr',
    cropTopPx: 16,
  });
  assert.equal(kept.capturePath, 'snapshot');
  assert.equal(kept.canvasMode, 'sdr');
  assert.equal(kept.cropTopPx, 16);
  assert.equal(Object.keys(S.manualCompatOverrides({
    capturePath: 'auto', canvasMode: 'auto', cropTopPx: 0,
  })).length, 0);

  // 推荐结果：三个逃生口原样保留，其他参数照常收敛
  const base = S.normalizeSettings({
    capturePath: 'snapshot',
    canvasMode: 'sdr',
    cropTopPx: 16,
    mappingMode: 'power',
    hdrPeakNits: 1400,
  });
  const before = JSON.stringify(base);
  const r = S.computeRecommended(base, 1000, 35);
  assert.equal(r.ok, true);
  assert.equal(r.next.capturePath, 'snapshot', '2D 快照不能被重置为 auto（1.2.33 回归）');
  assert.equal(r.next.canvasMode, 'sdr', '手选 8bit 画布不能被重置为 auto');
  assert.equal(r.next.cropTopPx, 16, '手工裁切不能被推荐清掉');
  assert.equal(r.next.mappingMode, 'bt2446a', '推荐本身仍须生效');
  assert.equal(r.next.hdrPeakNits, 1000, '物理峰值仍按输入写入');
  assert.equal(JSON.stringify(base), before, '不得改写入参');

  // 反向：非兼容态仍按推荐写
  const normal = S.computeRecommended(
    S.normalizeSettings({ capturePath: 'copy', canvasMode: 'auto', cropTopPx: 0 }), 1000, 35).next;
  assert.equal(normal.capturePath, 'auto');
  assert.equal(normal.canvasMode, 'auto');
});

test('护栏②写盘入口去重：同一语义只有一个入口，按钮不再成对', () => {
  // 1. SDR 百分比只有一个赋值点（1.2.28 滑块+同步 / 1.2.35 同步+保存都是这条）
  const writes = popup.match(/settings\.sdrSliderPercent\s*=/g) || [];
  assert.equal(writes.length, 1, 'SDR 百分比只能有一个写入点');

  // 2. setupListeners 内每个「写字段 + 立即 save」的入口，字段不得重叠
  const start = popup.indexOf('  function setupListeners() {');
  const end = popup.indexOf('  // ===== 保存状态机');
  assert.ok(start > 0 && end > start);
  const setup = popup.slice(start, end);
  const marks = [...setup.matchAll(/([\w.]+)\.addEventListener\('(\w+)'/g)];
  const owners = new Map();
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const body = setup.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : setup.length);
    if (!/\bsave\(|\bflushSave\(/.test(body)) continue;
    const control = m[1];
    // resetBtn 是整套配置的原子复位，语义与单项控件不同，允许写多字段
    if (control === 'el.resetBtn') continue;
    const fields = [...new Set([...body.matchAll(/settings\.(\w+)\s*=/g)].map((x) => x[1]))];
    for (const field of fields) {
      assert.equal(owners.has(field), false,
        field + ' 同时被 ' + owners.get(field) + ' 与 ' + control + ' 当作立即保存入口');
      owners.set(field, control);
    }
  }
  assert.ok(owners.size >= 6, '应覆盖主要单项控件，避免空跑');

  // 3. flushSave 的 click 入口唯一，且就是高级设置的保存按钮
  const flushClicks = marks.filter((m, i) => {
    const body = setup.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : setup.length);
    return m[2] === 'click' && /\bflushSave\(/.test(body);
  });
  assert.equal(flushClicks.length, 1);
  assert.match(flushClicks[0][1], /el\.advancedSave/);

  // 4. HTML 中不存在第二组同步/保存按钮
  assert.equal(/id="sdr-sync-btn"|id="advanced-save-2"/.test(popupHtml), false);
  assert.equal((popupHtml.match(/保存设置<\/button>/g) || []).length, 1);
});

// ---------- 1.2.38：状态诊断护栏③ ----------

test('护栏③状态诊断：字段齐全且 GET_STATUS 带回 diag', () => {
  const content = read('src/content/controller.js');
  const renderers = read('src/content/renderers.js');

  // content 端：GET_STATUS 必须同时回 status / diag / v（1.2.39 加版本）
  const hm = content.indexOf('case MESSAGE_TYPES.GET_STATUS:');
  const hmEnd = content.indexOf('break;', hm);
  assert.ok(hm > 0 && hmEnd > hm);
  const hmBlock = content.slice(hm, hmEnd);
  assert.match(hmBlock, /status: this\.getStatus\(\)/);
  assert.match(hmBlock, /diag: this\.getDiagnostics\(\)/);
  assert.match(hmBlock, /v: this\.getScriptVersion\(\)/);
  assert.ok(content.includes('getDiagnostics()'));
  assert.ok(content.includes('getScriptVersion()'));

  // renderer 诊断字段缺失即失败
  const d0 = renderers.indexOf('  readDiagnostics() {');
  const d1 = renderers.indexOf('  // ★ P2-11', d0);
  assert.ok(d0 > 0 && d1 > d0, 'VideoRenderer.readDiagnostics() 必须存在');
  const diagBlock = renderers.slice(d0, d1);
  for (const field of [
    'path', 'reason', 'configured', 'padded', 'coded', 'visible',
    'greenRows', 'manualCrop', 'hdrMode', 'canvas', 'failed', 'destroyed', 'tainted', 'drm',
  ]) {
    assert.ok(new RegExp('\\b' + field + '\\b').test(diagBlock),
      '诊断字段缺失: ' + field);
  }

  // popup 端：5 行节点 + 渲染函数 + fetchStatus 接收 diag
  for (const id of ['diag-toggle', 'diag-body', 'diag-source', 'diag-path', 'diag-padded',
                    'diag-green', 'diag-hdr', 'diag-counts', 'diag-error', 'diag-error-row',
                    'diag-copy', 'diag-save']) {
    assert.ok(popupHtml.includes('id="' + id + '"'), 'popup.html 缺少诊断节点: ' + id);
  }
  assert.match(popup, /function renderDiagnostics\(\)/);
  assert.match(popup, /lastDiag = response\?\.diag \|\| null/);
  assert.match(popup, /if \(typeof renderDiagnostics === 'function'\) renderDiagnostics\(\)/);
});

test('状态诊断行为：readDiagnostics 正确区分用户快照/补齐降级/绿边裁切', () => {
  const start = read('src/content/renderers.js').indexOf('  readDiagnostics() {');
  const contentSrc = read('src/content/renderers.js');
  const end = contentSrc.indexOf('  // ★ P2-11', start);
  // 类方法简写在 vm 顶层不是合法函数声明，补 function 关键字
  const block = contentSrc.slice(start, end).replace(
    '  readDiagnostics() {', '  function readDiagnostics() {');

  const ctx = {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.fn = readDiagnostics;', ctx);

  function make(overrides) {
    return Object.assign({
      probe: { padded: false, codedWidth: 0, codedHeight: 0, visibleWidth: 0, visibleHeight: 0 },
      settings: { capturePath: 'auto', cropTopPx: 0 },
      useExternalTexture: true,
      _autoSnapshot: false,
      _cropTopPx: 0,
      _cropDetected: false,
      _manualCrop: 0,
      hdrMode: 0,
      canvasFormat: 'rgba8unorm',
      failed: false, destroyed: false, tainted: false, drmProtected: false,
    }, overrides);
  }

  let d = ctx.fn.call(make({}));
  assert.equal(d.path, 'external');
  assert.equal(d.padded, false);

  d = ctx.fn.call(make({
    settings: { capturePath: 'snapshot', cropTopPx: 0 }, useExternalTexture: false,
  }));
  assert.equal(d.path, 'snapshot');
  assert.equal(d.reason, 'user');

  d = ctx.fn.call(make({
    useExternalTexture: false, _autoSnapshot: true,
    probe: { padded: true, codedWidth: 1920, codedHeight: 1088, visibleWidth: 1920, visibleHeight: 1080 },
  }));
  assert.equal(d.reason, 'padded');
  assert.equal(d.coded, '1920x1088');
  assert.equal(d.visible, '1920x1080');

  d = ctx.fn.call(make({
    useExternalTexture: false, _cropDetected: true, _cropTopPx: 8,
  }));
  assert.equal(d.reason, 'green-band');

  d = ctx.fn.call(make({
    useExternalTexture: false, _manualCrop: 16, settings: { capturePath: 'auto', cropTopPx: 16 },
  }));
  assert.equal(d.reason, 'manual-crop');
});

// ---------- 1.2.39：诊断块空态必须自证 ----------

test('诊断块空态自证：连接状态逐种情况给出原因，而不是一排「—」', () => {
  const src = read('src/popup/popup.js');
  const s = src.indexOf('  function diagFill(');
  const e = src.indexOf('  function renderDiagnostics()');
  assert.ok(s > 0 && e > s, 'buildDiagRows() 必须存在');
  const block = src.slice(s, e);

  const ctx = {
    EXT_VERSION: '1.2.39',
    lastConn: { state: 'idle', version: '' },
    lastDiag: null,
    lastSave: { state: 'idle', text: '' },
    t: (k, f) => f,
    tf: (k, f, vars) => f.replace(/\{(\w+)\}/g, (m, x) => (vars && vars[x] !== undefined ? vars[x] : m)),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.fn = buildDiagRows;', ctx);

  const rows = () => {
    const map = {};
    for (const r of ctx.fn()) map[r.id] = r;
    return map;
  };

  // 1) 还没查询：连接状态显示未知，「最近保存」有明确文案而不是「—」
  let r = rows();
  assert.equal(r.diagSource.value, '—');
  assert.equal(r.diagPath.value, '');
  assert.equal(r.diagSave.value, '本次未保存');
  assert.equal(r.diagError.value, '', '管线错误为空时不得占位');

  // 2) 内容脚本孤儿 / 超时
  for (const state of ['no_receiver', 'timeout']) {
    ctx.lastConn = { state, version: '' };
    r = rows();
    assert.match(r.diagSource.value, /未响应/);
    assert.equal(r.diagPath.value, '');
  }

  // 3) 能回包但没带版本 → 旧脚本
  ctx.lastConn = { state: 'ok', version: '' };
  assert.match(rows().diagSource.value, /版本未知/);

  // 4) 版本不一致 → 必须提示刷新
  ctx.lastConn = { state: 'ok', version: '1.2.30' };
  assert.match(rows().diagSource.value, /请刷新页面/);

  // 5) 版本一致但页面无视频
  ctx.lastConn = { state: 'ok', version: '1.2.39' };
  assert.match(rows().diagSource.value, /无有效视频/);

  // 6) 正常：路径带多视频标识，计数行完整
  ctx.lastDiag = {
    videoTotal: 3,
    videoIndex: 2,
    pipelineError: '',
    counts: { videos: 3, hdr: 1, crossOrigin: 0, drm: 0, codecFailed: 0 },
    video: {
      path: 'snapshot', reason: 'padded', padded: true,
      coded: '1920x1088', visible: '1920x1080',
      greenRows: null, manualCrop: 0, hdrMode: 0, canvas: 'rgba8unorm',
    },
  };
  r = rows();
  assert.match(r.diagSource.value, /脚本 1\.2\.39/);
  assert.match(r.diagPath.value, /snapshot · padded/);
  assert.match(r.diagPath.value, /第 2\/3 个视频/);
  assert.match(r.diagPadded.value, /1920x1088 → 1920x1080/);
  assert.match(r.diagCounts.value, /视频 3 · HDR 1/);
  assert.equal(r.diagError.value, '');

  // 7) 管线错误出现时必须占位且有值
  ctx.lastDiag.pipelineError = 'WGSL compile failed';
  r = rows();
  assert.equal(r.diagError.value, 'WGSL compile failed');
  assert.equal(r.diagError.hideIfEmpty, true);
  assert.equal(r.diagError.rowId, 'diagErrorRow');

  // 8) 渲染与复制共用同一份行数据（复制不得另取一套字段）
  assert.match(src, /function buildDiagRows\(\)/);
  assert.match(src, /for \(const row of buildDiagRows\(\)\)/);
  assert.match(src, /const rows = buildDiagRows\(\)\.filter\(\(r\) => r\.value\)/);
});

// ---------- 1.2.40：绿边行的语义不能被读成「查过、没问题」 ----------

test('绿边检测行：快照/直拷路径不适用，external 未检出只代表可见区', () => {
  const src = read('src/popup/popup.js');
  const s = src.indexOf('  function diagFill(');
  const e = src.indexOf('  function renderDiagnostics()');
  const block = src.slice(s, e);

  const ctx = {
    EXT_VERSION: '1.2.40',
    lastConn: { state: 'ok', version: '1.2.40' },
    lastSave: { state: 'idle', text: '' },
    t: (k, f) => f,
    tf: (k, f, vars) => f.replace(/\{(\w+)\}/g, (m, x) => (vars && vars[x] !== undefined ? vars[x] : m)),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.fn = buildDiagRows;', ctx);

  const green = (video) => {
    ctx.lastDiag = {
      videoTotal: 1, videoIndex: 1, pipelineError: '',
      counts: { videos: 1, hdr: 0, crossOrigin: 0, drm: 0, codecFailed: 0 },
      video: Object.assign({
        path: 'external', reason: 'zero-copy', padded: false,
        coded: '', visible: '', greenRows: 0, manualCrop: 0,
        hdrMode: 0, canvas: 'rgba16float',
      }, video),
    };
    return ctx.fn().find((r) => r.id === 'diagGreen').value;
  };

  // 快照/直拷：根本不存在填充行，不能显示「未检出」
  assert.match(green({ path: 'snapshot' }), /不适用/);
  assert.match(green({ path: 'copy' }), /不适用/);

  // external：未检测 / 未检出（仅可见区）/ 检出
  assert.match(green({ path: 'external', greenRows: null }), /未检测/);
  assert.match(green({ path: 'external', greenRows: 0 }), /仅可见区/);
  assert.match(green({ path: 'external', greenRows: 8 }), /检出 8px/);

  // 用户手裁优先于路径判断
  assert.match(green({ path: 'snapshot', manualCrop: 16 }), /手工裁切 16px/);
});

// ---------- 1.2.41：取帧卡片的三种结果都必须有可见反馈 ----------

test('取帧卡片反馈：已选中 / 保存中 / 已保存 / 失败各有文案，且不再静默返回', () => {
  assert.match(popupHtml, /id="capture-status"/);

  // 已选中的分支必须给出提示，而不是裸 return
  const sameBranch = popup.match(
    /if \(\(settings\.capturePath \|\| 'auto'\) === mode\.key\) \{\s*\n\s*setCaptureStatus\(tf\('captureSame'/);
  assert.ok(sameBranch, '点击已选中的卡片必须提示「已是当前选择」');

  for (const key of ['captureSame', 'captureSaving', 'captureSaved', 'captureSaveFailed']) {
    assert.ok(popup.includes("tf('" + key + "'"), '缺少反馈文案调用: ' + key);
  }

  // 保存结果必须真正参与文案：成功与失败分支都要出现
  assert.match(popup, /task\.then\(\(ok\) => \{/);
  assert.match(popup, /ok\s*\n?\s*\? tf\('captureSaved'/);

  // 中英键必须齐全，否则真机上 tf() 会退回中文兜底
  for (const loc of ['zh_CN', 'en']) {
    const msgs = JSON.parse(read('_locales/' + loc + '/messages.json'));
    for (const key of ['captureSame', 'captureSaving', 'captureSaved', 'captureSaveFailed']) {
      assert.ok(msgs[key] && msgs[key].message, loc + ' 缺少 ' + key);
    }
  }
});

// ---------- P4-2：uniform 布局三文件隐式契约的静态校验 ----------
// 背景：UNIFORM_FIELDS(shaders.js) → U 索引 → computeUniformData(utils.js) 的
// 46 处 out[U.xxx] → WGSL struct。字段名写错时 U.xxx === undefined，
// out[undefined] = v 是静默失败（写到数组字符串属性上），表现为画面异常而非报错。
// 这里把契约变成可校验的：任何字段引用必须从 UNIFORM_FIELDS 中来。

function parseUniformFields() {
  const m = content.match(/const UNIFORM_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(m, '应能定位 UNIFORM_FIELDS 定义');
  return [...m[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1]);
}

test('P4-2 契约：computeUniformData 的所有 U.xxx 引用都在 UNIFORM_FIELDS 中', () => {
  const fields = parseUniformFields();
  const declared = new Set(fields);
  assert.ok(fields.length >= 36 && fields.length <= 64, '字段数应在 shader 自检范围内');

  // U 必须由字段表生成，不能手写索引表（手写会与字段表漂移）
  assert.ok(/const U = Object\.fromEntries\(UNIFORM_FIELDS\.map\(/.test(content),
    'U 必须由 UNIFORM_FIELDS 推导，禁止手写索引');

  // 提取 computeUniformData 函数体
  const start = content.indexOf('function computeUniformData(');
  const end = content.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start, '应能定位 computeUniformData');
  const body = content.slice(start, end);

  const refs = [...body.matchAll(/\bU\.([A-Za-z0-9_]+)/g)].map((x) => x[1]);
  assert.ok(refs.length >= 40, '应覆盖主要 uniform 字段，实际 ' + refs.length);

  const unknown = [...new Set(refs)].filter((name) => !declared.has(name));
  assert.deepEqual(unknown, [], '存在未声明的 uniform 字段引用（会静默失败）: ' + unknown.join(', '));

  // 反向：字段表里每个非占位字段都应被赋值（_pad* 单独放行）
  const assigned = new Set(refs);
  const neverAssigned = fields.filter((f) => !f.startsWith('_pad') && !assigned.has(f));
  assert.deepEqual(neverAssigned, [], '字段已声明但从未被 computeUniformData 赋值: ' + neverAssigned.join(', '));
});

test('P4-2 契约行为：uniform 字段真实写入浮点数组且不产生字符串属性', () => {
  const fields = parseUniformFields();

  // WGSL struct 由 UNIFORM_FIELDS 运行时生成（单一来源），这里验证生成式而非字面字段
  const m = content.match(/const uniformsDecl = `([\s\S]*?)`;/);
  assert.ok(m, '应能定位 uniformsDecl');
  assert.ok(/\$\{UNIFORM_FIELDS\.map/.test(m[1]),
    'WGSL struct 必须由 UNIFORM_FIELDS 生成，禁止另写一份字段表');

  // 用整包运行时执行真实 computeUniformData（所有依赖已在 bundle 内）。
  // 切片 vm 会因 resolveToneTargets 等前置函数缺失而失败，整包才是线上真实形态。
  const R = loadRenderRuntime();
  const U = R.U;
  const out = new Float32Array(fields.length);
  const settings = S.normalizeSettings({});
  R.computeUniformData(settings, 1920, 1080, 1 / 1920, 1 / 1080, 0, null, out, null);

  // 每个非占位字段都应被写入有限数值
  const bad = fields.filter((f) => !f.startsWith('_pad') && !Number.isFinite(out[U[f]]));
  assert.deepEqual(bad, [], '以下字段未被写入有效值: ' + bad.join(', '));

  // 关键字段的实际取值（验证写入的是正确索引，不是错位）
  assert.equal(out[U.exposureMultiplier], 1, 'exposure=0 → 2^0 = 1');
  assert.ok(out[U.saturation] > 0, 'saturation 应被写入正值');
  assert.equal(out[U.outputGain], 1, '默认整体强度应为 1');
  assert.equal(out[U.canvasWidth], 1920);
  assert.equal(out[U.canvasHeight], 1080);

  // ★ 静默失败的核心证据：Float32Array 上不应出现字符串键
  const strKeys = Object.keys(out).filter((k) => !/^\d+$/.test(k));
  assert.deepEqual(strKeys, [], '出现字符串属性，说明某个 U.xxx 未定义（字段名写错）');

  // 缓冲大小必须从字段数推导，禁止硬编码
  assert.ok(/const UNIFORM_FLOATS = UNIFORM_FIELDS\.length;/.test(content));
  assert.ok(/const UNIFORM_BYTES = UNIFORM_FLOATS \* 4;/.test(content));
});

test('P4-2 契约：依赖断言覆盖所有被跨文件引用的共享符号', () => {
  const start = content.indexOf('function assertContentDependencies() {');
  const end = content.indexOf('const CONTENT_DEPS_MISSING', start);
  const block = content.slice(start, end);
  const names = [...block.matchAll(/^\s{4}(\w+): typeof/gm)].map((m) => m[1]);

  // 首版 17 项；补齐后应覆盖 shared-resources / tone-lut / core 的关键符号
  assert.ok(names.length >= 38, '依赖断言应覆盖 38+ 符号，实际 ' + names.length);
  for (const required of [
    'ToneLutManager', 'videoShaderCode', 'imageShaderCode',
    'UNIFORM_FLOATS', 'LUT_SIZE', 'STATUS', 'MESSAGE_TYPES',
    'pickTier', 'debouncedScan', 'GPU_ERROR_LIMIT',
  ]) {
    assert.ok(names.includes(required), '依赖断言缺少: ' + required);
  }

  // 断言结果必须进入诊断，真机才能自证
  assert.ok(/depsMissing:/.test(content), 'getDiagnostics 应暴露 depsMissing');
});

// ---------- P4-2：popup ↔ SW ↔ content 端到端往返（补 §23 点名的最大盲区） ----------
// 首版测试把三层各自关在独立 vm ctx 里，从没有一条用例把
// SET_SETTINGS → storage + 广播 → content 消费 → GET_STATUS 回传串起来。
// 这里用同一条消息总线串起三层，验证配置能闭环到达渲染器诊断。

test('P4-2 行为：设置从 popup 写盘、广播到 content、再由 GET_STATUS 回到 popup', async () => {
  // ---- 共享消息总线 ----
  const store = {};
  const listeners = [];
  const sent = [];
  const tabMessages = [];
  const chromeStub = {
    runtime: {
      getManifest: () => ({ version: '1.2.42' }),
      sendMessage: (msg) => {
        sent.push(msg);
        // SW 的监听器返回 true 表示异步响应，真实响应走 sendResponse 回调
        let response;
        for (const fn of listeners) {
          const reply = (r) => { response = r; };
          fn(msg, {}, reply);
        }
        // 等一个 tick 让 handleMessage 的 Promise 兑现并回调 reply
        return new Promise((resolve) => setTimeout(() => resolve(response || {}), 0));
      },
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (obj) => Object.assign(store, obj),
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://example.com/video' }],
      sendMessage: (tabId, msg) => {
        tabMessages.push({ tabId, msg });
        return Promise.resolve();
      },
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };

  // ---- 加载 SW（真实 handleMessage / enqueueSettingsUpdate / notifyContentScripts）----
  // importScripts 加载的 shared 符号用测试里已初始化的 S / HdrToneMath 注入
  const swCtx = {
    chrome: chromeStub, console, Promise, setTimeout, clearTimeout,
    HDRSettings: S,
    HdrToneMath: ctx.HdrToneMath,
    importScripts: () => {},
  };
  swCtx.globalThis = swCtx;
  vm.createContext(swCtx);
  vm.runInContext(sw, swCtx);
  await swCtx.handleMessage({ type: 'GET_SETTINGS' }); // 触发一次读，确认初始状态

  // ---- 加载 content controller（真实 onMessage + getDiagnostics）----
  const h = loadControllerHarness(async (adapter) => adapter);
  const controller = new h.Ctrl();
  controller.settings = S.normalizeSettings({});

  // ---- popup 侧：saveNow 发 SET_SETTINGS ----
  const saveCtx = makeSaveContext({ response: { success: true } });
  saveCtx.ctx.chrome.runtime.sendMessage = chromeStub.runtime.sendMessage;
  const changed = saveCtx.ctx.settings;
  changed.capturePath = 'snapshot';
  changed.outputGain = 1.35;
  saveCtx.ctx.api.save();
  await new Promise((r) => setTimeout(r, 0));

  // ---- 断言 1：写盘落库，且带上版本号 ----
  assert.ok(store.hdr_vision_global, '配置应写入 storage');
  assert.equal(store.hdr_vision_global.capturePath, 'snapshot');
  assert.equal(store.hdr_vision_global.outputGain, 1.35);
  assert.ok(store.hdr_vision_global._version, '保存时应写入 _version');

  // ---- 断言 2：广播到 content，且只发主 frame ----
  const updated = tabMessages.find((m) => m.msg.type === 'SETTINGS_UPDATED');
  assert.ok(updated, '应向标签页广播 SETTINGS_UPDATED');
  assert.equal(updated.msg.data.settings.capturePath, 'snapshot');
  assert.equal(updated.tabId, 1);

  // ---- 断言 3：content 收到广播后，GET_STATUS 带回 diag 与版本 ----
  controller.onSettingsUpdated(updated.msg.data.settings);
  await new Promise((r) => setTimeout(r, 0));
  // 直接调 controller 的诊断方法（GET_STATUS 分支的数据来源）
  const status = controller.getStatus();
  const diag = controller.getDiagnostics();
  assert.equal(typeof status, 'string', 'getStatus 返回状态枚举');
  assert.ok(diag && typeof diag === 'object', 'getDiagnostics 返回对象');
  assert.ok('depsMissing' in diag, '诊断应携带依赖状态字段');
  assert.equal(diag.status, status, 'diag.status 与 getStatus 一致');

  // ---- 断言 4：popup 读回时拿到的是刚写入的值（队列串行的结果）----
  const readBack = await chromeStub.runtime.sendMessage({ type: 'GET_SETTINGS' });
  assert.equal(readBack.settings.capturePath, 'snapshot');
  assert.equal(readBack.settings.outputGain, 1.35);
});

test('P4-2 行为：依赖缺失随诊断回到 popup 的连接状态行', () => {
  const start = popup.indexOf('  function diagFill(');
  const end = popup.indexOf('  function renderDiagnostics()');
  assert.ok(start > 0 && end > start);
  const block = popup.slice(start, end);
  const ctx = {
    EXT_VERSION: '1.2.42',
    lastConn: { state: 'ok', version: '1.2.42' },
    lastSave: { state: 'idle', text: '' },
    lastDiag: {
      videoTotal: 1, videoIndex: 1, pipelineError: '',
      depsMissing: ['ToneLutManager', 'LUT_SIZE'],
      counts: { videos: 1 }, video: null,
    },
    t: (k, f) => f,
    tf: (k, f, vars) => f.replace(/\{(\w+)\}/g, (m, x) => (vars && vars[x] !== undefined ? vars[x] : m)),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.fn = buildDiagRows;', ctx);
  const row = ctx.fn().find((r) => r.id === 'diagSource');
  assert.match(row.value, /依赖缺失/);
  assert.match(row.value, /ToneLutManager/);
  assert.match(row.value, /LUT_SIZE/);

  // 正常路径（depsMissing 为 null）必须保持原文案，不能被新分支污染
  ctx.lastDiag.depsMissing = null;
  vm.runInContext('this.fn = buildDiagRows;', ctx);
  const normal = ctx.fn().find((r) => r.id === 'diagSource');
  assert.match(normal.value, /脚本 1\.2\.42/);
  assert.doesNotMatch(normal.value, /依赖缺失/);
});
