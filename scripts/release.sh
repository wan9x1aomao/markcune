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

# gh 的长连接在代理抖动时会直接断掉（Post "https://api.github.com/graphql": EOF），而 CI 其实跑得好好的。
# 所以等打包不用 `gh run watch`，改成短轮询：每次只问一次状态，断一次不算失败。
# 返回 0 成功、1 失败、2 超时。
wait_for_run() {
  local id=$1 deadline=$((SECONDS + 2700)) status conclusion
  while (( SECONDS < deadline )); do
    status=""
    conclusion=""
    if read -r status conclusion < <("$GH" run view "$id" --json status,conclusion \
      --jq '"\(.status) \(.conclusion)"' 2>/dev/null); then
      if [[ "$status" == "completed" ]]; then
        [[ "$conclusion" == "success" ]] && return 0 || return 1
      fi
    fi
    sleep 20
  done
  return 2
}

# 0. 单元测试：和 Windows / Linux 的 CI 走同一个 npm test，测试不过就不发布，
#    这样 macOS 这一侧也不会漏掉一道闸（CI 只覆盖 Windows 和 Linux）。
echo "运行单元测试…"
if ! npm test; then
  echo "单元测试没有通过，已停止发布"
  exit 1
fi
echo

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
"$GH" workflow run build.yml --ref "$(git branch --show-current)" \
  || { echo "触发 Actions 失败，重试一次…"; sleep 3; "$GH" workflow run build.yml --ref "$(git branch --show-current)"; }
RUN=""
for _ in $(seq 1 30); do
  RUN=$("$GH" run list --workflow build.yml --limit 5 --json databaseId,headSha \
    --jq ".[] | select(.headSha == \"$COMMIT\") | .databaseId" 2>/dev/null | head -1 || true)
  [[ -n "$RUN" ]] && break
  sleep 2
done
[[ -n "$RUN" ]] || { echo "没能启动 GitHub Actions 打包"; exit 1; }
echo "Windows / Linux 正在 GitHub Actions 上打包：$("$GH" run view "$RUN" --json url --jq .url)"

export MDPAD_UPDATE_ENDPOINT="$UPDATE_ENDPOINT"
# 「一键整理」的网关地址。留空则不注入，应用只做规则整理。
# Windows / Linux 由 build.yml 从同一个 release.conf 读，三个平台的取值完全一致。
if [[ -n "${TIDY_URL:-}" ]]; then
  export MDPAD_TIDY_URL="$TIDY_URL"
  echo "整理服务：$MDPAD_TIDY_URL"
else
  echo "整理服务：未配置，这一次的包只做规则整理"
fi
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
if wait_for_run "$RUN"; then
  :
else
  code=$?
  [[ $code == 1 ]] && echo "GitHub Actions 打包失败" || echo "等了 45 分钟仍未结束"
  echo "详情：$("$GH" run view "$RUN" --json url --jq .url 2>/dev/null || echo "run $RUN")"
  exit 1
fi

# Same proxy: a dropped connection mid-download is worth three tries, not a lost release.
downloaded=""
for attempt in 1 2 3; do
  if "$GH" release download "v$VERSION" -D "$OUT" --clobber; then
    downloaded=1
    break
  fi
  echo "下载 CI 产物中断（第 $attempt 次），5 秒后重试…"
  sleep 5
done
[[ -n "$downloaded" ]] || { echo "没能下载 CI 产物，可手动执行：$GH release download v$VERSION -D $OUT --clobber"; exit 1; }

WIN="MDPad-${VERSION}-windows-x64-setup.exe"
LINUX="MDPad-${VERSION}-linux-x86_64.AppImage"
DEB="MDPad-${VERSION}-linux-amd64.deb"
for file in "$WIN" "$WIN.sig" "$LINUX" "$LINUX.sig" "$DEB"; do
  [[ -f "$OUT/$file" ]] || { echo "缺少 $file"; exit 1; }
done

# The site serves each platform under one fixed name, overwritten on every release; release/<版本号>/
# keeps the versioned names as an archive. Signatures cover file contents, so renaming keeps them valid.
SITE_MAC_DMG="MDPad-macOS-arm64.dmg"
SITE_MAC="MDPad-macOS-arm64.tar.gz"
SITE_WIN="MDPad-windows-x64-setup.exe"
SITE_LINUX="MDPad-linux-x86_64.AppImage"
SITE_DEB="MDPad-linux-amd64.deb"

# 3. One latest.json for every platform (non-ASCII escaped so any viewer shows it correctly).
# Signatures come from the versioned files in $OUT; urls point at the fixed names on the site.
VERSION="$VERSION" NOTES="$NOTES" BASE="$DOWNLOAD_BASE_URL" OUT="$OUT" \
  MAC="$MAC.tar.gz" WIN="$WIN" LINUX="$LINUX" \
  SITE_MAC="$SITE_MAC" SITE_WIN="$SITE_WIN" SITE_LINUX="$SITE_LINUX" node -e '
  const fs = require("fs");
  const { VERSION, NOTES, BASE, OUT, MAC, WIN, LINUX, SITE_MAC, SITE_WIN, SITE_LINUX } = process.env;
  const entry = (file, name) => ({ signature: fs.readFileSync(`${OUT}/${file}.sig`, "utf8"), url: `${BASE}/${name}` });
  const manifest = {
    version: VERSION,
    notes: NOTES,
    pub_date: new Date().toISOString(),
    platforms: {
      "darwin-aarch64": entry(MAC, SITE_MAC),
      "windows-x86_64": entry(WIN, SITE_WIN),
      "linux-x86_64": entry(LINUX, SITE_LINUX),
    },
  };
  const text = JSON.stringify(manifest, null, 2).replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  fs.writeFileSync(`${OUT}/latest.json`, text + "\n");'
rm "$OUT"/*.sig

echo
echo "已生成 ${OUT}："
ls -lh "$OUT" | tail -n +2

if [[ -n "$SITE_DIR" ]]; then
  mkdir -p "$SITE_DIR/downloads"
  cp "$OUT/$MAC.dmg"    "$SITE_DIR/downloads/$SITE_MAC_DMG"
  cp "$OUT/$MAC.tar.gz" "$SITE_DIR/downloads/$SITE_MAC"
  cp "$OUT/$WIN"        "$SITE_DIR/downloads/$SITE_WIN"
  cp "$OUT/$LINUX"      "$SITE_DIR/downloads/$SITE_LINUX"
  cp "$OUT/$DEB"        "$SITE_DIR/downloads/$SITE_DEB"
  cp "$OUT/latest.json" "$SITE_DIR/latest.json"
  [[ -f "$SITE_DIR/index.html" ]] && node scripts/update-site.mjs "$SITE_DIR" "$VERSION" \
    "mac=$OUT/$MAC.dmg" "windows=$OUT/$WIN" "linux=$OUT/$LINUX" "deb=$OUT/$DEB"
  echo
  echo "已放入官网目录 ${SITE_DIR}，用 WorkBuddy 重新发布这个目录即可。"
else
  echo
  echo "发布步骤：把 latest.json 以外的文件改成固定文件名后上传到 ${DOWNLOAD_BASE_URL}/，再把 latest.json 上传到 ${UPDATE_ENDPOINT}："
  echo "  $MAC.dmg → $SITE_MAC_DMG"
  echo "  $MAC.tar.gz → $SITE_MAC"
  echo "  $WIN → $SITE_WIN"
  echo "  $LINUX → $SITE_LINUX"
  echo "  $DEB → $SITE_DEB"
fi

# 4. 删掉本次的草稿 Release。它只是 Windows / Linux 产物的搬运工：资产已经收进
#    release/<版本号>/，也进了官网目录，留着只会一版一个地堆着（2026-10-17 一次清过 8 个）。
#    想让某个版本在 GitHub 上留一份正式 Release，用 KEEP_RELEASE=1 跑（草稿会留着，
#    之后 gh release edit v<版本号> --draft=false 发布）；历史版本靠 git tag 记录。
cleanup_draft() {
  local is_draft
  if [[ -n "${KEEP_RELEASE:-}" ]]; then
    echo
    echo "KEEP_RELEASE=1：保留草稿 Release v${VERSION}，要发布就执行 $GH release edit v${VERSION} --draft=false"
    return 0
  fi
  is_draft=$("$GH" release view "v$VERSION" --json isDraft --jq .isDraft 2>/dev/null || true)
  case "$is_draft" in
    true)
      # 草稿的 tag 还没在远端创建（gh 给的是 untagged-… 占位），所以不要加 --cleanup-tag：
      # 它去删一个不存在的 tag 会以非零码退出，让成功删除被误判成失败。删完按实际状态复核。
      "$GH" release delete "v$VERSION" --yes >/dev/null 2>&1 || true
      if [[ -z "$("$GH" release view "v$VERSION" --json tagName --jq .tagName 2>/dev/null || true)" ]]; then
        echo
        echo "已删除草稿 Release v${VERSION}（资产保留在 ${OUT} 和官网目录）"
      else
        echo
        echo "草稿 Release v$VERSION 没能自动删除，可手动执行：$GH release delete v$VERSION --yes"
      fi
      ;;
    false)
      echo
      echo "Release v$VERSION 已经是正式版，未删除"
      ;;
    *)
      echo
      echo "没有找到 v$VERSION 的 Release，跳过清理"
      ;;
  esac
}
cleanup_draft
