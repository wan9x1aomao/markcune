"""Renders the bright MarkCune app icon to src-tauri/app-icon.png (+ the full-bleed macOS version).

The design is drawn on the old 1024 grid (100px of clear space) and then scaled up to the
macOS icon grid the system's own icons use — see BODY below.

整套图标这样重做，顺序别换：

    python3 scripts/icon.py                 # 写 app-icon.png（圆角、带透明）、app-icon-mac.png（满版不透明）、
                                            #    app-icon-win.png（贴满画布的圆角版）
    npx tauri icon src-tauri/app-icon.png   # 生成全套（Windows .ico、小尺寸 png、icns）
    python3 scripts/icon.py --icns          # 用满版图重建 macOS 的 icon.icns（覆盖上一步）
    python3 scripts/icon.py --ico           # 用贴满画布的图重建 Windows 的 icon.ico（覆盖上一步）
    rm -rf src-tauri/icons/android src-tauri/icons/ios src-tauri/icons/64x64.png \\
           src-tauri/icons/StoreLogo.png src-tauri/icons/Square*.png

后两条必须在 `tauri icon` 之后跑，因为那一步会拿 app-icon.png（带 12.5% 透明留白）重刷 icns 与 ico。
它还会顺带生成 iOS / Android / Windows Store 的一整套，而本项目只在 tauri.conf.json 里用到 6 个文件。
之后再手动把 icons/128x128@2x.png 覆盖到 mdpad-site/icon.png、icons/32x32.png 覆盖到 favicon.png。

⚠️ 为什么 Windows 也要单独一份（2026-10-19）
Windows 不会像 macOS 那样裁掉透明边，托盘、资源管理器、开始菜单都是**原样**画：
带 12.5% 留白的图标，在旁边的 Chrome、VS Code（都是贴满画布）中间明显小一圈，
看起来就像"图标没换"。所以给 Windows 一份贴满画布、只保留圆角的图，
16 到 256 六个尺寸齐全（含 20/40/96/128 这些高 DPI 才用得到的），全部 32bpp。

⚠️ 为什么 macOS 要单独一份满版不透明图（2026-10-17 实测，别再走弯路）
macOS 26 里改「留白多少」根本没用：拿 NSWorkspace.icon(forFile:) 渲染验证过，
一幅 60% 的方块和一幅 100% 的方块，系统都先裁掉透明边再缩放到同一个方框里 ——
所以 824 / 896 / 1024 三种留白在程序坞里长得**一模一样**。
真正的差别在**有没有透明像素**：带透明边的图，系统会在下面垫一块中性灰底板
（实测 208,208,208）再把图案缩小放上去 —— 这才是「没填满」的真身；
把画布填成完全不透明，图案就直接铺满整个圆角方块，与系统自带图标齐平。
"""
import struct
import subprocess
import sys
import tempfile
from io import BytesIO
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageChops

S = 4  # supersampling
N = 1024 * S
PAD, R = 100 * S, 166 * S  # the tile in design coordinates; R grows with it, see BODY

# macOS 26 的图标网格：实测系统自带图标（计算器 / Safari / 备忘录 …）的图形都占画布 87.5%
# （1024 画布上留白 64px），圆角半径约图形的 20%。
# 我们原来按旧网格留白 100px（80.5%），在 Dock 里比旁边的图标小一圈，看着"没填满"。
BODY = 896                 # 824 的设计稿放大到 896
DESIGN = 1024 - 2 * 100    # 设计稿中方块的实际边长
GROW = BODY / DESIGN


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def gradient(size, top, bottom, diagonal=False):
    w, h = size
    g = Image.new('RGBA', (1, 256))
    for y in range(256):
        g.putpixel((0, y), lerp(top, bottom, y / 255))
    g = g.resize((w, h), Image.BILINEAR) if not diagonal else g.resize((w * 2, h * 2), Image.BILINEAR).rotate(45).crop((w // 2, h // 2, w // 2 + w, h // 2 + h))
    return g


def mask_rrect(box, radius):
    m = Image.new('L', (N, N), 0)
    ImageDraw.Draw(m).rounded_rectangle(box, radius, fill=255)
    return m


icon = Image.new('RGBA', (N, N), (0, 0, 0, 0))
tile = (PAD, PAD, N - PAD, N - PAD)
tile_mask = mask_rrect(tile, R)

# Tile: white fading to a cool tint, with a soft glow of color in two corners.
bg = gradient((N, N), (255, 255, 255, 255), (236, 241, 252, 255))
glow = Image.new('RGBA', (N, N), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse((N * 0.52, N * 0.50, N * 1.10, N * 1.08), fill=(124, 92, 255, 70))
gd.ellipse((-N * 0.10, -N * 0.12, N * 0.40, N * 0.38), fill=(59, 160, 246, 40))
glow = glow.filter(ImageFilter.GaussianBlur(70 * S))
bg = Image.alpha_composite(bg, glow)
icon.paste(bg, (0, 0), tile_mask)

# Hairline edge so the white tile still reads on a light Dock or desktop.
edge = Image.new('RGBA', (N, N), (0, 0, 0, 0))
ImageDraw.Draw(edge).rounded_rectangle(tile, R, outline=(28, 40, 72, 34), width=3 * S)
icon = Image.alpha_composite(icon, edge)

d = ImageDraw.Draw(icon)

# Sparkle, top right: a four-pointed star in warm amber with a small companion.
def sparkle(cx, cy, r, color):
    k = r * 0.22
    pts = [(cx, cy - r), (cx + k, cy - k), (cx + r, cy), (cx + k, cy + k), (cx, cy + r), (cx - k, cy + k), (cx - r, cy), (cx - k, cy - k)]
    d.polygon([(x * S, y * S) for x, y in pts], fill=color)

sparkle(812, 236, 52, (255, 176, 46, 255))
sparkle(742, 168, 22, (255, 120, 120, 255))

# The mark: "M" in ink, a down arrow in a blue-violet gradient.
ink = (31, 42, 68, 255)
W = 74  # stroke width
top, bottom = 400, 690
m = [(236, bottom), (236, top), (356, 556), (476, top), (476, bottom)]
d.line([(x * S, y * S) for x, y in m], fill=ink, width=W * S, joint='curve')
for x, y in (m[0], m[-1], m[1], m[3]):
    d.ellipse(((x - W / 2) * S, (y - W / 2) * S, (x + W / 2) * S, (y + W / 2) * S), fill=ink)

arrow = Image.new('L', (N, N), 0)
ad = ImageDraw.Draw(arrow)
ax = 682
ad.line([(ax * S, top * S), (ax * S, (bottom - 70) * S)], fill=255, width=W * S)
ad.ellipse(((ax - W / 2) * S, (top - W / 2) * S, (ax + W / 2) * S, (top + W / 2) * S), fill=255)
head = [(ax - 128, bottom - 130), (ax + 128, bottom - 130), (ax, bottom + 18)]
ad.polygon([(x * S, y * S) for x, y in head], fill=255)
arrow = arrow.filter(ImageFilter.GaussianBlur(S * 3)).point(lambda v: 255 if v > 128 else v * 2 if v > 64 else 0)
fill = gradient((N, N), (59, 108, 246, 255), (124, 92, 255, 255))
icon.paste(fill, (0, 0), arrow)

# Accent line under the mark, like a text baseline with a caret.
line_y = 790
d.rounded_rectangle((236 * S, (line_y - 9) * S, 600 * S, (line_y + 9) * S), 9 * S, fill=(31, 42, 68, 38))
cap = gradient((90 * S, 18 * S), (59, 108, 246, 255), (124, 92, 255, 255))
cap_mask = Image.new('L', cap.size, 0)
ImageDraw.Draw(cap_mask).rounded_rectangle((0, 0, cap.size[0] - 1, cap.size[1] - 1), 9 * S, fill=255)
icon.paste(cap, (622 * S, (line_y - 9) * S), cap_mask)

# 整体等比放大到 macOS 26 的网格：方块、发丝边、图形一起放大，构图比例一点不变。
square = icon.crop((PAD, PAD, N - PAD, N - PAD))
side = round(DESIGN * S * GROW)
square = square.resize((side, side), Image.LANCZOS)
canvas = Image.new('RGBA', (N, N), (0, 0, 0, 0))
offset = (N - side) // 2
canvas.paste(square, (offset, offset))
# 放大后方块的圆角也跟着变大了，按同一比例重新裁一次，让它和系统图标的圆角对上。
grid = mask_rrect((offset, offset, offset + side, offset + side), round(R * GROW))
canvas.putalpha(ImageChops.multiply(canvas.getchannel('A'), grid))

canvas.resize((1024, 1024), Image.LANCZOS).save('src-tauri/app-icon.png')

# Windows 专用：同一幅构图，贴满画布但保留圆角 —— Windows 不裁透明边，留白就是实打实的小一圈。
# 圆角按同一比例放大，和系统里其它应用的圆角方块看起来一致。
win_side = 1024
win = icon.crop((PAD, PAD, N - PAD, N - PAD)).resize((win_side, win_side), Image.LANCZOS)
win_mask = mask_rrect((0, 0, win_side, win_side), round(R / (DESIGN * S) * win_side))
win.putalpha(ImageChops.multiply(win.getchannel('A'), win_mask))
win.save('src-tauri/app-icon-win.png')

# macOS 专用：同一幅构图，但铺满画布且**没有任何透明像素**（见文件头的实测说明）。
# 铺满靠的是把方块直接拉到满版、垫一层同色渐变接住圆角处的空隙，系统之后自己会切圆角。
bleed = icon.crop((PAD, PAD, N - PAD, N - PAD)).resize((N, N), Image.LANCZOS)
backdrop = gradient((N, N), (255, 255, 255, 255), (236, 241, 252, 255)).convert('RGBA')
backdrop.alpha_composite(bleed)
backdrop.putalpha(Image.new('L', (N, N), 255))
backdrop.resize((1024, 1024), Image.LANCZOS).save('src-tauri/app-icon-mac.png')

print(f'wrote src-tauri/app-icon.png — 图形占画布 {BODY / 1024 * 100:.1f}%，圆角 {round(R * GROW / S)}/1024')
print('wrote src-tauri/app-icon-mac.png — 满版不透明（macOS 用）')
print(f'wrote src-tauri/app-icon-win.png — 贴满画布、保留圆角（Windows 用，圆角 {round(R / (DESIGN * S) * 1024)}/1024）')


def build_icns(source: str, target: str) -> None:
    """Rebuilds an .icns from one PNG, so the macOS icon can differ from the Windows one."""
    sizes = [(16, '16x16'), (32, '16x16@2x'), (32, '32x32'), (64, '32x32@2x'),
             (128, '128x128'), (256, '128x128@2x'), (256, '256x256'), (512, '256x256@2x'),
             (512, '512x512'), (1024, '512x512@2x')]
    image = Image.open(source).convert('RGBA')
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / 'icon.iconset'
        iconset.mkdir()
        for pixels, name in sizes:
            image.resize((pixels, pixels), Image.LANCZOS).save(iconset / f'icon_{name}.png')
        subprocess.run(['iconutil', '-c', 'icns', '-o', target, str(iconset)], check=True)


if '--icns' in sys.argv:
    # 这一步必须在 `npx tauri icon` 之后跑，否则会被它生成的 icns 覆盖。
    build_icns('src-tauri/app-icon-mac.png', 'src-tauri/icons/icon.icns')
    print('rebuilt src-tauri/icons/icon.icns from app-icon-mac.png (满版不透明)')


def _bmp_frame(image: Image.Image, size: int) -> bytes:
    """One 32bpp icon frame in the classic DIB form: BITMAPINFOHEADER + bottom-up BGRA + AND mask.

    Small frames are written this way rather than as PNG: the shell only grew PNG support at
    256x256, and older menu/taskbar paths still read the DIB form.
    """
    frame = image.resize((size, size), Image.LANCZOS)
    header = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, size * size * 4, 0, 0, 0, 0)
    rows = []
    for y in range(size - 1, -1, -1):
        row = bytearray()
        for x in range(size):
            r, g, b, a = frame.getpixel((x, y))
            row += bytes((b, g, r, a))
        rows.append(bytes(row))
    # 1bpp AND mask: every pixel opaque, rows padded to 4 bytes.
    mask_row = bytes(((size + 31) // 32) * 4)
    return header + b''.join(rows) + mask_row * size


def build_ico(source: str, target: str) -> None:
    """Rebuilds the Windows icon from the full-bleed artwork, with every size Explorer asks for.

    `tauri icon` writes 16/24/32/48/64/256 from the padded artwork; Windows never trims that padding,
    so the same icon reads smaller than its neighbours in the taskbar and in Explorer. The extra
    20/40/96/128 frames are the ones Windows asks for at 125% / 150% / 200% scaling.
    """
    image = Image.open(source).convert('RGBA')
    sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    frames = []
    for size in sizes:
        if size == 256:
            buffer = BytesIO()
            image.resize((size, size), Image.LANCZOS).save(buffer, format='PNG')
            frames.append(buffer.getvalue())
        else:
            frames.append(_bmp_frame(image, size))
    header = struct.pack('<HHH', 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries = b''
    for size, data in zip(sizes, frames):
        entries += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    Path(target).write_bytes(header + entries + b''.join(frames))


if '--ico' in sys.argv:
    build_ico('src-tauri/app-icon-win.png', 'src-tauri/icons/icon.ico')
    print('rebuilt src-tauri/icons/icon.ico from app-icon-win.png (贴满画布，16–256 共 10 个尺寸)')
