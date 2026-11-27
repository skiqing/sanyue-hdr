# 卅月 HDR

> Unleash Double HDR in Your Browser. / Perfect HDR, Awakened in Your Browser.

一个基于 **WebGPU** 的 Chrome 扩展，实时提升网页视频与图片的 HDR 观感。所有处理均在本地 GPU 完成，不上传任何数据。

[项目主页](https://skiqing.github.io/sanyue-hdr/) · [问题反馈](https://github.com/skiqing/sanyue-hdr/issues)

---

## 功能

- **实时 HDR 增强**：用 WebGPU 在 GPU 上逐帧做色调映射，支持 BT.2446a 与自定义幂函数两种曲线
- **双层合成**：把画面拆成低频 base 与高频 detail，压高光时不压平局部对比
- **HDR 源智能处理**：PQ / HLG HDR 视频可接管增强，也可原样跳过交给系统播放
- **去色带 / 锐化**：多尺度自适应 deband 与 CAS 锐化，二选一
- **取帧自适应**：常规源走 `importExternalTexture` 零拷贝；补齐帧自动切 2D 快照规避绿边
- **图片增强**：对网页中大尺寸图片应用相同效果
- **配置快照**：保存、导出、导入多套参数预设
- **诊断面板**：一键复制取帧路径、解码补齐、绿边检测、HDR 路径、页面计数、最近保存状态

## 技术原理

```
视频帧 → WebGPU external texture / 2D snapshot
       → 色调映射（BT.2446a 逆曲线 / 幂函数）
       → 双层合成（可选）
       → 高光上限 / 整体强度
       → 16float HDR 画布或 8bit 画布输出
```

关键实现：

- `src/content/shaders.js` — WGSL 着色器（视频、图片、双层三套）
- `src/content/tone-lut.js` — 色调映射 LUT 生成
- `src/shared/tone-math.js` — 与 shader 一致的目标白点/中调反解
- `src/content/renderers.js` — 渲染器与取帧路径求解

## 安装

### 从源码安装（开发版）

1. 克隆仓库：
   ```bash
   git clone https://github.com/skiqing/sanyue-hdr.git
   cd sanyue-hdr
   ```
2. 打开 Chrome，进入 `chrome://extensions`
3. 打开右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择本仓库根目录

**要求**：Chrome 116+（需要 WebGPU 支持）。

### 使用

- 点击工具栏图标打开弹窗，用顶部开关启用/禁用
- 用「应用推荐设置」一键配置，会先询问显示器峰值亮度与系统 SDR 亮度
- 高级设置里可精细调节曲线、白点、高光上限、双层、去色带等参数

## 开发

```bash
npm install       # 安装 eslint 等开发依赖
npm run check     # 完整检查：lint + 测试 + WGSL 编译 + shader parity + 双输出一致性
npm test          # 仅运行单元测试
npm run lint      # 仅运行 eslint
```

项目自带四类验证脚本（在 `tools/`）：

- `check-wgsl.js` — 真实编译 WGSL 着色器，捕获保留字等静默错误
- `check-shader-parity.js` — 用真实 WebGPU 对比视频/图片着色器输出一致性
- `check-dual-output.js` — 验证双层开关的高光亮度一致性
- `probe-knobs.js` — 实测整体强度与细节增益的真实作用

## 目录结构

```
├── manifest.json          # 扩展清单（MV3）
├── src/
│   ├── background/        # service worker：设置读写与迁移
│   ├── content/           # 内容脚本：着色器、渲染器、管理器
│   ├── popup/             # 弹窗 UI 与逻辑
│   └── shared/            # 设置 schema 与色调数学（两端共用）
├── _locales/              # 中英本地化
├── icons/                 # 16/32/48/128 PNG 图标
├── docs/                  # GitHub Pages 项目主页
├── tools/                 # 验证脚本与测试
└── LICENSE                # MIT
```

## 隐私

完全本地运行，不收集、不上传任何数据。详见 [隐私政策](https://skiqing.github.io/sanyue-hdr/privacy-policy.html)。

## 许可

[MIT](LICENSE) © 2026 卅月
