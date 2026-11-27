/**
 * 设置单一来源（Phase 0 / P0-2）
 *
 * 在此之前 DEFAULT_SETTINGS、PRESETS、CURRENT_SETTINGS_VERSION 分别存在于
 * popup.js 与 service-worker.js，且迁移里硬编码了预设目标值，导致出现过
 * 「预设是高动态、实际白点却是 1.20 / 1.25」的不一致。
 *
 * 本文件由 content script / popup / service worker 三端共同加载：
 *   - manifest.content_scripts：排在 tone-math.js 之前
 *   - popup.html：排在 popup.js 之前
 *   - service-worker.js：importScripts('../shared/settings-schema.js')
 *
 * 关键约定：storage 中保存的是「用户意图」，不保存按画布能力收敛后的值。
 * 8bit 画布的白点收敛由 tone-math.resolveTargets() 在渲染端完成。
 */
(function (global) {
  'use strict';

  const CURRENT_SETTINGS_VERSION = 15;

  // ==================== 预设 ====================
  const POWER_PRESETS = {
    standard: {
      label: 'presetStandard',
      labelDesc: 'presetStandardDesc',
      settings: {
        brightnessThreshold: 0.75,
        maxBoost: 1.4,
        exposure: 0.2,
        saturation: 1.2,
        peakBrightness: 10.0,
        shadowThreshold: 0.15,
        shadowCrush: 0.0,
      },
    },
    vivid: {
      label: 'presetVivid',
      labelDesc: 'presetVividDesc',
      settings: {
        brightnessThreshold: 0.55,
        maxBoost: 1.8,
        exposure: 0.1,
        saturation: 1.2,
        peakBrightness: 30.0,
        shadowThreshold: 0.15,
        shadowCrush: 0.15,
      },
    },
    softNatural: {
      label: 'presetSoftNatural',
      labelDesc: 'presetSoftNaturalDesc',
      settings: {
        brightnessThreshold: 0.7,
        maxBoost: 1.4,
        exposure: 0.2,
        saturation: 1.1,
        peakBrightness: 10.0,
        shadowThreshold: 0.15,
        shadowCrush: 0.0,
      },
    },
  };

  const BT2446A_PRESETS = {
    faithful: {
      label: 'presetFaithful',
      labelDesc: 'presetFaithfulDesc',
      settings: { exposure: 0.0, saturation: 1.0, targetWhite: 1.25, targetMid: 0.50 },
    },
    clarity: {
      label: 'presetClarity',
      labelDesc: 'presetClarityDesc',
      settings: { exposure: 0.0, saturation: 1.05, targetWhite: 1.25, targetMid: 0.52 },
    },
    cinema: {
      label: 'presetCinema',
      labelDesc: 'presetCinemaDesc',
      settings: { exposure: 0.0, saturation: 1.0, targetWhite: 1.15, targetMid: 0.46 },
    },
    highDynamic: {
      label: 'presetHighDynamic',
      labelDesc: 'presetHighDynamicDesc',
      hdrOnly: true,
      settings: { exposure: 0.0, saturation: 1.10, targetWhite: 1.4, targetMid: 0.50 },
    },
    // v14：删除 twoLayer（早期「伪双层」曲线预设）。
    // 它只改 4 个曲线标量，不会打开 dualLayer 开关，名字与实现长期不符；
    // 其观感（1.45 / 0.48 / 1.12）由 v14 迁移原样保留为用户自定义值。
  };

  // 1.2.31：全局推荐设置（一键应用）。覆盖映射方案 / 预设 / 接管 / 双层 / deband / CAS / 增益。
  //   1.2.32：高光上限仍属于用户选择，只在超过物理余量时下调，不强制回推荐基线。
  //   仍不写 hdrPeakNits / sdrSliderPercent —— 显示器物理峰值与系统同步参考白是
  //   用户事实，只能由「应用推荐」弹层里的显式输入提供。
  //   saturation 属于参数组，由调用方写 activeGroup()。
  const GLOBAL_RECOMMENDED = {
    mappingMode: 'bt2446a',
    presetByMode: { power: 'vivid', bt2446a: 'highDynamic' },
    hdrSourceMode: 'auto',
    canvasMode: 'auto',
    capturePath: 'auto',
    outputGain: 1.05,
    dualLayer: { enabled: true, mode: 'local', radius: 12, detail: 1.10, split: 0.5, soft: 0.15 },
    deband: { enabled: true, threshold: 0.012 },
    sharpen: { enabled: false, strength: 0.5 },
  };
  const GLOBAL_RECOMMENDED_SATURATION = 1.10;

  const HD = BT2446A_PRESETS.highDynamic.settings;
  const FAITHFUL = BT2446A_PRESETS.faithful.settings;

  // ==================== 数值范围（P2-5 单一来源） ====================
  // 以前同一条范围写在三处且互不一致：popup.html 的 min/max、normalizeSettings
  // 里的字面量、utils.computeUniformData 里的夹紧。典型症状是 radius=40 时
  // 滑块停在 32（HTML 上限）而渲染实际用 40；峰值 2500 时读数按 4000 算余量。
  //
  // 这里存的是「storage 里的值」的域。displayScale 表示该字段在 UI 上按百分比
  // 展示（0.75 ↔ 75%），popup 用 min/max × displayScale 设置控件。
  const RANGES = {
    // 输出 / 画面
    sdrSliderPercent: { min: 0, max: 100, step: 1 },
    hdrPeakNits: { min: 400, max: 2000, step: 50 },
    highlightCeiling: { min: 1.0, max: 2.0, step: 0.01 },
    outputGain: { min: 0.4, max: 1.6, step: 0.01 },
    renderScale: { min: 0.25, max: 1.0, step: 0.05 },
    cropTopPx: { min: 0, max: 64, step: 1 },
    // 色调曲线
    exposure: { min: -2.0, max: 2.0, step: 0.01 },
    saturation: { min: 0.0, max: 2.0, step: 0.01 },
    peakBrightness: { min: 1.0, max: 30.0, step: 0.01 },
    targetWhite: { min: 1.0, max: 2.0, step: 0.01 },
    targetMid: { min: 0.30, max: 0.70, step: 0.01 },
    brightnessThreshold: { min: 0.30, max: 1.00, step: 0.01, displayScale: 100 },
    maxBoost: { min: 1.0, max: 3.0, step: 0.01 },
    shadowThreshold: { min: 0.05, max: 0.30, step: 0.01, displayScale: 100 },
    shadowCrush: { min: 0.0, max: 1.0, step: 0.01 },
    // 双层
    dualRadius: { min: 4, max: 32, step: 1 },
    dualDetail: { min: 0.4, max: 2.0, step: 0.05 },
    dualSplit: { min: 0.1, max: 0.9, step: 0.01 },
    dualSoft: { min: 0.02, max: 0.4, step: 0.01 },
    // 画质增强
    debandThreshold: { min: 0.002, max: 0.03, step: 0.001 },
    sharpenStrength: { min: 0.0, max: 1.0, step: 0.01 },
  };

  // Windows SDR 亮度滑块 → nits（popup 读数与渲染端 headroom 必须同一口径）
  function sliderToNits(percent) {
    return 80 + percent * 4;
  }

  // 按范围夹紧；非数值 / NaN / Infinity 一律退回 fallback。
  // 之所以不接受字符串数字：导入的快照可能是手工编辑的，"0.8" 这类值
  // 在后续 Math.pow / 比较里行为不一致，宁可退回默认。
  function clampField(name, value, fallback) {
    const range = RANGES[name];
    if (typeof value !== 'number' || !isFinite(value)) return fallback;
    if (!range) return value;
    return Math.min(Math.max(value, range.min), range.max);
  }

  // ==================== 系统 SDR 亮度同步（1.2.26） ====================
  // 浏览器扩展读不到 Windows 的「SDR 内容亮度」滑块，只能由用户明确告知。
  // 这里只定义规则，不含 UI / storage：popup 负责在保存失败时整体回退。
  const CALIBRATION_VERSION = 1;
  // 只认这些字段可被校准派生；其余（白点、曲线、开关、峰值等）属于用户意图
  // 或显示器物理事实，同步系统亮度时一律不动。
  const CALIBRATABLE_FIELDS = ['sdrSliderPercent', 'highlightCeiling'];

  function emptyCalibration() {
    return {
      version: CALIBRATION_VERSION,
      sdrPercent: null,
      nits: null,
      appliedAt: 0,
      source: 'manual',
      derived: {},
      previous: {},
    };
  }

  // 导入快照里的 calibration 可能缺字段 / 带任意 key，逐字段重建。
  function normalizeCalibration(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyCalibration();
    if (raw.version !== CALIBRATION_VERSION) return emptyCalibration();
    const pct = (typeof raw.sdrPercent === 'number' && isFinite(raw.sdrPercent) &&
                 raw.sdrPercent >= RANGES.sdrSliderPercent.min &&
                 raw.sdrPercent <= RANGES.sdrSliderPercent.max)
      ? Math.round(raw.sdrPercent) : null;
    const nits = (typeof raw.nits === 'number' && isFinite(raw.nits) && raw.nits > 0)
      ? raw.nits : null;
    const cleanMap = (obj) => {
      const out = {};
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
      for (const key of CALIBRATABLE_FIELDS) {
        if (typeof obj[key] !== 'number' || !isFinite(obj[key])) continue;
        out[key] = clampField(key, obj[key], DEFAULT_SETTINGS[key]);
      }
      return out;
    };
    return {
      version: CALIBRATION_VERSION,
      sdrPercent: pct,
      nits: nits,
      appliedAt: (typeof raw.appliedAt === 'number' && isFinite(raw.appliedAt) && raw.appliedAt > 0)
        ? raw.appliedAt : 0,
      source: raw.source === 'import' ? 'import' : 'manual',
      derived: cleanMap(raw.derived),
      previous: cleanMap(raw.previous),
    };
  }

  /**
   * 由用户告知的系统 SDR 亮度百分比推导需要变化的参数。
   * 纯函数：不改入参、不写 storage、不读时间以外的外部状态。
   *
   * 返回 {
   *   ok, changed, reason, next, derived, skipped, warnings, nits, headroom
   * }
   *
   * 映射规则（明确边界）：
   *   sdrSliderPercent —— 同步目标本身，总是写成用户告知的百分比。
   *   highlightCeiling —— 仅当该字段仍属于「上次校准写入的值 / 从未校准时的
   *                       schema 默认值」时才按物理余量重算；用户手动改过就跳过。
   *   其余字段 —— 一律保留（白点 / 中调 / 曝光 / 增益 / 峰值 / 开关 / 路径…）。
   *
   * 重复与无效调整：
   *   - 百分比相同且没有派生字段需要变化 → changed:false，调用方不应写盘。
   *   - 用户改过的派生字段记录到 skipped，不覆盖。
   *
   * 边界：
   *   percent 必须是 0–100 的有限数（不接受字符串 / NaN / Infinity）。
   *   nits = 80 + pct*4 ∈ [80, 480]；headroom = hdrPeakNits / nits。
   *   推荐上限 = clamp(min(默认 1.2, headroom), 1.0, 2.0)。
   *   headroom < 1 表示显示器峰值低于系统参考白 →  warnings 提示，不拒绝同步。
   */
  function computeCalibration(settings, percent) {
    const fail = (reason) => ({
      ok: false, changed: false, reason, next: null,
      derived: {}, skipped: [], warnings: [], nits: null, headroom: null,
    });
    if (typeof percent !== 'number' || !isFinite(percent)) {
      return fail('系统亮度必须是 0–100 的数字');
    }
    if (percent < RANGES.sdrSliderPercent.min || percent > RANGES.sdrSliderPercent.max) {
      return fail('系统亮度必须在 0–100 之间');
    }

    const pct = Math.round(percent);
    const base = settings && typeof settings === 'object' ? settings : DEFAULT_SETTINGS;
    const cal = normalizeCalibration(base.calibration);
    const nits = sliderToNits(pct);
    const peak = clampField('hdrPeakNits', base.hdrPeakNits, DEFAULT_SETTINGS.hdrPeakNits);
    const headroom = peak / Math.max(nits, 1);

    // 字段所有权：首次同步时只有 schema 默认值算「我们拥有的」；
    // 之后只有仍等于上次 derived 值的字段才算。
    const owns = (field) => {
      const current = base[field];
      if (cal.sdrPercent === null) return current === DEFAULT_SETTINGS[field];
      const last = cal.derived[field];
      if (last !== undefined) return current === last;
      // 上次因用户改过而 skipped：改回 schema 默认值即重新获得所有权
      return current === DEFAULT_SETTINGS[field];
    };

    const next = deepClone(base);
    const derived = {};
    const previous = {};
    const skipped = [];

    // sdrSliderPercent 是同步目标本身，总是写入（它不是「其他用户设置」）。
    if (next.sdrSliderPercent !== pct) previous.sdrSliderPercent = next.sdrSliderPercent;
    next.sdrSliderPercent = pct;
    derived.sdrSliderPercent = pct;

    // highlightCeiling 受物理余量约束，但只在未被用户改动时派生。
    const recommended = Math.min(
      Math.max(Math.min(DEFAULT_SETTINGS.highlightCeiling, headroom), RANGES.highlightCeiling.min),
      RANGES.highlightCeiling.max
    );
    if (owns('highlightCeiling')) {
      if (next.highlightCeiling !== recommended) previous.highlightCeiling = next.highlightCeiling;
      next.highlightCeiling = recommended;
      derived.highlightCeiling = recommended;
    } else if (cal.sdrPercent !== null || base.highlightCeiling !== DEFAULT_SETTINGS.highlightCeiling) {
      skipped.push('highlightCeiling');
    }

    const ceilingUnchanged = base.highlightCeiling === next.highlightCeiling;
    const percentUnchanged = base.sdrSliderPercent === pct;
    const derivedUnchanged = CALIBRATABLE_FIELDS.every((k) => cal.derived[k] === derived[k]);
    if (percentUnchanged && ceilingUnchanged && derivedUnchanged && cal.sdrPercent === pct) {
      return {
        ok: true, changed: false, reason: '系统亮度未变化，无需调整', next: base,
        derived, skipped, warnings: [], nits, headroom,
      };
    }

    next.calibration = {
      version: CALIBRATION_VERSION,
      sdrPercent: pct,
      nits,
      appliedAt: Date.now(),
      source: 'manual',
      derived,
      previous,
    };

    const warnings = [];
    if (headroom < 1) {
      warnings.push('显示器峰值 ' + peak + ' nits 低于系统参考白 ' + nits +
        ' nits，高光会被面板裁切；请调低系统 SDR 亮度或提高显示器峰值设置');
    }
    return {
      ok: true, changed: true, reason: '', next, derived, skipped, warnings, nits, headroom,
    };
  }

  // ==================== 手工兼容字段白名单（1.2.37） ====================
  // 这些值是用户在真机上为规避兼容性问题亲手设置的「逃生口」，
  // 不是观感偏好。全局推荐只能改观感参数，无权把它们改回去：
  //   capturePath='snapshot' —— 顶部绿条（AV1/HEVC 补齐帧）唯一可靠的规避手段
  //   canvasMode='sdr'       —— 个别 AMD 驱动在 16float 画布上出彩色条带/方块
  //   cropTopPx > 0          —— 快照仍带边时手工裁掉的像素行数
  // 判据写成谓词而不是值表：只有明确识别到「手工兼容态」才保留，
  // 其余值（如 capturePath='copy'）仍按推荐收敛，避免白名单无限膨胀。
  const MANUAL_COMPAT_FIELDS = [
    { field: 'capturePath', isManual: (v) => v === 'snapshot' },
    { field: 'canvasMode', isManual: (v) => v === 'sdr' },
    { field: 'cropTopPx', isManual: (v) => typeof v === 'number' && isFinite(v) && v > 0 },
  ];

  function manualCompatOverrides(settings) {
    const base = settings && typeof settings === 'object' ? settings : {};
    const kept = {};
    for (const guard of MANUAL_COMPAT_FIELDS) {
      if (guard.isManual(base[guard.field])) kept[guard.field] = base[guard.field];
    }
    return kept;
  }

  // ==================== 推荐设置的物理收敛（1.2.32） ====================
  /**
   * 把用户告知的两个物理事实换算成一组「做得到」的精细参数。
   * 纯函数：不改入参、不读 storage，popup 的实时预览与最终应用共用同一套公式。
   *
   * 为什么要收敛：
   *   峰值与系统 SDR 白决定了真实余量 headroom = 峰值 ÷ 参考白。
   *   白点 / 高光上限如果申请超过 headroom，渲染端仍会夹紧，但 UI 会显示
   *   一个永远达不到的目标，用户会误以为「调了没反应」。
   *
   * 规则（相对当前值只降不升）：
   *   targetWhite       —— min(高动态预设 1.40, available)
   *   highlightCeiling  —— min(当前值, available)，保留用户低于余量的选择
   *   outputGain        —— 余量 ≥ 1.05 才加推荐的 1.05，否则 1.00，避免末端再裁一次
   *   available         —— clamp(headroom, 1.0, 2.0)
   *
   * 边界：峰值 400–2000 的整数且为 step（50）的倍数；SDR 0–100 的整数。
   * headroom < 1 仍允许应用，但返回警告（物理上高光必然被面板裁切，
   * 通常是两个值填反了）。
   */
  function recommendedTargets(peakNits, sdrPercent, currentCeiling) {
    const fail = (reason, field) => ({
      ok: false, reason, field,
      peak: null, sdrPercent: null, nits: null, headroom: null, available: null,
      targetWhite: null, highlightCeiling: null, outputGain: null,
      tuned: { targetWhite: false, highlightCeiling: false, outputGain: false },
      warnings: [],
    });
    if (typeof peakNits !== 'number' || !isFinite(peakNits) || !Number.isInteger(peakNits)) {
      return fail('显示器峰值必须是整数', 'peakNits');
    }
    if (peakNits < RANGES.hdrPeakNits.min || peakNits > RANGES.hdrPeakNits.max) {
      return fail('显示器峰值需在 ' + RANGES.hdrPeakNits.min + '–' +
        RANGES.hdrPeakNits.max + ' nits 之间', 'peakNits');
    }
    // 高级设置里的峰值滑杆 step=50；非 50 倍数的值会被 range 控件吸附，
    // 导致读数 401、滑块停 400。输入步骤直接拒绝，避免显示与生效不一致。
    if (peakNits % RANGES.hdrPeakNits.step !== 0) {
      return fail('显示器峰值需按 ' + RANGES.hdrPeakNits.step + ' nits 递增', 'peakNits');
    }
    if (typeof sdrPercent !== 'number' || !isFinite(sdrPercent) || !Number.isInteger(sdrPercent)) {
      return fail('系统 SDR 亮度必须是整数', 'sdrPercent');
    }
    if (sdrPercent < RANGES.sdrSliderPercent.min || sdrPercent > RANGES.sdrSliderPercent.max) {
      return fail('系统 SDR 亮度需在 ' + RANGES.sdrSliderPercent.min + '–' +
        RANGES.sdrSliderPercent.max + ' 之间', 'sdrPercent');
    }

    const peak = peakNits;
    const pct = sdrPercent;
    const nits = sliderToNits(pct);
    const headroom = peak / Math.max(nits, 1);
    const available = Math.min(
      RANGES.highlightCeiling.max,
      Math.max(RANGES.highlightCeiling.min, headroom)
    );
    const preset = BT2446A_PRESETS[GLOBAL_RECOMMENDED.presetByMode.bt2446a];
    const presetWhite = preset ? preset.settings.targetWhite : 1.4;
    const round2 = (v) => Math.round(v * 100) / 100;

    const targetWhite = round2(Math.min(presetWhite, available));
    const ceilingBase = clampField('highlightCeiling', currentCeiling,
      DEFAULT_SETTINGS.highlightCeiling);
    const highlightCeiling = round2(Math.min(ceilingBase, available));
    const outputGain = headroom >= GLOBAL_RECOMMENDED.outputGain
      ? GLOBAL_RECOMMENDED.outputGain
      : 1.0;

    const warnings = [];
    if (headroom < 1) {
      warnings.push('显示器峰值 ' + peak + ' nits 低于系统参考白 ' + nits +
        ' nits，高光会被面板裁切；请调低系统 SDR 亮度或核对峰值');
    }

    return {
      ok: true, reason: '', field: null,
      peak, sdrPercent: pct, nits, headroom, available,
      targetWhite, highlightCeiling, outputGain,
      tuned: {
        targetWhite: targetWhite < presetWhite - 0.001,
        highlightCeiling: highlightCeiling < ceilingBase - 0.001,
        outputGain: outputGain < GLOBAL_RECOMMENDED.outputGain - 1e-9,
      },
      warnings,
    };
  }

  /**
   * 推荐设置 = 全局推荐组合 + 两个物理事实 + 按余量收敛。
   * 返回 { ...recommendedTargets, next, previous }；next 已 normalize，可直接写盘。
   */
  function computeRecommended(settings, peakNits, sdrPercent) {
    const base = settings && typeof settings === 'object' ? settings : DEFAULT_SETTINGS;
    const plan = recommendedTargets(peakNits, sdrPercent, base.highlightCeiling);
    if (!plan.ok) return { ...plan, next: null, previous: {} };

    const next = deepClone(base);
    const rec = GLOBAL_RECOMMENDED;
    next.mappingMode = rec.mappingMode;
    next.presetByMode = deepClone(rec.presetByMode);
    next.hdrSourceMode = rec.hdrSourceMode;
    next.canvasMode = rec.canvasMode;
    next.capturePath = rec.capturePath;
    // 手工兼容字段白名单（1.2.37）：真机逃生口优先于推荐默认值。
    // 放在 rec 写入之后，确保 snapshot / sdr 画布 / 手工裁切不被覆盖。
    Object.assign(next, manualCompatOverrides(base));
    next.dualLayer = deepClone(rec.dualLayer);
    next.deband = deepClone(rec.deband);
    next.sharpen = deepClone(rec.sharpen);
    next.outputGain = plan.outputGain;

    // 预设值与指针必须对齐：高亮 highDynamic 时曲线也必须是 highDynamic。
    const preset = BT2446A_PRESETS[rec.presetByMode.bt2446a];
    const group = { ...(next.bt2446a || {}) };
    if (preset) Object.assign(group, preset.settings);
    group.saturation = GLOBAL_RECOMMENDED_SATURATION;
    group.targetWhite = plan.targetWhite;
    next.bt2446a = group;

    // presetByMode.power 也指向 vivid；曲线必须同步，否则切回幂函数模式时
    // 会「高亮鲜艳、实际还是旧参数」。1.2.32 一并修正。
    next.powerCurve = { ...(next.powerCurve || {}) };
    const powerPreset = POWER_PRESETS[rec.presetByMode.power];
    if (powerPreset) Object.assign(next.powerCurve, powerPreset.settings);

    next.hdrPeakNits = plan.peak;
    next.sdrSliderPercent = plan.sdrPercent;
    next.highlightCeiling = plan.highlightCeiling;

    // calibration 只记录「可校准字段」，与系统亮度同步共用同一份状态展示。
    // 高光上限没被下调时不写入 derived：状态行不应把「保留原值」说成「已调整」，
    // 也让后续同步继续把它视为用户自己的值。
    const previous = {};
    if (base.sdrSliderPercent !== plan.sdrPercent) previous.sdrSliderPercent = base.sdrSliderPercent;
    if (base.highlightCeiling !== plan.highlightCeiling) previous.highlightCeiling = base.highlightCeiling;
    const derived = { sdrSliderPercent: plan.sdrPercent };
    if (base.highlightCeiling !== plan.highlightCeiling) {
      derived.highlightCeiling = plan.highlightCeiling;
    }
    next.calibration = {
      version: CALIBRATION_VERSION,
      sdrPercent: plan.sdrPercent,
      nits: plan.nits,
      appliedAt: Date.now(),
      source: 'manual',
      derived,
      previous,
    };

    return { ...plan, next: normalizeSettings(next), previous };
  }

  // ==================== 默认设置 ====================
  // P0-2：默认值直接从预设派生，杜绝 1.20 / 1.25 / 1.4 三个白点各自硬编码。
  const DEFAULT_SETTINGS = {
    _version: CURRENT_SETTINGS_VERSION,
    enabled: true,
    mappingMode: 'bt2446a',
    enhanceImages: false,
    renderScale: 1.0,
    sdrSliderPercent: 35,
    hdrSourceMode: 'off',
    hdrPeakNits: 1000,
    // V1.2.6：默认自动，SDR 屏 / configure 失败会自动回退 8bit
    canvasMode: 'auto',
    canvasEncoding: 'srgb',
    highlightCeiling: 1.2,
    // P1-4：默认 auto —— AVC/非补齐帧走 importExternalTexture 零拷贝，
    // 只有解码帧带补齐（AV1/HEVC 1080→1088）时才自动切 2D 快照。
    // 原来的 snapshot 默认会让每一帧都做一次全帧 drawImage + 纹理上传，
    // 是「打开视频页 CPU 明显上升」的主因；需要「最兼容」的用户仍可在 UI 里手选。
    capturePath: 'auto',
    cropTopPx: 0,
    outputGain: 1.0,
    // DEPRECATED (P3-3)：1D LUT 回滚开关，无 UI；仅保留用于故障排查
    useToneLut: true,
    presetByMode: { power: 'standard', bt2446a: 'highDynamic' },
    powerCurve: { ...POWER_PRESETS.standard.settings },
    bt2446a: { ...HD },
    dualLayer: { enabled: false, mode: 'local', radius: 12, detail: 1.0, split: 0.5, soft: 0.15 },
    deband: { enabled: true, threshold: 0.012 },
    sharpen: { enabled: false, strength: 0.5 },
    // 系统 SDR 亮度同步记录：null 表示从未同步（旧配置 / 新装默认）
    calibration: null,
  };

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function deepMerge(target, source) {
    if (!source || typeof source !== 'object') return target;
    const result = Array.isArray(target) ? [...target] : { ...target };
    for (const key of Object.keys(source)) {
      const sv = source[key];
      const tv = result[key];
      if (sv && typeof sv === 'object' && !Array.isArray(sv) &&
          tv && typeof tv === 'object' && !Array.isArray(tv)) {
        result[key] = deepMerge(tv, sv);
      } else if (sv !== undefined) {
        result[key] = sv;
      }
    }
    return result;
  }

  // ==================== 迁移 ====================
  // 保留原有 v4→v13 迁移链；只把与预设重复的目标值改成引用 PRESETS。
  function migrateSettings(stored) {
    const s = { ...stored };
    const from = Number(s._version) || 0;

    if (from < 4) {
      s.hdrSourceMode = 'off';
      s.canvasMode = 'auto';
      s.canvasEncoding = s.canvasEncoding || 'srgb';
    }
    if (from < 5) {
      s.bt2446a = {
        exposure: 0,
        saturation: 1,
        peakBrightness: 1.7,
        boost: 1,
        midToneLift: 0.35,
      };
      s.presetByMode = { ...(s.presetByMode || {}), bt2446a: 'faithful' };
      s.outputGain = 1;
    }
    if (from < 6) {
      // v6 当时的历史行为；v13 会再改回 auto
      s.canvasMode = 'sdr';
    }
    if (from < 7) {
      s.capturePath = 'snapshot';
      s.cropTopPx = Number(s.cropTopPx) || 0;
    }
    if (from < 9) {
      const cur = s.bt2446a || {};
      s.bt2446a = {
        exposure: Number(cur.exposure) || 0,
        saturation: Number(cur.saturation) || 1,
        peakBrightness: 1.25,
        boost: Number(cur.boost) || 1,
        midToneLift: 0.85,
      };
      s.presetByMode = { ...(s.presetByMode || {}), bt2446a: 'faithful' };
      s.outputGain = 1;
    }
    if (from < 10) {
      const cur = s.bt2446a || {};
      // P3-1：旧版把这里的三个字段另存到 legacyBt2446a，但 normalizeSettings
      // 从不读取它，写入即丢弃。cur 本身就够用，不再复制一份死数据。
      s.bt2446a = {
        exposure: Number(cur.exposure) || 0,
        saturation: Number(cur.saturation) || 1,
        targetWhite: 1.20,
        targetMid: 0.50,
      };
      if (s.presetByMode && s.presetByMode.bt2446a === 'standard') {
        s.presetByMode.bt2446a = 'clarity';
      }
    }
    if (from < 11) {
      const isHighDynamic = s.presetByMode && s.presetByMode.bt2446a === 'highDynamic';
      const cur = s.bt2446a || {};
      if (isHighDynamic && Math.abs(Number(cur.targetWhite) - 2.0) < 0.001) {
        s.bt2446a = {
          ...cur,
          targetWhite: HD.targetWhite,
          saturation: Math.abs(Number(cur.saturation) - 1.15) < 0.001
            ? HD.saturation
            : cur.saturation,
        };
      }
    }
    if (from < 12) {
      const isFaithful = !s.presetByMode || s.presetByMode.bt2446a === 'faithful'
        || s.presetByMode.bt2446a === undefined;
      const cur = s.bt2446a || {};
      const isStd = Math.abs(Number(cur.targetWhite) - FAITHFUL.targetWhite) < 0.001
        && Math.abs(Number(cur.targetMid) - FAITHFUL.targetMid) < 0.001
        && Math.abs(Number(cur.saturation) - FAITHFUL.saturation) < 0.001;
      if (isFaithful && isStd) {
        s.presetByMode = {
          ...(s.presetByMode || {}),
          power: s.presetByMode?.power || 'standard',
          bt2446a: 'highDynamic',
        };
        s.bt2446a = { ...cur, ...HD };
      }
    }
    if (from < 13) {
      if (!s.canvasMode || s.canvasMode === 'sdr') s.canvasMode = 'auto';
      const isHighDynamic13 = s.presetByMode && s.presetByMode.bt2446a === 'highDynamic';
      const cur13 = s.bt2446a || {};
      // 只修「预设仍是 highDynamic 且白点正好是被 8bit 夹过的 1.25」的用户
      if (isHighDynamic13 && Math.abs(Number(cur13.targetWhite) - FAITHFUL.targetWhite) < 0.001) {
        s.bt2446a = { ...cur13, targetWhite: HD.targetWhite };
      }
    }

    if (from < 14) {
      // v14：twoLayer 预设下线。bt2446a 里已存的 1.45 / 0.48 / 1.12 是用户
      // 当前真实观感，原样保留（不回灌 highDynamic 的 1.4 / 0.50 / 1.10）；
      // 只把 presetByMode 指针落到 highDynamic，避免引用已删除的 key。
      const p14 = s.presetByMode || {};
      if (p14.bt2446a === 'twoLayer') {
        s.presetByMode = { ...p14, bt2446a: 'highDynamic' };
      }
    }

    if (from < 15) {
      // v15：取帧方式默认从 snapshot 改为 auto（P1-4）。
      // v7~v14 的 snapshot 是「默认值」而不是用户选择 —— 那个版本没有性能更优的
      // 默认可选，绝大多数配置里的 snapshot 都是被迁移/默认写进去的。
      // 这里统一抬到 auto：非补齐帧零拷贝，补齐帧仍会自动走 2D 快照（行为等价）。
      // 想强制「最兼容」的用户在 UI 里重新选一次 snapshot 即可。
      if (!s.capturePath || s.capturePath === 'snapshot') s.capturePath = 'auto';
    }

    delete s.compareSplit;
    delete s.debugOutline;
    s._version = CURRENT_SETTINGS_VERSION;
    return s;
  }

  // ==================== 归一化 / 校验 ====================
  // storage 与配置快照共用这一条路径。
  // P0-1：白点/中调只按「用户可输入的合法域」夹紧（1.0~2.0 / 0.30~0.70），
  //       绝不按当前画布能力夹紧——那是渲染端 resolveTargets 的职责。
  function normalizeSettings(raw) {
    const merged = deepClone(DEFAULT_SETTINGS);
    if (raw && typeof raw === 'object') {
      if (typeof raw.enabled === 'boolean') merged.enabled = raw.enabled;
      if (typeof raw.mappingMode === 'string') merged.mappingMode = raw.mappingMode;
      if (typeof raw.useBT2446a === 'boolean') {
        merged.mappingMode = raw.useBT2446a ? 'bt2446a' : 'power';
      }
      if (typeof raw.enhanceImages === 'boolean') merged.enhanceImages = raw.enhanceImages;
      // P2-4：renderScale 以前只判类型，导入 1e9 会让目标画布尺寸溢出
      if (raw.renderScale !== undefined) {
        merged.renderScale = clampField('renderScale', raw.renderScale, merged.renderScale);
      }
      if (typeof raw.hdrSourceMode === 'string' &&
          ['auto', 'pq', 'hlg', 'sdr', 'off'].includes(raw.hdrSourceMode)) {
        merged.hdrSourceMode = raw.hdrSourceMode;
      }
      if (['auto', 'import', 'copy', 'snapshot'].includes(raw.capturePath)) {
        merged.capturePath = raw.capturePath;
      }
      if (raw.cropTopPx !== undefined) {
        merged.cropTopPx = Math.round(clampField('cropTopPx', raw.cropTopPx, merged.cropTopPx));
      }
      if (raw.canvasEncoding === 'srgb' || raw.canvasEncoding === 'linear') {
        merged.canvasEncoding = raw.canvasEncoding;
      }
      if (raw.canvasMode === 'auto' || raw.canvasMode === 'sdr') {
        merged.canvasMode = raw.canvasMode;
      }
      if (raw.highlightCeiling !== undefined) {
        merged.highlightCeiling = clampField('highlightCeiling', raw.highlightCeiling, merged.highlightCeiling);
      }
      if (raw.outputGain !== undefined) {
        merged.outputGain = clampField('outputGain', raw.outputGain, merged.outputGain);
      }
      if (typeof raw.useToneLut === 'boolean') merged.useToneLut = raw.useToneLut;
      if (raw.hdrPeakNits !== undefined) {
        merged.hdrPeakNits = Math.round(clampField('hdrPeakNits', raw.hdrPeakNits, merged.hdrPeakNits));
      }
      if (raw.sdrSliderPercent !== undefined) {
        merged.sdrSliderPercent = Math.round(
          clampField('sdrSliderPercent', raw.sdrSliderPercent, merged.sdrSliderPercent));
      }
      if (raw.presetByMode) {
        if (typeof raw.presetByMode.power === 'string') merged.presetByMode.power = raw.presetByMode.power;
        if (typeof raw.presetByMode.bt2446a === 'string') {
          // 'twoLayer' 已在 v14 删除；配置快照/导入可能仍带旧值，这里兜底，
          // 避免 activePresetKey() 指向不存在的预设、导致整个列表无高亮。
          merged.presetByMode.bt2446a = raw.presetByMode.bt2446a === 'standard'
            ? 'clarity'
            : (raw.presetByMode.bt2446a === 'twoLayer' ? 'highDynamic' : raw.presetByMode.bt2446a);
        }
      }
      // P2-4：以前是 Object.assign，导入快照里的 exposure:1e9 / maxBoost:99
      // 会原样进渲染（Math.pow(2, 1e9) = Infinity → 整屏白）。逐字段按 RANGES 夹紧。
      if (raw.powerCurve && typeof raw.powerCurve === 'object') {
        const pc = raw.powerCurve;
        merged.powerCurve.exposure = clampField('exposure', pc.exposure, merged.powerCurve.exposure);
        merged.powerCurve.saturation = clampField('saturation', pc.saturation, merged.powerCurve.saturation);
        merged.powerCurve.peakBrightness = clampField('peakBrightness', pc.peakBrightness, merged.powerCurve.peakBrightness);
        merged.powerCurve.brightnessThreshold = clampField(
          'brightnessThreshold', pc.brightnessThreshold, merged.powerCurve.brightnessThreshold);
        merged.powerCurve.maxBoost = clampField('maxBoost', pc.maxBoost, merged.powerCurve.maxBoost);
        merged.powerCurve.shadowThreshold = clampField(
          'shadowThreshold', pc.shadowThreshold, merged.powerCurve.shadowThreshold);
        merged.powerCurve.shadowCrush = clampField('shadowCrush', pc.shadowCrush, merged.powerCurve.shadowCrush);
      }
      if (raw.bt2446a && typeof raw.bt2446a === 'object') {
        const b = raw.bt2446a;
        if (b.exposure !== undefined) {
          merged.bt2446a.exposure = clampField('exposure', b.exposure, merged.bt2446a.exposure);
        }
        if (b.saturation !== undefined) {
          merged.bt2446a.saturation = clampField('saturation', b.saturation, merged.bt2446a.saturation);
        }

        const hasTargets = (typeof b.targetWhite === 'number' && isFinite(b.targetWhite)) &&
                           (typeof b.targetMid === 'number' && isFinite(b.targetMid));
        if (hasTargets) {
          merged.bt2446a.targetWhite = clampField('targetWhite', b.targetWhite, merged.bt2446a.targetWhite);
          merged.bt2446a.targetMid = clampField('targetMid', b.targetMid, merged.bt2446a.targetMid);
        } else if (b.peakBrightness !== undefined || b.boost !== undefined || b.midToneLift !== undefined) {
          const legacy = {
            peakBrightness: b.peakBrightness ?? 1.25,
            boost: b.boost ?? 1,
            midToneLift: b.midToneLift ?? 0,
          };
          const TM = (typeof global !== 'undefined' && global.HdrToneMath)
            ? global.HdrToneMath
            : null;
          const tone = (TM && typeof TM.resolveTargets === 'function')
            ? TM.resolveTargets(legacy, false)
            : { white: Math.min((legacy.peakBrightness * legacy.boost) || 1.25, 1.25), mid: 0.475 };
          merged.bt2446a.targetWhite = tone.white;
          merged.bt2446a.targetMid = tone.mid;
        }
        delete merged.bt2446a.peakBrightness;
        delete merged.bt2446a.boost;
        delete merged.bt2446a.midToneLift;
      }
      if (raw.dualLayer && typeof raw.dualLayer === 'object') {
        if (typeof raw.dualLayer.enabled === 'boolean') merged.dualLayer.enabled = raw.dualLayer.enabled;
        if (raw.dualLayer.mode === 'zone' || raw.dualLayer.mode === 'local') {
          merged.dualLayer.mode = raw.dualLayer.mode;
        }
        if (raw.dualLayer.radius !== undefined) {
          merged.dualLayer.radius = Math.round(clampField('dualRadius', raw.dualLayer.radius, merged.dualLayer.radius));
        }
        if (raw.dualLayer.detail !== undefined) {
          merged.dualLayer.detail = clampField('dualDetail', raw.dualLayer.detail, merged.dualLayer.detail);
        }
        if (raw.dualLayer.split !== undefined) {
          merged.dualLayer.split = clampField('dualSplit', raw.dualLayer.split, merged.dualLayer.split);
        }
        if (raw.dualLayer.soft !== undefined) {
          merged.dualLayer.soft = clampField('dualSoft', raw.dualLayer.soft, merged.dualLayer.soft);
        }
      }
      if (raw.deband && typeof raw.deband === 'object') {
        if (typeof raw.deband.enabled === 'boolean') merged.deband.enabled = raw.deband.enabled;
        if (raw.deband.threshold !== undefined) {
          merged.deband.threshold = clampField('debandThreshold', raw.deband.threshold, merged.deband.threshold);
        }
      }
      if (raw.sharpen && typeof raw.sharpen === 'object') {
        if (typeof raw.sharpen.enabled === 'boolean') merged.sharpen.enabled = raw.sharpen.enabled;
        if (raw.sharpen.strength !== undefined) {
          merged.sharpen.strength = clampField('sharpenStrength', raw.sharpen.strength, merged.sharpen.strength);
        }
      }
      // 1.2.26：校准记录来自导入快照时必须逐字段校验，不能整包接收
      merged.calibration = normalizeCalibration(raw.calibration);
      // P2-10：两者互斥是硬约束。旧配置/导入快照可能同时为 true，
      // 此时 popup 会把两个开关都 disabled，用户无法关闭任何一个。
      if (merged.deband.enabled && merged.sharpen.enabled) {
        merged.sharpen.enabled = false;
      }
    }
    return merged;
  }

  global.HDRSettings = {
    CURRENT_SETTINGS_VERSION,
    DEFAULT_SETTINGS,
    POWER_PRESETS,
    BT2446A_PRESETS,
    GLOBAL_RECOMMENDED,
    GLOBAL_RECOMMENDED_SATURATION,
    RANGES,
    clampField,
    sliderToNits,
    computeCalibration,
    recommendedTargets,
    computeRecommended,
    MANUAL_COMPAT_FIELDS,
    manualCompatOverrides,
    normalizeCalibration,
    emptyCalibration,
    CALIBRATABLE_FIELDS,
    deepClone,
    deepMerge,
    migrateSettings,
    normalizeSettings,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
