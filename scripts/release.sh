#!/bin/bash
# 发布一个新版本：macOS 在本机打包，Windows 和 Linux 由 GitHub Actions 打包，
# 然后生成三平台共用的 latest.json，并把它和固定文件名的安装包上传到草稿 Release。
#
#   KEEP_RELEASE=1 scripts/release.sh <版本号> [更新说明]
#   例如：KEEP_RELEASE=1 scripts/release.sh 4.0.6 "修复了若干问题"
#
# 需要：已登录 gh（~/.local/bin/gh auth login）、改动都已提交、scripts/release.conf 已填写。
# 生成的文件在 release/<版本号>/（版本号文件名，本地归档）。
# GitHub Release 上只留固定文件名，这样 releases/latest/download/<文件名> 在草稿发布后能对上。
# SITE_DIR 留空则不写本地站点；填了目录才走原来的站点复制。
# 草稿默认保留。发布更新：gh release edit v<版本号> --draft=false
# 只有 KEEP_RELEASE=0 会删掉草稿（连同更新文件一起删掉）。
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
# Git for Windows checks this file out as CRLF. A trailing CR would be compiled into the update URL.
UPDATE_ENDPOINT=${UPDATE_ENDPOINT%$'\r'}
DOWNLOAD_BASE_URL=${DOWNLOAD_BASE_URL%$'\r'}
SITE_DIR=${SITE_DIR%$'\r'}
SIGNING_KEY_FILE=${SIGNING_KEY_FILE%$'\r'}
TIDY_URL=${TIDY_URL:-}
TIDY_URL=${TIDY_URL%$'\r'}
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
  for (const file of ["package.json", "src-tauri/tauri.conf.json", "package-lock.json"]) {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    json.version = process.env.VERSION;
    // package-lock.json 里还有一个 packages[""].version，tests/rebrand.test.mjs 会核对。
    if (file === "package-lock.json") json.packages[""].version = process.env.VERSION;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  }'
sed -i '' "s/^version = \".*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
(cd src-tauri && cargo update -p mdpad --offline >/dev/null 2>&1 || true)

# 1.5 许可清单的标题里印着版本号，必须跟着这一版一起重生成。
#     漏了这步，CI 的 npm test 会在 licenses.test.mjs 上失败（三个平台一起红）；
#     就算侥幸绕过，面板里也会写着上一版的版本号。生成器读 package.json，所以只能排在 bump 之后。
echo "生成第三方许可清单…"
if ! npm run licenses >/dev/null; then
  echo "生成许可清单失败，已停止发布"
  exit 1
fi
if ! node tests/licenses.test.mjs; then
  echo "许可清单与当前版本对不上，已停止发布"
  exit 1
fi
echo

if [[ -n "$(git status --porcelain)" ]]; then
  git add -A package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock \
    src/licenses-text.js THIRD-PARTY-NOTICES.md
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
# Unset stays empty so today's unencrypted key keeps working. Export the variable
# before running this script once the key itself has a passphrase. The value is never printed.
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
npx tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":true}}'

OUT="release/$VERSION"
rm -rf "$OUT" && mkdir -p "$OUT"
BUNDLE=src-tauri/target.noindex/release/bundle/macos
MAC="MarkCune-${VERSION}-macOS-arm64"
cp "$BUNDLE/MarkCune.app.tar.gz" "$OUT/$MAC.tar.gz"
cp "$BUNDLE/MarkCune.app.tar.gz.sig" "$OUT/$MAC.tar.gz.sig"
scripts/make-dmg.sh "$BUNDLE/MarkCune.app" "$OUT/$MAC.dmg"

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

WIN="MarkCune-${VERSION}-windows-x64-setup.exe"
LINUX="MarkCune-${VERSION}-linux-x86_64.AppImage"
DEB="MarkCune-${VERSION}-linux-amd64.deb"
for file in "$WIN" "$WIN.sig" "$LINUX" "$LINUX.sig" "$DEB"; do
  [[ -f "$OUT/$file" ]] || { echo "缺少 $file"; exit 1; }
done

# Fixed names are what releases/latest/download/<name> serves. Versioned names stay in
# release/<版本号>/ as a local archive. Signatures cover file bytes, so the rename stays valid.
# 3. latest.json + the fixed-name copies. MANUAL_UPGRADE=1 still writes latest.json locally
#    but does not upload it, so publishing the draft does not arm an automatic update.
# Always pass one flag. An empty "${array[@]}" under set -u aborts on macOS bash 3.2.
ASSET_ARGS=(--latest)
if [[ "${MANUAL_UPGRADE:-0}" == "1" ]]; then
  ASSET_ARGS=(--no-latest)
fi
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/markcune-release.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
# 这些赋值只作用于这一条 node 命令。shell 里的 MAC / WIN / LINUX / DEB 仍是带版本号的文件名。
VERSION="$VERSION" NOTES="$NOTES" BASE="$DOWNLOAD_BASE_URL" OUT="$OUT" \
  DMG="$MAC.dmg" MAC="$MAC.tar.gz" WIN="$WIN" LINUX="$LINUX" DEB="$DEB" \
  node scripts/github-release-assets.mjs stage "$STAGE" "${ASSET_ARGS[@]}"
rm -f "$OUT"/*.sig

echo
echo "已生成 ${OUT}："
ls -lh "$OUT" | tail -n +2

if [[ "${MANUAL_UPGRADE:-0}" == "1" ]]; then
  echo
  echo "MANUAL_UPGRADE=1：latest.json 只留在 ${OUT}，不上传到 Release，也不写入站点。"
  echo "  发布这个草稿不会替换 ${UPDATE_ENDPOINT}。"
elif [[ -n "$SITE_DIR" ]]; then
  # Pages are checked before latest.json or the packages replace the live copies.
  # A failure leaves the previous HTML, JSON and packages in place.
  # These names match scripts/github-release-assets.mjs (FIXED) and scripts/update-site.mjs.
  SITE_MAC_DMG="MarkCune-macOS-arm64.dmg"
  SITE_MAC="MarkCune-macOS-arm64.tar.gz"
  SITE_WIN="MarkCune-windows-x64-setup.exe"
  SITE_LINUX="MarkCune-linux-x86_64.AppImage"
  SITE_DEB="MarkCune-linux-amd64.deb"
  if [[ -f "$SITE_DIR/index.html" ]]; then
    node scripts/update-site.mjs "$SITE_DIR" "$VERSION" \
      "mac=$OUT/$MAC.dmg" "windows=$OUT/$WIN" "linux=$OUT/$LINUX" "deb=$OUT/$DEB" \
      "mac-updater=$OUT/$MAC.tar.gz" "latest=$OUT/latest.json"
  else
    mkdir -p "$SITE_DIR/downloads"
    cp "$OUT/$MAC.dmg"    "$SITE_DIR/downloads/$SITE_MAC_DMG"
    cp "$OUT/$MAC.tar.gz" "$SITE_DIR/downloads/$SITE_MAC"
    cp "$OUT/$WIN"        "$SITE_DIR/downloads/$SITE_WIN"
    cp "$OUT/$LINUX"      "$SITE_DIR/downloads/$SITE_LINUX"
    cp "$OUT/$DEB"        "$SITE_DIR/downloads/$SITE_DEB"
    cp "$OUT/latest.json" "$SITE_DIR/latest.json"
  fi
  echo
  echo "已额外放入站点目录 ${SITE_DIR}。自动更新不读这个目录，读的是 GitHub Release。"
else
  echo
  echo "SITE_DIR 为空，不写本地站点目录。"
fi

# 4. The draft Release is the update server. CI already uploaded versioned Windows / Linux
#    names; replace the asset list with the fixed names (and latest.json) and drop the rest.
upload_github_release() {
  local expected="$STAGE/expected.txt"
  local -a files
  local name uploaded="" attempt assets extra
  files=()
  node scripts/github-release-assets.mjs names "${ASSET_ARGS[@]}" > "$expected"
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    [[ -f "$STAGE/$name" ]] || { echo "缺少待上传文件 $name"; exit 1; }
    files+=("$STAGE/$name")
  done < "$expected"
  [[ ${#files[@]} -gt 0 ]] || { echo "没有要上传的文件"; exit 1; }

  for attempt in 1 2 3; do
    if "$GH" release upload "v$VERSION" "${files[@]}" --clobber; then
      uploaded=1
      break
    fi
    echo "上传 GitHub Release 中断（第 $attempt 次），5 秒后重试…"
    sleep 5
  done
  [[ -n "$uploaded" ]] || { echo "没能上传到草稿 Release v$VERSION"; exit 1; }

  assets=$("$GH" release view "v$VERSION" --json assets)
  printf '%s' "$assets" > "$STAGE/assets.json"
  node scripts/github-release-assets.mjs extra-assets "$STAGE/assets.json" "${ASSET_ARGS[@]}" > "$STAGE/extra.tsv"
  while IFS=$'\t' read -r name extra; do
    [[ -n "$name" ]] || continue
    echo "从 Release 去掉重复资产：$name"
    "$GH" api -X DELETE "$extra" >/dev/null
  done < "$STAGE/extra.tsv"

  local ok=""
  for attempt in 1 2 3; do
    "$GH" release view "v$VERSION" --json assets > "$STAGE/assets.json"
    if node scripts/github-release-assets.mjs check-assets "$STAGE/assets.json" "${ASSET_ARGS[@]}"; then
      ok=1
      break
    fi
    echo "资产列表还没对上（第 $attempt 次），2 秒后重试…"
    sleep 2
  done
  [[ -n "$ok" ]] || { echo "草稿 Release v$VERSION 的资产和固定文件名不一致，先不要发布"; exit 1; }

  echo
  echo "草稿 Release v${VERSION} 的资产已与固定文件名一致："
  node scripts/github-release-assets.mjs names "${ASSET_ARGS[@]}"
}
upload_github_release
rm -rf "$STAGE"

# Notes only. --draft=false is what publishes; this edit leaves the draft as a draft.
if [[ -n "$NOTES" ]]; then
  "$GH" release edit "v$VERSION" --title "MarkCune $VERSION" --notes "$NOTES" \
    || echo "更新 Release 说明失败。资产已经在草稿上，可以稍后自己改说明。"
fi

# 草稿就是更新源，默认留下。KEEP_RELEASE=1 与不设置都保留；KEEP_RELEASE=0 才删除。
finish_release() {
  local is_draft
  if [[ "${KEEP_RELEASE:-1}" == "0" ]]; then
    is_draft=$("$GH" release view "v$VERSION" --json isDraft --jq .isDraft 2>/dev/null || true)
    case "$is_draft" in
      true)
        # 草稿的 tag 还没在远端创建，不要加 --cleanup-tag：删一个不存在的 tag 会非零退出。
        "$GH" release delete "v$VERSION" --yes >/dev/null 2>&1 || true
        if [[ -z "$("$GH" release view "v$VERSION" --json tagName --jq .tagName 2>/dev/null || true)" ]]; then
          echo
          echo "KEEP_RELEASE=0：已删除草稿 Release v${VERSION}。更新文件只留在 ${OUT}，/releases/latest 不会指向这一版。"
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
    return 0
  fi
  echo
  echo "草稿 Release v${VERSION} 已留好。草稿不会出现在 /releases/latest。"
  echo "要让这一版对外提供更新，执行："
  echo "  $GH release edit v${VERSION} --draft=false"
  if [[ "${MANUAL_UPGRADE:-0}" == "1" ]]; then
    echo "MANUAL_UPGRADE=1：这次没有上传 latest.json。发布后 /releases/latest 只会带上安装包，不会推送自动更新。"
  else
    echo "发布之后，/releases/latest 才指向 v${VERSION}，${DOWNLOAD_BASE_URL}/ 下的固定文件名和 latest.json 才会被客户端读到。"
  fi
}
finish_release
