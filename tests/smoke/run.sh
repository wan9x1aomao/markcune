#!/bin/bash
# Smoke test: open a document in a debug build, drive the UI, then check what was written to disk.
# Build first with: npx tauri build --debug --no-bundle
#
# 三段：
#   1. sample.md —— 编辑、公式、表格、代码块、保存
#   2. untidy.md —— 「一键整理」：悬浮按钮出现、点它、结果落盘且文字一个都没少
#   3. 从链接打开 —— 真的去 GitHub 下一本书回来（要联网，连不上就记 SKIP）
set -euo pipefail
cd "$(dirname "$0")/../.."
BIN="${1:-src-tauri/target.noindex/debug/mdpad}"
WORK=$(mktemp -d)
cp -R tests/smoke/. "$WORK"

run_app() { # run_app <文档> <测试脚本> <日志名> [等待秒数]；应用自己跑完会退出
  # MDPAD_LIBRARY_DIR 指向临时目录，否则第 3 段会往用户真实的 ~/Documents/MDPad 里写书
  MDPAD_DATA_DIR="$WORK/.data-$3" MDPAD_LIBRARY_DIR="$WORK/library-$3" \
    MDPAD_TEST_JS="$(cat "tests/smoke/$2")" "$BIN" "$1" 2> "$WORK/$3.txt" &
  local pid=$!
  for _ in $(seq 1 "${4:-60}"); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill "$pid" 2>/dev/null || true
  cat "$WORK/$3.txt"
}

echo "=== 1. 打开、编辑、保存 ==="
run_app "$WORK/sample.md" test.js log

if grep -q 'loaded=true' "$WORK/log.txt" && grep -q '"katex":true' "$WORK/log.txt" \
  && grep -q '"status":"已保存"' "$WORK/log.txt" && grep -q '"headingMarkers":\["# "\]' "$WORK/log.txt" \
  && grep -q '新增的文字' "$WORK/sample.md"; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

echo
echo "=== 2. 一键整理 ==="
run_app "$WORK/untidy.md" tidy-test.js tidy-log

if grep -q '"appeared":true' "$WORK/tidy-log.txt" && grep -q '"busySeen":true' "$WORK/tidy-log.txt" \
  && grep -q '^# 项目周报$' "$WORK/untidy.md" && grep -q '^## 一、本周进展$' "$WORK/untidy.md" \
  && grep -q '^## 二、下周计划$' "$WORK/untidy.md" && grep -q '完成了登录页面' "$WORK/untidy.md" \
  && grep -q '接入新的导出流程' "$WORK/untidy.md"; then
  echo "PASS tidy"
else
  echo "FAIL tidy"
  exit 1
fi

echo
echo "=== 3. 从链接打开（要联网：下载一个真实的 GitHub 书仓） ==="
run_app "$WORK/sample.md" fetch-test.js fetch-log 180

if grep -q 'verdict=pass' "$WORK/fetch-log.txt"; then
  echo "PASS fetch"
elif grep -q 'verdict=skip' "$WORK/fetch-log.txt"; then
  # 这台机器到不了 GitHub。链接识别与解压的围栏已由 cargo test 的单测覆盖，
  # 所以这里只记 SKIP，不让网络问题挡住发版。
  echo "SKIP fetch（连不上 GitHub，未验证端到端）"
else
  echo "FAIL fetch"
  exit 1
fi
