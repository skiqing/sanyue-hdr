'use strict';
// HDR Vision — renderers.js（从 content-script.js 拆出，Phase 3 / P3-4）

// P3-2：视频 / 图片共用的尺寸缩放。renderScale 走 RANGES，7680 是单边硬上限。
function scaleForSize(settings, w, h) {
  const userScale = clampUnit('renderScale', settings?.renderScale ?? 1.0, 1.0);
  const maxSide = Math.max(w, h);
  const globalCap = maxSide > 7680 ? 7680 / maxSide : 1.0;
  return userScale * globalCap;
}

class VideoRenderer {
  constructor(shared, video, settings) {
    this.shared = shared;
    this.device = shared.device;
    this.video = video;
    this.settings = settings;
    this.canvas = null;
    this.context = null;
    this.uniformBuffer = null;
    this.canvasFormat = null;
    this.pipeline = null;
    this.container = null;
    this.resizeObserver = null;
    this.isRendering = false;
    this.videoFrameCallbackId = null;
    this.animationFrameId = null;
    this.lastUniformDataArray = new Float32Array(UNIFORM_FLOATS);
    this.lastUniformData = null;
    this.sourceIsHDR = false;
    this.probe = null;
    this.hdrMode = 0;
    this.failed = false;
    this.destroyed = false;
    this.tier = null;
    this._isFramePending = false;
    this._frameSeed = 0;
    this._hasRenderedOnce = false;
    // P2-6：失败时间窗与首帧退避状态（见 _noteRenderFailure）
    this._failureSince = 0;
    this._backoffUntil = 0;
    this._backoffCount = 0;
    // P2-12：隐藏原视频前记下站点自己的 opacity，恢复时写回原值。
    // 站点的「懒加载占位 / 淡入动画」可能会设 opacity:0，旧实现关扩展时
    // 一律写 '1'，会把本应隐藏的画面露出来。
    this._originalOpacity = null;
    this._opacitySaved = false;
    this._consecutiveFailures = 0;
    this._calibrated = false;
    this._calibrationFallback = false;
    // P1-3：探测被别的视频占用时不是「结论」，需要可退避重试；旧实现直接把
    // _calibrated 置死，导致页面里只有第一个视频能完成 HDR 标记校准。
    this._calibrationAttempts = 0;
    this._calibrationTimer = null;
    this._calibrationRetryMs = 400;
    this._probeUniform = null;
    this._loggedOnce = false;
    // P1-7：站点重建播放器 DOM 时会删掉扩展插入的 canvas，
    // 若不检查，原视频会一直保持 opacity:0，表现为整块黑屏。
    this._canvasWatchTimer = null;
    this._canvasMissingCount = 0;
    this._canvasWasMissing = false;
    this._positionAcquired = false;
    // P2-8：订阅全局 overlay 检测，不再每个 renderer 各自查 DOM
    this._onNiji = (found) => {
      if (this.destroyed || this.failed) return;
      this.nijiLucidCanvas = found;
      if (found && this.useExternalTexture) {
        this.useExternalTexture = false;
        this.bindGroupLayout = this.shared.getCopyLayout();
        this._configureCanvas();
        this._updateUniformBuffer(true);
        this._updateCanvasSize();
      }
    };
    nijiSubscribers.add(this._onNiji);

    this.videoTexture = null;
    this._videoTextureW = 0;
    this._videoTextureH = 0;
    this._videoTextureFormat = null;
    this._copyBindGroup = null;
    this._copyBindGroupTexture = null;
    this._copyFormatLocked = null;
    this._snapshotCanvas = null;
    this._snapshotCtx = null;
    this._loggedCanvasFallback = false;
    this._autoSnapshot = false;
    this._cropTopPx = 0;
    this._cropDetected = false;
    this._cropSrcKey = null;
    this._manualCrop = 0;
    this._detectCanvas = null;
    this._detectCtx = null;
    this._uvParams = null;
    this.nijiLucidCanvas = null;
    // ★ 默认走 import（Intel/NVIDIA 真零拷贝，AMD 无额外成本）
    this.useExternalTexture = true;
    this.bindGroupLayout = shared.getExternalLayout();

    this._onPlay = () => this._renderFrame();
    this._onPause = () => this._renderFrame();
    this._onSeeked = () => this._renderFrame();
    this._onLoadedData = () => this._renderFrame();

    this._setup();
  }

  _setup() {
    const video = this.video;
    // P1-5：EME 受保护媒体（Widevine / PlayReady）drawImage 通常不抛 SecurityError，
    // 而是画成黑帧 —— 若照常接管，黑帧会盖在原视频上，用户看到整块黑屏。
    // 判定优先于 isVideoPixelReadable（后者对 DRM 会误判为可读）。
    if (isDRMProtected(video)) {
      this.drmProtected = true;
      this.sourceIsHDR = false;
      this.failed = true;
      return;
    }
    if (!isVideoPixelReadable(video)) {
      this.sourceIsHDR = false;
      this.tainted = true;
      this.failed = true;
      return;
    }
    // P1-5：有的播放器先播放、后建 MediaKeys，_setup 时 mediaKeys 还是 null。
    // encrypted 事件是「这段内容走 EME」的可靠信号，收到就交回原视频。
    this._onEncrypted = () => this._abortForDRM('encrypted 事件');
    try { video.addEventListener('encrypted', this._onEncrypted); } catch {}
    this.probe = probeSource(video);
    this.sourceIsHDR = this.probe.isHDR;
    // ★ HDR 源不再一律跳过：auto 模式按探测到的传输函数走 PQ/HLG 解码专线
    this.hdrMode = resolveHDRMode(this.settings, this.probe);
    if (this.sourceIsHDR && this.hdrMode === 0 && shouldSkipHDRSource(this.settings)) {
      this.failed = true;
      return;
    }

    // ★ 取帧方式 + 手动裁切：单点求解（_setup / updateSettings / 换源重检共用）
    const capture = this._resolveCaptureMode();
    this._cropTopPx = capture.cropTopPx;
    this._autoSnapshot = capture.autoSnapshot;
    this.useExternalTexture = capture.useExternal;
    this.bindGroupLayout = capture.useExternal
      ? this.shared.getExternalLayout()
      : this.shared.getCopyLayout();

    const container = video.parentElement || document.body;
    this.container = container;

    this.canvas = document.createElement('canvas');
    this.canvas.className = '__extension_hdrvideocanvas';
    Object.assign(this.canvas.style, {
      position: 'absolute',
      pointerEvents: 'none',
      // ★ 必须与同级弹幕/字幕层处于同一层级（0），靠 DOM 顺序压在原视频之上；
      //   若设成 1 会盖住播放器后插入的弹幕层（斗鱼/B站都会中招）
      zIndex: '0',
    });

    this._positionAcquired = acquireRelativeContainer(container);

    video.insertAdjacentElement('afterend', this.canvas);
    this.context = this.canvas.getContext('webgpu');
    if (!this.context) {
      this.failed = true;
      this._cleanupCanvas();
      return;
    }

    this._configureCanvas();
    if (!this.pipeline) {
      this.failed = true;
      this._cleanupCanvas();
      return;
    }

    this._createUniformBuffer();
    this._updateCanvasSize();

    this.resizeObserver = new ResizeObserver(() => this._updateCanvasSize());
    this.resizeObserver.observe(video);

    this._videoResizeHandler = () => this._updateCanvasSize();
    video.addEventListener('loadedmetadata', this._videoResizeHandler);
    video.addEventListener('resize', this._videoResizeHandler);
  }

  _cleanupCanvas() {
    if (this.canvas && this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.canvas = null;
    if (this._positionAcquired) {
      releaseRelativeContainer(this.container);
      this._positionAcquired = false;
    }
  }

  _configureCanvas() {
    const wantHDR = HDR_DISPLAY_AVAILABLE && this.settings?.canvasMode !== 'sdr';
    if (wantHDR) {
      try {
        this.context.configure({
          device: this.device,
          format: 'rgba16float',
          toneMapping: { mode: 'extended' },
          alphaMode: 'premultiplied',
        });
        this.canvasFormat = 'rgba16float';
        this.pipeline = this.useExternalTexture
          ? this.shared.getExternalPipeline(this.canvasFormat)
          : this.shared.getCopyPipeline(this.canvasFormat);
        if (this.pipeline) {
          console.log('[HDR Vision] Video canvas configured as HDR (rgba16float + extended), path:', this.useExternalTexture ? 'external' : 'copy');
          return;
        }
      } catch (e) {
        console.warn('[HDR Vision] HDR configure failed, falling back to SDR:', e);
      }
    }

    try {
      const format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: format,
        alphaMode: 'premultiplied',
      });
      this.canvasFormat = format;
      this.pipeline = this.useExternalTexture
        ? this.shared.getExternalPipeline(this.canvasFormat)
        : this.shared.getCopyPipeline(this.canvasFormat);
      console.log('[HDR Vision] Video canvas configured as SDR:', format, 'path:', this.useExternalTexture ? 'external' : 'copy');
    } catch (e) {
      console.error('[HDR Vision] Failed to configure canvas:', e);
      this.canvasFormat = null;
      this.pipeline = null;
    }
  }

  _createUniformBuffer() {
    // ★ 缓冲长度来自 UNIFORM_FIELDS 推导的 UNIFORM_BYTES，不写死字节数
    this.uniformBuffer = this.device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  _getTargetSize() {
    const video = this.video;
    const srcW = this.nijiLucidCanvas ? this.nijiLucidCanvas.width : video.videoWidth;
    const srcH = this.nijiLucidCanvas ? this.nijiLucidCanvas.height : video.videoHeight;
    if (!srcW || !srcH) return { width: 0, height: 0 };

    const scale = scaleForSize(this.settings, srcW, srcH);

    if (scale >= 1.0) {
      return { width: srcW, height: srcH };
    }

    return {
      width: Math.max(1, Math.round(srcW * scale)),
      height: Math.max(1, Math.round(srcH * scale)),
    };
  }

  _updateCanvasSize() {
    const video = this.video;
    if (!this.canvas || !this.container) return;

    // P2-8：共享轮询结果，缺少 resize 时也能发现 overlay canvas
    this.nijiLucidCanvas = pollNijiLucid();

    const srcW = this.nijiLucidCanvas ? this.nijiLucidCanvas.width : video.videoWidth;
    const srcH = this.nijiLucidCanvas ? this.nijiLucidCanvas.height : video.videoHeight;
    if (!srcW || !srcH) return;

    const videoRect = video.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();

    // ★ 边框会把内容盒往里推：直接用 rect 会整体偏移，表现为顶部/边缘露出一条原视频
    const borderX = video.clientLeft || 0;
    const borderY = video.clientTop || 0;
    const elemWidth = video.clientWidth || videoRect.width;
    const elemHeight = video.clientHeight || videoRect.height;

    let objectFit = 'contain';
    try { objectFit = getComputedStyle(video).objectFit || 'contain'; } catch {}

    const videoAspect = srcW / srcH;
    const elemAspect = elemWidth / elemHeight;

    let displayWidth = elemWidth;
    let displayHeight = elemHeight;
    let uvScaleX = 1;
    let uvScaleY = 1;
    let uvOffsetX = 0;
    let uvOffsetY = 0;

    if (videoAspect && isFinite(videoAspect)) {
      if (objectFit === 'cover') {
        // 画面被裁切填满元素：画布铺满，靠 UV 裁掉超出部分
        if (elemAspect > videoAspect) {
          uvScaleX = videoAspect / elemAspect;      // 左右被裁
          uvOffsetX = (1 - uvScaleX) / 2;
        } else {
          uvScaleY = elemAspect / videoAspect;      // 上下被裁
          uvOffsetY = (1 - uvScaleY) / 2;
        }
      } else if (objectFit === 'none') {
        displayWidth = srcW;
        displayHeight = srcH;
      } else if (objectFit === 'fill') {
        displayWidth = elemWidth;
        displayHeight = elemHeight;
      } else {
        // contain（默认）：等比缩放并居中
        if (elemAspect > videoAspect) {
          displayHeight = elemHeight;
          displayWidth = displayHeight * videoAspect;
        } else {
          displayWidth = elemWidth;
          displayHeight = displayWidth / videoAspect;
        }
      }
    }

    const offsetX = (elemWidth - displayWidth) / 2;
    const offsetY = (elemHeight - displayHeight) / 2;
    // 不取整：取整会在边缘和 fractional 布局之间留下 1px 缝隙（顶部瑕疵的常见来源）
    const left = videoRect.left + borderX - containerRect.left + offsetX;
    const top = videoRect.top + borderY - containerRect.top + offsetY;

    this._uvParams = { scaleX: uvScaleX, scaleY: uvScaleY, offsetX: uvOffsetX, offsetY: uvOffsetY };

    this.canvas.style.left = `${left.toFixed(2)}px`;
    this.canvas.style.top = `${top.toFixed(2)}px`;
    this.canvas.style.width = `${displayWidth.toFixed(2)}px`;
    this.canvas.style.height = `${displayHeight.toFixed(2)}px`;

    const { width, height } = this._getTargetSize();
    if (width > 0 && height > 0 &&
        (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
      this._configureCanvas();
      if (!this.pipeline) return;
      this._updateUniformBuffer(true);
    }
  }

  updateSettings(settings) {
    // P0-3：取帧路径、手动裁切、渲染缩放、画布模式原本只在 _setup() 里读取，
    // 改动后必须重新应用，否则控件「能调但没反应」，要刷新页面才生效。
    const prev = this.settings || {};
    const canvasChanged = prev.canvasMode !== settings.canvasMode;
    const captureChanged =
      (prev.capturePath || 'auto') !== (settings.capturePath || 'auto');
    const cropChanged = Math.round(prev.cropTopPx || 0) !== Math.round(settings.cropTopPx || 0);
    const scaleChanged = prev.renderScale !== settings.renderScale;

    this.settings = settings;
    this.probe = probeSource(this.video);
    this.sourceIsHDR = this.probe.isHDR;
    const mode = settings.hdrSourceMode || 'auto';
    if (mode !== 'auto') this._calibrationFallback = false;
    const prevHdrMode = this.hdrMode;
    this.hdrMode = (mode === 'auto' && this._calibrationFallback)
      ? 0
      : resolveHDRMode(settings, this.probe);

    // P2-1：hdrMode 决定 copy 路径用 rgba16float 还是 rgba8unorm 承接。
    // 从「跳过」切到「接管 PQ」时若不解除格式锁，10bit 信号会被继续塞进
    // rgba8unorm → PQ 量化成 8bit，暗部出现明显色带。纹理本身会按新格式
    // 重建（_ensureVideoTexture 比对 _videoTextureFormat），这里只需解锁。
    if (prevHdrMode !== this.hdrMode) this._resetCopyTarget();

    if (captureChanged || cropChanged) {
      const capture = this._resolveCaptureMode();
      this._cropTopPx = capture.cropTopPx;
      this._autoSnapshot = capture.autoSnapshot;
      this._cropDetected = false;       // 让顶部绿条自动检测重新跑一遍
      this._cropSrcKey = null;
      this.useExternalTexture = capture.useExternal;
      this.bindGroupLayout = capture.useExternal
        ? this.shared.getExternalLayout()
        : this.shared.getCopyLayout();
      this._resetCopyTarget();
    }

    // 画布模式变化需要重新 configure（8bit ↔ 16float 是两种 swapchain）
    if (canvasChanged || captureChanged || cropChanged) {
      this._configureCanvas();
    }
    // 缩放 / 画布 / 取帧路径变化都要按新的目标尺寸重排 canvas
    if (scaleChanged || canvasChanged || captureChanged || cropChanged) {
      this._updateCanvasSize();
    }
    this._updateUniformBuffer(true);
  }

  _uniformExtra() {
    return {
      outputIsHDR: this.canvasFormat === 'rgba16float',
      outputLinear: this.canvasFormat === 'rgba16float' &&
        this.settings?.canvasEncoding === 'linear',
      hdrMode: this.hdrMode,
      inputBT2020: this.probe?.bt2020 === true,
      // 指纹不变时 update 是空操作；上传失败时自动退回 legacy 曲线
      lutReady: this.shared?.toneLut
        ? this.shared.toneLut.update(this.settings.bt2446a) : false,
    };
  }

  _updateUniformBuffer(force = false) {
    if (!this.device || !this.uniformBuffer || !this.canvas) return;
    if (!this.canvas.width || !this.canvas.height) return;
    const texelW = 1.0 / this.canvas.width;
    const texelH = 1.0 / this.canvas.height;
    const data = this.lastUniformDataArray;
    computeUniformData(
      this.settings,
      this.canvas.width,
      this.canvas.height,
      texelW,
      texelH,
      this._frameSeed,
      this._uvParams || null,
      data,
      this._uniformExtra()
    );
    if (!force && this.lastUniformData && this._uniformDataEquals(this.lastUniformData, data)) {
      return;
    }
    if (!this.lastUniformData) this.lastUniformData = new Float32Array(UNIFORM_FLOATS);
    this.lastUniformData.set(data);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  _uniformDataEquals(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // ★ 一次性校准：auto 模式下，如果「PQ/HLG 标记」与实际像素不符
  //   （解码后大面积超出 SDR 白点），自动回退到 SDR 处理，避免整屏发白/霓虹高光。
  //   P1-3：只有拿到结论才置 _calibrated；探测被占用（排队后仍取不到）时退避重试。
  async _calibrateHDRSource() {
    if (this._calibrated || this.destroyed) return;
    // 本来就不是 HDR / 用户显式指定了模式：无需探测，直接收敛
    if (this.hdrMode === 0 || (this.settings?.hdrSourceMode || 'auto') !== 'auto') {
      this._calibrated = true;
      return;
    }
    try {
      const stat = await this._probeFrameStats();
      if (this.destroyed || this.failed) return;
      if (!stat) {
        this._retryCalibration();
        return;
      }
      this._calibrated = true;
      if (stat.above > 0.20) {
        const pct = Math.round(stat.above * 100);
        this.hdrMode = 0;
        this._calibrationFallback = true;
        // P2-1：降级到 SDR 后 copy 纹理没必要继续占 16float（8bit 只需要一半显存），
        // 解锁让下一次取帧按 rgba8unorm 重建。
        this._resetCopyTarget();
        console.warn(
          '[HDR Vision] HDR 标记与像素不符：' + pct +
          '% 像素超出 SDR 白点 1.6 倍，已自动按 SDR 处理'
        );
        this._updateUniformBuffer(true);
        this._renderFrame();
      }
    } catch (e) {
      this._calibrated = true;
      console.warn('[HDR Vision] 校准探测失败:', e);
    }
  }

  // 探测没拿到结论（共享探测被占用 / 纹理未就绪 / 管线未编好）→ 退避重试。
  // 旧实现直接 return 且 _calibrated 已置死，页面里只有第一个视频能被校准。
  _retryCalibration() {
    if (this.destroyed || this._calibrated || this._calibrationTimer) return;
    this._calibrationAttempts++;
    if (this._calibrationAttempts > CALIBRATION_MAX_RETRIES) {
      this._calibrated = true;   // 放弃，避免留下无限定时器
      return;
    }
    const delay = this._calibrationRetryMs * this._calibrationAttempts;
    this._calibrationTimer = setTimeout(() => {
      this._calibrationTimer = null;
      this._calibrateHDRSource();
    }, delay);
  }

  // ★ P1-3：探测必须排队。_probeTexture / _probeReadback 是 shared 级单例，
  //   同时跑会互相覆盖；旧实现用 _probeBusy 直接丢弃后来者，等于放弃了其余视频的校准。
  _probeFrameStats() {
    if (!this.shared || typeof this.shared.withProbeLock !== 'function') return Promise.resolve(null);
    return this.shared.withProbeLock(() => this._probeFrameStatsLocked());
  }

  async _probeFrameStatsLocked() {
    if (this.destroyed || this.failed) return null;
    const shared = this.shared;
    if (!shared || shared._disposed) return null;
    const pipeline = shared.getProbePipeline(this.useExternalTexture);
    if (!pipeline) return null;

    const W = 32;
    const H = 32;
    const { texture, buffer } = shared.getProbeTargets();
    try {
      if (!this._probeUniform) {
        this._probeUniform = this.device.createBuffer({
          size: UNIFORM_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      }
      const data = new Float32Array(UNIFORM_FLOATS);
      const lutReady = this.shared.toneLut.update(this.settings.bt2446a);
      computeUniformData(this.settings, W, H, 1 / W, 1 / H, 0, null, data, {
        outputIsHDR: true,
        hdrMode: this.hdrMode,
        inputBT2020: this.probe?.bt2020 === true,
        lutReady,
      });
      // 纯测量：去掉曝光 / 饱和度 / 整体增益，只看解码结果
      data[0] = 1.0;
      data[1] = 1.0;
      data[3] = 1.0;
      data[36] = 1.0;
      this.device.queue.writeBuffer(this._probeUniform, 0, data);

      let bindGroup;
      if (this.useExternalTexture) {
        const ext = this.device.importExternalTexture({ source: this.video });
        bindGroup = this.device.createBindGroup({
          layout: shared.getExternalLayout(),
          entries: [
            { binding: 0, resource: ext },
            { binding: 1, resource: shared.sampler },
            { binding: 2, resource: { buffer: this._probeUniform } },
            { binding: 3, resource: shared.toneLut.view },
            { binding: 4, resource: shared.toneLut.sampler },
          ],
        });
      } else {
        if (!this.videoTexture) return null;
        bindGroup = this.device.createBindGroup({
          layout: shared.getCopyLayout(),
          entries: [
            { binding: 0, resource: this.videoTexture.createView() },
            { binding: 1, resource: shared.sampler },
            { binding: 2, resource: { buffer: this._probeUniform } },
            { binding: 3, resource: shared.toneLut.view },
            { binding: 4, resource: shared.toneLut.sampler },
          ],
        });
      }

      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture },
        { buffer, bytesPerRow: W * 8, rowsPerImage: H },
        { width: W, height: H, depthOrArrayLayers: 1 }
      );
      this.device.queue.submit([encoder.finish()]);

      await buffer.mapAsync(GPUMapMode.READ);
      const u16 = new Uint16Array(buffer.getMappedRange().slice(0));
      buffer.unmap();

      let above = 0;
      let n = 0;
      for (let i = 0; i + 3 < u16.length; i += 4) {
        const l = 0.2126 * halfToFloat(u16[i]) +
                  0.7152 * halfToFloat(u16[i + 1]) +
                  0.0722 * halfToFloat(u16[i + 2]);
        if (l > 1.6) above++;
        n++;
      }
      return n ? { above: above / n } : null;
    } catch (e) {
      return null;   // 单次探测失败不致命，交给 _retryCalibration 决定是否重试
    }
  }

  // ★ P1-7 + 1.2.26：站点重建播放器 DOM 时可能删掉扩展插入的 canvas，
  //   也可能连 <video> 一起换掉（B 站换集/切 P 就是后者）。两种情况必须分开：
  //   - video 脱离文档 → 站点已弃用这个元素。直接 destroy 让 manager 清条目、
  //     重新扫描新 video；不再误报「画布被反复移除」。
  //   - video 还在、canvas 被删 → 先恢复原视频可见（否则 opacity:0 直接黑屏），
  //     再尝试插回；插回成功后重新隐藏。连续 3 次失败才放弃。
  _startCanvasWatch() {
    if (this._canvasWatchTimer) return;
    this._canvasWatchTimer = setInterval(() => {
      if (this.destroyed || !this.isRendering || !this.canvas || !this.video) return;

      if (!this.video.isConnected) {
        console.info('[HDR Vision] 视频元素已被站点替换，等待重新扫描');
        this.stopRendering();
        this.destroy();
        return;
      }

      if (this.canvas.isConnected) {
        this._canvasMissingCount = 0;
        if (this._canvasWasMissing && this._opacitySaved) this.video.style.opacity = '0';
        this._canvasWasMissing = false;
        return;
      }

      // 画布缺失的每一秒都让原视频可见，避免「视频隐藏了但增强没画」的黑屏
      if (!this._canvasWasMissing && this._opacitySaved) {
        this.video.style.opacity = this._originalOpacity;
      }
      this._canvasWasMissing = true;
      this._canvasMissingCount++;
      if (this._canvasMissingCount <= 2) {
        this.video.insertAdjacentElement('afterend', this.canvas);
        this._updateCanvasSize();
        // insertAdjacentElement 后 canvas 应已回到文档；立即恢复隐藏，避免闪一帧原画
        if (this.canvas.isConnected) {
          this._canvasMissingCount = 0;
          if (this._opacitySaved) this.video.style.opacity = '0';
          this._canvasWasMissing = false;
        }
      } else {
        console.warn('[HDR Vision] 增强画布被反复移除，已恢复原视频');
        this.stopRendering();  // stopRendering 会把 opacity 恢复为站点原值
      }
    }, 1000);
  }

  _stopCanvasWatch() {
    if (this._canvasWatchTimer) {
      clearInterval(this._canvasWatchTimer);
      this._canvasWatchTimer = null;
    }
  }

  startRendering() {
    if (this.failed || this.destroyed) return;
    if (this.isRendering || !this.video || !this.canvas || !this.device) return;
    this.isRendering = true;
    this._startCanvasWatch();

    // P1-8：GPU 错误归属统一由 controller 的 device 级监听处理，避免误伤其他视频
    this._updateUniformBuffer(true);

    this._renderFrame();

    this.video.addEventListener('play', this._onPlay);
    this.video.addEventListener('pause', this._onPause);
    this.video.addEventListener('seeked', this._onSeeked);
    this.video.addEventListener('loadeddata', this._onLoadedData);

    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      this._renderWithVideoFrameCallback();
    } else {
      this._renderWithAnimationFrame();
    }
  }

  _renderWithVideoFrameCallback() {
    const callback = () => {
      if (!this.isRendering || this.destroyed) return;
      if (!this._isFramePending) {
        this._isFramePending = true;
        try {
          this._renderFrame();
        } finally {
          this._isFramePending = false;
        }
      }
      this.videoFrameCallbackId = this.video.requestVideoFrameCallback(callback);
    };
    this.videoFrameCallbackId = this.video.requestVideoFrameCallback(callback);
  }

  _renderWithAnimationFrame() {
    const callback = () => {
      if (!this.isRendering || this.destroyed) return;
      if (!this._isFramePending) {
        this._isFramePending = true;
        try {
          this._renderFrame();
        } finally {
          this._isFramePending = false;
        }
      }
      this.animationFrameId = requestAnimationFrame(callback);
    };
    this.animationFrameId = requestAnimationFrame(callback);
  }

  _ensureVideoTexture(w, h, format = 'rgba8unorm') {
    if (this.videoTexture && this._videoTextureW === w &&
        this._videoTextureH === h && this._videoTextureFormat === format) {
      return;
    }
    if (this.videoTexture) {
      try { this.videoTexture.destroy(); } catch {}
      this.videoTexture = null;
    }
    this._copyBindGroup = null;
    this._copyBindGroupTexture = null;
    this.videoTexture = this.device.createTexture({
      size: [w, h, 1],
      format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._videoTextureW = w;
    this._videoTextureH = h;
    this._videoTextureFormat = format;
  }

  _createExternalBindGroup() {
    const externalTexture = this.device.importExternalTexture({
      source: this.video,
    });
    return this.device.createBindGroup({
      layout: this.shared.getExternalLayout(),
      entries: [
        { binding: 0, resource: externalTexture },
        { binding: 1, resource: this.shared.sampler },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
        { binding: 3, resource: this.shared.toneLut.view },
        { binding: 4, resource: this.shared.toneLut.sampler },
      ],
    });
  }

  // ★ 检测源帧顶部的纯绿填充条（AV1/HEVC 解码器 1088 补齐常见），返回应裁掉的源像素行数
  // ★ 顶部填充条检测：源帧顶部按 1:1 采样，不缩放。
  //   整帧缩放到小尺寸会把 1080 里的十几行绿条插值抹平，这里只取顶部 96 行。
  _detectTopGreenBand() {
    const v = this.video;
    if (!v || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return 0;
    try {
      const SAMPLE_H = Math.min(96, v.videoHeight);
      const W = 192;
      if (!this._detectCanvas) this._detectCanvas = document.createElement('canvas');
      if (!this._detectCtx) {
        this._detectCtx = this._detectCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (this._detectCanvas.width !== W || this._detectCanvas.height !== SAMPLE_H) {
        this._detectCanvas.width = W;
        this._detectCanvas.height = SAMPLE_H;
      }
      this._detectCtx.drawImage(v, 0, 0, v.videoWidth, SAMPLE_H, 0, 0, W, SAMPLE_H);
      const d = this._detectCtx.getImageData(0, 0, W, SAMPLE_H).data;
      let rows = 0;
      // 判定用「累加和 × 阈值」，避免每行 3 次除法；40 行是上限，
      // 扫到第 41 行就可以停（再绿也会返回 0，继续扫描纯属浪费）
      const G_MIN = 140 * W, RB_MAX = 100 * W, GAP_MIN = 70 * W;
      for (let y = 0; y < SAMPLE_H && rows <= 40; y++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let i = y * W * 4;
        for (let x = 0; x < W; x++, i += 4) {
          r += d[i]; g += d[i + 1]; b += d[i + 2];
        }
        if (!(g > G_MIN && r < RB_MAX && b < RB_MAX &&
              (g - Math.max(r, b)) > GAP_MIN)) break;
        rows++;
      }
      // 最多认 40 行；超过说明整段画面本来就偏绿，不做处理
      return rows <= 40 ? rows : 0;
    } catch (e) {
      return 0;
    }
  }

  // ★ P2-11：快照按「目标尺寸」绘制，而不是源尺寸。
  //   输出画布本来就是 renderScale / 7680 上限之后的尺寸，先画一张全分辨率
  //   2D 画布再上传纯属浪费：4K 每帧 33MB 的 CPU 画布 + 33MB 纹理上传，
  //   缩小到目标尺寸后只剩 8MB（1080p 目标）。GPU 采样本来就是双线性缩放，
  //   画质不变（renderScale = 1 时目标 = 源，行为与旧版完全一致）。
  _snapshotToCanvas() {
    const v = this.video;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (!w || !h) throw new Error('snapshot: video size is empty');
    const target = this._getTargetSize();
    // 目标尺寸算不出来（元数据缺失）时退回源尺寸，宁可多占一点都不取帧失败
    const tw = target.width > 0 ? target.width : w;
    const th = target.height > 0 ? target.height : h;
    if (!this._snapshotCanvas) {
      this._snapshotCanvas = document.createElement('canvas');
      this._snapshotCtx = this._snapshotCanvas.getContext('2d', { alpha: false, willReadFrequently: false });
    }
    if (this._snapshotCanvas.width !== tw || this._snapshotCanvas.height !== th) {
      this._snapshotCanvas.width = tw;
      this._snapshotCanvas.height = th;
    }
    // 跨域/DRM 视频这里会抛 SecurityError，交给上层继续降级
    const cropTop = Math.min(this._cropTopPx || 0, Math.max(0, h - 16));
    if (cropTop > 0) {
      // ★ 源帧顶部带绿色填充条时（AV1/HEVC 解码器补齐），裁掉后再拉伸铺满
      this._snapshotCtx.drawImage(v, 0, cropTop, w, h - cropTop, 0, 0, tw, th);
    } else {
      this._snapshotCtx.drawImage(v, 0, 0, w, h, 0, 0, tw, th);
    }
    return { source: this._snapshotCanvas, w: tw, h: th };
  }

  // ★ 1.2.38：只读诊断快照。不触发渲染、不分配 GPU 对象，
  //   controller 汇总后随 GET_STATUS 回给 popup，让真机问题可自证。
  readDiagnostics() {
    const probe = this.probe || {};
    const configured = this.settings?.capturePath || 'auto';
    let path = 'external';
    let reason = 'zero-copy';
    if (!this.useExternalTexture) {
      path = (this.settings?.capturePath === 'snapshot' || this._autoSnapshot) ? 'snapshot' : 'copy';
      if (configured === 'snapshot') reason = 'user';
      else if (this._autoSnapshot && probe.padded && this.hdrMode === 0) reason = 'padded';
      else if (this._cropTopPx > 0 && this._cropDetected && !this._manualCrop) reason = 'green-band';
      else if (this._manualCrop > 0) reason = 'manual-crop';
      else if (configured === 'copy') reason = 'user';
      else reason = 'fallback';
    }
    return {
      path,
      reason,
      configured,
      padded: !!probe.padded,
      coded: probe.codedWidth ? probe.codedWidth + 'x' + probe.codedHeight : '',
      visible: probe.visibleWidth ? probe.visibleWidth + 'x' + probe.visibleHeight : '',
      greenRows: this._cropDetected ? (this._cropTopPx || 0) : null,
      manualCrop: Math.round(this.settings?.cropTopPx || 0),
      hdrMode: this.hdrMode,
      canvas: this.canvasFormat || '',
      failed: !!this.failed,
      destroyed: !!this.destroyed,
      tainted: !!this.tainted,
      drm: !!this.drmProtected,
    };
  }

  // ★ P2-11：本渲染器会占用的视频纹理字节数（用于 manager 侧预算准入）。
  //   external 路径的纹理由浏览器管理，不计入；快照按目标尺寸，直拷按源尺寸。
  estimateTextureBytes() {
    if (this.useExternalTexture) return 0;
    const bytesPerPixel = this.hdrMode > 0 ? 8 : 4;
    const wantSnapshot = this.settings?.capturePath === 'snapshot' || this._autoSnapshot === true;
    if (wantSnapshot) {
      const { width, height } = this._getTargetSize();
      if (width > 0 && height > 0) return width * height * bytesPerPixel;
    }
    const w = this.video?.videoWidth || 0;
    const h = this.video?.videoHeight || 0;
    return w * h * bytesPerPixel;
  }

  _createCopyBindGroup(kind) {
    const canvasSource = this.nijiLucidCanvas;
    let source;
    let srcW;
    let srcH;
    if (canvasSource) {
      source = canvasSource;
      srcW = canvasSource.width;
      srcH = canvasSource.height;
    } else if (kind === 'canvas') {
      const snap = this._snapshotToCanvas();
      source = snap.source;
      srcW = snap.w;
      srcH = snap.h;
    } else {
      source = this.video;
      srcW = this.video.videoWidth;
      srcH = this.video.videoHeight;
    }
    if (!srcW || !srcH) throw new Error('copy path: source size is empty');

    // HDR 源优先用 rgba16float 承接，保住 10bit 精度（避免 PQ 信号量化成 8bit 产生色带）
    const preferred = this.hdrMode > 0 ? 'rgba16float' : 'rgba8unorm';
    const formats = this._copyFormatLocked
      ? [this._copyFormatLocked]
      : (preferred === 'rgba8unorm' ? ['rgba8unorm'] : ['rgba16float', 'rgba8unorm']);

    let lastErr = null;
    for (const fmt of formats) {
      try {
        this._ensureVideoTexture(srcW, srcH, fmt);
        this.device.queue.copyExternalImageToTexture(
          { source, flipY: false, premultipliedAlpha: false },
          { texture: this.videoTexture, premultipliedAlpha: false },
          [srcW, srcH]
        );
        this._copyFormatLocked = fmt;
        // ★ 纹理与 uniform 缓冲不变时复用绑定组，避免每帧新建 GPU 对象
        if (!this._copyBindGroup || this._copyBindGroupTexture !== this.videoTexture) {
          this._copyBindGroup = this.device.createBindGroup({
            layout: this.shared.getCopyLayout(),
            entries: [
              { binding: 0, resource: this.videoTexture.createView() },
              { binding: 1, resource: this.shared.sampler },
              { binding: 2, resource: { buffer: this.uniformBuffer } },
              { binding: 3, resource: this.shared.toneLut.view },
              { binding: 4, resource: this.shared.toneLut.sampler },
            ],
          });
          this._copyBindGroupTexture = this.videoTexture;
        }
        return this._copyBindGroup;
      } catch (e) {
        lastErr = e;
        if (this.videoTexture) {
          try { this.videoTexture.destroy(); } catch {}
          this.videoTexture = null;
          this._videoTextureW = 0;
          this._videoTextureH = 0;
          this._videoTextureFormat = null;
          this._copyBindGroup = null;
          this._copyBindGroupTexture = null;
        }
      }
    }
    throw lastErr || new Error('copy path failed');
  }

  _degradeToCopyPath(err) {
    if (!this.useExternalTexture) return;
    this.useExternalTexture = false;
    this.bindGroupLayout = this.shared.getCopyLayout();
    console.warn(
      '[HDR Vision] importExternalTexture 失败，已降级到 copy 路径:',
      err && err.message ? err.message : err
    );
    this._configureCanvas();
    this._updateUniformBuffer(true);
  }

  // ★ 取帧方式的唯一求解点：设置 + 探测结果 + 手动裁切 + Niji 覆盖。
  //   _setup / updateSettings / _onSourceChanged 三处共用，避免条件各写一份后漂移。
  _resolveCaptureMode() {
    const capturePath = this.settings?.capturePath || 'auto';
    const manualCrop = Math.round(this.settings?.cropTopPx || 0);
    // 裁切只在 SDR 路径做：HDR 源要保持 external + 16float 的 10bit 精度
    const cropTopPx = (manualCrop > 0 && this.hdrMode === 0) ? manualCrop : 0;
    this._manualCrop = cropTopPx;

    let useExternal = !(capturePath === 'copy' || capturePath === 'snapshot' || cropTopPx > 0);
    let autoSnapshot = cropTopPx > 0;
    // ★ 自动模式：解码帧带补齐（AV1/HEVC 常见，1080→1088）时，external 纹理会把填充条读进来
    //   （顶部/底部一条绿边）。这种情况改用 2D 快照，由 Chrome 自己处理 visibleRect。
    if (capturePath === 'auto' && cropTopPx === 0 &&
        this.probe?.padded && this.hdrMode === 0) {
      useExternal = false;
      autoSnapshot = true;
      if (this.probe.codedWidth) {
        console.info(
          '[HDR Vision] 解码帧有补齐（' + this.probe.codedWidth + 'x' + this.probe.codedHeight +
          ' → 可见 ' + this.probe.visibleWidth + 'x' + this.probe.visibleHeight +
          '），自动改用 2D 快照取帧，避免填充条被读进来'
        );
      }
    }
    if (this.nijiLucidCanvas) useExternal = false;
    return { useExternal, autoSnapshot, cropTopPx };
  }

  // 取帧路径 / 格式变化后，旧的 copy 纹理格式与绑定组不再可信
  _resetCopyTarget() {
    this._copyBindGroup = null;
    this._copyBindGroupTexture = null;
    this._copyFormatLocked = null;
  }

  // ★ P1-1：同一 <video> 元素换源（播放列表切集、SPA 换片）时重新判定。
  //   旧实现把 srcKey 比对写在 !_cropDetected 分支里，而进入条件本身已排除该分支，
  //   等于永不重检：上一集的裁切值会被套到新一集上，或新一集的绿边一直留着。
  _onSourceChanged() {
    this._cropDetected = false;
    this._cropSrcKey = null;
    // P2-6：旧片源的失败与退避状态不适用于新片源
    this._resetFailureTracker();

    // 新片源的补齐情况 / HDR 标记可能与上一集不同
    this.probe = probeSource(this.video);
    this.sourceIsHDR = this.probe.isHDR;
    const prevHdrMode = this.hdrMode;
    this.hdrMode = resolveHDRMode(this.settings, this.probe);

    // 新片源需要重新校准（旧结论不适用于新源）
    this._calibrationFallback = false;
    this._calibrated = false;
    this._calibrationAttempts = 0;
    if (this._calibrationTimer) {
      clearTimeout(this._calibrationTimer);
      this._calibrationTimer = null;
    }

    if (this.sourceIsHDR && this.hdrMode === 0 && shouldSkipHDRSource(this.settings)) {
      // 新片源该跳过 → 交回 manager（destroy 会恢复原视频并清理条目）
      this.destroy();
      return;
    }

    const capture = this._resolveCaptureMode();
    this._cropTopPx = capture.cropTopPx;
    this._autoSnapshot = capture.autoSnapshot;
    if (capture.useExternal !== this.useExternalTexture || prevHdrMode !== this.hdrMode) {
      this.useExternalTexture = capture.useExternal;
      this.bindGroupLayout = capture.useExternal
        ? this.shared.getExternalLayout()
        : this.shared.getCopyLayout();
      this._resetCopyTarget();
      this._configureCanvas();
      this._updateCanvasSize();
    }
    this._updateUniformBuffer(true);
  }

  // P1-5：受保护内容一律不接管 —— 读帧只会得到黑帧，接管等于整块黑屏
  _abortForDRM(source) {
    if (this.destroyed) return;
    this.drmProtected = true;
    console.info('[HDR Vision] 检测到受保护内容（' + source + '），已停止增强并恢复原视频');
    this.destroy();
  }

  // ★ 每帧同步片源状态：换源重检（P1-1）+ 首次绿边检测。
  //   返回 false 表示 renderer 已因新片源该跳过而销毁，调用方应立即结束本帧。
  _syncSourceState() {
    const srcKey = (this.video.currentSrc || this.video.src || '').slice(0, 96);
    if (this._cropSrcKey !== null && this._cropSrcKey !== srcKey) {
      this._onSourceChanged();
      if (this.destroyed || this.failed) return false;
    }
    if (!this._cropDetected && this.video.readyState >= 2) {
      this._cropDetected = true;
      this._cropSrcKey = srcKey;
      const rows = this._detectTopGreenBand();
      if (rows > 0 && !this._manualCrop) {
        this._cropTopPx = rows;
        this._autoSnapshot = true;   // 裁切只在快照路径里做
        console.info('[HDR Vision] 顶部检出填充条，裁掉', rows, 'px');
        if (this.useExternalTexture) {
          this.useExternalTexture = false;
          this.bindGroupLayout = this.shared.getCopyLayout();
          this._configureCanvas();
          this._updateUniformBuffer(true);
        }
      }
    }
    return true;
  }

  // P2-6：连续失败不再只按「帧数」判死刑。
  //   90 帧 @60fps = 1.5s，切分辨率 / seek / 解码器重建时太容易误杀。
  //   - 已经成功渲染过：管线本身是好的，只有连续失败且持续 >3s 才停；
  //   - 还没出首帧：按 0.5→1→2→4→8s 指数退避重试，最多 6 档，
  //     既不每帧空转 GPU，也不会因为初始化慢就永久 destroy。
  //   返回 false 表示 renderer 已 destroy，调用方应立即结束本帧。
  _noteRenderFailure() {
    const now = Date.now();
    if (!this._failureSince) this._failureSince = now;
    this._consecutiveFailures++;

    if (this._hasRenderedOnce) {
      if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
          now - this._failureSince > FAILURE_WINDOW_MS) {
        console.warn('[HDR Vision] 渲染连续失败超过 ' + FAILURE_WINDOW_MS + 'ms，已停止该视频的增强');
        this.destroy();
        return false;
      }
      return true;
    }

    if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      if (this._backoffCount >= MAX_STARTUP_BACKOFFS) {
        console.warn('[HDR Vision] 首帧前反复失败，已停止该视频的增强');
        this.destroy();
        return false;
      }
      const delay = Math.min(
        STARTUP_BACKOFF_MAX_MS,
        STARTUP_BACKOFF_BASE_MS * Math.pow(2, this._backoffCount)
      );
      this._backoffCount++;
      this._backoffUntil = now + delay;
      // 半开计数：退避后再攒 MAX/2 次才进下一档，避免每个失败帧都推高指数
      this._consecutiveFailures = Math.floor(MAX_CONSECUTIVE_FAILURES / 2);
      console.warn('[HDR Vision] 首帧渲染失败，退避 ' + delay + 'ms 后重试');
    }
    return true;
  }

  _resetFailureTracker() {
    this._consecutiveFailures = 0;
    this._failureSince = 0;
    this._backoffUntil = 0;
    this._backoffCount = 0;
  }

  _renderFrame() {
    if (this.failed || this.destroyed) return false;
    // P2-6：退避窗口内不提交任何绘制（帧回调仍在跑，开销只有一次时间戳比较）
    if (this._backoffUntil && Date.now() < this._backoffUntil) return false;
    if (!this.video || !this.device || !this.context || !this.pipeline) return false;
    if (!this.canvas || !this.canvas.width || !this.canvas.height) return false;
    if (!this.video.videoWidth || !this.video.videoHeight) return false;
    if (this.video.readyState < 2) return false;

    try {
      // ★ 种子只服务 deband 抖动；关闭时保持常量，让 uniform 比较得以命中去重
      if (this.settings?.deband?.enabled) {
        this._frameSeed = (this._frameSeed + 1) % 1000;
      }
      this._updateUniformBuffer();

      // ★ 每个片源检测一次顶部绿条（源帧自带时裁掉）；换源必须重新判定（P1-1）
      if (!this._syncSourceState()) return false;

      let bindGroup;
      if (this.useExternalTexture) {
        // ★ 路径 1：importExternalTexture（零拷贝，AVC 基本都走这条）
        try {
          bindGroup = this._createExternalBindGroup();
        } catch (e) {
          if (isTaintError(e)) {
            this.tainted = true;
            throw e;   // 污染是硬限制，往下两级也一样读不到
          }
          this._degradeToCopyPath(e);
          bindGroup = null;
        }
      }
      if (!bindGroup) {
        const wantSnapshot = this.settings?.capturePath === 'snapshot' || this._autoSnapshot === true;
        try {
          // ★ 路径 2：直接把 <video> 拷进纹理 / 或按设置走 2D 快照
          bindGroup = this._createCopyBindGroup(wantSnapshot ? 'canvas' : 'video');
        } catch (e1) {
          // ★ 路径 3：把当前帧画进 2D canvas 再上传 —— 所有编码/驱动都兼容
          bindGroup = this._createCopyBindGroup('canvas');
          if (!this._loggedCanvasFallback) {
            console.warn(
              '[HDR Vision] 直拷失败，改用 2D 快照路径:',
              e1 && e1.message ? e1.message : e1
            );
            this._loggedCanvasFallback = true;
          }
        }
      }

      const commandEncoder = this.device.createCommandEncoder();
      const textureView = this.context.getCurrentTexture().createView();
      const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [
          {
            view: textureView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      renderPass.setPipeline(this.pipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.draw(3);
      renderPass.end();
      this.device.queue.submit([commandEncoder.finish()]);

      if (!this._hasRenderedOnce) {
        // P2-12：只记录一次，且必须在我们第一次改写之前
        if (!this._opacitySaved) {
          this._originalOpacity = this.video.style.opacity;
          this._opacitySaved = true;
        }
        this.video.style.opacity = '0';
        this._hasRenderedOnce = true;
        // ★ 首帧后做一次 HDR 标记校准（不阻塞渲染循环）
        if (this.hdrMode > 0) {
          setTimeout(() => this._calibrateHDRSource(), 600);
        }
      }

      this._resetFailureTracker();
      return true;
    } catch (e) {
      if (!this._noteRenderFailure()) return false;
      if (this.tainted || isTaintError(e)) {
        // 跨域污染：重试无意义，直接从画布撤掉、恢复原视频
        console.info('[HDR Vision] 视频受跨域限制，已停止处理该视频');
        this.tainted = true;
        this.destroy();
        return false;
      }
      if (!this._loggedOnce) {
        console.warn('[HDR Vision] Video render error:', e);
        this._loggedOnce = true;
      }
      return false;
    }
  }

  stopRendering() {
    this.isRendering = false;
    this._stopCanvasWatch();
    if (this.videoFrameCallbackId !== null && this.video) {
      try { this.video.cancelVideoFrameCallback(this.videoFrameCallbackId); } catch {}
      this.videoFrameCallbackId = null;
    }
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this._isFramePending = false;
    // P1-8：device 级 uncapturederror 由 controller 统一处理，renderer 不再各自挂监听
    if (this.video) {
      this.video.removeEventListener('play', this._onPlay);
      this.video.removeEventListener('pause', this._onPause);
      this.video.removeEventListener('seeked', this._onSeeked);
      this.video.removeEventListener('loadeddata', this._onLoadedData);
      // P2-12：恢复站点原本的 opacity（没改过就不动，否则会抹掉站点的内联样式）
      if (this._opacitySaved) {
        this.video.style.opacity = this._originalOpacity;
        this._opacitySaved = false;
        this._originalOpacity = null;
      }
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopRendering();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.video && this._videoResizeHandler) {
      this.video.removeEventListener('loadedmetadata', this._videoResizeHandler);
      this.video.removeEventListener('resize', this._videoResizeHandler);
      this._videoResizeHandler = null;
    }
    // P1-5：迟到的 encrypted 事件不再回调（renderer 已销毁）
    if (this.video && this._onEncrypted) {
      try { this.video.removeEventListener('encrypted', this._onEncrypted); } catch {}
    }
    this._onEncrypted = null;
    if (this.videoTexture) {
      try { this.videoTexture.destroy(); } catch {}
      this.videoTexture = null;
    }
    if (this.canvas && this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.canvas = null;
    this.context = null;
    this._snapshotCanvas = null;
    this._snapshotCtx = null;
    if (this._positionAcquired) {
      releaseRelativeContainer(this.container);
      this._positionAcquired = false;
    }
    if (this._onNiji) {
      nijiSubscribers.delete(this._onNiji);
      this._onNiji = null;
    }
    this.video = null;
    this.container = null;
    this.nijiLucidCanvas = null;
    this.lastUniformData = null;
    this.uniformBuffer = null;
    // P1-4：释放校准用 buffer 与绿条检测 canvas
    try { this._probeUniform?.destroy(); } catch {}
    this._probeUniform = null;
    // P1-3：撤销尚未触发的校准重试，避免销毁后仍持有 video/device
    if (this._calibrationTimer) {
      clearTimeout(this._calibrationTimer);
      this._calibrationTimer = null;
    }
    this._detectCanvas = null;
    this._detectCtx = null;
    // P1-5：通知 manager 清条目，避免自毁后永久留在 renderers 里
    const cb = this.onDestroyed;
    this.onDestroyed = null;
    if (typeof cb === 'function') {
      try { cb(this); } catch (e) { console.warn('[HDR Vision] onDestroyed error:', e); }
    }
  }
}
// ============ 视频管理器 ============

class ImageRenderer {
  constructor(shared, image, settings) {
    this.shared = shared;
    this.device = shared.device;
    this.image = image;
    this.settings = settings;
    this.canvas = null;
    this.context = null;
    this.uniformBuffer = null;
    this.texture = null;
    this.canvasFormat = null;
    this.pipeline = null;
    this.container = null;
    this.resizeObserver = null;
    this.failed = false;
    this.destroyed = false;
    this.isFetching = false;
    this.tier = null;
    this.lastRenderedSrc = null;
    this._drawUniformData = null;
    this._drawBindGroup = null;
    this._drawBindGroupTexture = null;
    // P1-7：画布被站点移除时恢复原图片
    this._canvasWatchTimer = null;
    this._canvasMissingCount = 0;
    // P2-12：同视频端 —— 恢复时写回站点原本的 opacity，而不是硬编码 '1'
    this._originalOpacity = null;
    this._opacitySaved = false;
    this._positionAcquired = false;

    this._onImageLoad = () => {
      if (this.destroyed || this.failed) return;
      const newSrc = this.image.currentSrc || this.image.src;
      if (newSrc === this.lastRenderedSrc) return;
      this._updateCanvasSize();
      this._render();
    };

    this._setup();
  }

  _setup() {
    const image = this.image;
    const container = image.parentElement || document.body;
    this.container = container;

    this.canvas = document.createElement('canvas');
    this.canvas.className = '__extension_hdrimagecanvas';
    Object.assign(this.canvas.style, {
      position: 'absolute',
      pointerEvents: 'none',
      // ★ 必须与同级弹幕/字幕层处于同一层级（0），靠 DOM 顺序压在原视频之上；
      //   若设成 1 会盖住播放器后插入的弹幕层（斗鱼/B站都会中招）
      zIndex: '0',
    });

    this._positionAcquired = acquireRelativeContainer(container);

    image.insertAdjacentElement('afterend', this.canvas);
    this.context = this.canvas.getContext('webgpu');
    if (!this.context) {
      this.failed = true;
      this._cleanupCanvas();
      return;
    }

    this._configureCanvas();
    if (!this.pipeline) {
      this.failed = true;
      this._cleanupCanvas();
      return;
    }

    this._createUniformBuffer();
    this._updateCanvasSize();

    this.resizeObserver = new ResizeObserver(() => {
      this._updateCanvasSize();
      this._render();
    });
    this.resizeObserver.observe(image);

    image.addEventListener('load', this._onImageLoad);
    this._startCanvasWatch();
  }

  // ★ P1-7 + 1.2.26：与视频端同构。元素被站点替换时直接 _fail 让 manager 清理，
  //   画布单独被删时先恢复原图可见，插回后再隐藏，避免中间的空窗黑图。
  _startCanvasWatch() {
    if (this._canvasWatchTimer) return;
    this._canvasWatchTimer = setInterval(() => {
      if (this.destroyed || this.failed || !this.canvas || !this.image) return;

      if (!this.image.isConnected) {
        console.info('[HDR Vision] 图片元素已被站点替换，等待重新扫描');
        this._fail();
        return;
      }

      if (this.canvas.isConnected) {
        this._canvasMissingCount = 0;
        if (this._canvasWasMissing && this._opacitySaved) this.image.style.opacity = '0';
        this._canvasWasMissing = false;
        return;
      }

      if (!this._canvasWasMissing && this._opacitySaved) {
        this.image.style.opacity = this._originalOpacity;
      }
      this._canvasWasMissing = true;
      this._canvasMissingCount++;
      if (this._canvasMissingCount <= 2) {
        this.image.insertAdjacentElement('afterend', this.canvas);
        this._updateCanvasSize();
        this._draw();
        if (this.canvas.isConnected) {
          this._canvasMissingCount = 0;
          if (this._opacitySaved) this.image.style.opacity = '0';
          this._canvasWasMissing = false;
        }
      } else {
        console.warn('[HDR Vision] 图片增强画布被反复移除，恢复原图片');
        this._fail();
      }
    }, 1000);
  }

  _stopCanvasWatch() {
    if (this._canvasWatchTimer) {
      clearInterval(this._canvasWatchTimer);
      this._canvasWatchTimer = null;
    }
  }

  _cleanupCanvas() {
    if (this.canvas && this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.canvas = null;
    if (this._positionAcquired) {
      releaseRelativeContainer(this.container);
      this._positionAcquired = false;
    }
  }

  _configureCanvas() {
    // P1-1：与视频一致尊重「输出画布」设置，不能只看显示器能力
    const wantHDR = HDR_DISPLAY_AVAILABLE && this.settings?.canvasMode !== 'sdr';
    if (wantHDR) {
      try {
        this.context.configure({
          device: this.device,
          format: 'rgba16float',
          toneMapping: { mode: 'extended' },
          alphaMode: 'premultiplied',
        });
        this.canvasFormat = 'rgba16float';
        this.pipeline = this.shared.getPipeline(this.canvasFormat);
        if (this.pipeline) return;
      } catch (e) {
        console.warn('[HDR Vision] Image HDR configure failed:', e);
      }
    }

    try {
      const format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: format,
        alphaMode: 'premultiplied',
      });
      this.canvasFormat = format;
      this.pipeline = this.shared.getPipeline(this.canvasFormat);
    } catch (e) {
      console.error('[HDR Vision] Image canvas configure failed:', e);
      this.canvasFormat = null;
      this.pipeline = null;
    }
  }

  _createUniformBuffer() {
    this.uniformBuffer = this.device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  _computeUV() {
    const img = this.image;
    const rect = img.getBoundingClientRect();
    const lw = rect.width;
    const lh = rect.height;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!lw || !lh || !nw || !nh) {
      return { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
    }
    let objectFit = 'fill';
    try {
      objectFit = window.getComputedStyle(img).objectFit || 'fill';
    } catch {}

    if (objectFit === 'cover') {
      const s = Math.max(lw / nw, lh / nh);
      const scaledW = nw * s;
      const scaledH = nh * s;
      const offX = Math.max(0, (scaledW - lw) / 2);
      const offY = Math.max(0, (scaledH - lh) / 2);
      return {
        scaleX: lw / scaledW,
        scaleY: lh / scaledH,
        offsetX: offX / scaledW,
        offsetY: offY / scaledH,
      };
    }
    if (objectFit === 'none') {
      const offX = Math.max(0, (nw - lw) / 2);
      const offY = Math.max(0, (nh - lh) / 2);
      return {
        scaleX: Math.min(nw, lw) / nw,
        scaleY: Math.min(nh, lh) / nh,
        offsetX: offX / nw,
        offsetY: offY / nh,
      };
    }
    if (objectFit === 'contain') {
      // P2-4：contain 的留白区必须透明，UV 范围为负偏移 + 放大
      const s = Math.min(lw / nw, lh / nh);
      const scaledW = nw * s;
      const scaledH = nh * s;
      const offX = Math.max(0, (lw - scaledW) / 2);
      const offY = Math.max(0, (lh - scaledH) / 2);
      return {
        scaleX: lw / scaledW,
        scaleY: lh / scaledH,
        offsetX: -offX / scaledW,
        offsetY: -offY / scaledH,
      };
    }
    return { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
  }

  _getTextureSize() {
    const image = this.image;
    const nw = image.naturalWidth;
    const nh = image.naturalHeight;
    if (!nw || !nh) return { width: 0, height: 0 };
    const scale = scaleForSize(this.settings, nw, nh);

    if (scale >= 1.0) return { width: nw, height: nh };
    return {
      width: Math.max(1, Math.round(nw * scale)),
      height: Math.max(1, Math.round(nh * scale)),
    };
  }

  _getCanvasBackingSize() {
    const image = this.image;
    const nw = image.naturalWidth;
    const nh = image.naturalHeight;
    if (!nw || !nh) return { width: 0, height: 0 };
    // P2-4：canvas 覆盖的是元素盒，backing size 应按元素尺寸计算，
    // 否则 contain 时会出现「用小纹理拉伸到元素盒」的模糊。
    const rect = image.getBoundingClientRect();
    const visW = rect.width || nw;
    const visH = rect.height || nh;
    const scale = scaleForSize(this.settings, visW, visH);

    if (scale >= 1.0) {
      return {
        width: Math.max(1, Math.round(visW)),
        height: Math.max(1, Math.round(visH)),
      };
    }
    return {
      width: Math.max(1, Math.round(visW * scale)),
      height: Math.max(1, Math.round(visH * scale)),
    };
  }

  _updateCanvasSize() {
    const image = this.image;
    if (!image.naturalWidth || !image.naturalHeight) return;
    if (!this.canvas || !this.container) return;

    const imgRect = image.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();

    const displayWidth = imgRect.width;
    const displayHeight = imgRect.height;
    const left = imgRect.left - containerRect.left;
    const top = imgRect.top - containerRect.top;

    this.canvas.style.left = `${Math.round(left)}px`;
    this.canvas.style.top = `${Math.round(top)}px`;
    this.canvas.style.width = `${Math.round(displayWidth)}px`;
    this.canvas.style.height = `${Math.round(displayHeight)}px`;

    const { width, height } = this._getCanvasBackingSize();
    if (width > 0 && height > 0 &&
        (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
      this._configureCanvas();
    }
  }

  updateSettings(settings) {
    // P0-3 / P1-1：canvasMode 变化必须重新 configure；renderScale 变化已在
    // _updateCanvasSize() 中按新值重算画布尺寸。
    const prevCanvasMode = this.settings?.canvasMode;
    this.settings = settings;
    if (prevCanvasMode !== settings.canvasMode) this._configureCanvas();
    this._updateCanvasSize();
    this._render();
  }

  _createTexture(width, height) {
    if (this.texture && this.texture.width === width && this.texture.height === height) return;
    if (this.texture) {
      try { this.texture.destroy(); } catch {}
    }
    this.texture = this.device.createTexture({
      size: [width, height, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  async _render() {
    if (this.failed || this.destroyed) return;
    if (!this.device || !this.pipeline || !this.canvas || !this.context) return;
    if (this.isFetching) return;

    const image = this.image;
    if (!image.naturalWidth || !image.naturalHeight) return;

    const src = image.currentSrc || image.src;
    if (!src) return;

    const naturalW = image.naturalWidth;
    const naturalH = image.naturalHeight;
    const { width, height } = this._getTextureSize();
    if (!width || !height) return;
    const needsResize = width !== naturalW || height !== naturalH;

    const isSameOrigin = isSameOriginUrl(src);
    const hasCrossOrigin =
      image.crossOrigin === 'anonymous' || image.crossOrigin === 'use-credentials';
    const canUploadDirectly = isSameOrigin || hasCrossOrigin;

    if (canUploadDirectly && !needsResize) {
      this._createTexture(width, height);
      try {
        this.device.queue.copyExternalImageToTexture(
          { source: image, flipY: false, premultipliedAlpha: false },
          { texture: this.texture, premultipliedAlpha: false },
          [width, height]
        );
        this._draw();
        this.lastRenderedSrc = src;
        return;
      } catch (e) { /* fallthrough */ }
    }

    this._renderViaBitmap(width, height, canUploadDirectly);
  }

  async _renderViaBitmap(targetW, targetH, canUploadDirectly) {
    if (this.isFetching || this.failed || this.destroyed) return;
    this.isFetching = true;

    const image = this.image;
    const src = image.currentSrc || image.src;
    const naturalW = image.naturalWidth;
    const naturalH = image.naturalHeight;
    const needsResize = targetW !== naturalW || targetH !== naturalH;

    try {
      let bitmap = null;
      if (canUploadDirectly) {
        try {
          const opts = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
          if (needsResize) {
            opts.resizeWidth = targetW;
            opts.resizeHeight = targetH;
            opts.resizeQuality = 'high';
          }
          bitmap = await createImageBitmap(image, opts);
        } catch { bitmap = null; }
      }

      if (!bitmap) {
        const response = await fetch(src, { mode: 'cors', credentials: 'omit' });
        if (!response.ok) throw new Error('fetch ' + response.status);
        const blob = await response.blob();
        const opts = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
        if (needsResize) {
          opts.resizeWidth = targetW;
          opts.resizeHeight = targetH;
          opts.resizeQuality = 'high';
        }
        bitmap = await createImageBitmap(blob, opts);
      }

      if (this.failed || this.destroyed || this.image !== image) {
        bitmap.close();
        return;
      }
      const currentSrc = image.currentSrc || image.src;
      if (currentSrc !== src) {
        bitmap.close();
        return;
      }
      // P1-4：await 期间窗口 resize 会改变目标尺寸，而新渲染被 isFetching 挡住，
      // 旧任务醒来后若仍用旧尺寸写纹理会导致拉伸/错位。尺寸不一致则丢弃本次结果。
      const nowSize = this._getTextureSize();
      if (nowSize.width !== targetW || nowSize.height !== targetH) {
        bitmap.close();
        return;
      }

      this._createTexture(targetW, targetH);
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap, flipY: false, premultipliedAlpha: false },
        { texture: this.texture, premultipliedAlpha: false },
        [targetW, targetH]
      );
      bitmap.close();
      this._draw();
      this.lastRenderedSrc = src;
    } catch (e) {
      this._fail();
    } finally {
      this.isFetching = false;
    }
  }

  _draw() {
    if (this.failed || this.destroyed) return;
    try {
      const { width: canvasW, height: canvasH } = this._getCanvasBackingSize();
      if (!canvasW || !canvasH) return;
      const uv = this._computeUV();
      // 复用 uniform 数组与绑定组：图片静态渲染，纹理/uniform buffer 在生命周期内不变
      if (!this._drawUniformData) this._drawUniformData = new Float32Array(UNIFORM_FLOATS);
      const data = this._drawUniformData;
      const texelW = 1.0 / canvasW;
      const texelH = 1.0 / canvasH;
      const lutReady = this.shared.toneLut.update(this.settings.bt2446a);
      computeUniformData(
        this.settings, canvasW, canvasH, texelW, texelH, 0, uv, data,
        {
          outputIsHDR: this.canvasFormat === 'rgba16float',
          outputLinear: this.canvasFormat === 'rgba16float' &&
            this.settings?.canvasEncoding === 'linear',
          lutReady,
        }
      );
      this.device.queue.writeBuffer(this.uniformBuffer, 0, data);

      if (!this._drawBindGroup || this._drawBindGroupTexture !== this.texture) {
        this._drawBindGroup = this.device.createBindGroup({
          layout: this.shared.bindGroupLayout,
          entries: [
            { binding: 0, resource: this.texture.createView() },
            { binding: 1, resource: this.shared.sampler },
            { binding: 2, resource: { buffer: this.uniformBuffer } },
            { binding: 3, resource: this.shared.toneLut.view },
            { binding: 4, resource: this.shared.toneLut.sampler },
          ],
        });
        this._drawBindGroupTexture = this.texture;
      }
      const bindGroup = this._drawBindGroup;

      const commandEncoder = this.device.createCommandEncoder();
      const textureView = this.context.getCurrentTexture().createView();
      const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [
          {
            view: textureView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });
      renderPass.setPipeline(this.pipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.draw(3);
      renderPass.end();
      this.device.queue.submit([commandEncoder.finish()]);

      // P2-12：首次隐藏前记录站点原值（每帧都会走到这里，只记一次）
      if (!this._opacitySaved) {
        this._originalOpacity = this.image.style.opacity;
        this._opacitySaved = true;
      }
      this.image.style.opacity = '0';
    } catch (e) {
      this._fail();
    }
  }

  _fail() {
    if (this.destroyed) return;
    this.failed = true;
    // P1-2：失败必须走完整销毁。只有 destroy() 会回调 onDestroyed，
    //   而 manager 靠它归还 _textureBytes 与 tier 名额、并把条目移出 renderers。
    //   旧实现只置 failed + 恢复 opacity，renderer 会永久占着预算 → 预算耗尽后整页不再增强。
    this.destroy();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._stopCanvasWatch();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.image) {
      this.image.removeEventListener('load', this._onImageLoad);
      // P2-12：只还原我们改过的 opacity
      if (this._opacitySaved) {
        this.image.style.opacity = this._originalOpacity;
        this._opacitySaved = false;
        this._originalOpacity = null;
      }
    }
    if (this.texture) {
      try { this.texture.destroy(); } catch {}
      this.texture = null;
    }
    this._drawBindGroup = null;
    this._drawBindGroupTexture = null;
    this._drawUniformData = null;
    if (this.canvas && this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.canvas = null;
    this.context = null;
    this.uniformBuffer = null;
    if (this._positionAcquired) {
      releaseRelativeContainer(this.container);
      this._positionAcquired = false;
    }
    this.image = null;
    this.container = null;
    // P1-5：通知 manager 清条目（含 _fail() 之后的失效渲染器）
    const cb = this.onDestroyed;
    this.onDestroyed = null;
    if (typeof cb === 'function') {
      try { cb(this); } catch (e) { console.warn('[HDR Vision] image onDestroyed error:', e); }
    }
  }
}

// ============ 图片管理器 ============
