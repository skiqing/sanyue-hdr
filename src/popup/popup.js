(function () {
  'use strict';

  // ★ sRGB 标准解码函数
  function srgbDecode(x) {
    if (x <= 0.04045) return x / 12.92;
    return Math.pow((x + 0.055) / 1.055, 2.4);
  }

  // Phase 0 / P0-2：预设与默认值来自共享 schema，popup 不再持有一份副本。
  const HDRSettings = globalThis.HDRSettings;
  const POWER_PRESETS = HDRSettings.POWER_PRESETS;
  const BT2446A_PRESETS = HDRSettings.BT2446A_PRESETS;
  const DEFAULT_SETTINGS = HDRSettings.DEFAULT_SETTINGS;

  const MESSAGE_TYPES = {
    GET_SETTINGS: 'GET_SETTINGS',
    SET_SETTINGS: 'SET_SETTINGS',
    GET_STATUS: 'GET_STATUS',
  };

  // P2-9：内容脚本主线程繁忙时 sendMessage 可能一直不回包，
  // 状态区会停在默认文案。超过 2s 按「无接收方」处理并清掉定时器。
  const STATUS_TIMEOUT_MS = 2000;
  const STATUS_SENTINEL_TIMEOUT = '__status_timeout__';

  // 1.2.39：popup 自己的版本，用来和内容脚本回报的版本比对。
  //   扩展重载但页面没刷新时，页面里的脚本仍是旧版：它能回消息，但字段会缺，
  //   诊断块必须把这种情况显式说出来，而不是显示一排「—」。
  const EXT_VERSION = (() => {
    try {
      return chrome.runtime.getManifest().version || '';
    } catch {
      return '';
    }
  })();

  const el = {
    statusIndicator: document.getElementById('status-indicator'),
    statusText: document.getElementById('status-text'),
    diagToggle: document.getElementById('diag-toggle'),
    diagBody: document.getElementById('diag-body'),
    diagPath: document.getElementById('diag-path'),
    diagPadded: document.getElementById('diag-padded'),
    diagGreen: document.getElementById('diag-green'),
    diagHdr: document.getElementById('diag-hdr'),
    diagSource: document.getElementById('diag-source'),
    diagCounts: document.getElementById('diag-counts'),
    diagError: document.getElementById('diag-error'),
    diagErrorRow: document.getElementById('diag-error-row'),
    diagCopy: document.getElementById('diag-copy'),
    diagSave: document.getElementById('diag-save'),
    hdrToggle: document.getElementById('hdr-toggle'),
    modeCards: document.querySelectorAll('.mode-card'),
    presetList: document.getElementById('preset-list'),
    presetsSection: document.getElementById('presets-section'),
    advancedToggle: document.getElementById('advanced-toggle'),
    advancedPanel: document.getElementById('advanced-panel'),
    advancedSave: document.getElementById('advanced-save'),
    advancedSaveBar: document.getElementById('advanced-save-bar'),
    advancedSaveHint: document.getElementById('advanced-save-hint'),

    sdrSlider: document.getElementById('sdr-slider'),
    sdrSliderValue: document.getElementById('sdr-slider-value'),
    sdrNits: document.getElementById('sdr-nits'),
    sdrItem: document.getElementById('sdr-item'),
    sdrHint: document.getElementById('sdr-hint'),
    calibrationStatus: document.getElementById('calibration-status'),
    applyRecommendedBtn: document.getElementById('apply-recommended-btn'),
    applyRecommendedStatus: document.getElementById('apply-recommended-status'),

    // 1.2.32：应用推荐前的物理参数输入步骤
    recommendedModal: document.getElementById('recommended-modal'),
    recommendedPeak: document.getElementById('recommended-peak'),
    recommendedSdr: document.getElementById('recommended-sdr'),
    recommendedPeakField: document.getElementById('recommended-peak-field'),
    recommendedSdrField: document.getElementById('recommended-sdr-field'),
    recommendedPeakError: document.getElementById('recommended-peak-error'),
    recommendedSdrError: document.getElementById('recommended-sdr-error'),
    recommendedPreview: document.getElementById('recommended-preview'),
    recommendedCaptureNote: document.getElementById('recommended-capture-note'),
    recommendedWarning: document.getElementById('recommended-warning'),
    recommendedError: document.getElementById('recommended-error'),
    recommendedConfirm: document.getElementById('recommended-confirm'),
    recommendedCancel: document.getElementById('recommended-cancel'),
    recommendedClose: document.getElementById('recommended-close'),

    exposure: document.getElementById('exposure'),
    exposureValue: document.getElementById('exposure-value'),
    saturation: document.getElementById('saturation'),
    saturationValue: document.getElementById('saturation-value'),
    peakBrightness: document.getElementById('peak-brightness'),
    peakBrightnessValue: document.getElementById('peak-brightness-value'),
    peakBrightnessDesc: document.getElementById('peak-brightness-desc'),
    peakBrightnessActual: document.getElementById('peak-brightness-actual'),
    peakBrightnessItem: document.getElementById('peak-brightness-item'),

    bt2446aSettings: document.getElementById('bt2446a-settings'),
    powerSettings: document.getElementById('power-settings'),

    targetWhite: document.getElementById('target-white'),
    targetWhiteValue: document.getElementById('target-white-value'),
    targetMid: document.getElementById('target-mid'),
    targetMidValue: document.getElementById('target-mid-value'),
    toneTargetsActual: document.getElementById('tone-targets-actual'),

    brightnessThreshold: document.getElementById('brightness-threshold'),
    brightnessThresholdValue: document.getElementById('brightness-threshold-value'),
    maxBoost: document.getElementById('max-boost'),
    maxBoostValue: document.getElementById('max-boost-value'),
    shadowThreshold: document.getElementById('shadow-threshold'),
    shadowThresholdValue: document.getElementById('shadow-threshold-value'),
    shadowCrush: document.getElementById('shadow-crush'),
    shadowCrushValue: document.getElementById('shadow-crush-value'),

    // V1.2.5 真双层
    dualLayerToggle: document.getElementById('dual-layer-toggle'),
    dualRadius: document.getElementById('dual-radius'),
    dualRadiusValue: document.getElementById('dual-radius-value'),
    dualRadiusItem: document.getElementById('dual-radius-item'),
    dualDetail: document.getElementById('dual-detail'),
    dualDetailValue: document.getElementById('dual-detail-value'),
    dualDetailItem: document.getElementById('dual-detail-item'),

    debandToggle: document.getElementById('deband-toggle'),
    debandStrength: document.getElementById('deband-strength'),
    debandStrengthValue: document.getElementById('deband-strength-value'),
    debandStrengthItem: document.getElementById('deband-strength-item'),
    debandToggleItem: document.getElementById('deband-toggle-item'),

    sharpenToggle: document.getElementById('sharpen-toggle'),
    sharpenStrength: document.getElementById('sharpen-strength'),
    sharpenStrengthValue: document.getElementById('sharpen-strength-value'),
    sharpenStrengthItem: document.getElementById('sharpen-strength-item'),
    sharpenToggleItem: document.getElementById('sharpen-toggle-item'),

    renderScale: document.getElementById('render-scale'),
    renderScaleValue: document.getElementById('render-scale-value'),
    enhanceImages: document.getElementById('enhance-images'),

    hdrSourceMode: document.getElementById('hdr-source-mode'),
    canvasMode: document.getElementById('canvas-mode'),
    canvasEncoding: document.getElementById('canvas-encoding'),
    highlightCeiling: document.getElementById('highlight-ceiling'),
    highlightCeilingValue: document.getElementById('highlight-ceiling-value'),
    highlightCeilingHint: document.getElementById('highlight-ceiling-hint'),
    outputGain: document.getElementById('output-gain'),
    outputGainValue: document.getElementById('output-gain-value'),
    hdrPeak: document.getElementById('hdr-peak'),
    hdrPeakValue: document.getElementById('hdr-peak-value'),
    resetBtn: document.getElementById('reset-btn'),
    capturePathList: document.getElementById('capture-path-list'),
    captureStatus: document.getElementById('capture-status'),
    cropTopPx: document.getElementById('crop-top'),
    profileName: document.getElementById('profile-name'),
    profileSave: document.getElementById('profile-save'),
    profileList: document.getElementById('profile-list'),
    profileExport: document.getElementById('profile-export'),
    profileImport: document.getElementById('profile-import'),
    profileFile: document.getElementById('profile-file'),
    profileHint: document.getElementById('profile-hint'),
  };

  // ★ 配置快照：设置本身自动保存，这里存的是可切换/可导出的快照
  const PROFILE_KEY = 'hdr_vision_profiles_v1';
  const MAX_PROFILES = 20;
  const PROFILE_HINT = '设置本身会自动保存；这里是存成可切换的快照，方便备份、对比和回滚';

  let settings = HDRSettings.deepClone(DEFAULT_SETTINGS);
  let advancedDirty = false;  // 高级设置是否有未保存改动
  // 1.2.38：诊断快照。lastDiag 来自内容脚本，lastSave 来自 popup 本地保存状态机。
  let lastDiag = null;
  // 1.2.39：state = idle | ok | timeout | no_receiver | unsupported
  let lastConn = { state: 'idle', version: '' };
  let lastSave = { state: 'idle', text: '' };
  let settingsLoadFailed = false;  // P0-4：读取失败时禁止写盘，避免覆盖用户配置

  function t(key, fallback) {
    return chrome.i18n.getMessage(key) || fallback;
  }

  // P3-5：带 {name} 占位符的本地化文案
  function tf(key, fallback, vars) {
    const raw = String(chrome.i18n.getMessage(key) || fallback);
    return raw.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m));
  }

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((e) => {
      const key = e.getAttribute('data-i18n');
      const msg = chrome.i18n.getMessage(key);
      if (msg) e.textContent = msg;
    });
    if (el.recommendedClose) {
      el.recommendedClose.setAttribute('aria-label', t('recommendedCloseLabel', '关闭'));
    }
  }

  // Phase 0 / P0-2：normalize 与 service worker 共用同一份实现。
  const normalize = HDRSettings.normalizeSettings;

  function activeGroup() {
    return settings.mappingMode === 'bt2446a' ? settings.bt2446a : settings.powerCurve;
  }

  // P2-5：滑杆的 min/max/step 全部从 RANGES 生成，HTML 里不再写死数字。
  //   popup.html 只保留 data-range="键名"，这样「滑块能拖到的范围」与
  //   normalizeSettings / 渲染端夹紧的范围永远是同一份，不会出现
  //   「滑块停在 32、实际按 40 渲染」这类显示与生效不符的问题。
  function applyRanges() {
    const RANGES = HDRSettings.RANGES;
    const fmt = (v) => String(Number(v.toFixed(6)));   // 0.3*100 = 30.000000000000004
    for (const node of document.querySelectorAll('[data-range]')) {
      const key = node.dataset.range;
      const range = RANGES[key];
      if (!range) {
        console.warn('[HDR Vision] 未知的 data-range:', key);
        continue;
      }
      const scale = range.displayScale || 1;
      node.min = fmt(range.min * scale);
      node.max = fmt(range.max * scale);
      node.step = fmt(range.step * scale);
    }
  }

  // 读数用的同源夹紧（避免读数按 100..4000 算余量、滑块只能到 2000）
  function clampByRange(key, value, fallback) {
    const range = HDRSettings.RANGES[key];
    const n = Number(value);
    if (!isFinite(n)) return fallback;
    return range ? Math.min(Math.max(n, range.min), range.max) : n;
  }

  function activePresets() {
    return settings.mappingMode === 'bt2446a' ? BT2446A_PRESETS : POWER_PRESETS;
  }

  function activePresetKey() {
    const presets = activePresets();
    const key = settings.presetByMode[settings.mappingMode];
    // 预设可能被删除（如 v14 的 twoLayer）；不校验会让按钮全部失去高亮。
    if (key && presets[key]) return key;
    return presets.standard ? 'standard' : '';
  }

  // ===== 配置快照 =====
  function fmtTime(ts) {
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  async function readProfiles() {
    try {
      const res = await chrome.storage.local.get(PROFILE_KEY);
      const list = res?.[PROFILE_KEY];
      return Array.isArray(list) ? list.filter((p) => p && p.id && p.settings) : [];
    } catch {
      return [];
    }
  }

  async function writeProfiles(list) {
    try {
      await chrome.storage.local.set({ [PROFILE_KEY]: list });
      return true;
    } catch (e) {
      console.warn('[HDR Vision] 配置快照写入失败:', e);
      return false;
    }
  }

  let profileHintTimer = null;
  function flashProfileHint(text) {
    if (!el.profileHint) return;
    el.profileHint.textContent = text;
    el.profileHint.classList.add('setting-desc-strong');
    if (profileHintTimer) clearTimeout(profileHintTimer);
    profileHintTimer = setTimeout(() => {
      el.profileHint.textContent = PROFILE_HINT;
      el.profileHint.classList.remove('setting-desc-strong');
    }, 2600);
  }

  function renderProfiles(list) {
    if (!el.profileList) return;
    el.profileList.textContent = '';
    const sorted = list.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    for (const p of sorted) {
      const row = document.createElement('div');
      row.className = 'profile-item';

      const name = document.createElement('span');
      name.className = 'profile-name';
      name.textContent = p.name;
      name.title = p.name;

      const time = document.createElement('span');
      time.className = 'profile-time';
      time.textContent = fmtTime(p.ts);

      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'ghost-btn mini';
      applyBtn.textContent = '应用';
      applyBtn.addEventListener('click', () => applyProfile(p.id));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'ghost-btn mini';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => deleteProfile(p.id));

      row.append(name, time, applyBtn, delBtn);
      el.profileList.appendChild(row);
    }
  }

  async function saveProfile() {
    const typed = (el.profileName?.value || '').trim().slice(0, 24);
    const now = new Date();
    const fallback = `配置 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const name = typed || fallback;

    const list = await readProfiles();
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      ts: Date.now(),
      settings: HDRSettings.deepClone(settings),
    };
    const idx = list.findIndex((p) => p.name === name);
    if (idx >= 0) list[idx] = item;
    else list.push(item);

    const trimmed = list.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, MAX_PROFILES);
    const ok = await writeProfiles(trimmed);
    renderProfiles(trimmed);
    if (ok) {
      if (el.profileName) el.profileName.value = '';
      flashProfileHint(tf(idx >= 0 ? 'profileOverwritten' : 'profileSaved',
        idx >= 0 ? '已覆盖「{name}」' : '已保存「{name}」', { name }));
    } else {
      flashProfileHint(t('profileSaveFailed', '保存失败：浏览器存储不可用'));
    }
  }

  async function applyProfile(id) {
    const list = await readProfiles();
    const item = list.find((p) => p.id === id);
    if (!item) return;
    settings = normalize(item.settings);
    render();
    save();
    flashProfileHint(tf('profileApplied', '已应用「{name}」', { name: item.name }));
  }

  async function deleteProfile(id) {
    const list = await readProfiles();
    const item = list.find((p) => p.id === id);
    const next = list.filter((p) => p.id !== id);
    await writeProfiles(next);
    renderProfiles(next);
    if (item) flashProfileHint(tf('profileDeleted', '已删除「{name}」', { name: item.name }));
  }

  async function exportProfiles() {
    const list = await readProfiles();
    const payload = {
      app: 'HDR Vision',
      schema: 1,
      exportedAt: new Date().toISOString(),
      profiles: list,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `hdr-vision-profiles-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    flashProfileHint(list.length
      ? tf('profileExported', '已导出 {count} 个配置', { count: list.length })
      : t('profileExportEmpty', '当前没有配置，导出的是空列表'));
  }

  async function importProfiles(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      flashProfileHint(t('profileImportFailed', '导入失败：文件不是有效的 JSON'));
      return;
    }
    let incoming = [];
    if (Array.isArray(data)) incoming = data;
    else if (Array.isArray(data?.profiles)) incoming = data.profiles;
    else if (data && typeof data === 'object') {
      incoming = [{ name: t('profileImportedName', '导入配置'), settings: data }];
    }

    const list = await readProfiles();
    let added = 0;
    let skipped = 0;
    for (const raw of incoming) {
      const src = raw && typeof raw === 'object' ? (raw.settings ?? raw) : null;
      if (!src || typeof src !== 'object') { skipped++; continue; }
      const fallbackName = tf('profileImportSeq', '导入 {seq}', { seq: added + 1 });
      const name = String(raw.name || fallbackName).trim().slice(0, 24) || fallbackName;
      const item = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${added}`,
        name,
        ts: Date.now(),
        settings: normalize(src),
      };
      const idx = list.findIndex((p) => p.name === name);
      if (idx >= 0) list[idx] = item;
      else list.push(item);
      added++;
      if (added >= MAX_PROFILES) break;
    }

    const trimmed = list.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, MAX_PROFILES);
    await writeProfiles(trimmed);
    renderProfiles(trimmed);
    flashProfileHint(added
      ? (skipped
        ? tf('profileImportedSkipped', '已导入 {count} 个配置（跳过 {skipped} 项）', { count: added, skipped })
        : tf('profileImported', '已导入 {count} 个配置', { count: added }))
      : t('profileImportEmpty', '没有可导入的配置'));
  }

  async function loadSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.GET_SETTINGS });
      if (!response || !response.settings) throw new Error('空设置响应');
      settings = normalize(response.settings);
      settingsLoadFailed = false;
    } catch (e) {
      // P0-4：加载失败时只展示默认值用于阅读，禁止任何写盘路径，
      // 否则一次瞬时故障就会把 storage 里的真实配置覆盖成默认值。
      console.error('Failed to load settings:', e);
      settingsLoadFailed = true;
      settings = HDRSettings.deepClone(DEFAULT_SETTINGS);
    }
    render();
    if (settingsLoadFailed) {
      setSaveState('error', '无法读取设置，请重新打开扩展（不会覆盖已存配置）');
    }
  }

  // ★ 当前显示是否具备 HDR 输出能力（16float 扩展画布才有意义）
  function hdrDisplayActive() {
    try {
      return window.matchMedia('(dynamic-range: high)').matches === true;
    } catch {
      return false;
    }
  }

  // ★ 这个滑块在哪些配置下真的参与渲染
  function sdrSliderRelevant() {
    if (settings.hdrSourceMode !== 'off') return true;          // 接管 HDR 源：折算 SDR 白
    return settings.canvasMode === 'auto' && hdrDisplayActive(); // 16float 画布：决定高光余量
  }

  // ★ 校准状态：显示上次同步值、哪些字段被派生、哪些因为用户改过而跳过
  function updateCalibrationStatus() {
    if (!el.calibrationStatus) return;
    const cal = settings.calibration;
    if (!cal || cal.sdrPercent === null) {
      el.calibrationStatus.textContent = t('calibrationNever', '尚未同步系统亮度 · 当前按默认 35% 校准');
      return;
    }
    const derived = Object.keys(cal.derived || {}).map((key) => {
      if (key === 'sdrSliderPercent') return t('calibrationReferenceWhite', '系统参考白');
      if (key === 'highlightCeiling') return t('calibrationCeiling', '高光上限');
      return key;
    });
    const skipped = [];
    // skipped 不持久化，实时按「当前值是否仍等于上次派生值」判断，便于用户改回后自动恢复所有权
    if (cal.derived && cal.derived.highlightCeiling !== undefined &&
        settings.highlightCeiling !== cal.derived.highlightCeiling) {
      skipped.push(t('calibrationCeiling', '高光上限'));
    }
    const when = cal.appliedAt ? fmtTime(cal.appliedAt) : '';
    let text = t('calibrationApplied', '已同步 {pct}%（{nits} nits）{when}').
      replace('{pct}', String(cal.sdrPercent)).
      replace('{nits}', String(Math.round(cal.nits || HDRSettings.sliderToNits(cal.sdrPercent)))).
      replace('{when}', when ? ' · ' + when : '');
    if (derived.length) text += ' · ' + t('calibrationDerived', '已调整：{fields}').replace('{fields}', derived.join(' / '));
    if (skipped.length) text += ' · ' + t('calibrationSkipped', '保留你的设置：{fields}').replace('{fields}', skipped.join(' / '));
    el.calibrationStatus.textContent = text;
  }

  // ★ 全局推荐设置：先让用户确认两个物理事实，再一键配置所有可调参数。
  //   hdrPeakNits / sdrSliderPercent 只有用户知道；它们与真实余量一起决定
  //   白点 / 高光上限 / 整体强度该收敛到多少。保存失败整体回退。
  async function applyRecommended(peakNits, sdrPercent) {
    const result = HDRSettings.computeRecommended(settings, peakNits, sdrPercent);
    if (!result.ok) {
      if (el.recommendedError) {
        el.recommendedError.textContent = result.reason;
        el.recommendedError.hidden = false;
      }
      return false;
    }

    const snapshot = HDRSettings.deepClone(settings);
    settings = result.next;
    render();

    const ok = await save();
    if (!ok) {
      settings = snapshot;
      render();
      if (el.recommendedError) {
        el.recommendedError.textContent = t('applyRecommendedRollback', '保存失败，已恢复原设置');
        el.recommendedError.hidden = false;
      }
      if (el.applyRecommendedStatus) {
        el.applyRecommendedStatus.textContent = t('applyRecommendedRollback', '保存失败，已恢复原设置');
      }
      return false;
    }

    if (el.recommendedError) {
      el.recommendedError.textContent = '';
      el.recommendedError.hidden = true;
    }
    if (el.applyRecommendedStatus) {
      let text = tf('applyRecommendedDone',
        '已应用全局推荐：峰值 {peak} nits · 参考白 {nits} nits（{pct}%）· 白点 {white}× · 高光上限 {ceiling}×', {
          peak: result.peak,
          nits: result.nits,
          pct: result.sdrPercent,
          white: result.targetWhite.toFixed(2),
          ceiling: result.highlightCeiling.toFixed(2),
        });
      if (result.tuned.targetWhite || result.tuned.highlightCeiling || result.tuned.outputGain) {
        text += ' · ' + tf('applyRecommendedTuned', '已按物理余量 {headroom}× 收敛', {
          headroom: result.headroom.toFixed(2),
        });
      }
      if (result.next.capturePath === 'auto') {
        text += ' · ' + t('applyRecommendedGreenBandHint', '若出现顶部绿边：取帧改 2D 快照');
      }
      el.applyRecommendedStatus.textContent = text;
    }
    return true;
  }

  // ★ 输入步骤：校验 → 实时预览 → 确认后写盘。
  //   取消 / Esc / 点遮罩都只关闭弹层，不碰 settings。
  let recommendedSaving = false;

  function clearRecommendedErrors() {
    if (el.recommendedError) {
      el.recommendedError.textContent = '';
      el.recommendedError.hidden = true;
    }
    for (const [field, input, error] of [
      [el.recommendedPeakField, el.recommendedPeak, el.recommendedPeakError],
      [el.recommendedSdrField, el.recommendedSdr, el.recommendedSdrError],
    ]) {
      if (field) field.classList.remove('invalid');
      if (error) {
        error.textContent = '';
        error.hidden = true;
      }
      if (input) input.removeAttribute('aria-invalid');
    }
  }

  function readRecommendedInputs() {
    const peakRaw = String(el.recommendedPeak ? el.recommendedPeak.value : '').trim();
    const sdrRaw = String(el.recommendedSdr ? el.recommendedSdr.value : '').trim();
    const peakRange = HDRSettings.RANGES.hdrPeakNits;
    const sdrRange = HDRSettings.RANGES.sdrSliderPercent;
    const errors = {};
    let peak = null;
    let pct = null;

    if (!peakRaw) {
      errors.peak = t('recommendedErrPeakRequired', '请输入显示器峰值亮度');
    } else {
      peak = Number(peakRaw);
      if (!Number.isFinite(peak) || !Number.isInteger(peak)) {
        errors.peak = t('recommendedErrInteger', '请输入整数');
      } else if (peak < peakRange.min || peak > peakRange.max) {
        errors.peak = tf('recommendedErrPeakRange', '峰值需在 {min}–{max} nits 之间', {
          min: peakRange.min,
          max: peakRange.max,
        });
      } else if (peak % peakRange.step !== 0) {
        errors.peak = tf('recommendedErrPeakStep', '峰值需按 {step} nits 递增', {
          step: peakRange.step,
        });
      }
    }

    if (!sdrRaw) {
      errors.sdr = t('recommendedErrSdrRequired', '请输入系统 SDR 亮度');
    } else {
      pct = Number(sdrRaw);
      if (!Number.isFinite(pct) || !Number.isInteger(pct)) {
        errors.sdr = t('recommendedErrInteger', '请输入整数');
      } else if (pct < sdrRange.min || pct > sdrRange.max) {
        errors.sdr = tf('recommendedErrSdrRange', '系统 SDR 亮度需在 {min}–{max} 之间', {
          min: sdrRange.min,
          max: sdrRange.max,
        });
      }
    }

    return { ok: Object.keys(errors).length === 0, peak, pct, errors };
  }

  function showRecommendedErrors(errors) {
    const bind = (field, input, error, message) => {
      if (input && error) {
        error.textContent = message || '';
        error.hidden = !message;
        if (message) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
      }
      if (field) field.classList.toggle('invalid', !!message);
    };
    bind(el.recommendedPeakField, el.recommendedPeak, el.recommendedPeakError, errors.peak);
    bind(el.recommendedSdrField, el.recommendedSdr, el.recommendedSdrError, errors.sdr);
    const first = errors.peak ? el.recommendedPeak : (errors.sdr ? el.recommendedSdr : null);
    if (first) first.focus();
  }

  function updateRecommendedPreview() {
    if (!el.recommendedPreview) return;
    const peakRaw = String(el.recommendedPeak ? el.recommendedPeak.value : '').trim();
    const sdrRaw = String(el.recommendedSdr ? el.recommendedSdr.value : '').trim();
    const emptyText = t('recommendedPreviewEmpty', '填入两个数值后，这里会显示将写入的精细参数');

    if (!peakRaw || !sdrRaw) {
      el.recommendedPreview.textContent = emptyText;
      if (el.recommendedWarning) {
        el.recommendedWarning.textContent = '';
        el.recommendedWarning.hidden = true;
      }
      return;
    }

    const plan = HDRSettings.recommendedTargets(Number(peakRaw), Number(sdrRaw),
      settings.highlightCeiling);
    if (!plan.ok) {
      el.recommendedPreview.textContent = emptyText;
      if (el.recommendedWarning) {
        el.recommendedWarning.textContent = '';
        el.recommendedWarning.hidden = true;
      }
      return;
    }

    el.recommendedPreview.textContent = tf('recommendedPreview',
      '参考白 {nits} nits · 余量 {headroom}× · 白点 {white}× · 高光上限 {ceiling}× · 强度 {gain}×', {
        nits: plan.nits,
        headroom: plan.headroom.toFixed(2),
        white: plan.targetWhite.toFixed(2),
        ceiling: plan.highlightCeiling.toFixed(2),
        gain: plan.outputGain.toFixed(2),
      });

    const warnings = [];
    if (plan.headroom < 1) {
      warnings.push(tf('recommendedWarnLowPeak',
        '峰值低于参考白 {nits} nits，高光会被面板裁切；请调低系统亮度或核对峰值', {
          nits: plan.nits,
        }));
    } else if (plan.tuned.targetWhite || plan.tuned.highlightCeiling || plan.tuned.outputGain) {
      warnings.push(t('recommendedWarnTuned', '余量不足，白点 / 高光上限已按物理上限收敛'));
    }
    if (!hdrDisplayActive()) {
      warnings.push(t('recommendedWarnNoHdr',
        '当前显示器未报告 HDR 输出，白点会按 8bit 画布收敛到 1.25×'));
    }
    if (el.recommendedWarning) {
      el.recommendedWarning.textContent = warnings.join(' ');
      el.recommendedWarning.hidden = warnings.length === 0;
    }
  }

  function openRecommendedDialog() {
    if (!el.recommendedModal) return;
    if (el.recommendedPeak) el.recommendedPeak.value = String(settings.hdrPeakNits ?? 1000);
    if (el.recommendedSdr) el.recommendedSdr.value = String(settings.sdrSliderPercent ?? 35);
    clearRecommendedErrors();
    updateRecommendedPreview();
    if (el.recommendedCaptureNote) {
      el.recommendedCaptureNote.textContent = settings.capturePath === 'snapshot'
        ? t('recommendedKeepSnapshot',
          '当前取帧是「2D 快照」，应用推荐后会保留；这是顶部绿边的兼容设置。')
        : t('recommendedAutoGreenBand',
          '推荐会把取帧设为「自动」；B 站等 AV1/HEVC 源若出现顶部绿边，请手动改回「2D 快照」。');
    }
    el.recommendedModal.hidden = false;
    document.body.classList.add('modal-open');
    const appRoot = document.querySelector('.app');
    if (appRoot) appRoot.inert = true;
    if (el.applyRecommendedBtn) el.applyRecommendedBtn.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => {
      if (el.recommendedModal.hidden) return;
      if (el.recommendedPeak) {
        el.recommendedPeak.focus();
        el.recommendedPeak.select();
      }
    });
  }

  function closeRecommendedDialog() {
    if (!el.recommendedModal || recommendedSaving) return;
    el.recommendedModal.hidden = true;
    document.body.classList.remove('modal-open');
    const appRoot = document.querySelector('.app');
    if (appRoot) appRoot.inert = false;
    if (el.applyRecommendedBtn) {
      el.applyRecommendedBtn.setAttribute('aria-expanded', 'false');
      el.applyRecommendedBtn.focus();
    }
  }

  function setRecommendedBusy(busy) {
    recommendedSaving = busy;
    for (const node of [el.recommendedConfirm, el.recommendedCancel, el.recommendedClose]) {
      if (node) node.disabled = busy;
    }
    for (const node of [el.recommendedPeak, el.recommendedSdr]) {
      if (node) node.disabled = busy;
    }
    if (el.recommendedConfirm) {
      el.recommendedConfirm.textContent = busy
        ? t('recommendedApplying', '正在应用…')
        : t('recommendedConfirm', '确认并应用');
    }
  }

  async function submitRecommended() {
    if (recommendedSaving) return;
    const parsed = readRecommendedInputs();
    if (!parsed.ok) {
      showRecommendedErrors(parsed.errors);
      return;
    }
    clearRecommendedErrors();
    setRecommendedBusy(true);
    let ok = false;
    try {
      ok = await applyRecommended(parsed.peak, parsed.pct);
    } catch (e) {
      console.error('[HDR Vision] 应用推荐设置失败:', e);
      if (el.recommendedError) {
        el.recommendedError.textContent = t('applyRecommendedRollback', '保存失败，已恢复原设置');
        el.recommendedError.hidden = false;
      }
    } finally {
      setRecommendedBusy(false);
    }
    if (ok) closeRecommendedDialog();
  }

  // ★ 刷新 SDR 滑块的读数、可用状态与作用说明
  function updateSdrReadout() {
    const pct = clampByRange('sdrSliderPercent', settings.sdrSliderPercent ?? 35, 35);
    const nits = Math.round(HDRSettings.sliderToNits(pct));
    const peak = clampByRange('hdrPeakNits', settings.hdrPeakNits ?? 1000, 1000);
    const headroom = peak / Math.max(nits, 1);
    const relevant = sdrSliderRelevant();

    el.sdrSlider.value = pct;
    if (el.sdrSliderValue) el.sdrSliderValue.textContent = pct + '%';
    if (el.sdrNits) el.sdrNits.textContent = nits + ' nits';
    el.sdrSlider.disabled = !relevant;
    if (el.sdrItem) el.sdrItem.classList.toggle('disabled', !relevant);
    updateCeilingReadout();
    updateCalibrationStatus();
    if (!el.sdrHint) return;

    if (settings.hdrSourceMode !== 'off') {
      el.sdrHint.textContent =
        `接管 HDR 源：${nits} nits 是本扩展的 SDR 白，值越大 HDR 画面越暗`;
    } else if (settings.canvasMode === 'auto' && hdrDisplayActive()) {
      // 这里只回答「1.0× 值多少 nits」；额度（余量）与花费（上限）统一放到
      // 高光上限那一行，避免同一句话读起来像第二个高光上限。
      let text = `16float 画布：1.0× = ${nits} nits（参考白）`;
      if (headroom < 2) {
        const available = Math.max(1.0, Math.min(2.0, headroom));
        text += `；物理余量只有 ${headroom.toFixed(2)}×（峰值 ${peak} ÷ ${nits}），会把高光上限压到 ${available.toFixed(2)}×`;
      }
      el.sdrHint.textContent = text;
    } else {
      el.sdrHint.textContent =
        '当前配置不读取此值：8bit 画布没有超过 SDR 白的余量，且 HDR 源为跳过';
    }
  }

  // ★ 高光上限的「花费 / 额度」读数：你设的值 vs 物理允许的最大值
  //   额度 = 峰值 ÷ SDR 白，夹紧公式必须与渲染端 utils.js 完全一致：
  //   min(max(用户值, 1.0), max(1.0, min(2.0, 余量)))
  function updateCeilingReadout() {
    if (!el.highlightCeilingHint) return;
    const pct = clampByRange('sdrSliderPercent', settings.sdrSliderPercent ?? 35, 35);
    const nits = Math.round(HDRSettings.sliderToNits(pct));
    const peak = clampByRange('hdrPeakNits', settings.hdrPeakNits ?? 1000, 1000);
    const requested = clampByRange('highlightCeiling', settings.highlightCeiling ?? 1.2, 1.2);

    if (settings.hdrSourceMode !== 'off') {
      el.highlightCeilingHint.textContent =
        `HDR 源接管时不读取此值：解码后按「HDR 源输出峰值」${peak} nits 限幅`;
      return;
    }
    if (!(settings.canvasMode === 'auto' && hdrDisplayActive())) {
      el.highlightCeilingHint.textContent =
        `8bit 画布：实际白点固定 ${nits} nits，超过 1.00× 的部分会被裁成纯白`;
      return;
    }

    const headroom = peak / Math.max(nits, 1);
    const available = Math.max(1.0, Math.min(2.0, headroom));
    const effective = Math.min(requested, available);
    const whiteNits = Math.round(nits * effective);
    const maxNits = Math.round(nits * available);

    let text = `实际白点 ${effective.toFixed(2)}× ≈ ${whiteNits} nits`
      + `（${nits} × ${effective.toFixed(2)}）`
      + `；物理可用上限 ${available.toFixed(2)}× ≈ ${maxNits} nits`;
    if (requested > available + 1e-6) {
      text += `，当前 ${requested.toFixed(2)}× 会被夹到 ${available.toFixed(2)}×`;
    }
    el.highlightCeilingHint.textContent = text;
  }

  // ★ 与渲染端同一份求解器（tone-math.js 由 popup.html 先于本模块加载）
  function resolveTone(bt, hdrCanvas) {
    const TM = (typeof globalThis !== 'undefined') ? globalThis.HdrToneMath : null;
    if (TM && typeof TM.resolveTargets === 'function') return TM.resolveTargets(bt, hdrCanvas);
    return { white: 1.2, mid: 0.5, lift: 0.78 };  // 极端兜底，与 content 侧一致
  }

  // ★ 更新目标参数的实际落点 / 幂函数模式的白点显示
  function updateActualWhitePoint() {
    const isBT = settings.mappingMode === 'bt2446a';
    const sdrPercent = settings.sdrSliderPercent ?? 35;
    const sdrNits = Math.round(HDRSettings.sliderToNits(sdrPercent));

    if (isBT) {
      if (!el.toneTargetsActual) return;
      const hdrCanvas = settings.canvasMode === 'auto' && hdrDisplayActive();
      const bt = settings.bt2446a;
      const tone = resolveTone(bt, hdrCanvas);
      const whiteNits = Math.round(sdrNits * tone.white);
      const cap = hdrCanvas ? 2.0 : 1.25;
      el.toneTargetsActual.textContent =
        `实际落点 · 白点 ${tone.white.toFixed(2)}×（≈${whiteNits} nits）`
        + ` · 中调 ${tone.mid.toFixed(2)} · 反解强度 ${tone.lift.toFixed(2)}`
        + ((bt.targetWhite ?? 1.2) > cap ? '（已按画布能力收敛）' : '');
      if (el.peakBrightnessActual) el.peakBrightnessActual.textContent = '';
      return;
    }

    if (!el.peakBrightnessActual) return;
    const peak = settings.powerCurve.peakBrightness ?? 10.0;
    const displayMultiplier = srgbDecode(peak);
    const hdrNits = Math.round(sdrNits * displayMultiplier);
    el.peakBrightnessActual.textContent =
      `SDR 白点 ${sdrNits} nits × ${displayMultiplier.toFixed(2)} = HDR 白点 ≈ ${hdrNits} nits`;
  }

  // ★ 更新 deband / sharpen 的互斥状态
  function updateMutexState() {
    const debandOn = settings.deband.enabled;
    const sharpenOn = settings.sharpen.enabled;

    // 一个开启时，另一个的 toggle 禁用
    el.debandToggle.disabled = sharpenOn;
    el.sharpenToggle.disabled = debandOn;

    // 视觉上的灰色锁定
    el.debandToggleItem.classList.toggle('mutex-locked', sharpenOn);
    el.sharpenToggleItem.classList.toggle('mutex-locked', debandOn);

    // 强度滑块禁用：自身关闭，或另一个功能开启时禁用
    el.debandStrengthItem.classList.toggle('disabled', !debandOn || sharpenOn);
    el.sharpenStrengthItem.classList.toggle('disabled', !sharpenOn || debandOn);

    // 强度滑块本身也设置 disabled 属性（防止键盘操作）
    el.debandStrength.disabled = !debandOn || sharpenOn;
    el.sharpenStrength.disabled = !sharpenOn || debandOn;
  }

  // ★ 双层子项：开关关闭时半径/细节没有作用对象，置灰避免「拧了没反应」
  function updateDualState() {
    const on = !!settings.dualLayer?.enabled;
    el.dualRadiusItem.classList.toggle('disabled', !on);
    el.dualDetailItem.classList.toggle('disabled', !on);
    el.dualRadius.disabled = !on;
    el.dualDetail.disabled = !on;
  }

  function render() {
    const isBT = settings.mappingMode === 'bt2446a';
    el.hdrToggle.checked = settings.enabled;

    el.modeCards.forEach((card) => {
      if (card.dataset.mode === settings.mappingMode) card.classList.add('active');
      else card.classList.remove('active');
    });

    renderPresets();
    renderCapturePath();

    // SDR 滑块
    el.sdrSlider.value = settings.sdrSliderPercent ?? 35;

    const group = activeGroup();
    el.exposure.value = group.exposure ?? 0;
    const sign = (group.exposure ?? 0) >= 0 ? '+' : '';
    el.exposureValue.textContent = `${sign}${(group.exposure ?? 0).toFixed(2)}`;
    el.saturation.value = group.saturation ?? 1.0;
    el.saturationValue.textContent = (group.saturation ?? 1.0).toFixed(2);
    // 峰值亮度滑块只服务幂函数模式；BT 模式改用「目标白点 / 目标中调」
    if (el.peakBrightnessItem) el.peakBrightnessItem.classList.toggle('hidden', isBT);
    const peakVal = settings.powerCurve.peakBrightness ?? 10.0;
    el.peakBrightness.value = peakVal;
    el.peakBrightnessValue.textContent = peakVal.toFixed(2);
    el.peakBrightnessDesc.textContent =
      t('peakBrightnessDesc', '相对于 SDR 白的最大亮度倍数（自定义幂函数模式）');

    if (isBT) {
      el.bt2446aSettings.classList.add('active');
      el.powerSettings.classList.remove('active');
    } else {
      el.bt2446aSettings.classList.remove('active');
      el.powerSettings.classList.add('active');
    }

    // P0-1：只计算「显示用的有效值」，绝不写回 settings。
    // 渲染端 resolveTargets() 已按画布能力收敛白点；storage 保存的是用户意图。
    // 这样在 SDR 屏打开 popup、或把画布切成 8bit，都不会把 1.4 永久改成 1.25。
    const hdrCanvas = settings.canvasMode === 'auto' && hdrDisplayActive();
    const whiteMax = hdrCanvas ? 2.0 : 1.25;
    const desiredWhite = clampByRange('targetWhite', settings.bt2446a.targetWhite ?? 1.20, 1.20);
    const desiredMid = clampByRange('targetMid', settings.bt2446a.targetMid ?? 0.50, 0.50);
    const shownWhite = Math.min(desiredWhite, whiteMax);
    el.targetWhite.value = shownWhite;
    el.targetWhite.max = String(whiteMax);
    el.targetWhiteValue.textContent =
      shownWhite.toFixed(2) + (shownWhite < desiredWhite - 0.001 ? '（已收敛）' : '');
    el.targetMid.value = desiredMid;
    el.targetMidValue.textContent = desiredMid.toFixed(2);

    el.brightnessThreshold.value = settings.powerCurve.brightnessThreshold * 100;
    el.brightnessThresholdValue.textContent = Math.round(settings.powerCurve.brightnessThreshold * 100) + '%';
    el.maxBoost.value = settings.powerCurve.maxBoost;
    el.maxBoostValue.textContent = settings.powerCurve.maxBoost.toFixed(2) + 'x';
    el.shadowThreshold.value = settings.powerCurve.shadowThreshold * 100;
    el.shadowThresholdValue.textContent = Math.round(settings.powerCurve.shadowThreshold * 100) + '%';
    el.shadowCrush.value = settings.powerCurve.shadowCrush;
    el.shadowCrushValue.textContent = settings.powerCurve.shadowCrush.toFixed(2);

    // V1.2.5 真双层回显
    if (el.dualLayerToggle && settings.dualLayer) {
      el.dualLayerToggle.checked = settings.dualLayer.enabled;
      el.dualRadius.value = settings.dualLayer.radius;
      el.dualRadiusValue.textContent = String(Math.round(settings.dualLayer.radius));
      el.dualDetail.value = settings.dualLayer.detail;
      el.dualDetailValue.textContent = Number(settings.dualLayer.detail).toFixed(2);
    }

    el.debandToggle.checked = settings.deband.enabled;
    el.debandStrength.value = settings.deband.threshold;
    el.debandStrengthValue.textContent = settings.deband.threshold.toFixed(3);

    el.sharpenToggle.checked = settings.sharpen.enabled;
    el.sharpenStrength.value = settings.sharpen.strength;
    el.sharpenStrengthValue.textContent = settings.sharpen.strength.toFixed(2);

    el.renderScale.value = settings.renderScale;
    el.renderScaleValue.textContent = Math.round(settings.renderScale * 100) + '%';
    el.enhanceImages.checked = settings.enhanceImages;

    el.hdrSourceMode.value = settings.hdrSourceMode;
    el.hdrPeak.value = settings.hdrPeakNits;
    el.hdrPeakValue.textContent = String(settings.hdrPeakNits);
    updateSdrReadout();

    el.cropTopPx.value = settings.cropTopPx;
    el.canvasMode.value = settings.canvasMode;
    el.canvasEncoding.value = settings.canvasEncoding;
    el.highlightCeiling.value = settings.highlightCeiling;
    el.highlightCeilingValue.textContent = settings.highlightCeiling.toFixed(2);
    el.outputGain.value = settings.outputGain;
    el.outputGainValue.textContent = settings.outputGain.toFixed(2);

    // ★ 更新互斥状态（替代原有的独立 disabled 切换）
    updateMutexState();
    updateDualState();

    updateActualWhitePoint();
  }

  function renderPresets() {
    const presets = activePresets();
    const activeKey = activePresetKey();
    const hdrAvailable = settings.canvasMode === 'auto' && hdrDisplayActive();
    el.presetList.innerHTML = '';
    for (const [key, preset] of Object.entries(presets)) {
      const unavailable = preset.hdrOnly && !hdrAvailable;
      const btn = document.createElement('button');
      btn.className = 'preset-item'
        + (key === activeKey ? ' active' : '')
        + (unavailable ? ' preset-unavailable' : '');
      btn.dataset.preset = key;
      btn.disabled = unavailable;
      const name = t(preset.label, key) + (unavailable ? t('needs16floatCanvas', '（需 16float 画布）') : '');
      const desc = t(preset.labelDesc, '');
      btn.innerHTML = `<span class="preset-name"></span><span class="preset-desc"></span>`;
      btn.querySelector('.preset-name').textContent = name;
      btn.querySelector('.preset-desc').textContent = desc;
      if (!unavailable) btn.addEventListener('click', () => applyPreset(key));
      el.presetList.appendChild(btn);
    }
  }

  // 取帧方式卡片：与预设共用 .preset-item 样式，选中态一致。
  const CAPTURE_MODES = [
    {
      key: 'auto',
      nameKey: 'captureAutoName', nameFallback: '自动（零拷贝优先）',
      descKey: 'captureAutoDesc',
      descFallback: '常规源走 external 零拷贝；AV1/HEVC 补齐帧自动切 2D 快照',
    },
    {
      key: 'snapshot',
      nameKey: 'captureSnapshotName', nameFallback: '2D 快照（最兼容）',
      descKey: 'captureSnapshotDesc',
      descFallback: '每帧做一次全画面拷贝，规避顶部绿边；应用推荐不会覆盖',
    },
    {
      key: 'copy',
      nameKey: 'captureCopyName', nameFallback: '直拷纹理',
      descKey: 'captureCopyDesc',
      descFallback: '直接复制解码纹理到 GPU，不做 2D 快照',
    },
    {
      key: 'import',
      nameKey: 'captureImportName', nameFallback: '仅 external（零拷贝）',
      descKey: 'captureImportDesc',
      descFallback: '始终用 external 纹理；补齐帧可能带顶部绿边',
    },
  ];

  function setCaptureStatus(text) {
    if (el.captureStatus) el.captureStatus.textContent = text || '';
  }

  function renderCapturePath() {
    if (!el.capturePathList) return;
    el.capturePathList.innerHTML = '';
    const active = settings.capturePath || 'auto';
    for (const mode of CAPTURE_MODES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-item' + (mode.key === active ? ' active' : '');
      btn.dataset.capture = mode.key;
      btn.innerHTML = '<span class="preset-name"></span><span class="preset-desc"></span>';
      btn.querySelector('.preset-name').textContent = t(mode.nameKey, mode.nameFallback);
      btn.querySelector('.preset-desc').textContent = t(mode.descKey, mode.descFallback);
      // 1.2.41：点当前已选中的卡片原来是静默 return，和「点击没反应/保存失败」
      //   在界面上完全一样。三种结果必须各自给出可见反馈。
      btn.addEventListener('click', () => {
        const label = t(mode.nameKey, mode.nameFallback);
        if ((settings.capturePath || 'auto') === mode.key) {
          setCaptureStatus(tf('captureSame', '已是当前选择：{name}', { name: label }));
          return;
        }
        settings.capturePath = mode.key;
        render();
        setCaptureStatus(tf('captureSaving', '正在保存：{name}…', { name: label }));
        const task = save();
        if (task && typeof task.then === 'function') {
          task.then((ok) => {
            setCaptureStatus(ok
              ? tf('captureSaved', '已保存：{name}', { name: label })
              : tf('captureSaveFailed', '保存失败：{name}（改动仍在，点「保存设置」重试）', { name: label }));
          }, () => {
            setCaptureStatus(tf('captureSaveFailed', '保存失败：{name}（改动仍在，点「保存设置」重试）', { name: label }));
          });
        }
      });
      el.capturePathList.appendChild(btn);
    }
  }

  function applyPreset(key) {
    const presets = activePresets();
    const preset = presets[key];
    if (!preset) return;
    if (preset.hdrOnly && !(settings.canvasMode === 'auto' && hdrDisplayActive())) return;
    settings.presetByMode[settings.mappingMode] = key;
    if (settings.mappingMode === 'bt2446a') {
      Object.assign(settings.bt2446a, preset.settings);
    } else {
      Object.assign(settings.powerCurve, preset.settings);
    }
    render();
    save();
  }

  // ★ 鼠标滚轮调节滑块
  function setupWheelForRange(input) {
    input.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const rawStep = parseFloat(input.step) || 0.01;
      const min = parseFloat(input.min);
      const max = parseFloat(input.max);
      const current = parseFloat(input.value);

      // 精细滑块（step < 0.05）时，滚轮步长放大 5 倍，避免太慢
      const multiplier = rawStep < 0.05 ? 5 : 1;
      const step = rawStep * multiplier;

      const direction = e.deltaY < 0 ? 1 : -1;
      let newValue = current + direction * step;
      newValue = Math.max(min, Math.min(max, newValue));

      // 避免浮点误差
      newValue = Math.round(newValue * 1000) / 1000;

      if (newValue === current) return;

      input.value = newValue;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, { passive: false });
  }

  function setupListeners() {
    if (el.diagToggle && el.diagBody) {
      el.diagToggle.addEventListener('click', () => {
        const open = el.diagBody.classList.toggle('hidden');
        el.diagToggle.setAttribute('aria-expanded', open ? 'false' : 'true');
        if (!open) renderDiagnostics();
      });
    }

    // 复制诊断只读不写盘，不属于「设置入口」，不会与护栏②的单入口规则冲突
    if (el.diagCopy) {
      el.diagCopy.addEventListener('click', () => { copyDiagnostics(); });
    }

    el.hdrToggle.addEventListener('change', async () => {
      settings.enabled = el.hdrToggle.checked;
      await save();
      // 内容脚本按队列异步应用设置，立刻查状态可能还是旧值 → 短暂重试几次，
      // 避免开关明明生效、文字却停在「未激活」造成误判。
      const delays = [0, 150, 300, 600];
      for (let i = 0; i < delays.length; i++) {
        if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
        const status = await fetchStatus();
        if (!settings.enabled) return;                 // 关闭：等不到 active 也无所谓
        if (status === 'no_receiver' || status === 'unavailable') return; // 重试无意义
        if (status === 'active' || status === 'source_hdr') return;
      }
    });

    el.modeCards.forEach((card) => {
      card.addEventListener('click', () => {
        settings.mappingMode = card.dataset.mode;
        render();
        save();
      });
    });

    el.advancedToggle.addEventListener('click', () => {
      el.advancedPanel.classList.toggle('hidden');
      el.advancedToggle.classList.toggle('open');
    });

    // ★ SDR 滑块：拖动即时生效
    el.sdrSlider.addEventListener('input', () => {
      const v = parseInt(el.sdrSlider.value, 10);
      if (isNaN(v)) return;
      settings.sdrSliderPercent = clampByRange('sdrSliderPercent', v, 35);
      updateSdrReadout();
      updateActualWhitePoint();
      markDirty();
    });

    if (el.applyRecommendedBtn) {
      el.applyRecommendedBtn.addEventListener('click', openRecommendedDialog);
    }
    if (el.recommendedConfirm) {
      el.recommendedConfirm.addEventListener('click', submitRecommended);
    }
    if (el.recommendedCancel) {
      el.recommendedCancel.addEventListener('click', closeRecommendedDialog);
    }
    if (el.recommendedClose) {
      el.recommendedClose.addEventListener('click', closeRecommendedDialog);
    }
    if (el.recommendedModal) {
      el.recommendedModal.addEventListener('click', (e) => {
        if (e.target === el.recommendedModal) closeRecommendedDialog();
      });
      // 监听放在 document：点过弹层里的非焦点区域后，焦点可能落回 body，
      // 此时 Esc / Tab 不会经过弹层节点，挂在弹层上会漏掉。
      document.addEventListener('keydown', (e) => {
        if (!el.recommendedModal || el.recommendedModal.hidden) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          closeRecommendedDialog();
          return;
        }
        if (e.key !== 'Tab') return;
        const focusable = [...el.recommendedModal.querySelectorAll(
          'button:not([disabled]), input:not([disabled])')];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!el.recommendedModal.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });
    }
    for (const [input, field, error] of [
      [el.recommendedPeak, el.recommendedPeakField, el.recommendedPeakError],
      [el.recommendedSdr, el.recommendedSdrField, el.recommendedSdrError],
    ]) {
      if (!input) continue;
      input.addEventListener('input', () => {
        if (error) {
          error.textContent = '';
          error.hidden = true;
        }
        if (field) field.classList.remove('invalid');
        input.removeAttribute('aria-invalid');
        if (el.recommendedError) {
          el.recommendedError.textContent = '';
          el.recommendedError.hidden = true;
        }
        updateRecommendedPreview();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitRecommended();
        }
      });
    }

    el.exposure.addEventListener('input', () => {
      const v = parseFloat(el.exposure.value);
      activeGroup().exposure = v;
      const sign = v >= 0 ? '+' : '';
      el.exposureValue.textContent = `${sign}${v.toFixed(2)}`;
      markDirty();
    });

    el.saturation.addEventListener('input', () => {
      const v = parseFloat(el.saturation.value);
      activeGroup().saturation = v;
      el.saturationValue.textContent = v.toFixed(2);
      markDirty();
    });

    el.peakBrightness.addEventListener('input', () => {
      const v = parseFloat(el.peakBrightness.value);
      settings.powerCurve.peakBrightness = v;
      el.peakBrightnessValue.textContent = v.toFixed(2);
      updateActualWhitePoint();
      markDirty();
    });

    el.targetWhite.addEventListener('input', () => {
      const cap = parseFloat(el.targetWhite.max) || 1.25;
      const v = Math.min(Math.max(parseFloat(el.targetWhite.value) || 1.0, 1.0), cap);
      settings.bt2446a.targetWhite = v;
      el.targetWhite.value = v;
      el.targetWhiteValue.textContent = v.toFixed(2);
      updateActualWhitePoint();
      markDirty();
    });

    el.targetMid.addEventListener('input', () => {
      // P0-1 / P2-5：范围与 schema / tone-math 统一，唯一来源是 RANGES
      const v = clampByRange('targetMid', parseFloat(el.targetMid.value), 0.5);
      settings.bt2446a.targetMid = v;
      el.targetMid.value = v;
      el.targetMidValue.textContent = v.toFixed(2);
      updateActualWhitePoint();
      markDirty();
    });

    el.brightnessThreshold.addEventListener('input', () => {
      const v = parseFloat(el.brightnessThreshold.value) / 100;
      settings.powerCurve.brightnessThreshold = v;
      el.brightnessThresholdValue.textContent = Math.round(v * 100) + '%';
      markDirty();
    });

    el.maxBoost.addEventListener('input', () => {
      const v = parseFloat(el.maxBoost.value);
      settings.powerCurve.maxBoost = v;
      el.maxBoostValue.textContent = v.toFixed(2) + 'x';
      updateActualWhitePoint();
      markDirty();
    });

    el.shadowThreshold.addEventListener('input', () => {
      const v = parseFloat(el.shadowThreshold.value) / 100;
      settings.powerCurve.shadowThreshold = v;
      el.shadowThresholdValue.textContent = Math.round(v * 100) + '%';
      markDirty();
    });

    el.shadowCrush.addEventListener('input', () => {
      const v = parseFloat(el.shadowCrush.value);
      settings.powerCurve.shadowCrush = v;
      el.shadowCrushValue.textContent = v.toFixed(2);
      markDirty();
    });

    // V1.2.5 真双层事件（走 markDirty，与其他高级设置一致）
    if (el.dualLayerToggle) {
      el.dualLayerToggle.addEventListener('change', () => {
        settings.dualLayer.enabled = el.dualLayerToggle.checked;
        updateDualState();
        markDirty();
      });
      el.dualRadius.addEventListener('input', () => {
        settings.dualLayer.radius = parseInt(el.dualRadius.value, 10);
        el.dualRadiusValue.textContent = String(Math.round(settings.dualLayer.radius));
        markDirty();
      });
      el.dualDetail.addEventListener('input', () => {
        settings.dualLayer.detail = parseFloat(el.dualDetail.value);
        el.dualDetailValue.textContent = settings.dualLayer.detail.toFixed(2);
        markDirty();
      });
    }

    el.debandToggle.addEventListener('change', () => {
      settings.deband.enabled = el.debandToggle.checked;
      updateMutexState();
      markDirty();
    });

    el.debandStrength.addEventListener('input', () => {
      const v = parseFloat(el.debandStrength.value);
      settings.deband.threshold = v;
      el.debandStrengthValue.textContent = v.toFixed(3);
      markDirty();
    });

    el.sharpenToggle.addEventListener('change', () => {
      settings.sharpen.enabled = el.sharpenToggle.checked;
      updateMutexState();
      markDirty();
    });

    el.sharpenStrength.addEventListener('input', () => {
      const v = parseFloat(el.sharpenStrength.value);
      settings.sharpen.strength = v;
      el.sharpenStrengthValue.textContent = v.toFixed(2);
      markDirty();
    });

    el.renderScale.addEventListener('input', () => {
      const v = parseFloat(el.renderScale.value);
      settings.renderScale = v;
      el.renderScaleValue.textContent = Math.round(v * 100) + '%';
      markDirty();
    });

    el.enhanceImages.addEventListener('change', () => {
      settings.enhanceImages = el.enhanceImages.checked;
      markDirty();
    });

    el.hdrSourceMode.addEventListener('change', () => {
      settings.hdrSourceMode = el.hdrSourceMode.value;
      // 只刷新受影响的读数：整页 render 会把下拉框按设置回写，容易掩盖即时选择
      updateSdrReadout();
      save();
    });

    // ★ 配置快照
    if (el.profileSave) el.profileSave.addEventListener('click', saveProfile);
    if (el.profileName) {
      el.profileName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveProfile();
        }
      });
    }
    if (el.profileExport) el.profileExport.addEventListener('click', exportProfiles);
    if (el.profileImport && el.profileFile) {
      el.profileImport.addEventListener('click', () => el.profileFile.click());
      el.profileFile.addEventListener('change', async () => {
        const file = el.profileFile.files && el.profileFile.files[0];
        if (file) await importProfiles(file);
        el.profileFile.value = '';
      });
    }

    el.cropTopPx.addEventListener('change', () => {
      const v = parseInt(el.cropTopPx.value, 10);
      settings.cropTopPx = isNaN(v) ? 0 : Math.round(clampByRange('cropTopPx', v, 0));
      el.cropTopPx.value = settings.cropTopPx;
      render();
      save();
    });

    el.resetBtn.addEventListener('click', () => {
      const keepEnabled = settings.enabled;
      settings = HDRSettings.deepClone(DEFAULT_SETTINGS);
      settings.enabled = keepEnabled;
      settings.deband = { enabled: false, threshold: 0.012 };
      settings.sharpen = { enabled: false, strength: 0.5 };
      render();
      save();
    });

    el.canvasEncoding.addEventListener('change', () => {
      settings.canvasEncoding = el.canvasEncoding.value;
      save();
    });

    el.canvasMode.addEventListener('change', () => {
      settings.canvasMode = el.canvasMode.value;
      // 画布切换会改变白点上限与高动态预设可用性，统一走 render 刷新
      render();
      save();
    });

    el.highlightCeiling.addEventListener('input', () => {
      const v = parseFloat(el.highlightCeiling.value);
      if (isNaN(v)) return;
      settings.highlightCeiling = v;
      el.highlightCeilingValue.textContent = v.toFixed(2);
      updateCeilingReadout();
      markDirty();
    });

    el.outputGain.addEventListener('input', () => {
      const v = parseFloat(el.outputGain.value);
      if (isNaN(v)) return;
      settings.outputGain = v;
      el.outputGainValue.textContent = v.toFixed(2);
      markDirty();
    });

    el.hdrPeak.addEventListener('input', () => {
      const v = parseInt(el.hdrPeak.value, 10);
      if (isNaN(v)) return;
      settings.hdrPeakNits = v;
      el.hdrPeakValue.textContent = String(v);
      updateSdrReadout();
      updateActualWhitePoint();
      markDirty();
    });

    // ★ 高级设置显式保存：点按钮立即写盘
    if (el.advancedSave) {
      el.advancedSave.addEventListener('click', () => { flushSave(); });
    }

    // ★ 关闭 popup 时兜底：有未保存改动就写盘，避免用户调了参数却丢失。
    //   这样「滑动中不保存」消除误触，同时不牺牲配置不丢。
    window.addEventListener('pagehide', () => { if (advancedDirty) flushSave(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && advancedDirty) flushSave();
    });

    // ★ 给所有滑块加滚轮支持
    document.querySelectorAll('input[type="range"]').forEach(setupWheelForRange);
  }

  // ===== 保存状态机（P0-4）=====
  // 滑块拖动只标记「待保存」；真正写盘只在点「保存设置」或关闭 popup 兜底时发生。
  // 关键：只有收到 service worker 的 { success: true } 才算成功，超时/异常都保留脏标记。
  function setSaveState(state, message) {
    if (!el.advancedSaveBar || !el.advancedSaveHint || !el.advancedSave) return;
    const tr = (key, fallback) => (typeof t === 'function' ? t(key, fallback) : fallback);
    el.advancedSaveBar.classList.remove('dirty', 'saved', 'error');
    let diagText = '';
    if (state === 'saved') {
      el.advancedSaveBar.classList.add('saved');
      el.advancedSaveHint.textContent = '已保存';
      el.advancedSave.disabled = true;
      const time = typeof fmtTime === 'function' ? fmtTime(Date.now()) : '';
      diagText = tr('diagSaveOk', '成功 · {time}').replace('{time}', time);
    } else if (state === 'error') {
      el.advancedSaveBar.classList.add('error');
      el.advancedSaveHint.textContent = message || '保存失败';
      el.advancedSave.disabled = false;
      diagText = tr('diagSaveFail', '失败 · {reason}').replace('{reason}', message || '保存失败');
    } else {
      el.advancedSaveBar.classList.add('dirty');
      el.advancedSaveHint.textContent = '有未保存的改动 · 点「保存设置」生效';
      el.advancedSave.disabled = false;
      diagText = tr('diagSaveDirty', '有未保存改动');
    }
    if (typeof setDiagSave === 'function') setDiagSave(state, diagText);
  }

  // P2-8：所有写盘入口（保存按钮 / pagehide / visibilitychange）共用一条队列。
  // 旧实现里三个入口各自 sendMessage，两次 storage.set 乱序时旧值会后到覆盖新值，
  // 用户表现就是「刚改的最后一项丢了」。这里排队执行，且执行时才读 settings，
  // 所以后触发的写一定带着最新值。
  let _saveChain = Promise.resolve();
  let _dirtyVersion = 0;

  function markDirty() {
    advancedDirty = true;
    _dirtyVersion++;
    setSaveState('dirty');
  }

  // ★ 原「按此值同步系统亮度」按钮的实质工作合并到这里。
  //   它不写盘，只把滑块值确认为系统亮度并派生高光上限 / 校准记录；
  //   真正的写盘统一由下面的 flushSave() 完成，避免两个保存入口。
  function applySdrCalibration() {
    if (!sdrSliderRelevant()) return { ok: true, changed: false, result: null };
    const pct = clampByRange('sdrSliderPercent', settings.sdrSliderPercent ?? 35, 35);
    const result = HDRSettings.computeCalibration(settings, pct);
    if (!result.ok || !result.changed) {
      return { ok: result.ok, changed: false, result };
    }
    settings = result.next;
    return { ok: true, changed: true, result };
  }

  function describeCalibration(result) {
    if (!result) return '';
    let text = t('calibrationDone', '已按 {pct}% 同步：参考白 {nits} nits').
      replace('{pct}', String(settings.sdrSliderPercent)).
      replace('{nits}', String(Math.round(result.nits)));
    if (result.skipped && result.skipped.length) {
      text += ' · ' + t('calibrationSkipped', '保留你的设置：{fields}').
        replace('{fields}', result.skipped.join(' / '));
    }
    for (const w of (result.warnings || [])) text += ' · ' + w;
    return text;
  }

  async function flushSave() {
    if (!advancedDirty) return true;
    const snapshot = HDRSettings.deepClone(settings);
    const cal = applySdrCalibration();
    if (cal.changed) render();

    const ok = await save();
    if (!ok) {
      settings = snapshot;
      render();
      if (cal.changed && el.calibrationStatus) {
        el.calibrationStatus.textContent = t('calibrationRollback', '保存失败，已恢复同步前的设置');
      }
      return false;
    }
    if (cal.changed && el.calibrationStatus) {
      el.calibrationStatus.textContent = describeCalibration(cal.result);
    }
    return ok;
  }

  function save() {
    const task = _saveChain.then(() => saveNow());
    // 一次失败不阻断后续重试
    _saveChain = task.then(() => {}, () => {});
    return task;
  }

  async function saveNow() {
    // 读取失败时禁止写盘，否则会用默认值覆盖 storage 中用户的真实配置。
    if (settingsLoadFailed) {
      setSaveState('error', '无法读取设置，请重新打开扩展（不会覆盖已存配置）');
      return false;
    }
    // ★ 不能在这里按 advancedDirty 跳过：HDR 开关等即时生效路径直接改
    //   settings.enabled 后调 save()，并不经过 markDirty()。跳过会让开关
    //   看起来能点、实际永远不写盘。dirty 只用于「关闭兜底」的 flushSave。
    const versionAtSend = _dirtyVersion;
    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.SET_SETTINGS,
          data: { settings },
        }),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 2000)),
      ]);
      if (response && response.success === true) {
        if (_dirtyVersion === versionAtSend) {
          advancedDirty = false;
          setSaveState('saved');
        } else {
          // 写盘期间用户又改了参数：不能把新改动误判为已保存。
          // 保持脏标记，由后续按钮 / 关闭兜底事件再写一次。
          setSaveState('dirty');
        }
        return true;
      }
      const reason = response && response.error
        ? response.error
        : (response && response.timeout ? '保存超时' : '保存失败');
      setSaveState('error', '保存失败：' + reason + '（改动仍在，点「保存设置」重试）');
      return false;
    } catch (e) {
      console.error('Failed to save settings:', e);
      setSaveState('error',
        '保存失败：' + (e && e.message ? e.message : e) + '（改动仍在，点「保存设置」重试）');
      return false;
    }
  }

  // ★ 1.2.38：诊断块。每行都是真机问题出现时可直接截图给出的字段。
  //   lastDiag 为 null 表示内容脚本未回诊断（旧版脚本 / 无视频 / 未激活）。
  // 1.2.39：诊断块的取值集中到一处，渲染与复制共用，避免以后加字段
  //   出现「界面有、复制没有」。第一行「连接状态」专门解释「其余行为什么是空的」，
  //   这是 1.2.38 最大的缺口：孤儿脚本和「页面没视频」在界面上长得一模一样。
  function diagFill(text, vars) {
    return String(text).replace(/\{(\w+)\}/g,
      (m, k) => (vars && vars[k] !== undefined ? String(vars[k]) : m));
  }

  function buildDiagRows() {
    const tr = (key, fallback) => (typeof t === 'function' ? t(key, fallback) : fallback);
    const unknown = tr('diagUnknown', '—');
    const diag = lastDiag || null;
    const v = diag && diag.video;
    const rows = [];
    const add = (id, label, value, opts) => {
      rows.push({
        id,
        label,
        value: value || '',
        hideIfEmpty: !!(opts && opts.hideIfEmpty),
        rowId: (opts && opts.rowId) || '',
      });
    };

    // ① 连接状态
    let source = unknown;
    if (lastConn.state === 'unsupported') {
      source = tr('diagSourceUnsupported', '当前页面不支持增强（chrome:// 等）');
    } else if (lastConn.state === 'ok') {
      if (!lastConn.version) {
        source = tr('diagSourceLegacy', '已连接 · 脚本版本未知（可能是旧版，刷新页面）');
      } else if (EXT_VERSION && lastConn.version !== EXT_VERSION) {
        source = diagFill(tr('diagSourceStale', '脚本 {v} · 扩展 {cur} · 请刷新页面'),
          { v: lastConn.version, cur: EXT_VERSION });
      } else if (!v) {
        source = diagFill(tr('diagSourceNoVideo', '脚本 {v} · 本页无有效视频'),
          { v: lastConn.version });
      } else {
        source = diagFill(tr('diagSourceOk', '脚本 {v}'), { v: lastConn.version });
      }
    } else if (lastConn.state === 'timeout' || lastConn.state === 'no_receiver') {
      source = tr('diagSourceNoReceiver', '内容脚本未响应 · 刷新页面后重试');
    }
    add('diagSource', tr('diagSource', '连接状态'), source);

    // ② 取帧路径（多视频页面标明是第几个，避免截图指向别的渲染器）
    let pathText = '';
    if (v && v.path) {
      pathText = diagFill(tr('diagPathValue', '{path} · {reason}'),
        { path: v.path, reason: v.reason || '' });
      if (diag.videoTotal > 1) {
        pathText += ' ' + diagFill(tr('diagVideoIndex', '（第 {i}/{n} 个视频）'),
          { i: diag.videoIndex || 1, n: diag.videoTotal });
      }
    }
    add('diagPath', tr('diagPath', '取帧路径'), pathText);

    // ③ 解码补齐
    let paddedText = '';
    if (v) {
      paddedText = v.padded
        ? diagFill(tr('diagPaddedYes', '是 · {coded} → {visible}'),
          { coded: v.coded || '?', visible: v.visible || '?' })
        : tr('diagPaddedNo', '否');
    }
    add('diagPadded', tr('diagPadded', '解码补齐'), paddedText);

    // ④ 绿边检测
    //   1.2.40：这一行原来只说「未检出」，会被读成「查过、没问题」。实际上检测靠
    //   drawImage 采样 video 元素的可见区，而 B 站 AV1/HEVC 的绿条躺在 external
    //   纹理的 coded 填充行里（1088 vs 1080），**它根本看不见**。所以必须区分：
    //   路径不含 external → 不适用；含 external 且 0 行 → 未检出但仅限可见区。
    let greenText = '';
    if (v) {
      if (v.manualCrop > 0) {
        greenText = diagFill(tr('diagGreenManual', '手工裁切 {n}px'), { n: v.manualCrop });
      } else if (v.path !== 'external') {
        greenText = tr('diagGreenMoot', '不适用 · 当前路径无填充行');
      } else if (v.greenRows === null) {
        greenText = tr('diagGreenPending', '未检测');
      } else if (v.greenRows > 0) {
        greenText = diagFill(tr('diagGreenFound', '检出 {n}px'), { n: v.greenRows });
      } else {
        greenText = tr('diagGreenVisibleOnly', '未检出 · 仅可见区');
      }
    }
    add('diagGreen', tr('diagGreen', '绿边检测'), greenText);

    // ⑤ HDR 路径
    let hdrText = '';
    if (v) {
      hdrText = diagFill(tr('diagHdrValue', '{mode} · {canvas}'),
        { mode: v.hdrMode || 0, canvas: v.canvas || '—' });
    }
    add('diagHdr', tr('diagHdr', 'HDR 路径'), hdrText);

    // ⑥ 页面计数（1.2.38 已采集，但一直没展示）
    let countsText = '';
    if (diag && diag.counts) {
      const c = diag.counts;
      countsText = diagFill(
        tr('diagCountsValue', '视频 {videos} · HDR {hdr} · 跨域 {cross} · DRM {drm} · 解码失败 {fail}'),
        { videos: c.videos || 0, hdr: c.hdr || 0, cross: c.crossOrigin || 0,
          drm: c.drm || 0, fail: c.codecFailed || 0 });
    }
    add('diagCounts', tr('diagCounts', '页面计数'), countsText);

    // ⑦ 管线错误：非空才占位
    add('diagError', tr('diagPipeline', '管线错误'),
      (diag && diag.pipelineError) || '', { hideIfEmpty: true, rowId: 'diagErrorRow' });

    // ⑧ 最近保存：本地状态，不依赖内容脚本
    add('diagSave', tr('diagSave', '最近保存'),
      lastSave.text || tr('diagSaveNone', '本次未保存'));

    return rows;
  }

  function renderDiagnostics() {
    if (!el.diagPath) return;
    const unknown = typeof t === 'function' ? t('diagUnknown', '—') : '—';
    for (const row of buildDiagRows()) {
      const node = el[row.id];
      if (node) node.textContent = row.value || unknown;
      if (row.rowId && el[row.rowId]) {
        el[row.rowId].classList.toggle('hidden', !row.value);
      }
    }
  }

  // 一键复制：把当前这 8 行原样导出成纯文本，用户直接粘贴即可，
  // 不需要再截图（截图会丢字、也没法复制字段值）。
  async function copyDiagnostics() {
    const rows = buildDiagRows().filter((r) => r.value);
    const head = typeof tf === 'function'
      ? tf('diagCopyHead', 'HDR Vision {v} 诊断', { v: EXT_VERSION || '?' })
      : 'HDR Vision diagnostics';
    const text = [head].concat(rows.map((r) => r.label + ': ' + r.value)).join('\n');

    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch {
        ok = false;
      }
    }
    if (!el.diagCopy) return;
    el.diagCopy.textContent = ok
      ? (typeof t === 'function' ? t('diagCopied', '已复制到剪贴板') : 'Copied')
      : (typeof t === 'function' ? t('diagCopyFailed', '复制失败，请截图') : 'Copy failed');
    setTimeout(() => {
      if (el.diagCopy) {
        el.diagCopy.textContent = typeof t === 'function' ? t('diagCopy', '复制诊断') : 'Copy';
      }
    }, 1500);
  }

  function setDiagSave(state, text) {
    lastSave = { state, text };
    renderDiagnostics();
  }

  async function fetchStatus() {
    let timer = null;
    try {
      // 查询标签页 + 发消息整体纳入超时：页面主线程卡死时两处都可能不回。
      const request = (async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          lastConn = { state: 'unsupported', version: '' };
          return 'unavailable';
        }
        const response = await chrome.tabs.sendMessage(tab.id, { type: MESSAGE_TYPES.GET_STATUS });
        lastDiag = response?.diag || null;
        // 内容脚本回报的版本：缺失说明是 1.2.38 之前注入的旧脚本
        lastConn = { state: 'ok', version: response?.v || '' };
        return response?.status || 'inactive';
      })();
      // 超时判定后请求仍可能晚到：晚到时补一次重绘，避免诊断块停在「未响应」；
      // 晚失败则吞掉，否则 Promise.race 已结束的 rejection 会变成 unhandled。
      request.then(
        () => { if (typeof renderDiagnostics === 'function') renderDiagnostics(); },
        () => {},
      );
      const status = await Promise.race([
        request,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(STATUS_SENTINEL_TIMEOUT), STATUS_TIMEOUT_MS);
        }),
      ]);
      if (status === STATUS_SENTINEL_TIMEOUT) {
        // 1.2.39：超时也要重绘诊断，否则整块停在「—」，看不出是没回包
        lastDiag = null;
        lastConn = { state: 'timeout', version: '' };
        updateStatus('no_receiver');
        if (typeof renderDiagnostics === 'function') renderDiagnostics();
        return 'no_receiver';
      }
      updateStatus(status);
      if (typeof renderDiagnostics === 'function') renderDiagnostics();
      return status;
    } catch {
      // 收不到回应：多数是扩展刚重载，页面里的内容脚本已成孤儿（context invalidated）
      lastDiag = null;
      lastConn = { state: 'no_receiver', version: '' };
      updateStatus('no_receiver');
      if (typeof renderDiagnostics === 'function') renderDiagnostics();
      return 'no_receiver';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function updateStatus(status) {
    el.statusIndicator.classList.remove('active', 'error', 'warning', 'info');
    switch (status) {
      case 'active':
        el.statusIndicator.classList.add('active');
        el.statusText.textContent = t('hdrActive', 'HDR 已激活');
        break;
      case 'source_hdr':
        el.statusIndicator.classList.add('info');
        el.statusText.textContent = t('sourceHdr', 'HDR 源已跳过（原样播放）');
        break;
      case 'no_webgpu':
        el.statusIndicator.classList.add('error');
        el.statusText.textContent = t('webgpuNotSupported', '此浏览器不支持 WebGPU');
        break;
      case 'shader_error':
        // P1-6：WGSL 编译 / pipeline 校验失败，页面里已有控制台详细行号
        el.statusIndicator.classList.add('error');
        el.statusText.textContent = t('shaderInitFailed', '着色器/管线初始化失败（详见扩展控制台）');
        break;
      case 'no_video':
        el.statusIndicator.classList.add('warning');
        el.statusText.textContent = t('noVideoFound', '此页面未找到视频');
        break;
      case 'cross_origin':
        el.statusIndicator.classList.add('info');
        el.statusText.textContent = t('crossOriginBlocked', '此站点禁止读帧（跨域），不做增强');
        break;
      case 'drm_protected':
        // P1-5：EME 受保护媒体读帧只能拿到黑帧，接管会整块黑屏
        el.statusIndicator.classList.add('info');
        el.statusText.textContent = t('drmProtected', '受保护内容（DRM），已跳过增强');
        break;
      case 'codec_failed':
        el.statusIndicator.classList.add('warning');
        el.statusText.textContent = t('codecRenderFailed', '此编码渲染失败（已回退原画）');
        break;
      case 'unavailable':
        el.statusIndicator.classList.add('warning');
        el.statusText.textContent = t('pageUnavailable', '此页面不可用');
        break;
      case 'no_receiver':
        // 扩展重载后，页面中的旧内容脚本已失效（收不到消息），必须刷新页面
        el.statusIndicator.classList.add('warning');
        el.statusText.textContent = t('staleContentScript', '请刷新页面后重试（扩展已更新，页面脚本仍是旧版）');
        break;
      default:
        el.statusText.textContent = t('hdrInactive', 'HDR 未激活');
    }
  }

  async function init() {
    applyRanges();
    applyI18n();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
      lastConn = { state: 'unsupported', version: '' };
      updateStatus('unavailable');
      if (typeof renderDiagnostics === 'function') renderDiagnostics();
      return;
    }
    await loadSettings();
    setupListeners();
    renderProfiles(await readProfiles());
    await fetchStatus();
  }

  // ★ 模块脚本可能晚于 DOMContentLoaded 执行，此时不要再等一次事件
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();