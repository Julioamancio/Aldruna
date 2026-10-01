# Desenha um pedaco da cidade (salas/cidade.json + .png) com grade e coordenadas, para planejar decoracao.
#   python preview_cidade.py x0 y0 x1 y1 saida.png [pasta das salas]
# x/y = dx/dy da cidade (o centro do recorte); so o terreo (dz = 0), como a pagina desenha dentro das casas.
import json
import os
import sys

from PIL import Image, ImageDraw

x0, y0, x1, y1 = (int(v) for v in sys.argv[1:5])
out = sys.argv[5]
base = os.path.join(sys.argv[6] if len(sys.argv) > 6 else "/opt/idle/gateway/public/salas", "cidade")
r = json.load(open(base + ".json"))
atlas = Image.open(base + ".png").convert("RGBA")
T, COLS = 32, 16
W, H = x1 - x0 + 1, y1 - y0 + 1
img = Image.new("RGBA", (W * T + T, H * T + T), (0, 0, 0, 255))


def cell(oid, wx, wy):
    a = r["atlas"].get(str(oid))
    if not a:
        return None, None
    k = a[1] * COLS + a[0] + (wy % a[3]) * a[2] + (wx % a[2])
    return atlas.crop(((k % COLS) * 64, (k // COLS) * 64, (k % COLS) * 64 + 64, (k // COLS) * 64 + 64)).resize((64, 64)), a


fx, fy = r["from"][0], r["from"][1]
tiles = sorted([t for t in r["tiles"] if t[2] == 0 and x0 <= t[0] <= x1 and y0 <= t[1] <= y1], key=lambda t: (t[1], t[0]))
for want in ((0, 1), (2, 3), (4,)):
    for t in tiles:
        px, py = (t[0] - x0) * T + T, (t[1] - y0) * T + T
        elev = 0
        items = sorted([(r["atlas"].get(str(i)) or [0, 0, 1, 1, 9])[4] for i in t[3:]])
        for oid in sorted(t[3:], key=lambda i: (r["atlas"].get(str(i)) or [0, 0, 1, 1, 9])[4]):
            im, a = cell(oid, fx + t[0], fy + t[1])
            if im is None or a[4] not in want:
                continue
            img.alpha_composite(im.resize((T * 2, T * 2)), (px - T - (a[5] + elev) * T // 32, py - T - (a[6] + elev) * T // 32))
            if a[4] in (2, 3):
                elev += a[7] or 0
d = ImageDraw.Draw(img)
for gx in range(W + 1):
    d.line([(gx * T + T, T), (gx * T + T, H * T + T)], fill=(255, 255, 255, 40))
for gy in range(H + 1):
    d.line([(T, gy * T + T), (W * T + T, gy * T + T)], fill=(255, 255, 255, 40))
for gx in range(W):
    if (x0 + gx) % 2 == 0:
        d.text((gx * T + T + 4, 6), str(x0 + gx), fill=(255, 230, 120, 255))
for gy in range(H):
    if (y0 + gy) % 2 == 0:
        d.text((2, gy * T + T + 10), str(y0 + gy), fill=(255, 230, 120, 255))
for name, (px, py) in r.get("points", {}).items():
    if x0 <= px <= x1 and y0 <= py <= y1:
        d.rectangle([((px - x0) * T + T, (py - y0) * T + T), ((px - x0) * T + 2 * T, (py - y0) * T + 2 * T)], outline=(80, 255, 80, 255), width=2)
        d.text(((px - x0) * T + T + 2, (py - y0) * T + T + 2), name, fill=(80, 255, 80, 255))
img.save(out)
print("ok", img.size)
