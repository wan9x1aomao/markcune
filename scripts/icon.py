"""Renders the bright MDPad app icon to src-tauri/app-icon.png (1024x1024, macOS icon grid)."""
from PIL import Image, ImageDraw, ImageFilter, ImageChops

S = 4  # supersampling
N = 1024 * S
PAD, R = 100 * S, 186 * S  # 824px squircle-ish tile, like the previous icon


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

icon = icon.resize((1024, 1024), Image.LANCZOS)
# Keep everything inside the tile.
icon.putalpha(ImageChops.multiply(icon.getchannel('A'), tile_mask.resize((1024, 1024), Image.LANCZOS)))
icon.save('src-tauri/app-icon.png')
print('wrote src-tauri/app-icon.png')
