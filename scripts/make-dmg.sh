#!/bin/bash
# 把 MarkCune.app 打成带背景图的安装 DMG：左边是应用，右边是「应用程序」，中间提示拖过去。
#
#   scripts/make-dmg.sh <MarkCune.app 路径> <输出 .dmg 路径>
#
# 背景图源文件是 scripts/dmg/background.html，改完后运行 scripts/dmg/render.sh 重新生成 background.tiff。
# 窗口布局要经过访达。访达忙或 AppleEvent 超时时会重试；仍失败则输出可安装但无自定义摆放的 DMG，不让发版中断。
set -euo pipefail

APP="${1:?用法：scripts/make-dmg.sh <MarkCune.app> <输出.dmg>}"
OUT="${2:?用法：scripts/make-dmg.sh <MarkCune.app> <输出.dmg>}"
BG="$(cd "$(dirname "$0")" && pwd)/dmg/background.tiff"
VOL="MarkCune"
# Window content is 640×400 to match the background; icon positions are icon centres.
W=640; H=400; ICON=112; APP_X=160; APPS_X=480; ICON_Y=200

STAGE=$(mktemp -d)
RW="$STAGE.rw.dmg"
DEV=""
cleanup() {
  if [[ -n "${DEV:-}" ]]; then
    hdiutil detach -quiet "$DEV" -force 2>/dev/null || true
    DEV=""
  fi
  if [[ -d "/Volumes/$VOL" ]]; then
    hdiutil detach -quiet "/Volumes/$VOL" -force 2>/dev/null || true
  fi
  rm -rf "$STAGE" "$RW"
}
trap cleanup EXIT

cp -R "$APP" "$STAGE/MarkCune.app"
ln -s /Applications "$STAGE/应用程序"
mkdir "$STAGE/.background"
cp "$BG" "$STAGE/.background/background.tiff"

# A volume with this name already mounted would make Finder lay out the wrong window.
if [[ -d "/Volumes/$VOL" ]]; then
  hdiutil detach -quiet "/Volumes/$VOL" -force
fi
hdiutil create -quiet -volname "$VOL" -srcfolder "$STAGE" -fs HFS+ -format UDRW -ov "$RW"
DEV=$(hdiutil attach -readwrite -noverify -noautoopen "$RW" | awk '/Apple_HFS/ {print $1}')
[[ -n "$DEV" ]] || { echo "无法挂载临时 DMG"; exit 1; }

ready=""
for _ in $(seq 1 30); do
  if [[ -d "/Volumes/$VOL/MarkCune.app" && -L "/Volumes/$VOL/应用程序" ]]; then
    ready=1
    break
  fi
  sleep 1
done
[[ -n "$ready" ]] || { echo "临时 DMG 挂载后未出现 /Volumes/$VOL"; exit 1; }
# Give Finder a moment to notice the volume before talking to it.
sleep 2

layout_ok=""
for attempt in 1 2 3; do
  if osascript <<EOF
with timeout of 60 seconds
  tell application "Finder"
    tell disk "$VOL"
      open
      delay 2
      set win to container window
      set current view of win to icon view
      set toolbar visible of win to false
      set statusbar visible of win to false
      set bounds of win to {200, 120, 200 + $W, 120 + $H + 28}
      set opts to icon view options of win
      set arrangement of opts to not arranged
      set icon size of opts to $ICON
      set text size of opts to 13
      set background picture of opts to file ".background:background.tiff"
      set position of item "MarkCune.app" of win to {$APP_X, $ICON_Y}
      set position of item "应用程序" of win to {$APPS_X, $ICON_Y}
      update without registering applications
      delay 1
      close
    end tell
  end tell
end timeout
EOF
  then
    layout_ok=1
    break
  fi
  echo "访达摆放 DMG 窗口失败（第 ${attempt} 次），稍后重试…"
  sleep 3
done

if [[ -z "$layout_ok" ]]; then
  echo "访达仍无法摆放窗口（常见原因：本机挂着很多安装盘，AppleEvent 超时）。将生成可安装的普通 DMG，不带自定义背景。"
fi

# Hide the background folder and make the window open automatically on mount.
SetFile -a V "/Volumes/$VOL/.background" 2>/dev/null || true
bless --folder "/Volumes/$VOL" --openfolder "/Volumes/$VOL" 2>/dev/null || true
rm -rf "/Volumes/$VOL/.fseventsd"
sync
hdiutil detach -quiet "$DEV"
DEV=""
hdiutil convert -quiet "$RW" -format UDZO -imagekey zlib-level=9 -ov -o "$OUT"
