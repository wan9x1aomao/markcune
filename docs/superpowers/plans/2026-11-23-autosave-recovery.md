# 自动保存误删恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 MarkCune 增加误删保护、保存前历史快照和最近版本恢复入口。

**Architecture:** 前端用纯函数判断大段删除并在自动保存前延迟五秒。Tauri 外壳按文档路径或草稿 ID 保存滚动快照，前端通过无路径参数的命令读取当前窗口对应的最近快照。恢复结果先回到编辑器，再按普通未保存修改流程写回。

**Tech Stack:** Vanilla JavaScript, Milkdown/CodeMirror, Tauri 2, Rust, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-23-autosave-recovery-design.md`

## Global Constraints

- 普通编辑仍使用现有一秒自动保存。
- 大段删除只延迟自动保存五秒，用户可以立即保存。
- 历史最多保留 20 份去重快照。
- 现有原子写入和外部文件冲突检测继续生效。
- 不把当前工作区已有未提交文件混入修复提交。

## Review Focus

- 删除后马上继续输入时，旧的延迟计时器不能覆盖新的内容。
- 恢复历史版本后，编辑器必须标记为未保存修改。
- 原子保存替换文件 inode 后，历史键仍能找到刚保存的快照。
- 草稿和已保存文件不能互相读到历史快照。
- 快照写入失败不能让正式文档进入半写状态。

### Task 1: 删除判定纯函数

**Files:**
- Create: `src/autosave-recovery.js`
- Test: `tests/autosave-recovery.test.mjs`

- [ ] 写测试覆盖清空、大于 500 字符、超过 20% 和普通小改动。
- [ ] 运行测试并确认因模块不存在而失败。
- [ ] 实现 `detectDestructiveDeletion(before, after)` 和 `saveDelayForDeletion(before, after, normalDelay, guardedDelay)`。
- [ ] 运行测试确认通过。

### Task 2: Tauri 历史快照存储

**Files:**
- Create: `src-tauri/src/history.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/files.rs`
- Test: `src-tauri/src/history.rs`

- [ ] 先写历史键、去重和最多 20 份的 Rust 测试并确认失败。
- [ ] 增加按文档路径或草稿 ID 分组的历史目录和原子快照写入。
- [ ] 增加 `history_save`、`history_latest` Tauri 命令并注册。
- [ ] 运行 Rust 定向测试确认通过。

### Task 3: 自动保存保护和恢复入口

**Files:**
- Modify: `src/bridge.js`
- Modify: `src/main.js`
- Modify: `src/commands.js`
- Test: `tests/autosave-recovery.test.mjs`

- [ ] 先补前端状态转换测试并确认失败。
- [ ] 保存前调用快照命令，检测大段删除并展示五秒缓冲提示。
- [ ] 增加“恢复上次保存版本”命令，恢复后标记为未保存。
- [ ] 将已保存文档和未命名草稿统一接入历史快照。
- [ ] 运行前端测试和语法检查。

### Task 4: 全量验证和同步

- [ ] 运行 `npm test`。
- [ ] 运行 `cargo test`。
- [ ] 运行构建或语法检查，确认已有未提交改动未被纳入。
- [ ] 提交修复分支并推送到 `origin`。
