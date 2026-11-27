'use strict';
// HDR Vision — core.js（从 content-script.js 拆出，Phase 3 / P3-4）

// 设置统一由 service-worker 下发（GET_SETTINGS），本文件不再保留一份默认副本，
// 避免两处默认值漂移。保留消息类型与状态常量供消息处理/状态上报使用。
const MESSAGE_TYPES = {
  GET_SETTINGS: 'GET_SETTINGS',
  SETTINGS_UPDATED: 'SETTINGS_UPDATED',
  GET_STATUS: 'GET_STATUS',
};

const STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  NO_VIDEO: 'no_video',
  NO_WEBGPU: 'no_webgpu',
  SOURCE_HDR: 'source_hdr',
  CODEC_FAILED: 'codec_failed',
  CROSS_ORIGIN: 'cross_origin',
  // P1-5：EME 受保护媒体不接管（drawImage 返回黑帧），单独上报而不是伪装成「未激活」
  DRM_PROTECTED: 'drm_protected',
  // P1-6：WGSL 编译或 pipeline 校验失败时不再伪装成「未激活/无视频」
  SHADER_ERROR: 'shader_error',
};

const IMAGE_MIN_PIXELS = 50_000;
const IMAGE_CONCURRENCY_TIERS = [
  { maxPixels: 1_000_000, max: 60 },
  { maxPixels: 4_000_000, max: 24 },
  { maxPixels: Infinity, max: 10 },
];
const IMAGE_BATCH_PER_FRAME = 16;
// P2-3：图片纹理总显存预算（RGBA8）。单张 8K ≈132MB，原来的 tier 允许 10 张 → 1.3GB。
const IMAGE_TEXTURE_BUDGET_BYTES = 256 * 1024 * 1024;
const IMAGE_PENDING_BACKOFF_MS = 250;

const VIDEO_CONCURRENCY_TIERS = [
  { maxPixels: 1_000_000, max: 12 },
  { maxPixels: 4_000_000, max: 6 },
  { maxPixels: Infinity, max: 3 },
];

// P2-11：视频纹理总预算（只统计自己分配的纹理，external 路径为 0）。
// 8K HDR 单张 rgba16float = 7680×4320×8 ≈ 265MB；tier 允许 3 张 → 795MB。
// 这个上限保证「至少接一个，但不会把整页显存吃穿」。
const VIDEO_TEXTURE_BUDGET_BYTES = 320 * 1024 * 1024;
const VIDEO_BUDGET_RETRY_MS = 3000;

const MAX_CONSECUTIVE_FAILURES = 90;
// P2-6：90 帧在 60fps 下只有 1.5s，切分辨率 / seek / 解码器重建很容易误杀。
// 已成功渲染过的视频要「连续失败 + 持续 >3s」才停；还没出过首帧的走指数退避，
// 给解码器初始化留窗口，最多退避 6 次（约 23s）再放弃。
const FAILURE_WINDOW_MS = 3000;
const STARTUP_BACKOFF_BASE_MS = 500;
const STARTUP_BACKOFF_MAX_MS = 8000;
const MAX_STARTUP_BACKOFFS = 6;
const SCAN_DEBOUNCE_MS = 200;
// P1-3：HDR 标记校准拿不到探测结论时的最大重试次数（退避 1×、2×、3×… 基准间隔）
const CALIBRATION_MAX_RETRIES = 4;
// P2-7：device 级 GPU 校验错误预算。20 次/10s 视为「管线真的坏了」，
// 先整体停用再延迟重建一次；错误计数按时间窗衰减，避免偶发抖动累积成永久停用。
const GPU_ERROR_LIMIT = 20;
const GPU_ERROR_WINDOW_MS = 10000;
const GPU_ERROR_RECOVERY_DELAY_MS = 2000;

// VideoManager / ImageManager 共用的分级与扫描调度，避免两份实现各自漂移
function pickTier(tiers, pixelCount) {
  for (const tier of tiers) {
    if (pixelCount < tier.maxPixels) return tier;
  }
  return tiers[tiers.length - 1];
}

function countRenderersInTier(renderers, tier) {
  let count = 0;
  for (const renderer of renderers.values()) {
    if (renderer.tier === tier) count++;
  }
  return count;
}

function debouncedScan(owner) {
  if (!owner.isEnabled) return;
  if (owner._scanDebounce) clearTimeout(owner._scanDebounce);
  owner._scanDebounce = setTimeout(() => owner.scan(), SCAN_DEBOUNCE_MS);
}

const hdrDisplayQuery = (() => {
  try {
    return typeof window.matchMedia === 'function'
      ? window.matchMedia('(dynamic-range: high)')
      : null;
  } catch { return null; }
})();

function detectHDRDisplay() {
  try {
    return hdrDisplayQuery ? hdrDisplayQuery.matches === true : false;
  } catch {
    return false;
  }
}

let HDR_DISPLAY_AVAILABLE = detectHDRDisplay();
console.log('[HDR Vision] HDR display available:', HDR_DISPLAY_AVAILABLE);

