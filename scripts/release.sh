#!/bin/bash
# 发布一个新版本：macOS 在本机打包，Windows 和 Linux 由 GitHub Actions 打包，
# 然后生成三平台共用的 latest.json，并更新官网目录。
#
#   scripts/release.sh <版本号> [更新说明]
#   例如：scripts/release.sh 3.3.0 "修复了若干问题"
#
# 需要：已登录 gh（~/.local/bin/gh auth login）、改动都已提交、scripts/release.conf 已填写。
# 生成的文件在 release/<版本号>/，配置了 SITE_DIR 时会直接放进官网目录。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?用法：scripts/release.sh <版本号> [更新说明]}"
NOTES="${2:-}"
GH="${GH:-$HOME/.local/bin/gh}"
# github.com is often only reachable through the system proxy (e.g. Clash); use it if set.
if [[ -z "${HTTPS_PROXY:-}" ]] && scutil --proxy 2>/dev/null | grep -q "HTTPSEnable : 1"; then
  PROXY="http://$(scutil --proxy | awk '/HTTPSProxy/ {print $3}'):$(scutil --proxy | awk '/HTTPSPort/ {print $3}')"
  export HTTPS_PROXY="$PROXY" https_proxy="$PROXY"
fi
SITE_DIR=""
source scripts/release.conf
[[ -n "$UPDATE_ENDPOINT" && -n "$DOWNLOAD_BASE_URL" ]] || { echo "请先在 scripts/release.conf 里填写 UPDATE_ENDPOINT 和 DOWNLOAD_BASE_URL"; exit 1; }
[[ -f "$SIGNING_KEY_FILE" ]] || { echo "找不到签名私钥：$SIGNING_KEY_FILE"; exit 1; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版本号格式应为 x.y.z"; exit 1; }
"$GH" auth status >/dev/null 2>&1 || { echo "请先登录 GitHub：$GH auth login"; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "还有未提交的改动，请先提交，保证三个平台打包的是同一份代码"; exit 1; }

# 1. One version everywhere, committed so GitHub Actions builds exactly this code.
VERSION="$VERSION" node -e '
  const fs = require("fs");
  for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    json.version = process.env.VERSION;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  }'
sed -i '' "s/^version = \".*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
(cd src-tauri && cargo update -p mdpad --offline >/dev/null 2>&1 || true)
if [[ -n "$(git status --porcelain)" ]]; then
  git add -A package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
  git commit -q -m "发布 v$VERSION"
fi
git push -q
COMMIT=$(git rev-parse HEAD)

# 2. Windows and Linux on GitHub Actions, macOS here, at the same time.
"$GH" workflow run build.yml --ref "$(git branch --show-current)"
RUN=""
for _ in $(seq 1 30); do
  RUN=$("$GH" run list --workflow build.yml --limit 5 --json databaseId,headSha \
    --jq ".[] | select(.headSha == \"$COMMIT\") | .databaseId" | head -1)
  [[ -n "$RUN" ]] && break
  sleep 2
done
[[ -n "$RUN" ]] || { echo "没能启动 GitHub Actions 打包"; exit 1; }
echo "Windows / Linux 正在 GitHub Actions 上打包：$("$GH" run view "$RUN" --json url --jq .url)"

export MDPAD_UPDATE_ENDPOINT="$UPDATE_ENDPOINT"
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$SIGNING_KEY_FILE")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npx tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":true}}'

OUT="release/$VERSION"
rm -rf "$OUT" && mkdir -p "$OUT"
BUNDLE=src-tauri/target.noindex/release/bundle/macos
MAC="MDPad-${VERSION}-macOS-arm64"
cp "$BUNDLE/MDPad.app.tar.gz" "$OUT/$MAC.tar.gz"
cp "$BUNDLE/MDPad.app.tar.gz.sig" "$OUT/$MAC.tar.gz.sig"
scripts/make-dmg.sh "$BUNDLE/MDPad.app" "$OUT/$MAC.dmg"

echo "等待 Windows / Linux 打包完成…"
"$GH" run watch "$RUN" --exit-status --interval 30 >/dev/null || {
  echo "GitHub Actions 打包失败，详情：$("$GH" run view "$RUN" --json url --jq .url)"; exit 1; }
"$GH" release download "v$VERSION" -D "$OUT" --clobber

WIN="MDPad-${VERSION}-windows-x64-setup.exe"
LINUX="MDPad-${VERSION}-linux-x86_64.AppImage"
DEB="MDPad-${VERSION}-linux-amd64.deb"
for file in "$WIN" "$WIN.sig" "$LINUX" "$LINUX.sig" "$DEB"; do
  [[ -f "$OUT/$file" ]] || { echo "缺少 $file"; exit 1; }
done

# 3. One latest.json for every platform (non-ASCII escaped so any viewer shows it correctly).
VERSION="$VERSION" NOTES="$NOTES" BASE="$DOWNLOAD_BASE_URL" OUT="$OUT" MAC="$MAC.tar.gz" WIN="$WIN" LINUX="$LINUX" node -e '
  const fs = require("fs");
  const { VERSION, NOTES, BASE, OUT, MAC, WIN, LINUX } = process.env;
  const entry = (file) => ({ signature: fs.readFileSync(`${OUT}/${file}.sig`, "utf8"), url: `${BASE}/${file}` });
  const manifest = {
    version: VERSION,
    notes: NOTES,
    pub_date: new Date().toISOString(),
    platforms: { "darwin-aarch64": entry(MAC), "windows-x86_64": entry(WIN), "linux-x86_64": entry(LINUX) },
  };
  const text = JSON.stringify(manifest, null, 2).replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  fs.writeFileSync(`${OUT}/latest.json`, text + "\n");'
rm "$OUT"/*.sig

echo
echo "已生成 ${OUT}："
ls -lh "$OUT" | tail -n +2

if [[ -n "$SITE_DIR" ]]; then
  mkdir -p "$SITE_DIR/downloads"
  cp "$OUT/$MAC.dmg" "$OUT/$MAC.tar.gz" "$OUT/$WIN" "$OUT/$LINUX" "$OUT/$DEB" "$SITE_DIR/downloads/"
  cp "$OUT/latest.json" "$SITE_DIR/latest.json"
  [[ -f "$SITE_DIR/index.html" ]] && node scripts/update-site.mjs "$SITE_DIR" "$VERSION" \
    "mac=$OUT/$MAC.dmg" "windows=$OUT/$WIN" "linux=$OUT/$LINUX"
  echo
  echo "已放入官网目录 ${SITE_DIR}，用 WorkBuddy 重新发布这个目录即可。"
else
  echo
  echo "发布步骤：把 latest.json 以外的文件上传到 ${DOWNLOAD_BASE_URL}/，再把 latest.json 上传到 ${UPDATE_ENDPOINT}。"
fi
