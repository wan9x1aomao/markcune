# MDPad

本地使用的 Markdown 所见即所得编辑器，类似 Typora。

- 编辑器：[Milkdown Crepe](https://milkdown.dev)（`src/`）
- 外壳：[Tauri 2](https://tauri.app)（`src-tauri/`），macOS 用系统 WebKit，Windows 用 WebView2

## 开发

需要 Node 22+ 和 Rust。

```bash
npm install
npm run dev          # 开发模式
npm run build        # macOS：src-tauri/target.noindex/release/bundle/macos/MDPad.app
npm run build:win    # Windows：src-tauri/target.noindex/release/bundle/nsis/*.exe
```

Windows 和 Linux 版由 GitHub Actions 编译（`.github/workflows/build.yml`），`scripts/release.sh` 会自动触发并收集结果。

## 测试

```bash
npx tauri build --debug --no-bundle
tests/smoke/run.sh          # 冒烟测试；Windows 上用 tests/smoke/run.ps1
tests/scenarios.sh          # 文件操作场景（外部修改、草稿恢复、阅读位置、撤销等），仅 macOS
(cd src-tauri && cargo test)
```
