"""Renders the bright MDPad app icon to src-tauri/app-icon.png.

The design is drawn on the old 1024 grid (100px of clear space) and then scaled up to the
macOS icon grid the system's own icons use — see BODY below.

整套图标这样重做，顺序别换：

    python3 scripts/icon.py
    npx tauri icon src-tauri/app-icon.png
    rm -rf src-tauri/icons/android src-tauri/icons/ios src-tauri/icons/64x64.png \\
           src-tauri/icons/StoreLogo.png src-tauri/icons/Square*.png

第三条是因为 `tauri icon` 会顺带生成 iOS / Android / Windows Store 的一整套，
而本项目只在 tauri.conf.json 里用到 6 个文件。之后再手动把
icons/128x128@2x.png 覆盖到 mdpad-site/icon.png、icons/32x32.png 覆盖到 favicon.png。
"""
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
print(f'wrote src-tauri/app-icon.png — 图形占画布 {BODY / 1024 * 100:.1f}%，圆角 {round(R * GROW / S)}/1024')
