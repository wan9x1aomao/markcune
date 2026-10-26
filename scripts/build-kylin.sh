#!/usr/bin/env bash
# 压 glibc 基线，编出能装进麒麟（以及更老的发行版）的 Linux 包。
#
# 为什么需要这个脚本：
#   CI 在 ubuntu-22.04 上编，产物的 libc 符号最高到 GLIBC_2.34；
#   麒麟桌面 V10 SP1（2203 起）是 glibc 2.31，装得上也起不来。
#   这里用 zig cc 当链接器，把符号版本压到指定基线，其余流程与正常打包一致。
#
# 为什么不做交叉编译：
#   aarch64 需要在 x86 机器上有 arm64 的 webkit2gtk-4.1 头文件，而且 AppImage
#   根本没法交叉。arm64 请用 GitHub 的 ubuntu-22.04-arm runner（仓库是 public，免费），
#   或在一台 arm64 机器上跑本脚本。这里只负责"本机架构 + 降基线"。
#
# 用法：
#   scripts/build-kylin.sh                  # 本机架构，基线 2.31（麒麟 V10 SP1 2203+）
#   scripts/build-kylin.sh --glibc 2.28     # 更老的基线（麒麟 2107 / 早期镜像）
#   scripts/build-kylin.sh --appimage       # 连 AppImage 一起出（仅本机架构）
#   scripts/build-kylin.sh --relax-deps     # 重打 deb，去掉 webkit2gtk-4.1 依赖声明（危险，见下）
#
# 产物落在 dist/kylin/，不碰 build.yml、release.sh、latest.json。

set -euo pipefail

GLIBC="2.31"
ARCH=""
OUT_DIR="dist/kylin"
WANT_APPIMAGE=0
SKIP_DEPS=0
RELAX_DEPS=0

die() { printf '\n[失败] %s\n' "$1" >&2; exit 1; }
info() { printf '\n==> %s\n' "$1"; }
warn() { printf '\n[注意] %s\n' "$1" >&2; }

usage() {
	 sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
	exit 0
}

while [ $# -gt 0 ]; do
	case "$1" in
		--glibc) GLIBC="${2:-}"; shift 2 ;;
		--arch) ARCH="${2:-}"; shift 2 ;;
		--out) OUT_DIR="${2:-}"; shift 2 ;;
		--appimage) WANT_APPIMAGE=1; shift ;;
		--skip-deps) SKIP_DEPS=1; shift ;;
		--relax-deps) RELAX_DEPS=1; shift ;;
		-h|--help) usage ;;
		*) die "不认识的参数：$1（--help 看用法）" ;;
	esac
done

case "$GLIBC" in
	2.28|2.31) ;;
	*) die "--glibc 只支持 2.28 或 2.31（其它基线没有验证过，别乱试）" ;;
esac

# ---------- 环境预检 ----------
info "检查环境"
[ "$(uname -s)" = "Linux" ] || die "这个脚本要在 Linux 上跑（Debian 12 已验证）"

# 允许在任意目录运行：脚本自己找仓库根，不依赖你 cd 到哪。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/release.conf" ] && [ -f "$SCRIPT_DIR/../package.json" ]; then
	cd "$SCRIPT_DIR/.."
elif [ -f scripts/release.conf ] && [ -f package.json ]; then
	: # 已经在仓库根
else
	die "找不到仓库根（需要 scripts/release.conf 和 package.json）。

  两种办法：
    cd ~/mdpad && ./scripts/build-kylin.sh      # 进仓库里跑
    cp /root/build-kylin.sh ~/mdpad/scripts/    # 或者把脚本放进仓库的 scripts/ 再跑"
fi
printf '   仓库 %s\n' "$(pwd)"

HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
	x86_64) HOST_TRIPLE_ARCH="x86_64" ;;
	aarch64|arm64) HOST_TRIPLE_ARCH="aarch64" ;;
	*) die "不支持的架构：$HOST_ARCH" ;;
esac
ARCH="${ARCH:-$HOST_TRIPLE_ARCH}"
[ "$ARCH" = "$HOST_TRIPLE_ARCH" ] || die "本脚本只做本机架构。

  你要的是 $ARCH，但这台机器是 $HOST_ARCH。交叉编译的坑（arm64 的 webkit2gtk-4.1
  头文件、AppImage 无法交叉）不值得踩。arm64 有两条正路：
    1) 用 GitHub 的 ubuntu-22.04-arm runner 跑本脚本（仓库是 public，免费）
    2) 开一台鲲鹏/飞腾机器，或在本地用 UTM 装麒麟 arm64，在那里跑本脚本"

TRIPLE="${ARCH}-unknown-linux-gnu"
UPPER="$(echo "$TRIPLE" | tr 'a-z-' 'A-Z_')"
LOWER="$(echo "$TRIPLE" | tr '-' '_')"
ZIG_TRIPLE="${ARCH}-linux-gnu.${GLIBC}"

if [ -f /etc/os-release ]; then
	# shellcheck disable=SC1091
	. /etc/os-release
	case "${ID:-}" in
		debian|ubuntu) ;;
		*) warn "发行版是 ${ID:-未知}，本脚本按 Debian/Ubuntu 的包名写的，可能需要你自己改依赖" ;;
	esac
fi

command -v node >/dev/null 2>&1 || die "缺 node。装 Node 22：
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
command -v cargo >/dev/null 2>&1 || die "缺 rust。装：
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && source \"\$HOME/.cargo/env\""

[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node 太老（需要 20+）"

# ---------- 系统依赖 ----------
SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

if [ "$SKIP_DEPS" -eq 0 ]; then
	info "安装构建依赖（webkit2gtk-4.1 是 Tauri 2 的硬依赖）"
	$SUDO apt-get update
	$SUDO apt-get install -y --no-install-recommends \
		build-essential pkg-config libssl-dev patchelf file \
		libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
		libxdo-dev libasound2-dev xvfb
else
	info "跳过依赖安装（--skip-deps）"
fi

if ! pkg-config --exists webkit2gtk-4.1; then
	die "pkg-config 找不到 webkit2gtk-4.1。

  麒麟上缺的正是它，但这里是编译机，必须有它才能编：
    sudo apt install libwebkit2gtk-4.1-dev
  如果 apt 装不上，说明这个镜像太老，换 Debian 12 / Ubuntu 22.04+。"
fi

# ---------- zig ----------
info "定位 zig"
ZIG_BIN=""
if command -v zig >/dev/null 2>&1; then
	ZIG_BIN="$(command -v zig)"
elif command -v python3 >/dev/null 2>&1 && python3 -c 'import ziglang' 2>/dev/null; then
	ZIG_BIN="$(python3 -c 'import os,ziglang;print(os.path.join(os.path.dirname(ziglang.__file__),"zig"))')"
fi
[ -n "$ZIG_BIN" ] && [ -x "$ZIG_BIN" ] || die "没找到 zig。Debian 12 的 pip 是 externally-managed，不能直接 --user 装，
  用 venv 再软链出来（PyPI 走清华源）：
    python3 -m venv /opt/zigvenv
    /opt/zigvenv/bin/pip install -i https://pypi.tuna.tsinghua.edu.cn/simple ziglang
    ln -sf \"\$(/opt/zigvenv/bin/python -c 'import os,ziglang;print(os.path.join(os.path.dirname(ziglang.__file__),\"zig\"))')\" /usr/local/bin/zig
  或者从 https://ziglang.org/download/ 下 linux-$HOST_ARCH 的 tar.xz 解压，把 zig 加进 PATH。"
printf '   zig: %s (%s)\n' "$ZIG_BIN" "$("$ZIG_BIN" version 2>/dev/null || echo '版本未知')"

# ---------- 链接器包装 ----------
# zig cc 直接当 rustc 的链接器：把 -target <arch>-linux-gnu.<glibc> 固定在包装里，
# 这样不用改 .cargo/config.toml，也不用传 RUSTFLAGS（不会污染缓存）。
LINKER_DIR="$(mktemp -d)"
trap 'rm -rf "$LINKER_DIR"' EXIT
WRAP="$LINKER_DIR/zigcc"
{
	cat <<'WRAPPER'
#!/bin/bash
# 这个包装同时充当 rustc 的链接器和 cc-rs 的 CC/CXX。
#
# cc-rs 会自己往命令行里塞 --target=x86_64-unknown-linux-gnu（rust 的三元组），
# 但 zig 的 target 语法里没有 "unknown" 这个 OS，写法必须是 x86_64-linux-gnu，
# 所以它会直接报 "unable to parse target query ... UnknownOperatingSystem"；
# 而且那个参数排在后面，会把下面 exec 里的 -target 覆盖掉。
# 处理办法：先把上游的 target 全部剥掉（含 -target 后面独立成项的值），再换成我们的。
args=()
skip=0
for a in "$@"; do
	if [ "$skip" = 1 ]; then skip=0; continue; fi
	case "$a" in
		--target=*) continue ;;
		-target) skip=1; continue ;;
		# aarch64 目标上 rustc 会自动加这个（Cortex-A53 芯片勘误 843419 的修补）。
		# zig cc 的链接参数是白名单式的，不认识它就整条命令失败：
		#   error: unsupported linker arg: --fix-cortex-a53-843419
		# 丢掉是安全的：它只对早期 A53 内核有意义，而麒麟桌面跑的是飞腾 D2000
		# （FTC663）和鲲鹏 920（TaiShan v110），都是 A72 系内核，不涉及这个勘误。
		-Wl,--fix-cortex-a53-*) continue ;;
	esac
	args+=("$a")
done

# 只在「链接」时加这个参数（有 -c 就是在编 C 源码，不需要）：
# 系统里的 libasound / libglib / libgmodule 是拿 2.35 的头编的，它们自己引用
# GLIBC_2.33/2.34 的符号；而我们链到的是 2.31 的桩库，链接器默认
# --no-allow-shlib-undefined，于是报一堆 undefined reference——注意那些引用
# 来自 /usr/lib 下的 .so，不是我们的代码。放行它们是对的：运行时这些符号由
# 目标机（麒麟）自己那套同名库提供，而麒麟的库本来就是按 2.31 编的。
link=1
for a in "${args[@]}"; do [ "$a" = "-c" ] && { link=0; break; }; done
extra=()
[ "$link" -eq 1 ] && extra=(-Wl,--allow-shlib-undefined)
WRAPPER
	echo "exec \"$ZIG_BIN\" cc -target $ZIG_TRIPLE \"\${extra[@]}\" \"\${args[@]}\""
} > "$WRAP"
chmod +x "$WRAP"

export "CARGO_TARGET_${UPPER}_LINKER=$WRAP"
export "CC_${LOWER}=$WRAP"
export "CXX_${LOWER}=$WRAP"

info "编译目标"
printf '   架构    %s\n   基线    glibc %s\n   链接器  %s\n' "$ARCH" "$GLIBC" "$ZIG_TRIPLE"

# ---------- 打包参数 ----------
# 和 build.yml 保持一致：更新地址来自 release.conf，写进二进制就不能再改。
# shellcheck disable=SC1091
source scripts/release.conf
export MDPAD_UPDATE_ENDPOINT="$UPDATE_ENDPOINT"
if [ -n "${TIDY_URL:-}" ]; then export MDPAD_TIDY_URL="$TIDY_URL"; fi
printf '\n   更新地址 %s\n   一键整理 %s\n' "$MDPAD_UPDATE_ENDPOINT" "${MDPAD_TIDY_URL:-未配置（只做规则整理）}"

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
printf '   版本     %s\n' "$VERSION"

[ -d node_modules ] || { info "安装前端依赖"; npm ci; }

BUNDLES="deb"
if [ "$WANT_APPIMAGE" -eq 1 ]; then
	BUNDLES="deb appimage"
	warn "AppImage 会静态打包 webkit 之外的运行时，体积 80MB 量级；它在麒麟上的
  可用性不如 deb（麒麟的 kysec 对未签名 AppImage 有限制），建议只做备选。"
fi

# ---------- 构建 ----------
info "开始构建（首次 15-30 分钟，之后走增量）"
# shellcheck disable=SC2086
npx tauri build --target "$TRIPLE" --bundles $BUNDLES

BUNDLE_DIR="src-tauri/target.noindex/$TRIPLE/release/bundle"
[ -d "$BUNDLE_DIR" ] || BUNDLE_DIR="src-tauri/target/$TRIPLE/release/bundle"
[ -d "$BUNDLE_DIR" ] || die "找不到打包产物目录，构建可能没走到 bundle 阶段"

# ---------- 基线校验 ----------
BIN="src-tauri/target.noindex/$TRIPLE/release/mdpad"
[ -f "$BIN" ] || BIN="src-tauri/target/$TRIPLE/release/mdpad"
[ -f "$BIN" ] || die "找不到可执行文件，无法校验基线"

info "校验 glibc 基线"
ACTUAL="$(readelf -V "$BIN" 2>/dev/null | grep -oE 'GLIBC_2\.[0-9]+' | sed 's/GLIBC_//' | sort -uV | tail -1)"
[ -n "$ACTUAL" ] || die "读不出 glibc 符号版本（readelf 没输出），别发这个包"
printf '   实测最高符号 GLIBC_%s（目标 ≤ %s）\n' "$ACTUAL" "$GLIBC"

# 取两者较大值；如果较大值不是目标值，说明超标了。
HIGHEST="$(printf '%s\n%s\n' "$GLIBC" "$ACTUAL" | sort -V | tail -1)"
if [ "$HIGHEST" != "$GLIBC" ]; then
	die "基线没压住：产物要求 GLIBC_$ACTUAL，比目标 $GLIBC 新，装到麒麟上会报
  'version GLIBC_$ACTUAL not found'。常见原因：某个依赖用了系统里自带的静态库，
  或链接器包装没生效（检查 CARGO_TARGET_${UPPER}_LINKER）。"
fi

# ---------- 收产物 ----------
mkdir -p "$OUT_DIR"
DEB_SRC="$(ls "$BUNDLE_DIR"/deb/*.deb 2>/dev/null | head -1)"
[ -n "$DEB_SRC" ] || die "没生成 deb"
DEB_OUT="$OUT_DIR/MarkCune-$VERSION-linux-$ARCH-glibc$GLIBC.deb"
cp "$DEB_SRC" "$DEB_OUT"

if [ "$RELAX_DEPS" -eq 1 ]; then
	warn "--relax-deps：把 deb 的 Depends 改成只剩 libgtk-3-0。

  为什么可能要用：麒麟的 webkit2gtk-4.1 如果不是标准包名，dpkg -i 会因为
  '依赖关系不满足: libwebkit2gtk-4.1-0' 直接拒绝安装，哪怕库其实已经在。
  为什么危险：依赖声明没了，缺库也不会在安装时告诉你，只会在启动时白屏/报错。
  只在"已经确认目标机装了 4.1 运行时、只是包名不匹配"时用。"
	TMP_DEB="$(mktemp -d)"
	dpkg-deb -R "$DEB_OUT" "$TMP_DEB/pkg"
	sed -i 's/^Depends:.*/Depends: libgtk-3-0/' "$TMP_DEB/pkg/DEBIAN/control"
	dpkg-deb -b "$TMP_DEB/pkg" "$DEB_OUT" >/dev/null
	rm -rf "$TMP_DEB"
fi

if [ "$WANT_APPIMAGE" -eq 1 ]; then
	APP_SRC="$(ls "$BUNDLE_DIR"/appimage/*.AppImage 2>/dev/null | head -1)"
	[ -n "$APP_SRC" ] && cp "$APP_SRC" "$OUT_DIR/MarkCune-$VERSION-linux-$ARCH-glibc$GLIBC.AppImage"
fi

# ---------- 汇报 ----------
info "完成"
printf '   产物   %s\n   大小   %s\n   SHA256 %s\n' \
	"$DEB_OUT" \
	"$(du -h "$DEB_OUT" | cut -f1)" \
	"$(sha256sum "$DEB_OUT" | cut -d' ' -f1)"
printf '\n   deb 架构与依赖：\n'
dpkg-deb -f "$DEB_OUT" Package Version Architecture Depends | sed 's/^/     /'

cat <<'EOF'

下一步：
  1) 拷到麒麟机器：scp dist/kylin/*.deb user@<麒麟机>:/tmp/
  2) 在麒麟上装：  sudo dpkg -i /tmp/MarkCune-*.deb
  3) 如果报 "依赖关系不满足: libwebkit2gtk-4.1-0"，说明目标机缺 4.1 运行时——
     这是麒麟侧的问题，不是这个包的问题。要么补 4.1 的 deb（麒麟开发者社区 /
     信创适配库），要么用 --relax-deps 重打一个只在你确认库已存在时使用。
  4) 起不来先看报错：`ldd $(which mdpad) | grep "not found"` 和 `mdpad` 直接跑。
EOF
