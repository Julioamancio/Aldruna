"""Troca o "OTSERVER" do logo do Destruitor por "IDLE".

Entrada: o logo do Julio com fundo transparente (Downloads/Design sem nome.png, 2560x1429).
Saida:  logo_destruitor_idle.png (tamanho original) e ../gateway/public/logo.webp (para a pagina).

Uma placa nova de pedra escura cobre a placa do OTSERVER, e o IDLE e escrito em Georgia Bold com o
mesmo acabamento das letras de DESTRUITOR: contorno escuro, borda de lava e metal claro em cima.
"""
import os
import random
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = r"C:\Users\julio\Downloads\Design sem nome.png"
FONT = r"C:\Windows\Fonts\georgiab.ttf"

base = Image.open(SRC).convert("RGBA")
W, H = base.size

# placa do OTSERVER no original (com folga para cobrir a borda dela)
X0, Y0, X1, Y1 = 918, 1096, 1668, 1266
R = 42


def rounded(box, r, fill=255, size=None):
    m = Image.new("L", size or (W, H), 0)
    ImageDraw.Draw(m).rounded_rectangle(box, r, fill=fill)
    return m


def gradient(box, stops):
    """Gradiente vertical RGBA dentro do retangulo."""
    x0, y0, x1, y1 = box
    g = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(g)
    h = y1 - y0
    for y in range(y0, y1 + 1):
        t = (y - y0) / max(1, h)
        for i in range(len(stops) - 1):
            (ta, ca), (tb, cb) = stops[i], stops[i + 1]
            if ta <= t <= tb:
                k = (t - ta) / max(1e-6, tb - ta)
                c = tuple(int(ca[j] + (cb[j] - ca[j]) * k) for j in range(3))
                break
        d.line([(x0, y), (x1, y)], fill=c + (255,))
    return g


def noise(amount, seed):
    random.seed(seed)
    n = Image.effect_noise((W // 2, H // 2), amount).resize((W, H)).filter(ImageFilter.GaussianBlur(1.2))
    return n


def paint(dst, color_img, mask):
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    layer.paste(color_img, (0, 0), mask)
    dst.alpha_composite(layer)


def solid(rgba):
    return Image.new("RGBA", (W, H), rgba)


out = base.copy()

# ---- placa ----
shadow = rounded((X0 - 4, Y0 + 6, X1 + 4, Y1 + 12), R + 6, 200).filter(ImageFilter.GaussianBlur(10))
paint(out, solid((0, 0, 0, 255)), shadow)
glow = rounded((X0 - 7, Y0 - 7, X1 + 7, Y1 + 7), R + 7, 235).filter(ImageFilter.GaussianBlur(5))
paint(out, solid((214, 78, 22, 255)), glow)
rim = rounded((X0, Y0, X1, Y1), R)
paint(out, solid((28, 12, 9, 255)), rim)
inner_box = (X0 + 8, Y0 + 8, X1 - 8, Y1 - 8)
inner = rounded(inner_box, R - 8)
stone = gradient(inner_box, [(0.0, (74, 60, 55)), (0.5, (50, 40, 37)), (1.0, (33, 25, 23))])
tex = noise(90, 1)
stone = Image.composite(ImageChops.add(stone, Image.merge("RGBA", [tex.point(lambda v: v // 4)] * 3 + [solid((0, 0, 0, 255)).split()[3]])), stone, inner)
paint(out, stone, inner)
# rachaduras finas na pedra, como na placa de DESTRUITOR
cracks = Image.new("L", (W, H), 0)
dc = ImageDraw.Draw(cracks)
random.seed(7)
for _ in range(9):
    cx = random.randint(X0 + 30, X1 - 30)
    cy = random.randint(Y0 + 20, Y1 - 20)
    pts = [(cx, cy)]
    for _ in range(random.randint(3, 6)):
        cx += random.randint(-22, 22)
        cy += random.randint(-16, 16)
        pts.append((cx, cy))
    dc.line(pts, fill=200, width=2)
paint(out, solid((18, 10, 8, 255)), ImageChops.multiply(cracks, inner))
# brilho fino em cima e lava embaixo, por dentro da borda
top_edge = ImageChops.subtract(rounded((X0 + 9, Y0 + 9, X1 - 9, Y1 - 9), R - 9), rounded((X0 + 9, Y0 + 12, X1 - 9, Y1 - 6), R - 9))
paint(out, solid((150, 110, 95, 150)), top_edge)
bottom_edge = ImageChops.subtract(rounded((X0 + 9, Y0 + 9, X1 - 9, Y1 - 8), R - 9), rounded((X0 + 9, Y0 + 6, X1 - 9, Y1 - 13), R - 9))
paint(out, solid((255, 110, 30, 170)), bottom_edge.filter(ImageFilter.GaussianBlur(1.5)))

# ---- IDLE ----
font = ImageFont.truetype(FONT, 176)
text = "IDLE"
spacing = 26
widths = [font.getbbox(c)[2] - font.getbbox(c)[0] for c in text]
total = sum(widths) + spacing * (len(text) - 1)
asc_top = font.getbbox("I")[1]
cap_h = font.getbbox("I")[3] - asc_top
x = (X0 + X1) // 2 - total // 2
y = (Y0 + Y1) // 2 - cap_h // 2 - asc_top + 2
mask = Image.new("L", (W, H), 0)
dm = ImageDraw.Draw(mask)
for c, w in zip(text, widths):
    dm.text((x - font.getbbox(c)[0], y), c, font=font, fill=255)
    x += w + spacing

grow = lambda m, r: m.filter(ImageFilter.MaxFilter(r))
paint(out, solid((0, 0, 0, 255)), grow(mask, 15).filter(ImageFilter.GaussianBlur(5)).point(lambda v: v * 0.8))  # sombra
paint(out, solid((40, 13, 9, 255)), grow(mask, 13))  # contorno escuro
paint(out, solid((205, 72, 26, 255)), grow(mask, 5))  # borda de lava
tb = mask.getbbox()
metal = gradient((tb[0], tb[1], tb[2], tb[3]), [(0.0, (246, 234, 226)), (0.45, (206, 172, 160)), (0.72, (178, 112, 92)), (1.0, (214, 86, 34))])
tex2 = noise(40, 2)
metal = ImageChops.subtract(metal, Image.merge("RGBA", [tex2.point(lambda v: v // 10)] * 3 + [solid((0, 0, 0, 0)).split()[3]]))
paint(out, metal, mask)
# bisel: claro no alto de cada letra, escuro embaixo
hi = ImageChops.subtract(mask, ImageChops.offset(mask, 0, 5)).filter(ImageFilter.GaussianBlur(1))
paint(out, solid((255, 250, 240, 170)), hi)
lo = ImageChops.subtract(mask, ImageChops.offset(mask, 0, -6)).filter(ImageFilter.GaussianBlur(1.5))
paint(out, solid((90, 25, 12, 150)), lo)

out.save(os.path.join(HERE, "logo_destruitor_idle.png"))
box = out.split()[3].getbbox()
pad = 20
crop = out.crop((max(0, box[0] - pad), max(0, box[1] - pad), min(W, box[2] + pad), min(H, box[3] + pad)))
web = crop.resize((900, round(900 * crop.height / crop.width)), Image.LANCZOS)
web.save(os.path.join(HERE, "..", "gateway", "public", "logo.webp"), "WEBP", quality=86, method=6)
prev = Image.new("RGBA", crop.size, (12, 13, 18, 255))
prev.alpha_composite(crop)
prev.convert("RGB").resize((crop.width // 2, crop.height // 2)).save(os.path.join(HERE, "preview_logo.jpg"), quality=88)
print("ok", web.size, os.path.getsize(os.path.join(HERE, "..", "gateway", "public", "logo.webp")) // 1024, "KB")
