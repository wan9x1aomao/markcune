# MarkCune 编辑器

[![CI](https://github.com/wan9x1aomao/markcune/actions/workflows/ci.yml/badge.svg)](https://github.com/wan9x1aomao/markcune/actions/workflows/ci.yml)

MarkCune（原 MDPad 编辑器）是一款轻量、免费的本地 Markdown 编辑器。打开就能打字，打下的每个字都留在你自己的硬盘上 —— 不登录、不联网、不上传。

**官网：<https://mdpad.app.workbuddy.host/>**（过渡期，markcune.md 上线后切换）｜ 免费开源（MIT）｜ macOS / Windows / Linux

> 名称说明：MarkCune 曾用名 MDPad 编辑器，中文语境称「MarkCune 编辑器」；官网域名仍是过渡期地址，功能与本地数据都与旧版一致。

![MarkCune 编辑器界面](docs/screenshot.png)

## 下载

安装包在官网：**<https://mdpad.app.workbuddy.host/>**（过渡期，markcune.md 上线后切换）

| 平台 | 要求 |
|---|---|
| macOS | 13 及以上（Apple 芯片） |
| Windows | 10 / 11，使用系统自带的 WebView2 |
| Linux | 需要 WebKitGTK 4.1（`.deb` 与 `.AppImage` 都提供） |

> 从 3.5.x 升级：4.0.0 不通过自动更新推送，请先卸载旧版 MDPad，再下载安装 MarkCune；设置、AI Key、草稿和书库都会保留。macOS 记得删掉旧的 `MDPad.app`，Windows 先在「应用」里卸载旧版。

历史版本从 [`v3.2.1`](https://github.com/wan9x1aomao/markcune/tags) 起都打了 tag，每个 tag 就是那个版本的源码快照。

## 功能

- **所见即所得，也能看源码** —— Markdown 一输入就排好版；`⌘/` 切到源码，`⌥⌘/` 分屏对照
- **文件夹 · 大纲 · 命令面板** —— 打开整个文件夹，左边文件、右边大纲；`⌘P` 快速打开，`⌘K` 命令面板
- **找不到的都能搜到** —— 命令面板按中英文关键词找功能（word、pdf、置顶），空查询先列常用；macOS 的「帮助」菜单（Windows / Linux 按 `F1`）打开一页功能与快捷键总表，点一行直接执行
- **一键整理格式** —— 随手写下的纯文本，一键分出标题、列表和引用。只重排结构，文字一个字都不改，一步撤销即可回到原样
- **AI 续写与改写（自带 Key，默认关闭）** —— 停笔后光标处淡出一句续写，`Tab` 收下、`Esc` 忽略；选中一段文字点旁边的 `AI`，润色、精简、译成英文都在原文位置给出对照，明确点「采纳」才写进文件。三种入口：选区按钮、`⌘K`、空行里打 `/`。Key 存在本机，没配 Key 时这些入口完全不出现
- **一次改好几段** —— 跨段选中可以逐段过一遍；两条以上建议时右侧列出每条改了哪里、改成什么，点一条跳过去，也能一键全收
- **粘贴链接，整本书到手** —— GitHub 上的书，把链接粘进来就下载到本地书库，图片和章节之间的跳转一起带走，断网也能读
- **自动保存，不丢稿** —— 停笔一秒自动保存，草稿重启后恢复；文件被外部改动时先提醒，不会覆盖
- **代码、公式、流程图** —— 代码高亮与一键复制，LaTeX 公式，Mermaid 流程图实时渲染
- **图片跟着文档走** —— 粘贴或拖入图片自动存进 `assets`，另存到别处时一起迁移
- **导出网页、Word、PDF** —— 网页是单文件，图片和公式字体都在里面；Word 里是真标题、真列表、真表格，改成什么结构就还是什么结构；PDF 走系统打印
- **语音输入** —— 编辑区右下角点一下开始、说完再点一下，转出来的字直接落进光标处；录音在本机完成，只把音频发给你指定的识别服务，落地后想改还是普通的字
- **轻巧** —— 系统原生 WebView，不内置浏览器；源码、公式、流程图、导出都按需加载

## 开发

需要 **Node 22+** 和 **Rust**（stable）。Linux 还要装 WebKitGTK 等系统依赖：

```bash
# 只在 Linux 上需要
sudo apt install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
                    librsvg2-dev libxdo-dev libssl-dev patchelf
```

```bash
npm install
npm run dev        # 开发模式（tauri dev）
npm run dev:web    # 只在浏览器里调前端（vite）
```

打包：

```bash
npm run build       # macOS：src-tauri/target.noindex/release/bundle/macos/MarkCune.app
npm run build:win   # Windows：NSIS 安装包
```

Linux 的 `.deb` / `.AppImage` 与 Windows 的 `.exe` 由 GitHub Actions 构建（`.github/workflows/build.yml`）。

## 测试

```bash
npm test                                   # 纯逻辑单测（整理、AI 触发规则、网关协议、下载回执、更新日志格式）
npm run test:browser                       # 界面与 AI 的逐项测试，真编辑器 + 无头 Chrome（需 Chrome；CI 也会跑）
(cd src-tauri && cargo test)               # Rust 单测（文件操作、链接识别、解压、AI 输出清洗）
npx tauri build --debug --no-bundle
tests/smoke/run.sh                         # 冒烟测试；Windows 上用 tests/smoke/run.ps1
tests/scenarios.sh                         # 文件操作场景，仅 macOS
```

⚠️ 冒烟测试会真的去 GitHub 下载一个仓库来验证「从链接打开」，需要联网。

`npm run test:browser` 驱动的是 `src/__lab.html`——一个带假 Tauri 外壳的看板，界面是真的、只有外壳的回答是写死的，所以不填 Key、不联网也能跑。每条用例都从一个新加载的页面开始，失败不会被前一条带歪；开发服务器没起的话脚本会自己起一个。覆盖范围：续写何时发请求（段末/句中/标题/组字中/冷却/开关）、灰字何时消失、Tab/Esc、改写对照与采纳/拒绝/重来、文档中途被改、多行结果、多段选中的逐块对照与逐段改写、审阅清单的逐条与批量操作、斜杠菜单里真的点得到、自定义指令的增删存、设置面板的每个字段与「清除 Key」、命令面板的关键词搜索与空查询分组、帮助面板的开关与点行执行、一次性提示只出现一次、以及没配置时入口是否真的消失。`src/__lab.*` 只是这个看板，不参与打包。

每次 push / PR，CI 会在 Linux 上自动跑一遍这套界面测试（`.github/workflows/ci.yml` 里的「界面测试（Chrome）」）。Chrome 和 WebView2 同属 Chromium，这类回归不用等发版才暴露；Windows 上真实 WebView2 的交互检查在 `preview.yml` 里，手动触发、不发版。

## 自动更新

更新地址在**打包时**通过 `MDPAD_UPDATE_ENDPOINT` 注入（`src-tauri/src/update.rs` 用 `option_env!` 读取）。不设这个变量编出来的包不会检查更新，从源码自己构建可以直接用。签名公钥写在 `src-tauri/tauri.conf.json`，私钥不进仓库。

检查更新在启动时、窗口回到前台时进行；应用一直留在前台时也会定时复查，频率上限为每 30 分钟一次。旧的 6 小时静默期会让早上检查过的机器整天看不到下午发布的版本，所以改短了。

## 一键整理的网关（可选）

「一键整理」不配 AI 也能用 —— 那时只做规则整理。想要更好的排版判断，可以自己跑一个网关：`gateway/` 里是一个零依赖的参考实现，接口约定见 [`docs/tidy-gateway.md`](docs/tidy-gateway.md)。应用只把原始行发过去、拿回每行的标签，文字始终由应用自己拼，所以网关改不了也丢不了用户的原话。

## AI 续写与改写（可选）

默认关闭。要打开，`⌘K` → **AI 设置…**（也在右上角 `⋯` 菜单里），挑一个服务商、填自己的 Key、点「测试连接」确认能用。内置 DeepSeek、通义千问、Kimi、智谱、OpenAI 和本地 Ollama 的预设，也可以用任意 OpenAI 兼容地址。

- **Key 只在这台电脑上**：存在应用自己的配置文件里，界面读不回来（只在已保存时显示「留空不修改」），提示词写在 Rust 侧，渲染层无法改写或看到
- **文字直接发给你填的那个地址**，MarkCune 不做中转；用谁的服务、数据到哪儿去，由你决定
- **没配 Key 时所有入口都不出现**：没有灰字、没有选区旁的按钮、命令面板和斜杠菜单里也没有改写命令，不会留个点不动的空壳
- **只有你点「采纳」才会改文档**：提议以「原文划掉 + 新文绿字」的对照呈现，`Esc` 或「拒绝」不留任何痕迹；采纳与拒绝都是一次撤销的事。短的改动就地对照，长改写整块排在段落下——两段长句挤在一行谁都读不下去

续写是否发出由本地规则决定（光标在段落末尾、停顿 600ms、正文足够长、不在输入法组字中），不会每敲一个字就发一次请求。

**三种改法入口。** 选中文字后旁边浮出 `AI` 按钮；`⌘K` 命令面板里也有同样的六条命令；在空行里打一个 `/`，菜单里有一组「AI 改写」，选一条就重写上面那一段（命令本身会被删掉，不会留在稿子里）。

**自定义指令。** 设置面板里最多存三条自己常说的话，比如「按公文格式改」「去掉客套话，直接说结论」。存好之后它们和内置的六种改法一样，出现在选区菜单、命令面板和斜杠菜单里。

**一次改好几段。** 跨段选中后，菜单末尾多一条「逐段改写（N 段）…」——选一种改法，一段一段过，每段各自请求、各自对照。建议累积到两条以上时，右侧出现审阅清单：每条显示原文摘录与改动摘要，点一条跳到那一段，`⌘↵` 采纳当前这条、`Esc` 拒绝；底部可以一键全部采纳或全部拒绝，也是一次撤销就能复原。清单收起（×）后回到原来的浮动条，一次只跟一条。

选中范围里夹着代码块、列表或表格时不会硬改——那段结构里混着语法，改坏了原文就找不回来，所以会直接说明不支持。

## 发版（维护者）

```bash
scripts/release.sh <版本号> "更新说明"
```

本地打 macOS 包 → 触发 GitHub Actions 打 Windows / Linux → 收产物、生成 `latest.json`、更新官网目录。需要签名私钥（`~/.tauri/mdpad.key`）和已登录的 `gh`，配置写在 `scripts/release.conf`。**这个脚本只服务于本仓库的发布流程，不是安装或构建 MarkCune 的方式**；从源码构建请用上面的 `npm run build`。

## 目录

```
src/             前端（Milkdown Crepe + CodeMirror，原生 JS 无框架）
src-tauri/       Rust 外壳（窗口、文件、草稿、下载、更新）
gateway/         「一键整理」网关的参考实现
scripts/         图标、DMG、发布脚本
tests/           单测与冒烟 / 场景测试
```

## 许可证

[MIT](LICENSE)。用到的第三方库：Milkdown（MIT）、Tauri（MIT / Apache-2.0）、CodeMirror（MIT）、KaTeX（MIT）、Mermaid（MIT）。

欢迎 issue 和 PR。提 PR 前请先跑一遍 `npm test` 和 `cargo test`。
