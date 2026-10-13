#!/bin/bash
# 用 Chrome 把 background.html 渲染成 DMG 背景图 background.tiff（同时含 1x 和 2x，视网膜屏也清晰）。
# 只有改了 background.html 才需要运行。
set -euo pipefail
cd "$(dirname "$0")"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

for scale in 1 2; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=$scale \
    --window-size=640,400 --screenshot="$TMP/bg$scale.png" "file://$PWD/background.html" 2>/dev/null
done
sips -s dpiWidth 144 -s dpiHeight 144 "$TMP/bg2.png" >/dev/null
tiffutil -cathidpicheck "$TMP/bg1.png" "$TMP/bg2.png" -out background.tiff >/dev/null
