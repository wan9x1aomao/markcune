# MarkCune 多平台更名清单（macOS / Windows / Linux）

- **日期：** 2026-10-27
- **用途：** 发 4.0.0 之前逐项核对，避免“只改了 macOS”。
- **状态标记：** ✅ 已改并验证 · ⚠️ 已改，需真机/CI 验证 · ⛔ 发版前必须先处理 · ⏳ 待设计

## 0. 三端共用的改名结果

| 项 | 旧 | 新 | 状态 |
|---|---|---|---|
| 产品名 `productName` | MDPad | MarkCune | ✅ |
| 版本 | 3.5.6 | 4.0.0（五个清单一致） | ✅ `tests/rebrand.test.mjs` 守住 |
| 安装包 / 更新包文件名 | `MDPad-<版本>-…` | `MarkCune-<版本>-…` | ✅ 发布脚本 + CI 已同步 |
| 应用标识 | `local.mdpad` | 不变 | ✅ 老配置、AI Key、草稿、最近文件都靠它 |
| 二进制 / crate 名 | `mdpad` | 不变 | ✅ 升级后按当前可执行文件路径重启 |
| 书库目录 | `~/Documents/MDPad/` | 不变 | ✅ 老用户的书在这里，本次不迁移 |
| 环境变量 / localStorage / 签名私钥 | `MDPAD_*`、`mdpad-*`、`~/.tauri/mdpad.key` | 不变 | ✅ 见 docs/rebrand-markcune.md 第 4 节 |
| 图标 `icon.icns` / `icon.ico` / PNG | 旧的「M + 箭头」 | 待重做 | ⏳ 三端共用同一套图标，一个设计决定覆盖三端 |

## 1. macOS

| 表面 | 结果 | 状态 |
|---|---|---|
| `.app` 包名 | `MDPad.app` → `MarkCune.app` | ✅ 调试打包验证：`CFBundleName=MarkCune`、版本 4.0.0 |
| 菜单栏 | `MarkCune` / 关于 / 隐藏 / 退出 / 帮助 › `MarkCune 官网` | ✅ 代码 |
| 窗口标题、关于页 | MarkCune | ✅ 代码 |
| 麦克风权限说明 | MarkCune 需要麦克风 | ✅ `Info.plist` + `zh-Hans` 本地化 |
| DMG 卷名 | `MarkCune` | ✅ `scripts/make-dmg.sh` |
| DMG 背景图 | 链接文字 `MarkCune /Applications` | ✅ `background.tiff` 已重新渲染 |
| 更新包命名 | `MarkCune-<版本>-macOS-arm64.tar.gz/.dmg` | ✅ `scripts/release.sh` |
| 升级路径 | 3.5.6 自动更新会原地替换旧 bundle 内容，但目录名仍是 `MDPad.app`；手动装 DMG 会与旧 `MDPad.app` 并存 | ⚠️ 真机升级验证；发布说明引导删除旧版 |

本机验证：`npx tauri build --debug --bundles app`，产物
`src-tauri/target.noindex/debug/bundle/macos/MarkCune.app`。
`make-dmg.sh` 在当前 DSH 沙箱里因 `hdiutil` 不可用无法跑通，需在普通终端或发版机验证。

## 2. Windows

| 表面 | 结果 | 状态 |
|---|---|---|
| NSIS 安装包 / Release 资产 | `MarkCune-<版本>-windows-x64-setup.exe` | ✅ `build.yml` |
| 安装目录 | `%LOCALAPPDATA%\MarkCune`（由 productName 推导） | ✅ 新装 |
| 开始菜单 / 桌面快捷方式 | `MarkCune.lnk` | ✅ 新装 |
| 卸载项 | `…\Uninstall\MarkCune`、DisplayName=MarkCune | ✅ 新装 |
| 窗口标题 / 任务栏 | `文档名 - MarkCune` | ✅ 代码 |
| 文件关联说明 | 「Markdown 文稿」「Open with MarkCune」 | ✅ 新安装器写入 |
| 设置 / AI Key / 草稿 | 仍按 `local.mdpad` 落在原位置 | ✅ identifier 未变 |
| **3.5.6 → 4.0.0 升级** | 旧卸载键是 `Uninstall\MDPad`、旧目录是 `%LOCALAPPDATA%\MDPad`；新安装器 `/UPDATE` 找不到旧安装，会在新目录再装一份，旧版和旧快捷方式残留 | ✅ 已选 B：不发自动更新，官网手动下载并提示先卸载旧版（见下） |
| 图标 | 旧 | ⏳ |

**Windows 升级：已选 B（2026-10-27）**

- 4.0.0 不通过自动更新推送：旧站 `latest.json` 继续停在 3.5.6，3.5.6 客户端不会弹更新提示；
- 官网提供 4.0.0 手动下载，下载页必须写「**先卸载旧版 MDPad，再安装 MarkCune**」，否则 NSIS 会装出两份；
- 已知代价：老用户手动换一次；旧版的设置、AI Key、草稿、最近文件、书库按 `local.mdpad` 保留，不会丢；
- 后续：新站就绪后把 `UPDATE_ENDPOINT` 指向新站再发下一版；如果 4.0.0 打包时仍指向旧端点，那么下一版也要手动装一次，之后才恢复自动更新。

## 3. Linux

| 表面 | 结果 | 状态 |
|---|---|---|
| `.deb` 包名 | `md-pad` → `mark-cune`（Tauri 由 productName 推导） | ✅ 新包名 |
| 旧包处理 | 新包声明 `Conflicts` + `Replaces: md-pad`，安装时替换旧包，不并排 | ✅ `tauri.conf.json`；⚠️ 需容器/真机装一次验证 |
| 桌面入口 | `MDPad.desktop` → `MarkCune.desktop`；`Name=MarkCune`；`Comment=本地 Markdown 所见即所得编辑器` | ✅ 由 productName/shortDescription 生成 |
| Exec / 图标名 | `mdpad`（沿用二进制名）；图标 `mdpad.png` | ✅ 保持稳定，升级不受影响 |
| `.deb` / `.AppImage` 产物名 | `MarkCune-<版本>-linux-…` | ✅ `release.sh`、`build.yml` |
| 麒麟线 | `scripts/build-kylin.sh` 产物 `MarkCune-…deb/.AppImage` | ✅ |
| 升级路径 | `.deb` 走 replaces 自动移除旧包；AppImage 原地覆盖当前文件（文件名不变），手动下载新版需自己删旧文件 | ⚠️ 真机/容器验证 |
| 图标 | 旧 | ⏳ |

注意：`.deb` 的 `Package:` 字段使用 kebab-case，所以是 `mark-cune` 而不是 `markcune`；
上游 3.5.6 的包名是 `md-pad`（已从 `release/3.5.6/MDPad-3.5.6-linux-amd64.deb` 的 control 文件确认）。

## 4. 发版前必须过的验证

本机已过：

- `npm test`（含新增 `tests/rebrand.test.mjs`：版本一致、productName、identifier、crate 名、deb 旧包冲突）
- `npm run build:web`
- `cargo test`（74 passed）
- `npm run test:browser`（191/191）
- `npx tauri build --debug --bundles app`（MarkCune.app / 4.0.0 / local.mdpad）

必须在真机或 CI 上补：

- [ ] macOS：手动装 4.0.0（先删旧 `MDPad.app`），确认 AI Key、书库、草稿原样
- [ ] Windows：先卸载旧版 MDPad，再装 `MarkCune-*-setup.exe`；确认目录、快捷方式、卸载项、文件关联只有一份
- [ ] Linux：Ubuntu/deepin 上 `dpkg -i MarkCune-*.deb`，确认旧 `md-pad` 被替换、菜单只有一项；AppImage 双击可启动
- [ ] 旧站 `latest.json` 没被覆盖：3.5.6 客户端检查更新时**不弹** 4.0.0（这是 B 方案的核心）
- [ ] 三端全新安装后，关于页、菜单、窗口标题、安装包属性里都只有 MarkCune

## 5. 与官网相关的待办（本次不动）

官网还要继续斟酌，所以以下都先挂起：`markcune.md/.com` 注册与备案、站点换牌、旧域名 301、
`latest.json` 新地址、README/应用内官网链接切换、GitHub 仓库改名。站点就绪前，应用内链接与
`release.conf` 继续指向旧地址（3.5.x 客户端只认旧地址）。

## 6. 手动升级（B 方案）的发版流程

已落到工具里：`scripts/release.conf` 默认 `MANUAL_UPGRADE=1`，`scripts/release.sh` 会照常打包、
收集三端产物、生成 `release/<版本>/latest.json`，但**不碰 `SITE_DIR`、不覆盖旧站 `latest.json`**。

1. **发 4.0.0 前**：确认 `UPDATE_ENDPOINT` 用哪个——
   - 新站已就绪：改成新站更新地址，4.0.0 客户端以后能自动更新；
   - 新站未就绪：沿用旧地址，4.0.0 自己也只能手动升级下一版，等下一版再把端点换到新站。
2. **跑** `scripts/release.sh 4.0.0 "改名 MarkCune"`：产物在 `release/4.0.0/`，终端会列出新站要放的 5 个固定文件名。
3. **官网（新站）**：挂下载文件，写明「先卸载旧版 MDPad」；`latest.json` 与站点同时上线，不要提前放。
4. **不要**把 4.0.0 的包或 `latest.json` 放进旧站目录。
5. 发布后验证：3.5.6 客户端检查更新应提示「已是最新」；4.0.0 新装用户设置、AI Key、书库原样。
6. 新站成为主站后：`MANUAL_UPGRADE=0`，以后版本按老流程同步站点。
