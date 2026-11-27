'use strict';
// HDR Vision — tone-lut.js（从 content-script.js 拆出，Phase 3 / P3-4）

class ToneLutManager {
  constructor(device, size) {
    this.device = device;
    this.size = size || LUT_SIZE;
    // V1.2.4：纹理 6 行（与 HdrToneMath.DUAL_ROWS 一致）
    this.rows = (typeof HdrToneMath !== 'undefined' && HdrToneMath.DUAL_ROWS) || 6;
    this.fingerprint = null;
    this.texture = device.createTexture({
      size: [this.size, this.rows, 1],
      format: 'r16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    // 纹理整个生命周期不变，view 只需建一次；external 路径每帧都要新建 bindGroup，
    // 复用 view 可避免每帧一次 GPU 对象分配。
    this.view = this.texture.createView();
    // 缓存上次指纹的输入：对象引用 + 目标值，参数未变时连字符串拼接都省掉
    this._lastBt = null;
    this._lastW = NaN;
    this._lastM = NaN;
  }

  update(bt) {
    if (typeof HdrToneMath === 'undefined') return false;
    const w = bt && bt.targetWhite;
    const m = bt && bt.targetMid;
    // 每帧热路径：settings 对象与两个目标值都没变，直接命中（external 路径每帧调用）
    if (this.fingerprint !== null && bt === this._lastBt &&
        w === this._lastW && m === this._lastM) return true;
    const fp = HdrToneMath.lutFingerprint(bt);
    if (fp === this.fingerprint) {
      this._lastBt = bt;
      this._lastW = w;
      this._lastM = m;
      return true;
    }
    const data = HdrToneMath.buildDualLut(bt, this.size);
    try {
      this.device.queue.writeTexture(
        { texture: this.texture },
        data,
        { bytesPerRow: this.size * 2, rowsPerImage: this.rows },
        { width: this.size, height: this.rows }
      );
      this.fingerprint = fp;
      this._lastBt = bt;
      this._lastW = w;
      this._lastM = m;
      return true;
    } catch (e) {
      console.warn('[HDR Vision] LUT 上传失败，回退 legacy 曲线:', e);
      this.fingerprint = null;
      this._lastBt = null;
      this._lastW = NaN;
      this._lastM = NaN;
      return false;
    }
  }

  // P1-4：shared 资源随重建/bfcache 一起释放，避免 device 仍存活时累积纹理。
  destroy() {
    try { this.texture?.destroy(); } catch {}
    this.texture = null;
    this.view = null;
    this.sampler = null;
    this.fingerprint = null;
    this._lastBt = null;
  }
}
