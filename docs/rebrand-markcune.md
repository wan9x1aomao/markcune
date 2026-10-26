# MarkCune 品牌更名实施说明

- **状态：** A 类（品牌表层）已完成；B 类升级 spike、域名与图标待办
- **日期：** 2026-10-26
- **定名结论：** 公开品牌只用 **MarkCune**；**MarkCuneus** 只作为商标 / 法务主体名，不进界面、不进官网标题。
- **版本：** 更名版本为 **4.0.0**。

## 1. 定名与口径

| 场景 | 写法 |
|---|---|
| 品牌名（界面、官网、README 标题） | **MarkCune** |
| 中文习惯说法 | **MarkCune 编辑器**（不再造中文品牌名） |
| 代码 / 域名 / 文件名 | 小写 **markcune** |
| 法务 / 商标 / 未来 About 小字 | MarkCuneus（本次不进 UI） |
| 禁用写法 | Markcune、Mark Cune、MarkCUNe、MC Editor |

口号沿用官网原型里已通过事实核对的一句：**安静地打字。**（英文待定，不写进应用内。）

过渡写法：更名后的 1–2 个版本，在官网首页、README 首段、发布说明首段保留
**MarkCune（原 MDPad 编辑器）**；正文其余位置只用 MarkCune。

## 2. 产品事实（更名不改变）

免费开源（MIT）、本地 Markdown 编辑器；macOS / Windows / Linux；本地优先、默认不登录不上传；AI 续写与改写为 BYOK、默认关闭，没配 Key 时入口不出现；导出网页 / Word / PDF、语音输入、一键整理等能力不变。

## 3. 本次改什么（A 类：品牌表层）

- 应用显示名、窗口标题、macOS 菜单栏、关于页、更新提示、错误提示里的旧名。
- 命令面板 / 帮助里指向官网的条目。
- 文档元数据（导出的 docx 作者与说明）。
- 安装包与产物文件名：`MarkCune-<版本>-<平台>-<架构>.<后缀>`（平台后缀规则不变）。
- `tauri.conf.json` 的 `productName`、`package.json` / `Cargo.toml` / `tauri.conf.json` 的版本号 → `4.0.0`。
- README、CHANGELOG、发布脚本、官网更新脚本、press 模板、设计文档里的旧名。
- 官网原型 `preview/quiet-paper.html` 的品牌与字标。

## 4. 必须保留的内部标识（例外清单，逐条加注释说明原因）

这些不是用户可见品牌，改了要迁移数据或弄断升级链，**本次一律不动**：

| 标识 | 值 | 原因 |
|---|---|---|
| Bundle ID / App ID | `local.mdpad` | 系统据此认出同一个应用；改了会多一份配置、丢 AI Key |
| Rust crate / 二进制名 | `mdpad` | Tauri 升级后按当前可执行文件路径重启，改名可能让老包升完起不来 |
| 用户数据目录 | `~/Library/Application Support/local.mdpad` | 设置、草稿、最近文件、AI Key 都在这里 |
| 书库目录 | `~/Documents/MDPad/` | 老用户下载的书在这里；本次不迁移，继续读写旧路径 |
| Home 兜底目录 | `~/.mdpad/` | 同上 |
| 环境变量 | `MDPAD_DATA_DIR`、`MDPAD_LIBRARY_DIR`、`MDPAD_UPDATE_ENDPOINT`、`MDPAD_TIDY_URL`、`MDPAD_AI_*`、`MDPAD_TEST_*` | 发布脚本、CI、网关、测试共同依赖的契约 |
| 签名私钥 | `~/.tauri/mdpad.key` | 已发布的更新包靠它签名；换路径不能换私钥 |
| 更新端点 / 下载地址 / 官网本地目录 | `mdpad.app.workbuddy.host`、`$HOME/mdpad-site` | 3.5.x 客户端只认旧地址，新域名就绪前不能断 |
| localStorage / 插件键 / DOM 类 / 调试全局 | `mdpad-theme`、`mdpad-*`、`__mdpadDebug`、`__mdpadExport`、`mdpad-img:` 等 | 存的是用户数据和测试契约，改名要迁移 |
| 历史发布物 | `release/` 下旧版本、历史 tag、`docs/press/3.5.2.md` | 历史记录保留旧名，不改写 |
| 测试专用 ObjC 类名 / 临时文件后缀 | `MDPadTestDraggingInfo`、`.mdpad-tmp` 等 | 仅测试与临时文件，对用户不可见 |

新增代码如果要写品牌名，用 `MarkCune`；如果要碰路径 / 标识，先回来看这张表。

## 5. 这次先不动的过渡项

- **域名**：`markcune.com / .md / .app / .cn` 待注册；注册并部署前，README / 应用里的官网链接继续指向旧地址，并注明“过渡期”。
- **GitHub 仓库**：仍是 `wan9x1aomao/mdpad`；改名后旧地址会自动跳转，但要在域名与站点就绪后再做。
- **图标 / 字标**：MarkCune 的视觉应从“楔形刻痕 / 文本光标”出发，不用毛笔与墨痕；本次只改原型，正式图标另起一轮。
- **升级 spike**：`productName` 已经改成 MarkCune，但 macOS 覆盖升级后的 `.app` 目录名、Windows NSIS 是否残留旧快捷方式，必须在发 4.0.0 前真机验证 3.5.6 → 4.0.0。
- **书库目录**：新用户仍落在 `~/Documents/MDPad/`；是否改成 `~/Documents/MarkCune/` 并做复制式迁移，放到升级 spike 里一起决定。

## 6. 版本与更新日志

- `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`package-lock.json`、`src-tauri/Cargo.lock` 统一为 `4.0.0`。
- CHANGELOG 新增 `## 4.0.0 · 2026-10-26`，第一条写明改名，并说明“升级不用重新配置”；条数 ≤ 5，禁止 `**` 与三反引号（`tests/changelog.test.mjs` 会查）。

## 7. 验收（A 类）

- [x] `npm test` 通过；`npm run build:web` 通过。
- [x] 全库检索 `MDPad` / `mdpad`，残留只剩第 4 节例外与历史记录。
- [x] 界面可见处（标题、菜单、关于、更新提示、命令面板、官网条目）全部为 MarkCune。
- [x] `tauri.conf.json` 的 `identifier` 仍是 `local.mdpad`，crate 名仍是 `mdpad`。
- [x] 安装包 / 更新包文件名统一为 `MarkCune-*`，发布脚本与官网更新脚本一致。

## 8. A 类落地记录（2026-10-26）

改了 34 个文件，按表层归类：

- **应用可见层**：`tauri.conf.json` productName、窗口标题、macOS 菜单五项、关于页、更新提示、AI 隐私说明、docx 元数据、错误提示、命令面板官网条目、`index.html` / `__lab.html` 标题。
- **文档与发布**：README、CHANGELOG（4.0.0）、package / Cargo 版本与包名、release / make-dmg / build-kylin / update-site / DMG 背景、CI 产物名、press 模板、置顶设计文档、测试样例。
- **官网原型**：`preview/quiet-paper.html` 换成 `Mark / Cune` 两行字标 + 文字光标记号，signature 与页脚同步；截图已重出。

验证：`npm test`（含 changelog 结构检查）、`npm run build:web`、`cargo test`（74 passed）、浏览器界面测试（188 条）全部通过；旧名残留只落在第 4 节例外与历史记录。

## 9. 下一步（发 4.0.0 之前必须做）

1. **升级 spike**：逐项见 [多平台更名清单](rebrand-platforms.md) 第 4 节。重点
   - macOS：`/Applications/MDPad.app` 升级后内容是否变成 MarkCune、是否出现两个应用；
   - Windows：旧卸载键 `Uninstall\MDPad`、旧目录 `%LOCALAPPDATA%\MDPad`，新安装器 `/UPDATE` 找不到旧版会在新目录再装一份 —— 发版前必须在“A. NSIS 迁移钩子”与“B. 4.0.0 先不推自动更新、官网手动下载”之间拍板（见平台清单第 2 节）；
   - Linux：新 `.deb` 已声明 `Conflicts/Replaces: md-pad`，要装一次确认旧包被替换、菜单只有一项；
   - 三端都要确认设置、AI Key、草稿、最近文件、`~/Documents/MDPad` 书库原样。
2. **域名与站点**：注册 `markcune.com / .md / .app / .cn`；新站上线后把 README、`src/main.js` 里的旧地址切过去，旧域名 301。
3. **图标与字标**：以“楔形刻痕 / 文字光标”为起点做正式图标，跑 `npx tauri icon` 重新生成全套并替换 `docs/screenshot.png`。
4. **GitHub 仓库改名**：站点与域名就绪后再改，旧地址要能跳转。
5. **发布说明**：按 press 模板写更名公告，第一段保留“MarkCune（原 MDPad 编辑器）”。
