#!/bin/bash
# Smoke test: open sample.md in a debug build, edit and save it, then check the result.
# Build first with: npx tauri build --debug --no-bundle
set -euo pipefail
cd "$(dirname "$0")/../.."
BIN="${1:-src-tauri/target.noindex/debug/mdpad}"
WORK=$(mktemp -d)
cp -R tests/smoke/. "$WORK"

MDPAD_DATA_DIR="$WORK/.data" MDPAD_TEST_JS="$(cat tests/smoke/test.js)" "$BIN" "$WORK/sample.md" 2> "$WORK/log.txt" &
PID=$!
for _ in $(seq 1 60); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
kill "$PID" 2>/dev/null || true
cat "$WORK/log.txt"

if grep -q 'loaded=true' "$WORK/log.txt" && grep -q '"katex":true' "$WORK/log.txt" \
  && grep -q '"status":"已保存"' "$WORK/log.txt" && grep -q '"headingMarkers":\["# "\]' "$WORK/log.txt" \
  && grep -q '新增的文字' "$WORK/sample.md"; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi
