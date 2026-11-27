'use strict';
// HDR Vision — managers.js（从 content-script.js 拆出，Phase 3 / P3-4）

class VideoManager {
  constructor(device) {
    this.device = device;
    // P4-1：shared 延迟到知道取帧方式后再建 —— 只预编译真正会用到的那条管线
    this.shared = null;
    this.ready = null;
    this.shaderReady = false;
    this._destroyed = false;
    this.renderers = new Map();
    this.observed = new WeakSet();
    // P2-11：视频纹理预算（快照/直拷路径才分配，external 记 0）
    this._textureBytes = 0;
    this._loggedBudget = false;
    this._budgetRetryTimer = null;
    this.settings = null;
    this.minArea = 15000;
    this.isEnabled = false;
    this._scanDebounce = null;
    this.intersectionObserver = null;
    this.detectedVideoCount = 0;
    this.detectedHDRCount = 0;
    this.failedCodecCount = 0;
    this.crossOriginCount = 0;
    this.drmProtectedCount = 0;
    this._loggedCodecFail = false;
    this._loggedCrossOrigin = false;
    this._loggedDRM = false;

    this.mutationObserver = new MutationObserver(() => this.scheduleScan());
  }

  // P4-1：只编译当前取帧方式需要的管线；另一条路径等真正用到再补建
  _prepareShared() {
    if (this.shared || !this.device || this._destroyed) return;
    const capturePath = this.settings?.capturePath || 'auto';
    const preferred = (capturePath === 'snapshot' || capturePath === 'copy') ? 'copy' : 'external';
    this.shared = new SharedVideoResources(this.device, preferred);
    // P1-4：auto 的两条路径都可能用到（补齐帧 / import 失败降级都会走 copy）。
    // copy 管线提前异步编译，避免第一次遇到 AV1/HEVC 补齐帧时在主线程同步编译造成卡顿。
    const extra = (capturePath === 'auto' && preferred === 'external')
      ? this.shared.preparePath('copy')
      : null;
    this.ready = Promise.all([this.shared.ready, extra]).then(() => {
      if (this._destroyed) return;
      this.shaderReady = true;
      // 编译期间被挡下的视频此时统一纳入扫描
      if (this.isEnabled) this.scan();
    });
  }

  _createIntersectionObserver() {
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const video = entry.target;
          if (entry.isIntersecting) this._activate(video);
          else this._deactivate(video);
        }
      },
      { rootMargin: '200px' }
    );
  }

  _getTier(pixelCount) {
    return pickTier(VIDEO_CONCURRENCY_TIERS, pixelCount);
  }

  // P2-11：按渲染器自报的纹理占用重算总量（不维护增量，避免尺寸变化后漂移）
  _recountTextureBytes() {
    let total = 0;
    for (const r of this.renderers.values()) {
      if (r && typeof r.estimateTextureBytes === 'function') total += r.estimateTextureBytes();
    }
    this._textureBytes = total;
    return total;
  }

  // 预算准入：当前占用 + 新渲染器 ≤ 上限，或页面里还没有任何占用时允许这一个
  // （避免单个 8K 视频因为自身就超预算而永远不被接管）。
  _admitRenderer(renderer) {
    const bytes = typeof renderer.estimateTextureBytes === 'function'
      ? renderer.estimateTextureBytes() : 0;
    if (bytes <= 0) return true;
    const used = this._recountTextureBytes();
    if (used > 0 && used + bytes > VIDEO_TEXTURE_BUDGET_BYTES) return false;
    return true;
  }

  _scheduleBudgetRetry() {
    if (this._budgetRetryTimer) return;
    this._budgetRetryTimer = setTimeout(() => {
      this._budgetRetryTimer = null;
      if (this.isEnabled) this.scheduleScan();
    }, VIDEO_BUDGET_RETRY_MS);
  }

  // 预算拒绝：撤掉刚建的渲染器、退回观察队列并留退避时间，3s 后重扫。
  // 单独成方法是为了让「拒绝后不残留观察状态」可被单测直接驱动。
  _rejectForBudget(video, renderer) {
    try { renderer.destroy(); } catch {}
    this.observed.delete(video);
    try { this.intersectionObserver?.unobserve(video); } catch {}
    video.__hdrBudgetUntil = Date.now() + VIDEO_BUDGET_RETRY_MS;
    if (!this._loggedBudget) {
      console.info('[HDR Vision] 视频纹理预算已满，暂不接管该视频');
      this._loggedBudget = true;
    }
    this._scheduleBudgetRetry();
  }

  _countInTier(tier) {
    return countRenderersInTier(this.renderers, tier);
  }

  setEnabled(enabled) {
    if (this.isEnabled === enabled) return;
    this.isEnabled = enabled;

    if (enabled) {
      this._prepareShared();
      // P2-8：全局只启动一个 overlay 检测器
      startNijiPolling();
      this._createIntersectionObserver();
      this.observed = new WeakSet();
      this.renderers.clear();
      this.detectedVideoCount = 0;
      this.detectedHDRCount = 0;
      this.failedCodecCount = 0;
      this.crossOriginCount = 0;
      this.drmProtectedCount = 0;
      this._loggedCodecFail = false;
      this._loggedCrossOrigin = false;
      this._loggedDRM = false;
      // ★ 保护：document.body 可能为空
      const root = document.body || document.documentElement;
      if (root) {
        this.mutationObserver.observe(root, { childList: true, subtree: true });
      }
      this.scan();
    } else {
      this.mutationObserver.disconnect();
      this.clearAll();
      stopNijiPolling();
    }
  }

  updateSettings(settings) {
    const prevMode = this.settings?.hdrSourceMode;
    this.settings = settings;
    this._prepareShared();
    for (const renderer of this.renderers.values()) {
      renderer.updateSettings(settings);
    }
    // ★ HDR 源处理模式变化：之前被跳过的 HDR 视频需要重新纳入扫描
    if (prevMode !== settings.hdrSourceMode) {
      this.observed = new WeakSet();
      this.detectedVideoCount = 0;
      this.detectedHDRCount = 0;
      this.scheduleScan();
    }
  }

  scheduleScan() {
    debouncedScan(this);
  }

  scan() {
    if (!this.isEnabled) return;
    // P4-1：pipeline 还在异步编译时不建渲染器，编译完成后由 ready 回调重新扫描
    if (!this.shaderReady) return;
    // P1-5：SPA 移除 <video> 后 renderer 不会自己消失，定期清扫，避免条目/gpu 资源单调增长
    for (const [el, renderer] of [...this.renderers]) {
      if (!el.isConnected) {
        renderer.destroy();
        this.renderers.delete(el);
        this.observed.delete(el);
      }
    }
    const videos = document.querySelectorAll('video');
    for (const video of videos) {
      if (this.observed.has(video)) continue;
      if (this.renderers.has(video)) continue;
      this._maybeObserve(video);
    }
  }

  _maybeObserve(video) {
    if (!this.isEnabled) return;
    if (this.observed.has(video)) return;
    if (this.renderers.has(video)) return;
    // P2-11：纹理预算退避期内不重复建/拆渲染器
    if (video.__hdrBudgetUntil && Date.now() < video.__hdrBudgetUntil) return;

    if (!video.videoWidth || !video.videoHeight || video.readyState < 2) {
      if (!video.__hdrRetryState) {
        video.__hdrRetryState = { attempts: 0 };
        const retry = () => {
          if (!video.__hdrRetryState) return;
          if (!this.isEnabled) {
            delete video.__hdrRetryState;
            return;
          }
          if (this.observed.has(video) || this.renderers.has(video)) {
            delete video.__hdrRetryState;
            return;
          }
          video.__hdrRetryState.attempts++;
          if (video.__hdrRetryState.attempts > 30) {
            delete video.__hdrRetryState;
            return;
          }
          if (video.videoWidth && video.videoHeight && video.readyState >= 2) {
            delete video.__hdrRetryState;
            this._maybeObserve(video);
          } else {
            setTimeout(retry, 300);
          }
        };
        video.addEventListener('loadedmetadata', retry, { once: true });
        video.addEventListener('loadeddata', retry, { once: true });
        video.addEventListener('canplay', retry, { once: true });
        setTimeout(retry, 300);
      }
      return;
    }

    this.detectedVideoCount++;

    const probe = probeSource(video);
    if (probe.isHDR) this.detectedHDRCount++;

    this.observed.add(video);
    // 源是 HDR 且用户选择「不处理」→ 与旧版行为一致：直接跳过
    if (probe.isHDR && resolveHDRMode(this.settings, probe) === 0 &&
        shouldSkipHDRSource(this.settings)) return;
    if (this.intersectionObserver) {
      this.intersectionObserver.observe(video);
    }
  }

  _activate(video) {
    if (!this.isEnabled) return;
    if (!this.shaderReady) return;
    if (this.renderers.has(video)) return;
    if (!video.videoWidth || !video.videoHeight) return;

    // ★ P1-5：EME 受保护媒体读帧只能拿到黑帧（且不抛错），接管等于整块黑屏。
    if (isDRMProtected(video)) {
      this.drmProtectedCount = (this.drmProtectedCount || 0) + 1;
      this.observed.add(video);
      if (!this._loggedDRM) {
        console.info('[HDR Vision] 该视频受 DRM 保护（EME），浏览器不允许读帧，已跳过增强');
        this._loggedDRM = true;
      }
      return;
    }

    // ★ 跨域视频读不到像素，直接跳过（不建画布、不报错）
    if (!isVideoPixelReadable(video)) {
      this.crossOriginCount = (this.crossOriginCount || 0) + 1;
      this.observed.add(video);
      if (!this._loggedCrossOrigin) {
        console.info('[HDR Vision] 该视频受跨域限制，浏览器禁止读取画面像素，已跳过增强');
        this._loggedCrossOrigin = true;
      }
      return;
    }

    const probe = probeSource(video);
    if (probe.isHDR && resolveHDRMode(this.settings, probe) === 0 &&
        shouldSkipHDRSource(this.settings)) {
      this.observed.add(video);
      return;
    }

    const pixelCount = video.videoWidth * video.videoHeight;
    if (pixelCount < this.minArea) return;

    const tier = this._getTier(pixelCount);
    if (this._countInTier(tier) >= tier.max) return;

    try {
      const renderer = new VideoRenderer(this.shared, video, this.settings);
      if (renderer.failed) {
        // HDR 源被跳过是正常行为；非 HDR 失败才算"这个编码渲染不了"
        if (!renderer.sourceIsHDR) {
          this.failedCodecCount = (this.failedCodecCount || 0) + 1;
          if (!this._loggedCodecFail) {
            console.warn('[HDR Vision] 该视频编码无法建立渲染器（不是 HDR 源）');
            this._loggedCodecFail = true;
          }
        }
        renderer.destroy();
        return;
      }
      renderer.tier = tier;
      renderer.onDestroyed = () => {
        // P1-5：renderer 自毁（GPU 错误/跨域/连续失败）后立刻从管理器移除
        if (this.renderers.get(video) === renderer) this.renderers.delete(video);
        // 播放中途才检测到 EME（encrypted 事件）时，状态也要能报 drm_protected
        if (renderer.drmProtected) this.drmProtectedCount = (this.drmProtectedCount || 0) + 1;
        try { this.intersectionObserver?.unobserve(video); } catch {}
        // P2-11：归还后重新统计，等预算的视频可以在下一轮扫描进来
        this._recountTextureBytes();
      };
      // P2-11：纹理预算准入。超限时不接管这个视频（外部纹理路径不受影响），
      // 3s 后重扫；期间若其他视频滚出视口释放了纹理，就能补上。
      if (!this._admitRenderer(renderer)) {
        this._rejectForBudget(video, renderer);
        return;
      }
      this.renderers.set(video, renderer);
      this._recountTextureBytes();
      renderer.startRendering();
    } catch (e) {
      console.warn('[HDR Vision] Failed to activate video renderer:', e);
    }
  }

  _deactivate(video) {
    const renderer = this.renderers.get(video);
    if (!renderer) return;
    renderer.destroy();
    this.renderers.delete(video);
  }

  clearAll() {
    for (const renderer of this.renderers.values()) renderer.destroy();
    this.renderers.clear();
    this.observed = new WeakSet();
    this._textureBytes = 0;
    if (this._budgetRetryTimer) {
      clearTimeout(this._budgetRetryTimer);
      this._budgetRetryTimer = null;
    }
    if (this.intersectionObserver) this.intersectionObserver.disconnect();
    if (this._scanDebounce) {
      clearTimeout(this._scanDebounce);
      this._scanDebounce = null;
    }
  }

  destroy() {
    this._destroyed = true;
    this.clearAll();
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }
    this.mutationObserver.disconnect();
    stopNijiPolling();
    // P1-4：shared GPU 资源不再随 manager 引用丢弃而泄漏
    try { this.shared?.destroy(); } catch {}
  }
}

// ============ 图片渲染器 ============
class ImageManager {
  constructor(device) {
    this.device = device;
    this.shared = new SharedImageResources(device);
    this.renderers = new Map();
    this.pending = new Set();
    this.observed = new WeakSet();
    this.settings = null;
    this.isEnabled = false;
    this._scanDebounce = null;
    this._flushScheduled = false;
    this._pendingBackoff = null;
    this._textureBytes = 0;
    this.intersectionObserver = null;
    this.shaderReady = false;
    this._destroyed = false;

    this.mutationObserver = new MutationObserver(() => this.scheduleScan());

    // P4-1：图片管线异步编译，就绪后再开始扫描/出队
    this.ready = this.shared.ready.then(() => {
      if (this._destroyed) return;
      this.shaderReady = true;
      if (this.isEnabled) {
        this.scan();
        if (this.pending.size) this._scheduleFlush();
      }
    });
  }

  _createIntersectionObserver() {
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const img = entry.target;
          if (entry.isIntersecting) this._queueActivate(img);
          else this._deactivate(img);
        }
      },
      { rootMargin: '400px' }
    );
  }

  _getTier(pixelCount) {
    return pickTier(IMAGE_CONCURRENCY_TIERS, pixelCount);
  }

  _countInTier(tier) {
    return countRenderersInTier(this.renderers, tier);
  }

  _countPendingInTier(tier) {
    let count = 0;
    for (const img of this.pending) {
      if (img.__hdrTier === tier) count++;
    }
    return count;
  }

  setEnabled(enabled) {
    if (this.isEnabled === enabled) return;
    this.isEnabled = enabled;

    if (enabled) {
      this._createIntersectionObserver();
      this.observed = new WeakSet();
      this.renderers.clear();
      this.pending.clear();
      this._flushScheduled = false;
      // ★ 保护：document.body 可能为空
      const root = document.body || document.documentElement;
      if (root) {
        this.mutationObserver.observe(root, { childList: true, subtree: true });
      }
      this.scan();
    } else {
      this.mutationObserver.disconnect();
      this.clearAll();
    }
  }

  updateSettings(settings) {
    this.settings = settings;
    for (const renderer of this.renderers.values()) {
      renderer.updateSettings(settings);
    }
  }

  scheduleScan() {
    debouncedScan(this);
  }

  scan() {
    if (!this.isEnabled) return;
    // P4-1：管线未就绪时先不建渲染器，ready 回调会重新扫描
    if (!this.shaderReady) return;
    // P1-5：清扫已从 DOM 移除的图片渲染器
    for (const [el, renderer] of [...this.renderers]) {
      if (!el.isConnected) {
        renderer.destroy();
        this.renderers.delete(el);
        this.pending.delete(el);
        this.observed.delete(el);
      }
    }
    const images = document.querySelectorAll('img');
    for (const img of images) {
      if (this.observed.has(img)) continue;
      if (!img.complete) {
        // P2-10：未加载完的图片每次 scan 都挂一个 load 监听 → 图片站高频 DOM 变更时
        // 同一张图会堆积几十个回调（且 onerror 时永不释放）。改成一次性挂钩。
        if (!img.__hdrLoadHooked) {
          img.__hdrLoadHooked = true;
          img.addEventListener('load', () => {
            // 加载失败时允许后续 scan 重新挂钩（例如站点替换了 src）
            img.__hdrLoadHooked = false;
            if (this.isEnabled) this._maybeObserve(img);
          }, { once: true });
          img.addEventListener('error', () => {
            img.__hdrLoadHooked = false;
          }, { once: true });
        }
        continue;
      }
      // 已 complete 但没有尺寸 = 坏图/空 src，无需挂钩
      if (!img.naturalWidth) continue;
      this._maybeObserve(img);
    }
  }

  _maybeObserve(img) {
    if (!this.isEnabled) return;
    if (this.observed.has(img)) return;
    if (!img.naturalWidth || !img.naturalHeight) return;

    const pixelCount = img.naturalWidth * img.naturalHeight;
    if (pixelCount < IMAGE_MIN_PIXELS) return;

    const src = img.currentSrc || img.src || '';
    if (src.startsWith('data:image/svg')) return;

    this.observed.add(img);
    if (this.intersectionObserver) this.intersectionObserver.observe(img);
  }

  _queueActivate(img) {
    if (!this.isEnabled) return;
    if (this.renderers.has(img)) return;
    if (this.pending.has(img)) return;

    const pixelCount = img.naturalWidth * img.naturalHeight;
    const tier = this._getTier(pixelCount);

    if (this._countInTier(tier) + this._countPendingInTier(tier) >= tier.max) return;

    img.__hdrTier = tier;
    this.pending.add(img);
    this._scheduleFlush();
  }

  _scheduleFlush() {
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    requestAnimationFrame(() => {
      this._flushScheduled = false;
      this._flushPending();
    });
  }

  _flushPending() {
    // P4-1：管线未就绪时不建渲染器；pending 保留，ready 回调会重新出队
    if (!this.shaderReady) return;
    const before = this.pending.size;
    let processed = 0;
    for (const img of this.pending) {
      if (processed >= IMAGE_BATCH_PER_FRAME) break;
      if (!this.isEnabled) {
        this.pending.clear();
        return;
      }
      if (!img.isConnected || this.renderers.has(img)) {
        this.pending.delete(img);
        continue;
      }
      const pixelCount = img.naturalWidth * img.naturalHeight;
      const tier = this._getTier(pixelCount);
      if (this._countInTier(tier) >= tier.max) continue;

      // P2-3：总显存预算，避免 >4MP tier 允许多张 8K 图吃掉 1GB+
      const scale = Math.min(Math.max(this.settings?.renderScale ?? 1, 0.25), 1);
      const bytes = Math.round(pixelCount * scale * scale * 4);
      if (this._textureBytes > 0 && this._textureBytes + bytes > IMAGE_TEXTURE_BUDGET_BYTES) {
        continue;
      }

      try {
        const renderer = new ImageRenderer(this.shared, img, this.settings);
        if (renderer.failed) {
          renderer.destroy();
          this.pending.delete(img);
          continue;
        }
        renderer.tier = tier;
        renderer._budgetBytes = bytes;
        renderer.onDestroyed = () => {
          // P1-5 + P2-3：自毁时清条目并归还显存预算
          if (this.renderers.get(img) === renderer) this.renderers.delete(img);
          this._textureBytes = Math.max(0, this._textureBytes - (renderer._budgetBytes || 0));
          try { this.intersectionObserver?.unobserve(img); } catch {}
        };
        this._textureBytes += bytes;
        this.renderers.set(img, renderer);
        renderer._render();
        this.pending.delete(img);
        processed++;
      } catch (e) {
        this.pending.delete(img);
      }
    }
    if (this.pending.size === 0 || !this.isEnabled) return;
    // P2-1：tier/预算全部阻塞时退避，避免 requestAnimationFrame 60Hz 空转
    if (processed > 0 || this.pending.size !== before) {
      this._scheduleFlush();
    } else {
      if (this._pendingBackoff) clearTimeout(this._pendingBackoff);
      this._pendingBackoff = setTimeout(() => {
        this._pendingBackoff = null;
        if (this.isEnabled) this._scheduleFlush();
      }, IMAGE_PENDING_BACKOFF_MS);
    }
  }

  _deactivate(img) {
    const renderer = this.renderers.get(img);
    if (!renderer) {
      this.pending.delete(img);
      return;
    }
    renderer.destroy();
    this.renderers.delete(img);
  }

  clearAll() {
    for (const renderer of this.renderers.values()) renderer.destroy();
    this.renderers.clear();
    this.pending.clear();
    this.observed = new WeakSet();
    this._flushScheduled = false;
    this._textureBytes = 0;
    if (this._pendingBackoff) {
      clearTimeout(this._pendingBackoff);
      this._pendingBackoff = null;
    }
    if (this.intersectionObserver) this.intersectionObserver.disconnect();
    if (this._scanDebounce) {
      clearTimeout(this._scanDebounce);
      this._scanDebounce = null;
    }
  }

  destroy() {
    this._destroyed = true;
    this.clearAll();
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }
    this.mutationObserver.disconnect();
    // P1-4：图片 shared 资源随 manager 一起释放
    try { this.shared?.destroy(); } catch {}
  }
}

// ============ 主控制器 ============
