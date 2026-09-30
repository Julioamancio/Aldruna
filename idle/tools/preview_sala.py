# Desenha uma sala (salas/<id>.json + .png) como a pagina vai desenhar, para conferir.
#   python3 preview_sala.py dragoes /tmp/sala.png
import json
import sys

from PIL import Image

rid, out = sys.argv[1], sys.argv[2]
base = "/opt/idle/gateway/public/salas/" + rid
r = json.load(open(base + ".json"))
atlas = Image.open(base + ".png")
T = 32
W, H = r["w"], r["h"]
fx, fy, fz = r["from"]
img = Image.new("RGBA", ((W + 1) * T, (H + 1) * T), (0, 0, 0, 255))
COLS = 16


def cell(oid, px, py):
    a = r["atlas"].get(str(oid))
    if not a:
        return None, a
    k = a[1] * COLS + a[0] + (py % a[3]) * a[2] + (px % a[2])
    return atlas.crop(((k % COLS) * 64, (k // COLS) * 64, (k % COLS) * 64 + 64, (k // COLS) * 64 + 64)), a


tiles = sorted(r["tiles"], key=lambda t: (t[1], t[0]))
for layer_pass in (0, 1):  # 1a passada: chao; 2a: o resto
    for t in tiles:
        if t[2] != 0:
            continue
        dx, dy, ids = t[0], t[1], t[3:]
        wx, wy = fx + dx, fy + dy
        sx, sy = (dx + W // 2 + 1) * T, (dy + H // 2 + 1) * T
        elev = 0
        items = sorted(ids, key=lambda i: (r["atlas"].get(str(i), [0, 0, 1, 1, 3])[4]))
        for oid in items:
            c, a = cell(oid, wx, wy)
            if c is None:
                continue
            if (a[4] == 0) != (layer_pass == 0):
                continue
            c = c.resize((T * 2, T * 2), Image.NEAREST)
            img.alpha_composite(c, (sx - T - a[5] // 2 - elev, sy - T - a[6] // 2 - elev))
            elev += a[7] // 2
img.save(out)
print("ok", img.size)
