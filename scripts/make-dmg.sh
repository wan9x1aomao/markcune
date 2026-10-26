#!/bin/bash
# 把 MarkCune.app 打成带背景图的安装 DMG：左边是应用，右边是「应用程序」，中间提示拖过去。
#
#   scripts/make-dmg.sh <MarkCune.app 路径> <输出 .dmg 路径>
#
# 背景图源文件是 scripts/dmg/background.html，改完后运行 scripts/dmg/render.sh 重新生成 background.tiff。
set -euo pipefail

APP="${1:?用法：scripts/make-dmg.sh <MarkCune.app> <输出.dmg>}"
OUT="${2:?用法：scripts/make-dmg.sh <MarkCune.app> <输出.dmg>}"
BG="$(cd "$(dirname "$0")" && pwd)/dmg/background.tiff"
VOL="MarkCune"
# Window content is 640×400 to match the background; icon positions are icon centres.
W=640; H=400; ICON=112; APP_X=160; APPS_X=480; ICON_Y=200

STAGE=$(mktemp -d)
RW="$STAGE.rw.dmg"
trap 'rm -rf "$STAGE" "$RW"' EXIT

cp -R "$APP" "$STAGE/MarkCune.app"
ln -s /Applications "$STAGE/应用程序"
mkdir "$STAGE/.background"
cp "$BG" "$STAGE/.background/background.tiff"

# A volume with this name already mounted would make Finder lay out the wrong window.
[[ -d "/Volumes/$VOL" ]] && hdiutil detach -quiet "/Volumes/$VOL" -force
hdiutil create -quiet -volname "$VOL" -srcfolder "$STAGE" -fs HFS+ -format UDRW -ov "$RW"
DEV=$(hdiutil attach -readwrite -noverify -noautoopen "$RW" | awk '/Apple_HFS/ {print $1}')

# Finder stores the layout in the volume's .DS_Store. The title bar is not part of the
# content area, so the window is made taller by its height.
osascript <<EOF
tell application "Finder"
  tell disk "$VOL"
    open
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
EOF

# Hide the background folder and make the window open automatically on mount.
SetFile -a V "/Volumes/$VOL/.background" 2>/dev/null || true
bless --folder "/Volumes/$VOL" --openfolder "/Volumes/$VOL" 2>/dev/null || true
rm -rf "/Volumes/$VOL/.fseventsd"
sync
hdiutil detach -quiet "$DEV"
hdiutil convert -quiet "$RW" -format UDZO -imagekey zlib-level=9 -ov -o "$OUT"
