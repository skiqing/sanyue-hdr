'use strict';
// HDR Vision — controller.js（从 content-script.js 拆出，Phase 3 / P3-4）

// P3-9：10 个 classic script 靠 manifest 顺序隐式共享全局。最后加载的
// controller.js 在这里做一次总检查：缺文件 / 改顺序会在控制台直接报名字，
// 而不是等到首帧才表现为黑屏或「开关没反应」。
// 同时给出命名空间 HDRV，新代码统一从这里取，不再新增散落全局。
function assertContentDependencies() {
  const checks = {
    HDRSettings: typeof HDRSettings !== 'undefined',
    HdrToneMath: typeof HdrToneMath !== 'undefined',
    UNIFORM_FIELDS: typeof UNIFORM_FIELDS !== 'undefined',
    U: typeof U !== 'undefined',
    UNIFORM_BYTES: typeof UNIFORM_BYTES !== 'undefined',
    HDR_DISPLAY_AVAILABLE: typeof HDR_DISPLAY_AVAILABLE !== 'undefined',
    nijiSubscribers: typeof nijiSubscribers !== 'undefined',
    clampUnit: typeof clampUnit !== 'undefined',
    computeUniformData: typeof computeUniformData !== 'undefined',
    probeSource: typeof probeSource !== 'undefined',
    isDRMProtected: typeof isDRMProtected !== 'undefined',
    VideoRenderer: typeof VideoRenderer !== 'undefined',
    ImageRenderer: typeof ImageRenderer !== 'undefined',
    VideoManager: typeof VideoManager !== 'undefined',
    ImageManager: typeof ImageManager !== 'undefined',
    SharedVideoResources: typeof SharedVideoResources !== 'undefined',
    SharedImageResources: typeof SharedImageResources !== 'undefined',
    // P4-2：补齐首版遗漏的跨文件依赖。原表只覆盖 17/87，删掉 tone-lut.js
    // 时断言照样通过，直到 new SharedVideoResources() 才 ReferenceError，
    // 且被 _ensureManagers 的 catch 吞成泛化错误。这里覆盖所有被实际引用的符号。
    STATUS: typeof STATUS !== 'undefined',
    MESSAGE_TYPES: typeof MESSAGE_TYPES !== 'undefined',
    hdrDisplayQuery: typeof hdrDisplayQuery !== 'undefined',
    GPU_ERROR_LIMIT: typeof GPU_ERROR_LIMIT !== 'undefined',
    GPU_ERROR_WINDOW_MS: typeof GPU_ERROR_WINDOW_MS !== 'undefined',
    GPU_ERROR_RECOVERY_DELAY_MS: typeof GPU_ERROR_RECOVERY_DELAY_MS !== 'undefined',
    // 注意：这里**不能**放 ADAPTER_OPTIONS。它在 Windows 上合法地取值为
    // undefined（utils.js 用它抑制 powerPreference 告警），而 typeof 对
    // 「声明为 undefined」和「根本没有声明」返回同一个值，会把正常平台
    // 误报成依赖缺失。存在性探针只适用于「一定有值」的符号；utils.js 的
    // 覆盖由 isSameOriginUrl / probeSource / isDRMProtected 保证。
    isSameOriginUrl: typeof isSameOriginUrl !== 'undefined',
    UNIFORM_FLOATS: typeof UNIFORM_FLOATS !== 'undefined',
    LUT_SIZE: typeof LUT_SIZE !== 'undefined',
    ToneLutManager: typeof ToneLutManager !== 'undefined',
    videoShaderCode: typeof videoShaderCode !== 'undefined',
    videoShaderCodeCopy: typeof videoShaderCodeCopy !== 'undefined',
    imageShaderCode: typeof imageShaderCode !== 'undefined',
    reportShaderErrors: typeof reportShaderErrors !== 'undefined',
    createPipelineChecked: typeof createPipelineChecked !== 'undefined',
    createPipelineCheckedAsync: typeof createPipelineCheckedAsync !== 'undefined',
    invalidPipelines: typeof invalidPipelines !== 'undefined',
    pickTier: typeof pickTier !== 'undefined',
    countRenderersInTier: typeof countRenderersInTier !== 'undefined',
    debouncedScan: typeof debouncedScan !== 'undefined',
    startNijiPolling: typeof startNijiPolling !== 'undefined',
    stopNijiPolling: typeof stopNijiPolling !== 'undefined',
    VIDEO_CONCURRENCY_TIERS: typeof VIDEO_CONCURRENCY_TIERS !== 'undefined',
    IMAGE_CONCURRENCY_TIERS: typeof IMAGE_CONCURRENCY_TIERS !== 'undefined',
  };
  const missing = Object.keys(checks).filter((name) => !checks[name]);
  if (missing.length) {
    console.error('[HDR Vision] 内容脚本依赖缺失（检查 manifest 加载顺序）:', missing.join(', '));
  }
  return missing;
}

const CONTENT_DEPS_MISSING = assertContentDependencies();

if (CONTENT_DEPS_MISSING.length === 0) {
  // 只读快照：现有消费者仍用原全局，避免一次性改 10 个文件带来的回归风险。
  globalThis.HDRV = Object.freeze({
    HDRSettings,
    HdrToneMath,
    U,
    UNIFORM_FIELDS,
    UNIFORM_BYTES,
    clampUnit,
    computeUniformData,
    VideoRenderer,
    ImageRenderer,
    VideoManager,
    ImageManager,
  });
}

class HDRController {
  constructor() {
    this.device = null;
    this.videoManager = null;
    this.imageManager = null;
    this.settings = null;
    this.isInitialized = false;
    this.initPromise = null;
    this._settingsQueue = Promise.resolve();
    // P0-1：device lost 恢复状态，防止并发恢复与重复注册 lost 回调
    this._deviceLost = false;
    this._recovering = false;
    this._destroyed = false;
    // P0-2：保存在 _init() 中注册的监听/补丁引用，供 destroy() 精确还原
    this._cleanupFns = [];
    // bfcache 恢复监听：跨 destroy 存活，不放进 _cleanupFns
    this._onPageShow = null;
    // P1-6：异步 shader / pipeline 错误通过此字段上报到 popup
    this._pipelineError = null;
    // P2-7：device 级 GPU 错误预算与一次性自愈
    this._gpuErrorCount = 0;
    this._gpuErrorWindowStart = 0;
    this._gpuErrorRecoveryUsed = false;
    this._gpuErrorRecoveryTimer = null;
    pipelineErrorHandler = (label, text) => { this._pipelineError = text; };
    // P1-4：device 代际，防止过期 lost 回调替换新 device
    this._deviceGeneration = 0;
    // P2-7 / P1-3：URL 变化时的延时 kick  timers 集中管理
    this._kickTimers = [];
    // P4-2：页面出现媒体（video / 开启图片增强时的 img）后才启动 GPU
    this._gpuStarting = false;
    this._gpuStartPromise = null;
    this._videoWatch = null;
  }

  async init() {
    if (this.initPromise) return this.initPromise;
    // bfcache 恢复后重新 init：解除 destroy 标记，允许 lost 回调再次生效
    this._destroyed = false;
    // destroy() 会清空错误回调，bfcache 恢复后需要重新挂上
    pipelineErrorHandler = (label, text) => { this._pipelineError = text; };
    this.initPromise = this._init().catch((e) => {
      // P1-6：init 失败不能留下永久 rejected 的 promise，否则本页再也无法重试
      console.error('[HDR Vision] init failed:', e);
      this.initPromise = null;
      this.isInitialized = false;
      this._pipelineError = 'init：' + (e && e.message ? e.message : String(e));
    });
    return this.initPromise;
  }

  async _init() {
    if (!document.body || !document.documentElement) {
      console.log('[HDR Vision] Not an HTML document, skipping init');
      return;
    }
    if (document.contentType && document.contentType !== 'text/html') {
      console.log('[HDR Vision] Content type is not HTML:', document.contentType);
      return;
    }

    // P1-3：先注册消息与页面监听，再决定是否申请 GPU。
    // 即使扩展关闭 / 无 WebGPU，popup 也能拿到明确状态而不是 no_receiver。
    if (hdrDisplayQuery) {
      const onHdrDisplayChange = (e) => {
        HDR_DISPLAY_AVAILABLE = e.matches === true;
        console.log('[HDR Vision] HDR display changed:', HDR_DISPLAY_AVAILABLE);
        this._rebuildRenderers();
      };
      if (hdrDisplayQuery.addEventListener) {
        hdrDisplayQuery.addEventListener('change', onHdrDisplayChange);
        this._cleanupFns.push(() => hdrDisplayQuery.removeEventListener?.('change', onHdrDisplayChange));
      } else if (hdrDisplayQuery.addListener) {
        hdrDisplayQuery.addListener(onHdrDisplayChange);
        this._cleanupFns.push(() => hdrDisplayQuery.removeListener?.(onHdrDisplayChange));
      }
    }

    const onMessage = (message, sender, sendResponse) => {
      try {
        this.handleMessage(message, sender, sendResponse);
      } catch (e) {
        console.warn('[HDR Vision] message handler error:', e);
        sendResponse({ error: String(e) });
      }
      return true;
    };
    chrome.runtime.onMessage.addListener(onMessage);
    this._cleanupFns.push(() => chrome.runtime.onMessage.removeListener(onMessage));

    let lastUrl = window.location.href;
    const handleUrlChange = () => {
      const newUrl = window.location.href;
      if (newUrl === lastUrl) return;
      lastUrl = newUrl;
      if (!this.settings?.enabled) return;
      const kick = () => {
        if (!this.settings?.enabled) return;
        this.videoManager?.scheduleScan();
        this.imageManager?.scheduleScan();
      };
      kick();
      this._kickTimers.forEach(clearTimeout);
      this._kickTimers = [
        setTimeout(kick, 500),
        setTimeout(kick, 1500),
        setTimeout(kick, 3000),
      ];
    };
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      handleUrlChange();
    };
    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      handleUrlChange();
    };
    this._cleanupFns.push(() => {
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
      this._kickTimers.forEach(clearTimeout);
      this._kickTimers = [];
    });
    window.addEventListener('popstate', handleUrlChange);
    window.addEventListener('hashchange', handleUrlChange);
    this._cleanupFns.push(() => {
      window.removeEventListener('popstate', handleUrlChange);
      window.removeEventListener('hashchange', handleUrlChange);
    });
    const onScroll = () => {
      this.videoManager?.scheduleScan();
      this.imageManager?.scheduleScan();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    this._cleanupFns.push(() => window.removeEventListener('scroll', onScroll));

    const onPageHide = () => this.destroy();
    window.addEventListener('pagehide', onPageHide);
    this._cleanupFns.push(() => window.removeEventListener('pagehide', onPageHide));

    if (this._onPageShow) window.removeEventListener('pageshow', this._onPageShow);
    this._onPageShow = (e) => { if (e && e.persisted === true) this.init(); };
    window.addEventListener('pageshow', this._onPageShow);

    await this.loadSettings();
    this.isInitialized = true;

    // P1-3：扩展关闭时不申请 device，也不编译任何 shader / pipeline。
    if (!this.settings?.enabled) {
      console.log('[HDR Vision] 扩展处于关闭状态，跳过 GPU 初始化');
      return;
    }
    if (!navigator.gpu) {
      console.warn('[HDR Vision] WebGPU not available');
      return;
    }
    await this._startGpu();
  }

  // P4-2：页面上没有视频（也没开图片增强）时先不申请 device、不编译管线。
  // 大多数页面（首页 / 图文 / 列表）根本用不到，冷启动时这笔开销很明显。
  _pageNeedsGpu() {
    if (document.querySelector('video')) return true;
    return !!(this.settings?.enhanceImages && document.querySelector('img'));
  }

  _watchForMedia() {
    if (this._videoWatch || this._destroyed) return;
    const root = document.documentElement || document.body;
    if (!root) return;
    this._videoWatch = new MutationObserver(() => {
      if (!this._pageNeedsGpu()) return;
      this._videoWatch?.disconnect();
      this._videoWatch = null;
      this._startGpu();
    });
    this._videoWatch.observe(root, { childList: true, subtree: true });
    this._cleanupFns.push(() => {
      this._videoWatch?.disconnect();
      this._videoWatch = null;
    });
  }

  // P0-1：拆掉绑在当前 device 上的渲染器，不碰 device 本身。
  // manager.destroy() 会停掉观察器、渲染循环与 shared GPU 资源。
  _dropManagers() {
    if (this.videoManager) {
      try { this.videoManager.destroy(); } catch (e) {
        console.warn('[HDR Vision] videoManager destroy failed:', e);
      }
      this.videoManager = null;
    }
    if (this.imageManager) {
      try { this.imageManager.destroy(); } catch (e) {
        console.warn('[HDR Vision] imageManager destroy failed:', e);
      }
      this.imageManager = null;
    }
  }

  // P0-1：device 与其上的渲染器一起作废。
  // 主动 destroy 触发的 lost 回调 reason 为 'destroyed'，_watchDevice 会直接忽略，
  // 因此不会把「换 device」误判成「device 丢了」。
  _dropDevice() {
    this._dropManagers();
    const old = this.device;
    this.device = null;
    if (old) { try { old.destroy(); } catch {} }
  }

  // 幂等启动：设备 + manager + pipeline 编译都在这里，重复调用不会叠加。
  // P0-1：并发调用共享同一次启动（返回 _gpuStartPromise），避免两次 requestDevice
  // 相互覆盖 —— 后一次会把前一次刚拿到的 device destroy 掉。
  async _startGpu() {
    if (this._destroyed || this._recovering) return;
    if (this._gpuStarting) return this._gpuStartPromise;
    // destroy() → bfcache 重入 init() 时，上一轮启动可能还在 await requestDevice。
    // 等它收尾再开始，否则两次申请会互相覆盖（后一次 destroy 掉前一次的 device）。
    if (this._gpuStartPromise) {
      try { await this._gpuStartPromise; } catch {}
      if (this._destroyed) return;
    }
    if (!this.settings?.enabled || !navigator.gpu) return;
    if (!this._pageNeedsGpu()) {
      this._watchForMedia();
      return;
    }
    this._gpuStarting = true;
    this._gpuStartPromise = (async () => {
      try {
        if (!this.device || this._deviceLost) {
          // ★ P0-1 核心：旧 device 已失效，绑在它上面的 manager 必须一起拆掉。
          //   否则 _ensureManagers() 认为 manager「已存在」而跳过创建，
          //   新 device 申请成功、_deviceLost 复位，绘制却仍发往失效 device。
          this._dropDevice();
          if (!await this._requestDevice()) return;
          // await 期间可能 pagehide → destroy()：把刚拿到的 device 放掉，不要复活
          if (this._destroyed) { this._dropDevice(); return; }
        }
        if (!this._ensureManagers()) return;
        this.videoManager.setEnabled(true);
        if (this.settings.enhanceImages) this.imageManager?.setEnabled(true);
      } catch (e) {
        console.warn('[HDR Vision] GPU 初始化失败:', e);
      }
    })();
    try {
      await this._gpuStartPromise;
    } finally {
      this._gpuStarting = false;
      this._gpuStartPromise = null;
    }
  }

  // P1-3 / P2-2：只在确实需要增强时才申请 device，优先高性能适配器。
  // ADAPTER_OPTIONS 在 Windows 上是 undefined —— 该平台会忽略 powerPreference 并告警。
  async _requestDevice() {
    try {
      let adapter = await navigator.gpu.requestAdapter(ADAPTER_OPTIONS);
      // 指定高性能却拿不到适配器时，退回默认策略再试一次
      if (!adapter && ADAPTER_OPTIONS) adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        console.warn('[HDR Vision] No GPU adapter');
        this._deviceLost = true;
        return null;
      }
      const nextDevice = await adapter.requestDevice();
      // P0-1：替换引用前释放旧 device（lost 回调 reason='destroyed' 会被忽略）。
      // 放在 await 之后：申请失败时不会把还能用的旧 device 提前弄没。
      const previous = this.device;
      this.device = nextDevice;
      if (previous && previous !== nextDevice) { try { previous.destroy(); } catch {} }
      this._deviceGeneration++;
      this._watchDevice(this.device, this._deviceGeneration);
      this._deviceLost = false;
      return this.device;
    } catch (e) {
      console.error('[HDR Vision] Failed to init WebGPU:', e);
      this._deviceLost = true;
      return null;
    }
  }

  // P1-3：manager 懒创建 —— 图片增强关闭时完全不编译 image shader / pipeline。
  _ensureManagers() {
    if (!this.device || this._deviceLost) return false;
    try {
      // P0-1 兜底：manager 必须与当前 device 同代。任何调用路径漏了拆解时
      // 在这里重建，避免「新 device + 旧渲染器」这种只在真机上出现的组合。
      const stale = (this.videoManager && this.videoManager.device !== this.device)
        || (this.imageManager && this.imageManager.device !== this.device);
      if (stale) this._dropManagers();
      if (!this.videoManager) {
        this.videoManager = new VideoManager(this.device);
        this.videoManager.updateSettings(this.settings);
      }
      if (this.settings?.enhanceImages && !this.imageManager) {
        this.imageManager = new ImageManager(this.device);
        this.imageManager.updateSettings(this.settings);
      }
      return true;
    } catch (e) {
      this._pipelineError = 'resources：' + (e && e.message ? e.message : String(e));
      console.error('[HDR Vision] 渲染资源初始化失败:', e);
      return false;
    }
  }

  // P0-1：为一个 device 注册错误与 lost 监听。首次初始化与 lost 恢复共用，
  // 避免两处逻辑漂移；lost 回调不再只打日志，而是触发恢复流程。
  _watchDevice(device, generation) {
    // P1-8：device 级错误不再由每个 renderer 各自计数（那会让一个坏视频
    // 拖垮同页所有实例）；这里统一记录，超过预算才整体降级。
    // P2-7：计数按时间窗衰减 —— 偶发的驱动抖动不该累积成永久停用。
    const nowMs = () => (typeof performance !== 'undefined' && performance.now
      ? performance.now() : Date.now());
    this._gpuErrorCount = 0;
    this._gpuErrorWindowStart = nowMs();
    // P2-7：每个 device 代际允许一次「延迟重建」自愈
    this._gpuErrorRecoveryUsed = false;
    if (this._gpuErrorRecoveryTimer) {
      clearTimeout(this._gpuErrorRecoveryTimer);
      this._gpuErrorRecoveryTimer = null;
    }
    device.addEventListener?.('uncapturederror', (e) => {
      const msg = e.error?.message || String(e.error);
      console.warn('[HDR Vision] GPU uncaptured error:', msg);
      if (generation !== this._deviceGeneration || this._destroyed) return;
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (now - this._gpuErrorWindowStart > GPU_ERROR_WINDOW_MS) {
        this._gpuErrorWindowStart = now;
        this._gpuErrorCount = 0;
      }
      this._gpuErrorCount++;
      if (this._gpuErrorCount >= GPU_ERROR_LIMIT) {
        this._gpuErrorCount = 0;
        this._gpuErrorWindowStart = 0;
        this._onGpuErrorBudgetExceeded(generation);
      }
    });
    device.lost?.then((info) => {
      // 主动 destroy（页面卸载）不需要恢复
      if (info.reason === 'destroyed') return;
      // P1-4：旧 device 的迟到 lost 不能替换当前 device
      if (generation !== this._deviceGeneration || this._destroyed) return;
      this._handleDeviceLost(info);
    });
  }

  // P2-7：错误预算超限后的收敛点。先整体停用（不再向坏管线继续提交绘制），
  // 写 _pipelineError 让 popup 显示 shader_error，再延迟 2s 重建一次管线。
  // 同一 device 代际只自愈一次；再次超限才真正停用到刷新为止。
  _onGpuErrorBudgetExceeded(generation) {
    if (this._destroyed || generation !== this._deviceGeneration) return;
    this._pipelineError = 'runtime：GPU 校验错误过多';
    this.videoManager?.setEnabled(false);
    this.imageManager?.setEnabled(false);
    if (this._gpuErrorRecoveryUsed) {
      console.warn('[HDR Vision] GPU 校验错误再次超限，本次会话不再尝试恢复');
      return;
    }
    this._gpuErrorRecoveryUsed = true;
    console.warn(
      '[HDR Vision] GPU 校验错误超限，已停用增强，' +
      (GPU_ERROR_RECOVERY_DELAY_MS / 1000) + 's 后重建一次管线'
    );
    this._gpuErrorRecoveryTimer = setTimeout(() => {
      this._gpuErrorRecoveryTimer = null;
      // 期间若发生 device lost / 页面卸载，各自路径会接管，这里不再重复恢复
      if (this._destroyed || generation !== this._deviceGeneration || this._deviceLost) return;
      this._gpuErrorCount = 0;
      this._gpuErrorWindowStart = 0;
      this._rebuildRenderers();
    }, GPU_ERROR_RECOVERY_DELAY_MS);
  }

  // P0-1：device lost 后重新申请 device 并重建全部渲染器。
  // 用 _recovering 防止并发恢复；失败时保持 _deviceLost=true，状态上报不再谎报 ACTIVE。
  async _handleDeviceLost(info) {
    if (this._destroyed) return;
    if (this._recovering) {
      console.warn('[HDR Vision] GPU device lost again during recovery:', info.reason, info.message);
      return;
    }
    this._recovering = true;
    console.warn('[HDR Vision] GPU device lost:', info.reason, info.message, '- recovering');
    try {
      // P0-1：启动流程可能正在申请 device，先等它结束再判定 —— 否则两个
      // requestDevice 会相互覆盖，后一次把前一次刚拿到的 device destroy 掉。
      if (this._gpuStartPromise) {
        try { await this._gpuStartPromise; } catch {}
        if (this._destroyed) return;
        // 启动流程已经拿到可用 device 并建好 manager：这次 lost 属于旧 device，
        // 恢复已完成，不必再申请一次。
        if (this.device && !this._deviceLost && this.videoManager?.device === this.device) {
          console.info('[HDR Vision] GPU device already recovered by start path');
          return;
        }
      }
      // 到这里才是真正需要恢复：期间一律视为不可用，getStatus 不再谎报 ACTIVE
      this._deviceLost = true;
      // P0-1：先停掉旧渲染器，避免恢复期间它们继续向失效 device 提交绘制
      this._dropManagers();
      // P1-4 / P2-2：恢复也走统一入口（高性能优先 + 代际标记）
      const newDevice = await this._requestDevice();
      // 阶段一#2：await 期间可能发生 pagehide → destroy()，恢复线程醒来后
      // 必须重新确认状态，否则会复活已销毁的 controller（新建 canvas + GPU 资源泄漏）
      if (this._destroyed) {
        if (newDevice) { try { newDevice.destroy(); } catch {} }
        return;
      }
      if (!newDevice) throw new Error('No GPU device during recovery');
      // 用新 device 重建渲染器（video + image 的 shared 资源与 pipeline 全部重建）
      this._rebuildRenderers();
      console.info('[HDR Vision] GPU device recovered');
    } catch (e) {
      console.error('[HDR Vision] GPU device recovery failed:', e);
      // _deviceLost 保持 true：getStatus 会返回 NO_WEBGPU，不再谎报 ACTIVE
    } finally {
      this._recovering = false;
    }
  }

  // ★ 重建渲染器（HDR 显示状态变化 / 需要重建 pipeline 时）
  _rebuildRenderers() {
    // 第三轮#1：device 处于 lost 态时 device 引用仍非空，但已失效；
    // 此时重建只会产生注定失败的新渲染器与误导日志。P0-1 恢复路径会先把
    // _deviceLost 置 false 再调用本函数，因此不会被此守卫误伤。
    if (!this.device || this._deviceLost) return;
    // P1-3：旧实现只把 destroy 包在 try 里，new/setEnabled 抛错会冒泡但留下半初始化状态。
    // 统一保护：失败时标记 _deviceLost，让 getStatus 不再谎报 ACTIVE，并保留可诊断日志。
    try {
      // P1-6：重建时清空上一轮错误；若新 shader/pipeline 仍失败，异步回调会再次写回。
      this._pipelineError = null;
      // P0-1：统一走 _dropManagers()，避免两处重复的 destroy + 置空逻辑漂移
      this._dropManagers();
      this.videoManager = new VideoManager(this.device);
      // P1-3：图片增强关闭时连 ImageManager 都不建，避免白编译图片管线
      this.imageManager = this.settings?.enhanceImages ? new ImageManager(this.device) : null;
      this.videoManager.updateSettings(this.settings);
      this.imageManager?.updateSettings(this.settings);
      if (this.settings?.enabled) {
        this.videoManager.setEnabled(true);
        if (this.settings.enhanceImages) this.imageManager.setEnabled(true);
      }
    } catch (e) {
      console.warn('[HDR Vision] Renderer rebuild failed:', e);
      this._deviceLost = true;
    }
  }

  async loadSettings() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.GET_SETTINGS,
      });
      if (response?.settings) {
        this.settings = response.settings;
        this.videoManager?.updateSettings(this.settings);
        this.imageManager?.updateSettings(this.settings);
      }
    } catch (e) {
      console.error('[HDR Vision] Failed to load settings:', e);
    }
  }

  handleMessage(message, sender, sendResponse) {
    const { type, data } = message;
    switch (type) {
      case MESSAGE_TYPES.SETTINGS_UPDATED:
        this.onSettingsUpdated(data.settings);
        sendResponse({ success: true });
        break;
      case MESSAGE_TYPES.GET_STATUS:
        // 1.2.39：v 是内容脚本自己所属的扩展版本。扩展重载后页面里的脚本会变成
        //   孤儿，此时 v 与 popup 读到的版本不一致——诊断块靠它区分「脚本旧版」
        //   与「页面真没视频」。
        sendResponse({ status: this.getStatus(), diag: this.getDiagnostics(), v: this.getScriptVersion() });
        break;
      default:
        sendResponse({ error: 'Unknown message type' });
    }
  }

  onSettingsUpdated(settings) {
    // ★ 串行化处理，避免快速连续 toggle 导致并发调用 setEnabled
    this._settingsQueue = this._settingsQueue.then(() => {
      try {
        this._doUpdateSettings(settings);
      } catch (e) {
        console.warn('[HDR Vision] Settings update error:', e);
      }
    });
  }

  _doUpdateSettings(settings) {
    const wasEnabled = this.settings?.enabled;
    const wasEnhanceImages = this.settings?.enhanceImages;
    this.settings = settings;

    // P1-3：从关闭切到开启时可能还没有 device（初始化阶段刻意不建）。
    if (settings.enabled && (!this.device || this._deviceLost)) {
      if (!navigator.gpu) return;
      this._pipelineError = null;
      // P0-1：_startGpu() 是异步的（申请 device + 异步编译管线）。这里不能只发不等：
      // 恢复完成后必须把当前设置补应用一遍，否则「改设置触发的恢复」会停在
      // _ensureManagers 创建时的那一次 updateSettings 上（并发启动时甚至完全没有）。
      this._startGpu().then(() => this._applySettings()).catch(() => {});
      return;
    }
    if (settings.enabled && !this.videoManager) {
      if (!this._ensureManagers()) return;
    }
    if (settings.enhanceImages && !this.imageManager) this._ensureManagers();

    this.videoManager?.updateSettings(settings);
    this.imageManager?.updateSettings(settings);

    if (settings.enabled && !wasEnabled) {
      this.videoManager?.setEnabled(true);
      if (settings.enhanceImages) this.imageManager?.setEnabled(true);
    } else if (!settings.enabled && wasEnabled) {
      this.videoManager?.setEnabled(false);
      this.imageManager?.setEnabled(false);
    }

    if (settings.enhanceImages && !wasEnhanceImages) {
      this.imageManager?.setEnabled(true);
    } else if (!settings.enhanceImages && wasEnhanceImages) {
      this.imageManager?.setEnabled(false);
    }
  }

  // P0-1：把当前设置补应用到现有 manager（恢复/启动完成后的收敛点）。
  // 幂等：manager 不存在或已销毁时都是空操作。
  _applySettings() {
    if (this._destroyed || !this.settings) return;
    this.videoManager?.updateSettings(this.settings);
    this.imageManager?.updateSettings(this.settings);
    if (!this.settings.enabled) return;
    this.videoManager?.setEnabled(true);
    if (this.settings.enhanceImages) this.imageManager?.setEnabled(true);
  }

  // ★ 1.2.38：GET_STATUS 的只读诊断明细。只汇总已有字段，不触发任何状态变更。
  //   与 getStatus() 分开：前者给「为什么是这个状态」，后者只给状态枚举。
  getScriptVersion() {
    try {
      return chrome?.runtime?.getManifest?.()?.version || '';
    } catch {
      return '';
    }
  }

  getDiagnostics() {
    const vm = this.videoManager;
    const im = this.imageManager;
    const videos = vm && typeof vm.renderers?.values === 'function'
      ? [...vm.renderers.values()] : [];
    const active = videos.find((r) => r && !r.destroyed && !r.failed) || videos[0] || null;
    return {
      // 1.2.39：多视频页面（首页推荐、带预览的播放页）里必须标明这条诊断属于哪个
      //   视频，否则截图回来可能指向另一个渲染器。
      videoIndex: active ? videos.indexOf(active) + 1 : 0,
      videoTotal: videos.length,
      status: this.getStatus(),
      pipelineError: this._pipelineError || '',
      counts: {
        videos: vm?.detectedVideoCount || 0,
        hdr: vm?.detectedHDRCount || 0,
        crossOrigin: vm?.crossOriginCount || 0,
        drm: vm?.drmProtectedCount || 0,
        codecFailed: vm?.failedCodecCount || 0,
      },
      video: active && typeof active.readDiagnostics === 'function'
        ? active.readDiagnostics()
        : null,
      images: im?.isEnabled ? (im.renderers?.size || 0) : 0,
      // P4-2：依赖断言结果进入诊断，缺文件/改顺序时 popup 能直接看到名字，
      // 不必去翻控制台。正常时为 null，不改变既有消费方行为。
      depsMissing: CONTENT_DEPS_MISSING.length ? CONTENT_DEPS_MISSING.slice() : null,
    };
  }

  getStatus() {
    // HDR 总开关关闭时优先返回 INACTIVE（P1-3 后关闭状态根本没有 device）
    if (this.settings && this.settings.enabled === false) return STATUS.INACTIVE;
    // P0-1：device 已丢失且未恢复成功时，不再谎报 ACTIVE
    if (this._deviceLost || !navigator.gpu || !this.device) return STATUS.NO_WEBGPU;
    // P1-6：shader / pipeline 失败优先于「未激活」，让用户看到真实原因
    if (this._pipelineError) return STATUS.SHADER_ERROR;

    const vm = this.videoManager;
    const im = this.imageManager;

    // P1-5：按「有效」渲染器计数，自毁/失败的条目不再谎报 ACTIVE
    const hasVideo = vm && [...vm.renderers.values()]
      .some((r) => r && !r.destroyed && !r.failed && r.isRendering);
    const hasImage = im?.isEnabled && [...im.renderers.values()]
      .some((r) => r && !r.destroyed && !r.failed);
    if (hasVideo || hasImage) return STATUS.ACTIVE;
    if (vm && vm.detectedHDRCount > 0 && vm.detectedVideoCount > 0) return STATUS.SOURCE_HDR;
    // P1-5：DRM 受保护内容优先于「跨域」，给用户一个准确的原因
    if (vm && (vm.drmProtectedCount || 0) > 0) return STATUS.DRM_PROTECTED;
    if (vm && (vm.crossOriginCount || 0) > 0) return STATUS.CROSS_ORIGIN;
    if (vm && (vm.failedCodecCount || 0) > 0) return STATUS.CODEC_FAILED;
    if (vm && vm.detectedVideoCount > 0) return STATUS.INACTIVE;
    return STATUS.NO_VIDEO;
  }

  destroy() {
    // P0-1：标记已销毁，lost 回调不再触发恢复
    this._destroyed = true;
    this._gpuStarting = false;
    this._videoWatch = null;
    // P0-2：逐一移除 _init() 注册的监听并还原 history 补丁
    for (const fn of this._cleanupFns) {
      try { fn(); } catch (e) { console.warn('[HDR Vision] cleanup error:', e); }
    }
    this._cleanupFns = [];
    this._dropManagers();
    // P1-4：释放 device 本身（lost 回调收到 reason='destroyed' 会被忽略）
    try { this.device?.destroy(); } catch {}
    this.device = null;
    // 注意：不清 _gpuStartPromise —— 若启动流程仍在 await，下一轮 _startGpu
    // 会先等它收尾，避免两次 requestDevice 互相覆盖。它自己的 finally 会清空。
    this._kickTimers.forEach(clearTimeout);
    this._kickTimers = [];
    // P2-7：撤销待触发的 GPU 错误自愈，避免销毁后重建渲染器
    if (this._gpuErrorRecoveryTimer) {
      clearTimeout(this._gpuErrorRecoveryTimer);
      this._gpuErrorRecoveryTimer = null;
    }
    pipelineErrorHandler = null;
    // bfcache 恢复时允许重新 init；_destroyed 保持 true 直到 init() 被调用，
    // 确保 destroy 后异步到达的 lost 回调不会误触发恢复
    this.initPromise = null;
    this.isInitialized = false;
  }
}

const controller = new HDRController();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => controller.init());
} else {
  controller.init();
}

// pagehide 监听已在 controller._init() 内注册并纳入 _cleanupFns，此处不再重复注册
