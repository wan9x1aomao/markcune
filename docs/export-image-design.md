# 导出为图片 · 设计文档

> 分支：`feature/export-image`（基于 `rebrand/markcune`，4.0.0）
> 状态：设计稿，**尚未实现**。本文只定方案，不含功能代码。
> 命令 id：`export-image`；界面标题：**导出为图片…**

---

## 0. 结论速览

| 问题 | 决定 |
|---|---|
| 导出什么 | v1 **整篇文档**；选区导出留到 v1.1（接口已预留，见 §1.1） |
| 产物 | **一张长图（PNG）**；超长时先降清晰度，再按块边界**分段**成多张 |
| 宽度 / 缩放 | 版心固定 **760 CSS px**，固定 **2 倍**输出 → 图片宽 **1520 px**；不跟随屏幕 DPR / 窗口缩放 |
| 主题 | v1 **只出浅色**（与网页 / Word / PDF 一致）；深色留到 v1.1 |
| 格式 | v1 **只做 PNG**；JPEG / WebP 不做（理由见 §1.5） |
| 入口 | macOS 原生菜单「文件」里接在“导出为 PDF…”之后；Windows/Linux 的「···」菜单同位置；命令面板；帮助面板自动收录；**不设快捷键** |
| 技术路线 | **自写**：复用 `renderDocument()` 生成完整文档 → 离屏量尺寸 → SVG `foreignObject` → `<img>` → `<canvas>` → `toBlob('image/png')`。**不引入任何新依赖** |
| 写盘 | 新增 Rust 命令 `export_image`：原生保存对话框 + 原始字节请求体 + PNG 校验 + `files::atomic_write`；非 Tauri 环境回退为浏览器下载 |
| 隐私 | 全程本地，不上传；唯一可能的网络请求是“文档里本来就引用的远程图片”的读取，与编辑器显示时相同 |
| CHANGELOG | **本次跳过**：4.0.0 段已有 5 条，再加一行会让 `tests/changelog.test.mjs` 失败（上限 5 条） |

---

## 1. v1 范围

### 1.1 整篇 vs 选区 —— v1 只做整篇

- 现有三种导出（网页 / Word / PDF）全部是整篇，入口、文案、测试都是一个模式；图片导出保持一致，用户心智最简单。
- 选区在三种视图下语义不同：富文本里是 ProseMirror 选区，源码模式里是 CodeMirror 文本区间，分屏时两边都有；要做对需要额外决定“源码选区如何映射到渲染结果”。v1 不背这个复杂度。
- **预留**：图片导出的核心函数签名接收一个 ProseMirror 节点（`buildImage(doc, options)`），与 `renderDocument(doc, …)` 相同。v1.1 做“将选区导出为图片…”时只需：
  ```js
  const slice = view.state.selection.content();
  const doc = view.state.schema.topNodeType.createAndFill(null, slice.content);
  ```
  再把 `doc` 交给同一函数即可，渲染、量尺寸、写盘全部复用。

### 1.2 长图

- 默认产出**一张**纵向长图，内容与“导出为网页”看到的页面一致（同一份 `documentCss()`）。
- 只有在超出画布上限时才降清晰度 / 分段（§4.6）。

### 1.3 导出宽度与缩放

- 版心：`documentCss()` 现在是 `max-width: 760px; padding: 56px 40px 80px`（`box-sizing: border-box`，正文宽 680 CSS px）。图片导出把 `max-width` 改为固定 `width: 760px`，其余一致。
- 缩放：**固定 2 倍**，图片宽 1520 px。
  - 不读 `devicePixelRatio`：同一篇文档在 Retina 屏和 1080p 屏导出的图片应完全相同，测试也才可重复。
  - 不受窗口缩放（⌘= / Ctrl+=，即 `window.set_zoom`）影响：我们按 CSS px 排版、按固定倍数光栅化。
  - 1520 px 宽在手机上（1080–1290 px 屏宽）会被等比缩小显示，文字依然清晰；在电脑上按 2x 看也是正常字号。
- v1 不提供宽度 / 倍数选项，不弹设置面板。

### 1.4 浅色 / 深色 —— v1 只出浅色

- 理由：
  1. 现有导出明确“always light, independent of the app theme”（`export.js` 注释），Mermaid 导出也固定 `'light'`，代码高亮导出用的是浅色 `tok-*` 调色。
  2. `documentCss()` 里写死了约 30 处颜色；做深色需要把它参数化成调色板，同时给 `tokenCss()` 传深色 `PALETTES.dark`、Mermaid 传 `'dark'`。这是独立的一块工作，且会碰现有 HTML/PDF 导出的样式，风险应单独评估。
  3. 透明底 PNG / 黑色线稿图片放到深色底上会“消失”，需要额外处理（如给图片垫白底），属于深色专属的问题。
- v1.1 计划：`documentCss(scope, palette = 'light')`，`tokenCss` 已支持传入作用域，`code-theme.js` 已有 `PALETTES.dark`，命令拆成“导出为图片（浅色）/（深色）”或跟随当前主题——届时再定。

### 1.5 格式：只做 PNG

| 格式 | 决定 | 理由 |
|---|---|---|
| PNG | **做** | 无损，文字边缘锐利；三端 WebView 的 `canvas.toBlob('image/png')` 均可用；纯文字长图压缩率本来就好（大面积纯白） |
| JPEG | 不做 | 文字边缘有振铃 / 色块；对“文档截图”这种以文字为主的内容观感明显变差。唯一优势是含大量照片时体积小，可在 v1.x 视反馈再加 |
| WebP | 不做 | **WKWebView（macOS）的 `toBlob('image/webp')` 不编码 WebP，会静默退回 PNG**；为一个平台不支持的格式做开关会让“三端一致”失效。若将来要做，需要在 Rust 侧编码（新增 crate，体积与许可证另评） |

输出为**不透明**白底 PNG（先 `fillRect` 白色再绘制），避免在聊天软件深色背景下出现透明区域。

### 1.6 明确不做（v1）

- 不加水印、页眉页脚或“由 MarkCune 导出”字样（用户内容不夹带品牌）。
- 不写 PNG `pHYs`（DPI）块、不写 EXIF/元数据。
- 不复制到剪贴板（“复制为图片”可作为后续命令，复用同一渲染结果）。
- 不做分页（A4 分页请用“导出为 PDF”）。

---

## 2. 入口与接线

与现有导出的接线方式保持一致：命令注册在 `src/commands.js`，动作在 `src/main.js` 的 `actions`，macOS 原生菜单发 `menu` 事件回页面，Windows/Linux 走页面里的「···」菜单与命令面板。

### 2.1 命令定义（`src/commands.js`，「导出」组）

```js
{ id: 'export-image', group: '导出', title: '导出为图片…', keywords: '导出 图片 长图 png 截图 分享 image picture screenshot export' },
```

- 放在 `export-pdf` 之后。
- `group` 与 `keywords` 必填（浏览器测试“每条命令都有分组和搜索关键词”会查）。
- 不放进 `COMMON_COMMANDS`（`src/discovery.js`）：常用组刻意只有 8 条，导出类已有 `export-word` 代表；图片导出靠搜索“图片 / png / 长图”即可找到。
- 帮助面板（`helpGroups()`）按 `group` 自动收录到「导出」组，无需改 `help.js`。

### 2.2 原生菜单（`src-tauri/src/main.rs::build_menu`，仅 macOS）

在「文件」子菜单的导出组里，紧接 `export-pdf`：

```rust
&item("export-html", "导出为网页…", None)?,
&item("export-word", "导出为 Word…", None)?,
&item("export-pdf", "导出为 PDF…", None)?,
&item("export-image", "导出为图片…", None)?,
```

`handle_menu` 的默认分支已经把未知 id 以 `menu` 事件发给聚焦窗口，`main.js` 里 `api.on('menu', run)` 接住，**无需改 `handle_menu`**。`native_action` 白名单也不需要改（它只放行窗口级动作）。

### 2.3 「···」菜单（`src/main.js::showMore`，Windows/Linux 的主要入口，macOS 也显示）

```js
item('export-html'),
item('export-word'),
item('export-pdf'),
item('export-image'),
```

### 2.4 动作（`src/main.js::actions`）

```js
'export-image': exportImage,
```

### 2.5 快捷键 —— 不设

- 现有三种导出都没有快捷键，图片导出保持一致；导出是低频操作，命令面板（⌘K / Ctrl+K）一步可达。
- 冲突检查记录（供以后需要时参考）：
  - 应用已占用：`Mod+N/O/Shift+O/P/S/Shift+S/W/F/G/Shift+G/B/I/E/K/,/=/-/0//`、`Mod+Alt+F/X/L//`、`Ctrl+H`、`Mod+Shift+L/T/D`、`F1/F8/F11`（`commands.js` + `shortcuts.js` 的 `EXTRA`）。
  - 编辑器内部（Milkdown / CodeMirror）：`Mod-Alt-0…8`、`Mod-Alt-c/g/x`、`Mod-Shift-b/h/l/m/u/z/k` 等。
  - 若将来要设，`Mod+Shift+E` 在以上范围内未被占用、macOS 也非系统保留，是候选；但 `Mod+E` 已是“行内代码”，相邻键容易误触，故 v1 不设。

### 2.6 保存对话框

- 默认文件名：`${exportTitle()}.png`（`exportTitle()` 现有逻辑：已保存文档取主文件名，未保存为 `未命名`）。
- 默认目录：与 `export_html` / `export_docx` 相同——文档所在目录，否则当前打开的文件夹。
- 扩展名过滤：`add_filter("PNG 图片", &["png"])`。
- 用户输入的名字**没有 `.png` 后缀**时（Linux GTK 对话框不会自动补后缀），Rust 侧补上 `.png`；补完后若该文件已存在，弹原生确认“已存在同名图片，要替换吗？”（因为对话框的覆盖确认只针对用户输入的原名）。
- 分段导出（§4.6）时写为同目录下的 `名称-1.png … 名称-N.png`；写之前若其中任一已存在，弹一次原生确认“将替换已有的 N 张同名图片”。

---

## 3. 技术方案与取舍

### 3.1 候选方案

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. html-to-image / dom-to-image(-more) / modern-screenshot** | 克隆 DOM，逐节点内联 `getComputedStyle`，抓取字体 / 图片转 data URL，再走 SVG `foreignObject` → canvas | 现成；处理任意 DOM | ① 它们的核心价值是“把任意页面的计算样式内联”，而我们导出的内容本来就是**自己生成、样式完全受控**的 `.mdpad-export`，这部分用不上；② 逐节点 `getComputedStyle` 在长文档（数万节点）上很慢；③ 它们用 `fetch()` 抓资源，而应用 CSP 的 `connect-src` 只放行 `'self' ipc: http://ipc.localhost`，`asset:` / `http://asset.localhost` / `https:` 都会被拦，等于还得自己预处理；④ 新增依赖（MIT，压缩后约 10–40 KB，体积可接受，但收益小） |
| **A'. html2canvas** | 用 JS 重新实现 CSS 排版并画到 canvas | 不依赖 `foreignObject` | 约 200 KB（min）；自己实现的排版对 CJK 断行、KaTeX、内联 SVG、`border-radius + overflow` 等还原度差；MIT。**否决** |
| **B. 自写 DOM → SVG foreignObject → canvas（推荐）** | 复用 `renderDocument()` 得到完整文档 → 序列化成 XHTML 放进 `<svg><foreignObject>`，样式用 `documentCss()` + `katexCss()`（字体已内联）→ data URL 交给 `<img>` → 画到 `<canvas>` → `toBlob` | 不加依赖；与网页 / PDF 导出**同一份渲染**，所见一致；内容由文档模型生成，**与编辑器 DOM、懒渲染、CodeMirror 挂载状态完全无关**；约 200–300 行 | 需要自己处理：资源全部内联（SVG 作为图片时不能加载外部资源）、字体加载时机、画布上限；`foreignObject` 在 WebKit 上有已知怪癖（§3.3） |
| **C. WebView 原生截图** | macOS `WKWebView.takeSnapshot(with:)`；Windows WebView2 `CapturePreview` / DevTools `Page.captureScreenshot`；Linux `webkit_web_view_get_snapshot` | 像素与屏幕完全一致 | Tauri 2 / wry **没有跨平台截图 API**，要通过 `with_webview` 写三套平台代码（objc2 / webview2-com / webkit2gtk）；能力不一致：WKWebView 的 `takeSnapshot` 只可靠地截**可见区域**（全文需滚动拼接或临时放大 WebView），WebView2 的 `CapturePreview` 也只截视口（全页要走 `CallDevToolsProtocolMethod` + `captureBeyondViewport`），只有 WebKitGTK 的 `WEBKIT_SNAPSHOT_REGION_FULL_DOCUMENT` 原生支持整页；截的是**编辑器界面**而非导出版式，要么另开隐藏窗口加载导出 HTML，要么动编辑器状态；三套实现三套测试矩阵。**否决**，仅作 §3.3 的兜底预案 |

### 3.2 推荐：方案 B，流水线

```
exportDocument()                      // main.js 现有：取富文本 / 分屏预览的 ProseMirror doc（只读快照）
  └─ renderDocument(doc, {image, diagram})   // export.js 现有：完整渲染（代码高亮、KaTeX、Mermaid、图片）
       image:   resolveImage → embedImage   // 本地图 → data: URL（Rust image_data_url）
       diagram: renderMermaid(code, 'light', { htmlLabels: false })
  └─ inlineRemoteImages / downscaleImages    // export-image.js 新：远程图转 data URL 或占位；大图预缩放
  └─ measure()                               // 离屏 Shadow DOM 容器里排版，量总高与各顶层块的上下边
  └─ planImage(layout, limits)               // image-plan.js 新（纯函数）：定倍数与分段
  └─ rasterize(segment)                      // SVG foreignObject → <img>.decode() → canvas → toBlob('image/png')
  └─ api.exportImage(bytes, name, parts)     // bridge.js 新 → Rust export_image（对话框 + 校验 + 原子写）
```

要点：

1. **不碰编辑器 DOM。** 代码块高亮由 `highlight()` 直接用 lezer 解析文档文本生成，与 Milkdown 的 CodeMirror 懒挂载 / 占位块（`lazy.js`、3.5.6 修过的等高占位）无关；200 块以上大文档的虚拟渲染也不影响导出。**不调用** `editor.renderAll(true)`。
2. **同一份版式。** 图片看起来就是“导出为网页”在 760px 宽下的样子，差别只在 §4.8 的少量“图片专用规则”。
3. **SVG 以目标像素尺寸声明。** `<svg width="W×s" height="H×s" viewBox="0 y W h">`，让引擎按矢量直接栅格化到 2x，而不是先 1x 再 `drawImage` 放大（会糊）。分段时只改 `viewBox` 的 `y` / `h`，同一份 SVG 文本复用。
4. **序列化。** `new XMLSerializer().serializeToString(wrapper)`，`wrapper` 是 `xmlns="http://www.w3.org/1999/xhtml"` 的 `<div>`，内含 `<style>`（`documentCss()` + 图片专用规则 + `katexCss()`）和 `<article class="mdpad-export">`。SVG 文本用 `data:image/svg+xml;charset=utf-8,` + `encodeURIComponent` 交给 `<img>`（WebKit 对 `blob:` SVG 的 `foreignObject` 偶有 taint 问题，data URL 最稳；CSP `img-src` 已放行 `data:` 与 `blob:`）。
5. **新文件**：`src/export-image.js`（DOM 相关，动态 `import()` 懒加载，与 `export.js` / `docx.js` 一样不进首屏包）和 `src/image-plan.js`（零依赖纯函数，Node 可直接单测）。

### 3.3 三端 WebView 差异与风险

| 项 | WKWebView（macOS 13+） | WebView2（Windows，Chromium） | WebKitGTK（Linux 4.1 / 麒麟） | 对策 |
|---|---|---|---|---|
| SVG `foreignObject` 画到 canvas 不 taint（data URL） | 可（需实测确认） | 可 | 可（需实测确认） | §7 浏览器测试只覆盖 Chromium；WebKit 两端列入手动清单；若 taint，`toBlob` 抛 `SecurityError`，按 §6 提示 |
| `foreignObject` 内 `<img>`（data URL）首帧未解码 → 图片空白 | **已知会发生** | 少见 | 可能 | 先在主文档里对所有 data URL `new Image().decode()` 预热；`<img>.onload` 后再 `await img.decode()`，再等两帧（`requestAnimationFrame`×2）后绘制；绘制后抽样检查图片区域非白，若空白则**重画一次** |
| `foreignObject` 内 `@font-face`（data URL）加载时机 | 可能首帧用回退字体 | 一般已就绪 | 可能 | 同上“预热 + 两帧 + 必要时重画”；KaTeX 字体同时用 `FontFace` 在主文档注册（`document.fonts.load`）以预热解码 |
| 嵌套 `foreignObject`（Mermaid `htmlLabels`） | 不可靠 | 可 | 不可靠 | 图片导出时以 `htmlLabels: false` 渲染 Mermaid（纯 SVG `<text>`）；失败再退回默认配置 |
| 系统字体在 SVG 图片里可用 | 可 | 可 | 可 | 无需内联系统字体（§4.7） |
| `toBlob('image/png')` | 可 | 可 | 可 | — |
| 画布上限 | 见 §4.6 | 见 §4.6 | 见 §4.6 | 运行时探测 + 降级 |

**兜底预案（不在 v1 实施）**：若某端 WebKit 实测 `foreignObject` 方案不可用，只为该平台补方案 C 的“隐藏窗口加载 `buildHtml()` 结果 + 原生整页截图”（Linux 有 `FULL_DOCUMENT` 最容易；macOS 可用 `createPDF` 后栅格化或分屏拼接）。触发条件与决策写入实现 PR。

### 3.4 依赖、体积与许可证

- **不新增 npm 依赖，不新增 Rust crate。** 用到的都已在仓库：`katex`（MIT）、`mermaid`（MIT）、`@lezer/highlight` / `@codemirror/*`（MIT）、`base64`（MIT/Apache-2.0，Rust 侧已有，用于本地图片转 data URL）。
- 新增前端代码估计约 300 行（`export-image.js` + `image-plan.js`），懒加载；Rust 侧约 80 行。

---

## 4. 特殊内容处理

### 4.1 KaTeX

- `renderDocument()` 已用 `katex.renderToString(..., { output: 'html' })` 渲染行内 / 块级公式，并返回 `math: true`。
- 字体：复用 `export.js` 里现成的 `katexCss()`——遍历样式表，把 KaTeX 的 woff2 `@font-face` 读成 data URL 内联，并带上 `.katex` 规则。实现时把它从模块私有函数改为 `export`。
- KaTeX 样式表来自 Crepe 的 `theme/common/latex.css`（`@import 'katex/dist/katex.min.css'`，经 `editor.js` 引入），应用和 `__lab.html` 都会加载，`katexCss()` 能拿到。
- 预热：内联字体之外，再用 `FontFace` 在主文档 `document.fonts.add()` 并 `load()` 一次，减少 SVG 图片里首帧缺字形。
- 过宽的块级公式（超过 680px 正文宽）：见 §4.8，按比例缩小字号以完整显示，不裁切。

### 4.2 Mermaid

- 走现有 `diagram` 回调：`renderMermaid(code, 'light')` 返回 SVG 字符串，`renderDocument()` 放进 `<figure class="diagram">`；渲染失败时自动退回为代码块原文（现有逻辑）。
- 图片导出专用：`renderMermaid(code, 'light', { htmlLabels: false })`，避免嵌套 `foreignObject`。`diagram.js` 里 `current` 缓存键要从“主题”扩展为“主题 + htmlLabels”，否则编辑器预览与导出交替时配置会串。
- Mermaid 的 SVG 自带 `<style>`，选择器以唯一 `#mdpad-diagram-N` 为前缀，不会与文档样式冲突；`securityLevel: 'strict'` 保持不变。
- `XMLSerializer` 会把通过 `innerHTML` 解析的 SVG 输出为合法 XML（命名空间、自闭合），无需额外处理。

### 4.3 代码高亮（CodeMirror 懒挂载 / 占位块）

- **不依赖编辑器里已挂载的 CodeMirror。** `export.js::highlight()` 根据围栏语言用 `LanguageDescription.load()` 拿解析器，`highlightCode()` 产出带 `tok-*` 类的 span，颜色来自 `tokenCss()`（与编辑器同一调色板 `code-theme.js`）。因此无论代码块是否在视口内、是否是等高占位块、是否已被 5 秒后卸载，导出内容都完整。
- 语言包是打包进应用的 chunk，离线可用；未知语言按纯文本转义输出。
- 长行：网页导出用 `overflow-x: auto`，图片里滚动条无意义且会裁切；图片专用规则改为 `white-space: pre-wrap; word-break: break-all`（与打印规则一致）。

### 4.4 本地图片

- 解析链路与 HTML / Word 导出完全相同：`resolveImage(src)`（相对路径按文档目录解析 → Rust `allow_image` 校验真是图片并加入 asset 作用域 → `convertFileSrc` 得到 `asset://localhost/…` 或 `http://asset.localhost/…`）→ `embedImage(url)`（Rust `image_data_url`，≤ 50 MB，读成 `data:` URL）。
- **为什么必须转 data URL**：SVG 作为 `<img>` 渲染时**不加载任何外部资源**（包括 `asset:` 协议），不转就是空白；另外即使能加载，跨源资源画进 canvas 也会 taint 导致 `toBlob` 抛 `SecurityError`。data URL 同源，不 taint。
- 已经是 `data:` 的图片（未命名文档里粘贴的图片）直接使用。
- 未保存文档里的相对路径、`allow_image` 拒绝（不是图片 / 不存在）、WebView 不能解码的格式（如 Windows 上的 HEIC / TIFF）→ 占位框（§4.5 同款），计入“失败图片数”。
- **大图预缩放**：每张光栅图解码后若 `naturalWidth > 680 × 倍数`（2x 时 1360 px），先画到临时 canvas 缩到该宽度再转 data URL（PNG 源 → PNG，JPEG 源 → `image/jpeg` 0.92），避免把几十 MB 的原图塞进 SVG 拖慢 / 撑爆内存。SVG 图片保持矢量不缩。临时 canvas 只处理同源 data URL，不会 taint。

### 4.5 远程图片

- 现状：CSP 的 `img-src` 放行 `https:`，编辑器能显示远程图；但 `connect-src` 不放行 `https:`，页面里 `fetch()` 远程图会被 CSP 拦截。
- v1 做法（不新增网络能力）：
  1. 新建 `Image`，设 `crossOrigin = 'anonymous'` 后加载原 URL，**单张 8 秒超时**；
  2. 加载成功且服务器带 CORS 头 → 画到临时 canvas → `toDataURL()` 得到 data URL（顺带完成大图预缩放）；
  3. 失败（离线、404、超时、无 CORS 头导致 `SecurityError`）→ 替换为占位框：
     `<div class="image-missing">图片无法导出：{alt 或文件名}</div>`（浅灰虚线框，保持段落结构）。
  4. 所有远程图并行加载，整体不超过 15 秒；超时的一律占位，导出继续。
- 结果里汇总失败数，成功提示后追加说明（§6）。
- 不做：v1 不在 Rust 侧代为下载远程图片（那会给页面开一个“让外壳请求任意 URL”的能力，需要单独评估 SSRF / 体积上限 / 超时）。若反馈里无 CORS 的图床很多，v1.1 再加 `remote_image_data_url(url)`（仅 https、`Content-Type: image/*`、≤ 20 MB、10 秒超时），复用 `fetch.rs` 的 reqwest 客户端。
- “仅本地处理、不上传”：上述加载只是读取文档本身引用的图片（与编辑器显示同一请求），不发送文档内容，也不把生成的图片发往任何地方。

### 4.6 超长文档与画布尺寸 / 面积上限

**各引擎上限（公开资料 + 经验值，实现时以运行时探测为准）**

| 引擎 | 单边上限 | 面积上限 | 备注 |
|---|---|---|---|
| Chromium / WebView2 | 32,767 px | 268,435,456 px²（16384²） | 超限时 `toBlob` 回调 `null` 或画布静默失效 |
| WebKit（macOS WKWebView） | 约 32,767 px（取决于版本） | 268,435,456 px²（桌面） | 超限时 canvas 变“不可用”，`getContext` 仍返回对象但绘制无效 |
| WebKitGTK | 受 cairo 图像表面限制，单边 32,767 px | 视内存 | 老版本（麒麟等）更保守 |

**MarkCune 自定上限（保守，留余量，同时控制内存）**

- `MAX_SIDE = 32000` 设备像素；`MAX_AREA = 64_000_000` px²（约 256 MB RGBA）；
- `MIN_SCALE = 1`；`MAX_PARTS = 10`。

**规划（`image-plan.js::planImage`，纯函数）**

输入：`{ width: 760, height, blocks: [{ top, bottom }] }`（CSS px，来自离屏测量）与上限。

1. `scale = min(2, MAX_SIDE / height, sqrt(MAX_AREA / (width × height)))`；若 `scale ≥ MIN_SCALE` → 单张，`scale` 取到 0.25 的整倍数向下取整（1.75、1.5…，避免奇怪倍数），`scale < 2` 时标记 `reduced: true`。
2. 否则 `scale = MIN_SCALE` 分段：每段高度上限 `MAX_SIDE / scale` CSS px，从上往下贪心装入顶层块，**只在顶层块之间切**（段首段尾留出原有的块间距，不切开段落 / 表格 / 代码块）。
3. 单个顶层块本身就高于一段上限（超长代码块 / 超长表格 / 超高图片）→ 该块独占一段，并在块内按 `MAX_SIDE / scale` 硬切（这是唯一会切开内容的情况，切线处画 1px 浅灰虚线提示续接）。
4. 段数 > `MAX_PARTS` → 返回 `{ tooLong: true }`，不导出，提示改用 PDF。
5. 输出：`{ scale, reduced, parts: [{ y, height }], tooLong }`。

**运行时探测**：真正分配画布前，对目标尺寸做一次探测（创建 canvas → 在右下角 `fillRect(1×1)` → `getImageData` 读回 alpha）。探测失败 → 用更小的上限（`MAX_SIDE` 减半）重新 `planImage`，最多重试 2 次；仍失败按“画布失败”提示。这比硬编码各引擎数字可靠（同一引擎不同版本、不同内存状态都不一样）。

**量级参考**：760px 版心、16px 正文，每 1000 CSS px 约 900–1100 个汉字。2x 单张上限 16,000 CSS px ≈ 1.6 万字；1x 单张 32,000 CSS px ≈ 3 万字；10 段约 30 万字。

### 4.7 字体

- **系统字体不内联**：`documentCss()` 已经给出跨平台回退链 `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif`，代码字体 `'SF Mono', ui-monospace, Menlo, Consolas, 'Cascadia Mono', monospace`。SVG 作为图片渲染时可以使用本机已安装的系统字体（被禁止的只是**外部资源加载**），而且系统中文字体动辄 10–50 MB，内联不现实，许可证也不允许随文件分发。
- **Web 字体必须内联**：目前只有 KaTeX 字体（§4.1）。应用样式 `style.css` 没有自定义 `@font-face`，无需处理。
- **Linux 缺中文字体**时会显示方块，这与编辑器本身表现一致，列入手动检查清单（建议安装 `fonts-noto-cjk`），不在导出层兜底。
- 测量和栅格化使用同一引擎、同一字体回退链，因此量出的高度与画出的结果一致。

### 4.8 图片专用样式规则（`imageRules(scope)`，与 `printRules` 并列放在 `export.js`）

- `.mdpad-export { width: 760px; max-width: none; margin: 0; }`
- `figure.code pre { white-space: pre-wrap; word-break: break-all; overflow: visible; }`
- `th, td { overflow-wrap: anywhere; }`，`table { overflow: visible; }`（圆角保留，内容不裁）
- `.math-block`、`figure.diagram`：测量阶段若 `scrollWidth > clientWidth`，给该元素加内联 `font-size`（公式）或 `width`（流程图 SVG）按比例缩到正好放下，最小缩到 60%；再小就保留裁切（极端情况，接受）。
- `.image-missing { … }` 占位框样式。
- 链接下划线保留（图片里不可点，但能看出是链接）。

### 4.9 离屏渲染容器（不影响编辑器状态）

- 数据来源是 `view.state.doc` —— 不可变快照，不 dispatch 任何事务，不改选区、滚动位置、撤销栈、懒渲染窗口。
- 测量容器：`document.body` 下临时插入一个宿主 `<div>`，样式 `position: fixed; left: -100000px; top: 0; width: 760px; visibility: hidden; pointer-events: none; contain: layout style paint;`，`aria-hidden="true"`，内部挂 **Shadow DOM**（`all: initial` 重置继承），只放 `<style>`（与 SVG 里完全相同的 CSS 文本）+ `<article>`。
  - 用 Shadow DOM 而非直接放进页面：隔离 `style.css` 的全局规则，保证“量到的”和“SVG 里画出来的”是同一套样式。
  - 用 Shadow DOM 而非 `srcdoc` iframe：不必等 iframe 加载，也避开 srcdoc 继承应用 CSP 带来的平台差异；iframe 作为备选（PDF 浏览器测试里已有同类用法）。
- 测量前：`await document.fonts.ready`，所有 `<img>` `decode()` 完成。
- 测量内容：`article.getBoundingClientRect().height`（向上取整）以及每个顶层子元素的 `top / bottom`（含外边距折叠后的位置）。
- **`finally` 中移除宿主元素**，异常路径也不残留（浏览器测试会检查）。
- `exportDocument()` 在纯源码模式下会切回富文本（现有导出同样如此），这是已有行为，不额外改变。
- 重入：导出进行中再次触发时直接提示“正在导出图片，请稍候”，不并发。

---

## 5. 保存与写文件

### 5.1 新增 Rust 命令 `export_image`（`src-tauri/src/main.rs`，与 `export_html` / `export_docx` 并列）

**为什么不复用现有命令**：`export_docx` 的过滤器写死为“Word 文档 / docx”，`export_html` 走字符串参数（不适合二进制）；`save_image` 只能写进文档旁的 `assets/`。三者都不满足“PNG 过滤 + 多段写出 + PNG 校验”。新增一个命令，形状照搬 `export_docx`：

```text
invoke('export_image', <Uint8Array 原始请求体>, { headers: {
  'x-file-name': encodeURIComponent('笔记.png'),
  'x-parts': 'N',            // 段数，1 表示单张
}})
→ Result<u32, String>        // 实际写出的文件数；0 = 用户取消
```

- **请求体**：N 张 PNG 首尾相接。PNG 本身自带边界（签名 + chunk 序列直到 `IEND`），Rust 侧按 chunk 结构切开，**一次 IPC、一次对话框、无需跨调用保存状态**。
- **校验**：每段必须以 PNG 签名 `89 50 4E 47 0D 0A 1A 0A` 开头、首 chunk 为 `IHDR`、以 `IEND` 结束，段数等于 `x-parts`；总大小 ≤ 512 MB。任何不符 → `Err("图片数据无效")`。这样页面经此命令**只能写 PNG**。
- **路径权限范围**：写入目标**只来自原生保存对话框**（`blocking_save_file`），页面不能指定路径；分段时只写所选文件同目录下的 `{stem}-{i}.png`。不新增 Tauri 插件，不动 `capabilities/default.json`，不扩大 `assetProtocol.scope`（应用自身命令与 `export_docx` 一样不受 capability 限制）。
- **写盘**：每个文件用 `files::atomic_write`（临时文件 + rename，失败时退回直写），错误文案沿用 `files::describe`（“没有访问权限”“磁盘空间不足”“磁盘是只读的”……）。
- **默认目录**：与 `export_docx` 相同（`with_win` 取文档目录或根目录）。
- **扩展名与覆盖**：见 §2.6；确认框复用 `confirm` 命令同款 `MessageDialogButtons::OkCancelCustom("替换", "取消")`。
- **纯函数放 `files.rs` 便于 `cargo test`**：`split_pngs(&[u8], expected) -> Result<Vec<&[u8]>, String>`、`png_target(PathBuf) -> PathBuf`（补后缀）、`part_paths(&Path, n) -> Vec<PathBuf>`。
- 注册：`generate_handler![…, export_docx, export_image, …]`。
- 内部标识不变：临时文件后缀仍是 `.mdpad-tmp`（`atomic_write` 现有行为，属 `docs/rebrand-markcune.md` 第 4 节例外）。

### 5.2 前端桥接（`src/bridge.js`）

```js
exportImage: (bytes, name, parts) =>
  invoke('export_image', bytes, { headers: { 'x-file-name': encodeURIComponent(name), 'x-parts': String(parts) } }),
```

### 5.3 Web / lab 环境回退：浏览器下载

- 判断：`isTauri()`（`@tauri-apps/api/core` 导出；真实应用里 Tauri 注入 `window.isTauri = true`，`__lab.html` 的假壳不设）。
- 非 Tauri：逐段 `URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))` + `<a download="笔记.png">` 点击，随后 `revokeObjectURL`；多段时名字为 `笔记-1.png …`。提示“已下载图片”。
- 这条路径让 `npm run dev:web` / `__lab.html` 下也能手动验证效果，同时给浏览器测试一个不经对话框的出口。

### 5.4 `main.js` 里的 `exportImage()`（形状与 `exportWord()` 一致）

```js
async function buildExportImage(options) { /* exportDocument → buildImage(doc, {...image/diagram 回调与 buildExportHtml 相同}) */ }

async function exportImage() {
  if (exportingImage) return toast('正在导出图片，请稍候');
  // 1. 空文档 → 提示并返回
  // 2. toast('正在生成图片…', 60000)
  // 3. build：失败 → toast(`导出失败：${message}`)
  // 4. 写盘：0 → 静默（与其他导出一致，取消不提示）；n → 成功文案（§6）
}
```

- 测试钩子：`window.__mdpadExport` 增加 `image: buildExportImage`（键名沿用 `__mdpadExport`，属第 4 节例外，不改名）。

---

## 6. 失败情况与提示文案

所有提示走现有 `toast()`；错误统一沿用“`导出失败：…`”前缀，与网页 / Word 导出一致。

| 情况 | 判定 | 文案 | 行为 |
|---|---|---|---|
| 生成中 | 开始渲染 | `正在生成图片…` | 长时间 toast，结束时被结果覆盖 |
| 重复触发 | 上一次未结束 | `正在导出图片，请稍候` | 忽略本次 |
| 空文档 | 无文字、无图片 / 分割线 / 表格 / 公式 / 代码块 | `文档是空的，没有可导出的内容` | 不弹对话框 |
| 成功（单张 2x） | — | `已导出为图片` | — |
| 成功但降了清晰度 | `reduced` | `已导出为图片（文档较长，已按 1.5 倍清晰度输出）` | 倍数按实际值 |
| 成功并分段 | `parts > 1` | `已导出为 3 张图片（文档较长，已按段落分开）` | — |
| 太长无法导出 | `tooLong` | `文档太长，无法导出为图片，请改用“导出为 PDF”` | 不弹对话框 |
| 部分图片失败 | 失败数 n > 0 | 成功文案后追加：`，有 n 张图片无法载入，已用占位框代替` | 照常导出 |
| 画布分配失败 / `toBlob` 返回空 | 探测重试后仍失败 | `导出失败：图片过大或内存不足，请改用“导出为 PDF”` | — |
| 画布被污染 | `SecurityError` | `导出失败：有图片无法嵌入，请检查文档中的网络图片` | 正常不应出现（所有资源都已转 data URL），出现说明有遗漏，属 bug |
| 渲染异常 | 其他异常 | `导出失败：{错误信息}` | — |
| 写盘失败 | Rust `Err` | `导出失败：没有访问权限` / `导出失败：磁盘空间不足` / `导出失败：图片数据无效` 等 | 文案来自 `files::describe` |
| 用户取消 | 对话框取消或覆盖确认点“取消”，返回 0 | **不提示** | 与现有导出一致 |
| 非 Tauri 下载 | — | `已下载图片` / `已下载 3 张图片` | — |

Mermaid 单图渲染失败时按现有逻辑退回显示代码原文，不单独提示。

---

## 7. 验证计划

基线：`npm test` 通过；`NODE_OPTIONS=--experimental-websocket npm run test:browser` 191/191 通过（本机 Node 20 需要该参数）。实现完成后两者都必须仍然全绿，浏览器用例数相应增加。

### 7.1 单元测试：`tests/export-image.test.mjs`（新建，接入 `npm test`）

风格同 `tests/changelog.test.mjs`：`node:assert/strict`，无框架，最后打印一行 `export-image ok（…）`。

1. **规划（`src/image-plan.js`，零依赖，Node 直接 import）**
   - 短文档（高 3000）→ `scale 2`、1 段、`reduced false`；
   - 中长（高 20000）→ 单张，`scale` 为 1.5（向 0.25 取整）、`reduced true`；
   - 超长（高 100000，块均匀）→ `scale 1`、多段，每段 `height × scale ≤ MAX_SIDE`，切点都落在块边界；
   - 单块超高 → 该块独占并被硬切，其余段仍在块边界；
   - 超过 `MAX_PARTS` → `tooLong`；
   - 自定义 `limits`（如 `maxSide: 4000`）生效——浏览器测试靠它避免分配巨型画布。
2. **PNG 工具**（`image-plan.js` 里的 `pngInfo(bytes)`：签名 + IHDR 宽高）：合法 PNG 读出宽高；截断 / 非 PNG 返回 `null`。
3. **接线静态检查**（读源码文本，类似 `rebrand.test.mjs`；注意 Node 20 没有全局 `navigator`，**不要直接 import `commands.js`**，用正则读文本，或先 `globalThis.navigator = { userAgent: '' }` 再动态 import）：
   - `commands.js` 有 `id: 'export-image'`、`group: '导出'`，关键词含 `图片`、`png`、`长图`，且位于 `export-pdf` 之后；
   - `main.rs` 的 `build_menu` 中 `item("export-image", "导出为图片…", None)` 紧跟 `export-pdf`；`generate_handler!` 含 `export_image`；
   - `main.js` 的 `actions` 有 `'export-image'`，`showMore` 里 `item('export-image')` 紧跟 `item('export-pdf')`；
   - `bridge.js` 有 `exportImage` 且调用 `'export_image'`；
   - 新增文件中不含 `MDPad` 字样（品牌只用 MarkCune）。
4. `package.json` 的 `test` 脚本末尾追加 `&& node tests/export-image.test.mjs`。

### 7.2 Rust 单元测试（`files.rs` 的 `#[cfg(test)]`，`cargo test`）

- `split_pngs`：两张最小 PNG 拼接 → 切成 2 段；段数与声明不符 / 缺 `IEND` / 签名错误 → `Err`；
- `png_target`：`a` → `a.png`，`a.PNG` 不变，`a.jpg` → `a.jpg.png`；
- `part_paths`：`/x/笔记.png`, 3 → `笔记-1.png…笔记-3.png`，同目录。

### 7.3 浏览器测试：在 `tests/ai-browser.mjs` 末尾加「导出图片」组

放进现有脚本（而非新建），这样 `npm run test:browser` 一条命令覆盖；沿用 `fresh()` / `check()` / `run()`。需要在 `src/__lab.js` 增加 `window.__lab.image(options)`：对当前 doc 调 `buildImage`，返回 `{ scale, reduced, failed, parts: [{ width, height, base64 }], html, nonWhite: [每段非白像素比例], leftovers }`，并在 `__lab.html` 的假 `invoke` 中记录第三个参数（`options.headers`）。

| # | 用例 | 断言 |
|---|---|---|
| I1 | 综合文档：中文标题 / 段落、加粗链接、`js` 代码块、表格、任务列表、行内与块级 KaTeX、一个 Mermaid、一张 data URL 本地图 | 返回 1 段；Node 侧解 base64：前 8 字节为 PNG 签名，IHDR 宽 = 1520，高 = `ceil(测量高 × 2)` 且 > 0 |
| I2 | 非空白像素 | 页面内 `createImageBitmap` → `getImageData`：非白像素比例 > 1%；标题所在区域（测量得到的 h1 矩形）有深色像素；块级公式矩形内有非白像素（KaTeX 字体已生效） |
| I3 | 懒渲染下的代码块 | 文档 ≥ 200 个顶层块且末尾有代码块，确认编辑器里该块**未挂载** `.cm-editor`；导出的 `html` 中含该代码的 `tok-keyword` span |
| I4 | 不影响编辑器 | 导出前后 `md()` 相同、选区相同、滚动位置相同；导出后页面中无残留离屏宿主元素（`leftovers === 0`） |
| I5 | 超长（小上限） | `buildImage(doc, { limits: { maxSide: 4000 } })` 对长文档：`reduced` 或 `parts.length > 1`；每段 PNG 高 ≤ 4000；所有段宽一致 |
| I6 | 远程图片失败 | `![x](https://example.invalid/a.png)`（`--no-proxy-server` 下必然失败）：仍产出 PNG，`failed === 1`，`html` 含 `image-missing`，耗时 < 20 秒 |
| I7 | 空文档 | `setDoc('')` 后导出 → 抛出 / 返回空文档标记，文案为“文档是空的，没有可导出的内容” |
| I8 | 写盘接线 | 临时设 `window.isTauri = true`，调 `api.exportImage(bytes, '测试.png', 1)`：假壳收到 `export_image`，请求体为 `Uint8Array`，headers 含 `x-file-name` 与 `x-parts: '1'` |
| I9 | 下载回退 | `isTauri` 为假时，拦截 `HTMLAnchorElement.prototype.click`：`download === '测试.png'`，`href` 以 `blob:` 开头 |
| I10 | 可发现性 | 命令面板搜 `png`、`长图`、`图片` 都能找到“导出为图片…”；帮助面板「导出」组含该行 |

注：I1–I2 只能证明 Chromium（WebView2 同内核）可用，WebKit 两端由 §7.4 手动覆盖。

### 7.4 三端手动检查清单

每个平台都用同一份样例文档（建议放 `tests/smoke/export-image.md`：含上表 I1 的全部元素 + 一张相对路径本地图 `assets/…` + 一张远程图 + 3 万字长段落用于超长）：

**通用（三端都做）**

- [ ] 入口：命令面板搜“图片 / png / 长图”可见；「···」菜单在“导出为 PDF…”下方；帮助面板「导出」组可见
- [ ] 保存对话框：默认名 `文档名.png`（未保存文档为 `未命名.png`），默认目录为文档所在目录，过滤器显示“PNG 图片”
- [ ] 输出：宽 1520 px，白底不透明；中文、英文、代码字体正常，无方块字
- [ ] KaTeX：行内 / 块级公式字形正确（不是回退字体的方框或错位）
- [ ] Mermaid：图形与文字标签都可见
- [ ] 代码块：远离视口、未展开过的代码块也有高亮；长行自动换行不被裁切
- [ ] 本地图片（相对路径、绝对路径、粘贴的）都在；超大照片导出不卡死
- [ ] 断网后远程图片显示占位框，提示里有失败张数，其余内容完整
- [ ] 长文档：出现“已按 x 倍清晰度输出”或“已分成 n 张”，文件名 `-1、-2…`；已存在同名时弹替换确认
- [ ] 取消对话框无提示；写到只读位置提示“导出失败：没有访问权限”
- [ ] 导出前后编辑器光标、选区、滚动位置、撤销历史不变；应用为深色主题时导出仍是浅色
- [ ] 窗口缩放（放大 / 缩小）后导出，图片尺寸不变
- [ ] 界面上所有新文案只出现 “MarkCune”，不出现旧名

**macOS（WKWebView，macOS 13+）**

- [ ] 原生菜单「文件」中“导出为图片…”位于“导出为 PDF…”之后，点击可用
- [ ] 重点核对 §3.3 的 WebKit 风险：图片首帧不空白、KaTeX 字体首帧生效、`toBlob` 未抛 `SecurityError`
- [ ] Retina 与外接 1x 显示器上导出的图片完全一致（尺寸、像素）

**Windows（WebView2）**

- [ ] 无菜单栏，「···」与 Ctrl+K 可达；对话框中文过滤器显示正常
- [ ] 文件名含中文 / 空格时写盘正常；被其他程序锁定的同名文件给出可读错误
- [ ] 中文字体为微软雅黑，代码字体 Consolas / Cascadia Mono

**Linux（WebKitGTK 4.1；含麒麟 ARM 构建）**

- [ ] GTK 对话框输入不带后缀的名字 → 实际写出 `.png`；补后缀后与已有文件同名时弹替换确认
- [ ] 安装 `fonts-noto-cjk` 时中文正常；未安装时与编辑器表现一致（方块），不崩溃
- [ ] 老版本 WebKitGTK 上长文档能触发降级而不是白图

### 7.5 验收清单

- [ ] `npm test` 全部通过（含新的 `export-image.test.mjs`，`changelog` / `rebrand` 仍通过）
- [ ] `NODE_OPTIONS=--experimental-websocket npm run test:browser` 全部通过（191 + 新增用例）
- [ ] `npm run build:web` 通过；`export-image.js` 为独立懒加载 chunk，首屏包体积无明显增长
- [ ] `cargo test`（`src-tauri`）通过
- [ ] §7.4 三端清单逐项打勾，截图 / 导出样张附在 PR 中
- [ ] 无新增 npm 依赖、无新增 Rust crate；`capabilities/default.json`、`tauri.conf.json` 的 CSP 与 `assetProtocol` 未改
- [ ] 版本号、`scripts/release.conf`、`scripts/release.sh` 未改；内部标识（`local.mdpad`、crate `mdpad`、`MDPAD_*`、`mdpad-*` 键、`__mdpadExport`、`~/Documents/MDPad/`）未改
- [ ] CHANGELOG 未改（理由见 §0）
- [ ] 全程无上传：除文档本身引用的远程图片读取外，无任何新网络请求

---

## 8. 约束（实现时必须遵守）

1. **品牌**：界面只用 “MarkCune”。**不改**内部标识：`local.mdpad`、crate / 二进制名 `mdpad`、`MDPAD_*` 环境变量、`mdpad-*` localStorage 键、`~/Documents/MDPad/`、`.mdpad-export` 类名、`__mdpadExport` / `__mdpadDebug` 调试全局、`.mdpad-tmp` 临时后缀（见 `docs/rebrand-markcune.md` 第 4 节；`tests/rebrand.test.mjs` 会检查）。
2. **不改**版本号（`package.json` / `tauri.conf.json` / `Cargo.toml` / 两个 lock 文件）、`scripts/release.conf`、`scripts/release.sh`。
3. **CHANGELOG**：只有在 `tests/changelog.test.mjs` 仍通过（每版 ≤ 5 条、不含 `**` 或三反引号）时，才可在顶部 4.0.0 段下加一行；**当前 4.0.0 已有 5 条，因此跳过**。
4. **三端可用**：macOS / Windows / Linux 都必须能用；任何平台专属路径都要有对应的手动检查项。
5. **纯本地**：不上传文档内容或生成的图片；不新增遥测。
6. **用户可见文案**用简体中文，标点与现有 UI 一致（中文引号“”、省略号“…”、全角括号）。

---

## 9. 给实现者的任务清单（按文件排序）

> 建议按此顺序提交，每步都能单独跑测试。

| # | 文件 | 改动 | 对应测试 |
|---|---|---|---|
| 1 | `src/image-plan.js`（新） | 零依赖纯函数：`LIMITS`（`maxSide 32000`、`maxArea 64e6`、`minScale 1`、`maxParts 10`）、`planImage(layout, limits)`、`pngInfo(bytes)` | 7.1-1、7.1-2 |
| 2 | `tests/export-image.test.mjs`（新）+ `package.json` | 规划 / PNG / 接线静态检查；`test` 脚本末尾追加该文件（**只改 scripts.test，不动 version**） | `npm test` |
| 3 | `src/export.js` | ① `export` 出 `katexCss()`；② 新增 `imageRules(scope)`（§4.8）；③ `renderDocument` 增加可选 `missingImage(src, alt)` 回调：图片回调返回 `null` 时渲染 `.image-missing` 占位（默认行为不变，HTML/PDF 不受影响） | 现有“导出 PDF”“Word”浏览器用例仍通过 |
| 4 | `src/diagram.js` | `renderMermaid(code, theme, { htmlLabels } = {})`；缓存键改为主题 + htmlLabels | 7.3-I1（Mermaid 区域非白） |
| 5 | `src/export-image.js`（新） | `buildImage(doc, { image, diagram, limits })`：调用 `renderDocument` → 远程图 CORS 内联 / 占位、大图预缩放（§4.4–4.5）→ Shadow DOM 离屏测量（§4.9）→ `planImage` → 画布探测 → SVG `foreignObject` 栅格化（预热、两帧、空白重画，§3.3）→ 返回 `{ parts: [{ bytes, width, height }], scale, reduced, failed }`；`finally` 清理离屏节点；导出 `isBlankDoc(doc)` | 7.3-I1…I7 |
| 6 | `src/bridge.js` | `exportImage(bytes, name, parts)`（§5.2）；`saveImageParts(parts, name)`：`isTauri()` 时拼接字节调 `exportImage`，否则逐段下载（§5.3） | 7.3-I8、I9 |
| 7 | `src/commands.js` | 「导出」组新增 `export-image`（§2.1） | 7.1-3、7.3-I10 |
| 8 | `src/main.js` | `buildExportImage()`（图片 / 图表回调与 `buildExportHtml` 相同，`diagram` 用 `htmlLabels: false`）、`exportImage()`（重入保护、空文档、进度提示、§6 文案）；`actions['export-image']`；`showMore` 加 `item('export-image')`；`window.__mdpadExport.image` | 7.1-3；手动 7.4 |
| 9 | `src/__lab.js`、`src/__lab.html` | `window.__lab.image(options)`（返回 base64、尺寸、非白像素比例、残留节点数、序列化 HTML）；假 `invoke` 记录第三个参数 `options` | 7.3 全组 |
| 10 | `tests/ai-browser.mjs` | 末尾“汇总”前新增「导出图片」组 I1–I10；I3 复用“代码块”组的长文档构造方式 | `NODE_OPTIONS=--experimental-websocket npm run test:browser` |
| 11 | `src-tauri/src/files.rs` | 纯函数 `split_pngs`、`png_target`、`part_paths` + `#[cfg(test)]` 用例 | 7.2，`cargo test` |
| 12 | `src-tauri/src/main.rs` | `export_image` 命令（§5.1：读 `x-file-name` / `x-parts`、校验与切分、对话框、补后缀与覆盖确认、`atomic_write`、返回写出数）；`generate_handler!` 注册；`build_menu` 在 `export-pdf` 后加菜单项 | 7.1-3；7.4 macOS 菜单 |
| 13 | `tests/smoke/export-image.md`（新，可选） | 手动检查用样例文档（§7.4） | 7.4 |
| — | `CHANGELOG.md` | **不改**（4.0.0 已满 5 条） | `tests/changelog.test.mjs` |
| — | `capabilities/default.json`、`tauri.conf.json`、版本文件、发布脚本 | **不改** | `tests/rebrand.test.mjs` |

### 9.1 后续版本（不在 v1）

- v1.1：将选区导出为图片（§1.1）；深色主题（§1.4）；外壳代下载无 CORS 的远程图（§4.5）。
- v1.x：复制为图片到剪贴板；JPEG（视反馈）；导出宽度选项（如 600 / 760 / 960）。
