'use strict';
// HDR Vision — shared-resources.js（从 content-script.js 拆出，Phase 3 / P3-4）

class SharedVideoResources {
  // preferredPath：按当前取帧方式只预编译真正会用到的管线（'external' | 'copy'）。
  // 另一条路径首次被请求时才补建（NijiLucid / 设置切换才会走到）。
  constructor(device, preferredPath) {
    this.device = device;
    this.preferredPath = preferredPath === 'copy' ? 'copy' : 'external';

    // 两套 shader module
    this.shaderModuleExternal = device.createShaderModule({ code: videoShaderCode });
    this.shaderModuleCopy = device.createShaderModule({ code: videoShaderCodeCopy });
    reportShaderErrors(this.shaderModuleExternal, 'video/external');
    reportShaderErrors(this.shaderModuleCopy, 'video/copy');

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.toneLut = new ToneLutManager(device, LUT_SIZE);

    // ★ external 路径：binding 0 = externalTexture
    this.bindGroupLayoutExternal = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.pipelineLayoutExternal = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayoutExternal],
    });

    // ★ copy 路径：binding 0 = texture_2d
    this.bindGroupLayoutCopy = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.pipelineLayoutCopy = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayoutCopy],
    });

    this._sdrFormat = navigator.gpu.getPreferredCanvasFormat();
    this.pipelineSDRExt = null;
    this.pipelineHDRExt = null;
    this.pipelineSDRCopy = null;
    this.pipelineHDRCopy = null;
    this._built = { external: false, copy: false };
    // P1-4：同一条路径只编译一次（auto 会提前预取第二条路径，避免重复编译）
    this._buildPromises = { external: null, copy: null };
    // P2-2：每条路径的编译尝试计数（最多 2 次，防止坏驱动下每帧重编译）
    this._buildRetries = { external: 0, copy: 0 };
    this._disposed = false;
    // P1-3：探测任务的串行队列（见 withProbeLock）
    this._probeChain = Promise.resolve();

    // P4-1：pipeline 必须异步编译。同步 createRenderPipeline 会在渲染主线程上
    // 做完整着色器编译，冷启动 4 条管线累加可达数百毫秒 —— 表现就是视频卡住、
    // 页面点不动。异步版本把编译放到别的线程，主线程不再被冻结。
    this.ready = this._buildPath(this.preferredPath);
  }

  _pipelineDescriptor(useExternal, format) {
    const module = useExternal ? this.shaderModuleExternal : this.shaderModuleCopy;
    const layout = useExternal ? this.pipelineLayoutExternal : this.pipelineLayoutCopy;
    return {
      layout,
      vertex: { module, entryPoint: 'vertexMain' },
      fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    };
  }

  // P2-2：编译失败不能把整条取帧路径永久钉死。
  //   旧实现先置 _built[path] = true 再 await，而 createPipelineCheckedAsync
  //   失败时不抛异常而是返回 null —— 于是一次驱动重置 / 瞬时 OOM 之后，
  //   这条路径在本页就再也建不起来，只能刷新。
  //   这里回滚标记并记一次重试额度：允许再编译一次，两次都失败才认定不可用。
  _markBuildFailed(path, label) {
    this._buildPromises[path] = null;
    this._buildRetries[path] = (this._buildRetries[path] || 0) + 1;
    if (this._buildRetries[path] < 2) {
      this._built[path] = false;
      console.warn('[HDR Vision] ' + label + ' 管线编译失败，下次请求时重试');
    } else {
      console.warn('[HDR Vision] ' + label + ' 管线连续编译失败，本页不再尝试该路径');
    }
  }

  // 异步建一条路径的 SDR（+ HDR）管线；两条路径并行时互不干扰
  _buildPath(path) {
    // 幂等：重复调用返回同一个 promise，避免 auto 预取与 ready 各编译一遍
    if (this._buildPromises[path]) return this._buildPromises[path];
    if (this._built[path]) return Promise.resolve();
    if (this._disposed) return Promise.resolve();
    this._built[path] = true;
    const useExternal = path === 'external';
    const label = useExternal ? 'video/external' : 'video/copy';
    const jobs = [
      createPipelineCheckedAsync(this.device, this._pipelineDescriptor(useExternal, this._sdrFormat), label + '/sdr')
        .then((p) => { if (this._disposed) return; if (useExternal) this.pipelineSDRExt = p; else this.pipelineSDRCopy = p; }),
    ];
    if (HDR_DISPLAY_AVAILABLE) {
      jobs.push(
        createPipelineCheckedAsync(this.device, this._pipelineDescriptor(useExternal, 'rgba16float'), label + '/hdr')
          .then((p) => { if (this._disposed) return; if (useExternal) this.pipelineHDRExt = p; else this.pipelineHDRCopy = p; })
      );
    }
    const promise = Promise.all(jobs).then(() => {
      if (this._disposed) return;
      // SDR 是必需项；HDR 失败只影响 16float，由 getPipeline 返回 null 走回退
      const sdr = useExternal ? this.pipelineSDRExt : this.pipelineSDRCopy;
      if (sdr && !invalidPipelines.has(sdr)) return;
      this._markBuildFailed(path, label);
    }, (err) => {
      // 描述符构造等同步错误：同样按一次失败处理，不向上抛（ready 不该 reject）
      this._markBuildFailed(path, label);
      console.warn('[HDR Vision] ' + label + ' 管线异常:', err && err.message ? err.message : err);
    });
    this._buildPromises[path] = promise;
    return promise;
  }

  // P1-4：后台预取另一条取帧路径。auto 模式两条都可能用到，
  // 提前异步编译可避免首次遇到补齐帧时在主线程同步编译（_ensurePathSync）造成卡顿。
  preparePath(path) {
    if (this._disposed) return Promise.resolve();
    return this._buildPath(path);
  }

  // 另一条路径被临时需要（NijiLucid / 切取帧方式）时同步补建；属于低频路径，可接受一次卡顿
  _ensurePathSync(path) {
    if (this._disposed || this._built[path]) return;
    this._built[path] = true;
    const useExternal = path === 'external';
    const label = useExternal ? 'video/external' : 'video/copy';
    try {
      const sdr = createPipelineChecked(this.device, this._pipelineDescriptor(useExternal, this._sdrFormat), label + '/sdr');
      if (!sdr) {
        // 同步创建就是 null（校验失败/设备丢失），直接走重试额度
        this._buildPromises[path] = null;
        this._buildRetries[path] = (this._buildRetries[path] || 0) + 1;
        if (this._buildRetries[path] < 2) this._built[path] = false;
        return;
      }
      if (useExternal) this.pipelineSDRExt = sdr; else this.pipelineSDRCopy = sdr;
      if (HDR_DISPLAY_AVAILABLE) {
        const hdr = createPipelineChecked(this.device, this._pipelineDescriptor(useExternal, 'rgba16float'), label + '/hdr');
        if (useExternal) this.pipelineHDRExt = hdr; else this.pipelineHDRCopy = hdr;
      }
    } catch (e) {
      // 描述符 / 设备异常：回滚，允许下次再试
      this._built[path] = false;
      console.warn('[HDR Vision] ' + label + ' 管线补建异常:', e && e.message ? e.message : e);
    }
  }

  // ★ 校准探测：输出到离屏 rgba16float（与显示画布无关，始终可用）
  getProbePipeline(useExternal) {
    const key = useExternal ? '_probePipelineExt' : '_probePipelineCopy';
    if (this[key] !== undefined) {
      return (this[key] && !invalidPipelines.has(this[key])) ? this[key] : null;
    }
    try {
      const module = useExternal ? this.shaderModuleExternal : this.shaderModuleCopy;
      const layout = useExternal ? this.pipelineLayoutExternal : this.pipelineLayoutCopy;
      this[key] = createPipelineChecked(this.device, {
        layout,
        vertex: { module, entryPoint: 'vertexMain' },
        fragment: {
          module,
          entryPoint: 'fragmentMain',
          targets: [{ format: 'rgba16float' }],
        },
        primitive: { topology: 'triangle-list' },
      }, useExternal ? 'probe/external' : 'probe/copy');
    } catch (e) {
      console.warn('[HDR Vision] Probe pipeline creation failed:', e);
      this[key] = null;
    }
    return this[key];
  }

  getProbeTargets() {
    if (!this._probeTexture) {
      this._probeTexture = this.device.createTexture({
        size: [32, 32, 1],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      // 32 × 8 = 256 字节/行，满足 copyTextureToBuffer 的对齐要求
      this._probeReadback = this.device.createBuffer({
        size: 32 * 32 * 8,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    }
    return { texture: this._probeTexture, buffer: this._probeReadback };
  }

  // P2-2：读取管线时容忍「异步校验判失效」——重建一次，避免一次驱动抖动
  // 让这条路径到刷新为止都返回 null。重试有额度，不会每帧重编译。
  _getPathPipeline(useExternal, format) {
    const path = useExternal ? 'external' : 'copy';
    const read = () => (useExternal
      ? (format === 'rgba16float' ? this.pipelineHDRExt : this.pipelineSDRExt)
      : (format === 'rgba16float' ? this.pipelineHDRCopy : this.pipelineSDRCopy));
    this._ensurePathSync(path);
    let p = read();
    if (p && !invalidPipelines.has(p)) return p;
    if (!p || (this._buildRetries[path] || 0) >= 2) return null;

    // 建过但被异步校验判失效：清掉这个格式的坏管线，再补建一次
    this._buildPromises[path] = null;
    this._buildRetries[path] = (this._buildRetries[path] || 0) + 1;
    this._built[path] = false;
    if (useExternal) {
      if (format === 'rgba16float') this.pipelineHDRExt = null; else this.pipelineSDRExt = null;
    } else if (format === 'rgba16float') {
      this.pipelineHDRCopy = null;
    } else {
      this.pipelineSDRCopy = null;
    }
    this._ensurePathSync(path);
    p = read();
    return (p && !invalidPipelines.has(p)) ? p : null;
  }

  getExternalPipeline(format) {
    return this._getPathPipeline(true, format);
  }

  getCopyPipeline(format) {
    return this._getPathPipeline(false, format);
  }

  getExternalLayout() {
    return this.bindGroupLayoutExternal;
  }

  getCopyLayout() {
    return this.bindGroupLayoutCopy;
  }

  // ★ P1-3：探测串行化。_probeTexture / _probeReadback 是 shared 级单例，
  //   两个视频同时探测会互相覆盖纹理与回读缓冲。旧实现用 _probeBusy 直接丢弃后来者，
  //   导致页面里只有第一个视频能被校准；这里改成排队：后来者等前一个跑完再执行。
  withProbeLock(fn) {
    const run = (this._probeChain || Promise.resolve()).then(fn);
    // 一次失败不能阻断后续排队者
    this._probeChain = run.then(() => {}, () => {});
    return run;
  }

  // P1-4：shared 资源生命周期随 manager 结束
  destroy() {
    this._probeChain = Promise.resolve();   // 丢弃排队中的探测任务
    try { this.toneLut?.destroy(); } catch {}
    try { this._probeTexture?.destroy(); } catch {}
    try { this._probeReadback?.destroy(); } catch {}
    this._probeTexture = null;
    this._probeReadback = null;
    this._probePipelineExt = null;
    this._probePipelineCopy = null;
    this.pipelineSDRExt = null;
    this.pipelineHDRExt = null;
    this.pipelineSDRCopy = null;
    this.pipelineHDRCopy = null;
    this._built = { external: true, copy: true };  // 已销毁，禁止再补建
    this._disposed = true;
    this.shaderModuleExternal = null;
    this.shaderModuleCopy = null;
  }
}

// ============ 共享图片资源 ============
class SharedImageResources {
  constructor(device) {
    this.device = device;
    this.shaderModule = device.createShaderModule({ code: imageShaderCode });
    reportShaderErrors(this.shaderModule, 'image');
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.toneLut = new ToneLutManager(device, LUT_SIZE);
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this._sdrFormat = navigator.gpu.getPreferredCanvasFormat();
    this.pipelineSDR = null;
    this.pipelineHDR = null;
    // P2-3：与视频端对齐 —— destroy() 之后异步编译仍会落地，必须能拒收，
    // 否则已销毁的 shared 被 promise 链延长持有，还会往已析构的对象写管线。
    this._disposed = false;
    // P4-1：与视频端一致，图片管线也异步编译，避免首屏主线程被编译阻塞
    this.ready = this._buildPipelines();
  }

  _descriptor(format) {
    return {
      layout: this.pipelineLayout,
      vertex: { module: this.shaderModule, entryPoint: 'vertexMain' },
      fragment: {
        module: this.shaderModule,
        entryPoint: 'fragmentMain',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    };
  }

  async _buildPipelines() {
    const jobs = [
      createPipelineCheckedAsync(this.device, this._descriptor(this._sdrFormat), 'image/sdr')
        .then((p) => { if (this._disposed) return; this.pipelineSDR = p; }),
    ];
    if (HDR_DISPLAY_AVAILABLE) {
      jobs.push(
        createPipelineCheckedAsync(this.device, this._descriptor('rgba16float'), 'image/hdr')
          .then((p) => { if (this._disposed) return; this.pipelineHDR = p; })
      );
    }
    await Promise.all(jobs);
  }

  getPipeline(format) {
    const p = format === 'rgba16float' ? this.pipelineHDR : this.pipelineSDR;
    return (p && !invalidPipelines.has(p)) ? p : null;
  }

  destroy() {
    this._disposed = true;
    try { this.toneLut?.destroy(); } catch {}
    this.pipelineSDR = null;
    this.pipelineHDR = null;
    this.shaderModule = null;
    this.device = null;
  }
}

// ============ 视频渲染器 ============
