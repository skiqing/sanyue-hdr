/**
 * 色调数学：由「目标白点 / 目标中调」反解曲线参数。
 *
 * 这份实现必须与 shader 中的 bt2446aInverseWithLift + midToneLift +
 * compressSDRHeadroom 完全一致，否则"设定的目标"和"看到的画面"会脱节。
 * 内容脚本与弹窗共用本文件（manifest 的 content_scripts 顺序保证先加载）。
 */
(function (global) {
  'use strict';

  // BT.2446a 逆映射在给定峰值下的输出亮度（输入为 sRGB 编码值 0..1）
  // 注：曾尝试缓存 pHDR（只依赖 peak*boost），实测在 V8 上缓存查找开销已接近甚至
  //     超过重算 pow/log（双峰值场景反而慢约 11%），故不做缓存，保持实现最简。
  function lumaAt(encoded, peak, boost) {
    const l = Math.min(Math.max(encoded, 0), 1);
    if (l < 1e-5) return 0;

    let yp;
    if (l <= 0.7969) {
      yp = l / 1.0770;
    } else if (l >= 0.99545) {
      yp = 2.0 * l - 1.0;
    } else {
      const a = 1.1510;
      const b = -2.7811;
      const c = 0.6302 + l;
      yp = (-b - Math.sqrt(Math.max(b * b - 4 * a * c, 0))) / (2 * a);
    }

    const maxL = Math.max(peak * boost, 1.0) * 100.0;
    const pHDR = 1.0 + 32.0 * Math.pow(maxL / 10000.0, 1.0 / 2.4);
    const y = (Math.exp(yp * Math.log(pHDR)) - 1.0) / (pHDR - 1.0);
    return y * peak * boost;
  }

  // 中调补偿 + 8bit 画布的高光软压缩
  function liftAndCompress(luma, peak, boost, lift, hdrCanvas) {
    let out = luma;

    if (lift > 0.001 && out > 1e-5) {
      const effectivePeak = Math.min(peak * boost, 5.0);
      const norm = Math.min(Math.max(out / effectivePeak, 0), 1);
      const gamma = 1.0 / (1.0 + lift * 0.7);
      const lifted = Math.pow(norm, gamma) * effectivePeak;
      out = Math.max(lifted, out);   // shader: lumaScale = max(newLuma / outputLuma, 1)
    }

    if (!hdrCanvas) {
      const knee = 0.95;
      if (out > knee) {
        const x = (out - knee) / (1.0 - knee);
        out = knee + (1.0 - knee) * (x / (1.0 + x));
      }
    }
    return out;
  }

  function outputAt(encoded, peak, boost, lift, hdrCanvas) {
    return liftAndCompress(lumaAt(encoded, peak, boost), peak, boost, lift, hdrCanvas);
  }

  // 单调递增 → 二分求解：让输入 0.5 的输出等于目标中调
  function solveLift(peak, targetMid, hdrCanvas) {
    // 输入恒为 0.5，逆映射结果与 lift 无关，提到循环外只算一次（原为 30 次）
    const baseLuma = lumaAt(0.5, peak, 1.0);
    let lo = 0.0;
    let hi = 2.0;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (liftAndCompress(baseLuma, peak, 1.0, mid, hdrCanvas) < targetMid) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  const cache = new Map();

  /**
   * 解析出本轮渲染要用的 { white, mid, lift }。
   * 兼容旧参数（peakBrightness / boost / midToneLift）：按旧观感折算成等价目标，
   * 这样升级后画面不会突然跳变。
   */
  function resolveTargets(bt, hdrCanvas) {
    const legacyPeak = Number(bt && bt.peakBrightness);
    const legacyBoost = Number(bt && bt.boost);
    const legacyLift = Number(bt && bt.midToneLift);
    const legacyWhite =
      (isFinite(legacyPeak) ? legacyPeak : 1.0) * (isFinite(legacyBoost) ? legacyBoost : 1.0);

    let white = bt && typeof bt.targetWhite === 'number' && isFinite(bt.targetWhite)
      ? bt.targetWhite
      : legacyWhite;
    white = Math.min(Math.max(white, 1.0), 2.0);
    if (!hdrCanvas) white = Math.min(white, 1.25);   // 8bit 画布没有超过 SDR 白的余量

    let mid;
    if (bt && typeof bt.targetMid === 'number' && isFinite(bt.targetMid)) {
      mid = bt.targetMid;
    } else {
      // 旧实现里 8bit 会把 lift 抬到 0.85，这里按同样规则折算
      const oldLift = isFinite(legacyLift) ? legacyLift : 0.35;
      const effectiveOldLift = hdrCanvas ? oldLift : Math.max(oldLift, 0.85);
      // ★ 必须用收敛后的 white：8bit 画布上旧白点可能是 1.955，直接拿它算会把中调顶到上限
      mid = outputAt(0.5, white, 1.0, effectiveOldLift, hdrCanvas);
    }
    mid = Math.min(Math.max(mid, 0.30), 0.70);

    const key = white.toFixed(3) + '|' + mid.toFixed(3) + '|' + (hdrCanvas ? 1 : 0);
    const hit = cache.get(key);
    if (hit) return hit;

    const result = { white: white, mid: mid, lift: solveLift(white, mid, hdrCanvas) };
    if (cache.size > 64) cache.clear();
    cache.set(key, result);
    return result;
  }

  // ============ 1D LUT 生成（阶段 2）============
  // 只烘焙「BT.2446a 逆映射 + midToneLift」，不烘焙 8bit 高光压缩。
  // 压缩仍留在 shader 的 OKLab 之后做，保持原有管线顺序、避免两级压缩。
  function outputRaw(encoded, peak, boost, lift) {
    let out = lumaAt(encoded, peak, boost);
    if (lift > 0.001 && out > 1e-5) {
      const effectivePeak = Math.min(peak * boost, 5.0);
      const norm = Math.min(Math.max(out / effectivePeak, 0), 1);
      const gamma = 1.0 / (1.0 + lift * 0.7);
      out = Math.max(Math.pow(norm, gamma) * effectivePeak, out);
    }
    return out;
  }

  const _f32 = new Float32Array(1);
  const _u32 = new Uint32Array(_f32.buffer);
  function toHalf(val) {
    if (!isFinite(val)) return val > 0 ? 0x7c00 : 0xfc00;
    _f32[0] = val;
    const x = _u32[0];
    const sign = (x >>> 16) & 0x8000;
    const exp = ((x >>> 23) & 0xff) - 127 + 15;
    const mant = x & 0x7fffff;
    if (exp <= 0) {
      if (exp < -10) return sign;
      return sign | ((mant | 0x800000) >>> (14 - exp));
    }
    if (exp >= 31) return sign | 0x7c00;
    // 四舍五入到最近偶数，降低半精度量化误差
    return sign | (exp << 10) | ((mant + 0x1000 + ((mant >>> 13) & 1)) >>> 13);
  }

  // V1.2.4 双层合成 LUT：256×6
  //   行0/1 = 原单层 SDR/HDR（与单层 LUT 前两行一致，向后兼容）
  //   行2/3 = 8bit 画布的暗部层 / 亮部层
  //   行4/5 = 16float 画布的暗部层 / 亮部层
  // 为什么必须按画布拆两套：8bit 画布白点被 resolveTargets 收敛到 ≤1.25，
  // 且渲染末端还有 compressSDRHeadroom 把 >0.95 的部分压回 1.0；
  // 若 8bit 也走 HDR 那套（白点 1.5），亮部层全部落在压缩区里，收益被抹平。
  const DUAL_DARK = { targetWhite: 1.15, targetMid: 0.46 };
  const DUAL_BRIGHT = { targetWhite: 1.5, targetMid: 0.48 };
  const DUAL_ROWS = 6;
  function buildDualLut(bt, size) {
    const n = Math.max(2, Math.min(1024, Math.round(size || 256)));
    const sdr = resolveTargets(bt, false);
    const hdr = resolveTargets(bt, true);
    // 8bit：暗部层 1.15 本就低于 1.25 上限，只有亮部层会被收敛到 1.25
    const darkSdr = resolveTargets(DUAL_DARK, false);
    const brightSdr = resolveTargets(DUAL_BRIGHT, false);
    const darkHdr = resolveTargets(DUAL_DARK, true);
    const brightHdr = resolveTargets(DUAL_BRIGHT, true);
    const out = new Uint16Array(n * DUAL_ROWS);
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      out[i] = toHalf(outputRaw(x, sdr.white, 1.0, sdr.lift));
      out[n + i] = toHalf(outputRaw(x, hdr.white, 1.0, hdr.lift));
      out[2 * n + i] = toHalf(outputRaw(x, darkSdr.white, 1.0, darkSdr.lift));
      out[3 * n + i] = toHalf(outputRaw(x, brightSdr.white, 1.0, brightSdr.lift));
      out[4 * n + i] = toHalf(outputRaw(x, darkHdr.white, 1.0, darkHdr.lift));
      out[5 * n + i] = toHalf(outputRaw(x, brightHdr.white, 1.0, brightHdr.lift));
    }
    return out;
  }

  // LUT 指纹：P3-2 起把 DUAL_* 常量的实际值也纳入指纹，
  // 改双层曲线参数时不再需要手动升级 'L6|' 前缀。
  function lutFingerprint(bt) {
    const sdr = resolveTargets(bt, false);
    const hdr = resolveTargets(bt, true);
    return 'L' + DUAL_ROWS + '|'
      + DUAL_DARK.targetWhite + '|' + DUAL_DARK.targetMid + '|'
      + DUAL_BRIGHT.targetWhite + '|' + DUAL_BRIGHT.targetMid + '|'
      + sdr.white.toFixed(4) + '|' + sdr.lift.toFixed(4) + '|'
      + hdr.white.toFixed(4) + '|' + hdr.lift.toFixed(4);
  }

  global.HdrToneMath = {
    lumaAt: lumaAt,
    outputAt: outputAt,
    outputRaw: outputRaw,
    toHalf: toHalf,
    buildDualLut: buildDualLut,
    DUAL_ROWS: DUAL_ROWS,
    lutFingerprint: lutFingerprint,
    solveLift: solveLift,
    resolveTargets: resolveTargets,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
