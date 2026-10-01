# Destruitor Idle: tira do cliente 15.11 as imagens dos itens da loja (e do equipamento inicial e das pocoes).
# Roda na VPS:  python3 /opt/idle/src/tools/sprites.py
#   le  /root/idle-dl/things1511 (appearances-*.dat + catalog-content.json + sprites-*.bmp.lzma)
#   gera /opt/idle/gateway/public/itens/<id>.png
#
# Sao artes da CipSoft: so valem com o jogo fechado (senha). Antes de abrir ao publico, trocar por arte propria.
#
# Formato (conferido no OTClient 4.1, spriteappearances.cpp):
#   sprites-*.bmp.lzma = zeros + 70 0A FA 80 24 + tamanho em 7 bits (cabecalho de 32 bytes da CipSoft)
#                        + LZMA (1 byte de propriedades, 4 do dicionario, 8 do tamanho) -> BMP 384x384
#   no BMP o magenta (255,0,255) e transparente; spritetype 0=32x32, 1=32x64, 2=64x32, 3=64x64
import glob
import io
import json
import lzma
import os
import re

from PIL import Image, ImageChops

ASSETS = os.environ.get("ASSETS", "/root/idle-dl/things1511")  # ASSETS=...: rodar com uma copia local
OUT = "/opt/idle/gateway/public/itens"
SHOP = "/opt/idle/idle-scripts/idle_shop.lua"
PRICES = "/opt/idle/idle-scripts/idle_prices.lua"

# equipamento inicial (send_first_items do Canary) e pocoes/munição que aparecem na pagina
EXTRA = [3059, 3074, 7991, 7992, 3362, 3552, 3572, 3066, 3425, 3277, 3571, 8095, 3374, 7773, 3359, 3354, 3372,
         3350, 3447, 7774, 3327, 266, 268, 236, 237, 239, 238, 7642, 7643, 23373, 3031, 3035, 3043,
         # icones da tela do jogo (barra de cima, postura, stamina): itens do proprio Tibia
         3392, 3280, 3281, 3059, 2854, 2871, 2906, 2821, 2816, 2972, 3409, 3422, 17722,
         # magias na barra de acoes: runa/item do Tibia que lembra cada uma
         3051, 3052, 3098, 3152, 3160, 3198, 3189, 3158, 3175, 3155, 3200, 3149, 3191, 3192, 3202, 3161,
         3164, 3182, 7367, 7378, 3278, 3287, 7368, 3279, 3342, 3319, 3079]


# ---------------------------------------------------------------- protobuf minimo
def varint(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        if c < 0x80:
            return r, i
        s += 7


def fields(b):
    """Gera (numero, tipo, valor) de uma mensagem protobuf."""
    i = 0
    while i < len(b):
        key, i = varint(b, i)
        num, wt = key >> 3, key & 7
        if wt == 0:
            v, i = varint(b, i)
        elif wt == 2:
            n, i = varint(b, i)
            v = b[i:i + n]
            i += n
        elif wt == 5:
            v = b[i:i + 4]
            i += 4
        elif wt == 1:
            v = b[i:i + 8]
            i += 8
        else:
            raise ValueError("tipo protobuf %d" % wt)
        yield num, wt, v


def first_sprite(appearance):
    """Appearance: 1=id, 2=frame_group; FrameGroup: 3=sprite_info; SpriteInfo: 5=sprite_id (repetido)."""
    oid, sprite = None, None
    for num, wt, v in fields(appearance):
        if num == 1 and wt == 0:
            oid = v
        elif num == 2 and wt == 2 and sprite is None:
            for n2, w2, v2 in fields(v):
                if n2 == 3 and w2 == 2:
                    for n3, w3, v3 in fields(v2):
                        if n3 == 5:
                            if w3 == 0:
                                sprite = v3
                            else:  # empacotado
                                sprite, _ = varint(v3, 0)
                            break
                    break
    return oid, sprite


catalog = [x for x in json.load(open(ASSETS + "/catalog-content.json")) if x["type"] == "sprite"]
SIZES = {0: (32, 32), 1: (32, 64), 2: (64, 32), 3: (64, 64)}
sheets = {}


def sheet(entry):
    f = entry["file"]
    if f not in sheets:
        raw = open(os.path.join(ASSETS, f), "rb").read()
        i = 0
        while raw[i] == 0:
            i += 1
        assert raw[i:i + 5] == b"\x70\x0A\xFA\x80\x24", "cabecalho CIP inesperado em " + f
        i += 5
        while raw[i] & 0x80:  # tamanho em 7 bits
            i += 1
        i += 1
        props = raw[i]
        dict_size = int.from_bytes(raw[i + 1:i + 5], "little")
        data = raw[i + 1 + 4 + 8:]
        lc, rem = props % 9, props // 9
        lp, pb = rem % 5, rem // 5
        bmp = lzma.decompress(data, format=lzma.FORMAT_RAW, filters=[{"id": lzma.FILTER_LZMA1, "dict_size": dict_size, "lc": lc, "lp": lp, "pb": pb}])
        img = Image.open(io.BytesIO(bmp)).convert("RGB")
        # magenta (255,0,255) = transparente, feito com operacoes de imagem (pixel a pixel em Python e lento)
        r, g, b = img.split()
        magenta = ImageChops.multiply(ImageChops.multiply(r.point(lambda v: 255 if v == 255 else 0), g.point(lambda v: 255 if v == 0 else 0)),
                                      b.point(lambda v: 255 if v == 255 else 0))
        img = img.convert("RGBA")
        img.putalpha(ImageChops.invert(magenta))
        if len(sheets) > 64:  # guarda poucas folhas na memoria
            sheets.pop(next(iter(sheets)))
        sheets[f] = img
    return sheets[f]


def main():
    want = set(EXTRA)
    for m in re.finditer(r"\bid = (\d+)", open(SHOP, encoding="utf-8").read()):
        want.add(int(m.group(1)))
    # tudo o que o NPC compra (loot da mochila, Venda rapida e Despachar loot)
    if os.path.exists(PRICES):
        for m in re.finditer(r"\[(\d+)\]\s*=", open(PRICES, encoding="utf-8").read()):
            want.add(int(m.group(1)))
    # colares e aneis dos botoes AUTO do Inventario (rodar tools/acessorios.py antes)
    acc = os.path.join(OUT, "acessorios.json")
    if os.path.exists(acc):
        for e in json.load(open(acc, encoding="utf-8")).get("itens", []):
            want.add(int(e["id"]))

    apps = open(glob.glob(ASSETS + "/appearances-*.dat")[0], "rb").read()
    sprite_of = {}
    for num, wt, v in fields(apps):
        if num == 1 and wt == 2:  # object
            oid, sp = first_sprite(v)
            if oid in want and sp is not None:
                sprite_of[oid] = sp

    os.makedirs(OUT, exist_ok=True)
    done = 0
    for oid, sp in sorted(sprite_of.items()):
        entry = next((c for c in catalog if c["firstspriteid"] <= sp <= c["lastspriteid"]), None)
        if not entry:
            continue
        w, h = SIZES[entry["spritetype"]]
        img = sheet(entry)
        cols = img.width // w
        k = sp - entry["firstspriteid"]
        x, y = (k % cols) * w, (k // cols) * h
        tile = img.crop((x, y, x + w, y + h))
        box = tile.getbbox()
        if not box:
            continue
        # centraliza num quadrado de 64 (os de 32 dobram de tamanho, sem borrar)
        if (w, h) == (32, 32):
            tile = tile.resize((64, 64), Image.NEAREST)
        canvas = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        canvas.paste(tile, ((64 - tile.width) // 2, (64 - tile.height) // 2), tile)
        canvas.save(os.path.join(OUT, "%d.png" % oid), optimize=True)
        done += 1
    print("itens pedidos:", len(want), "| com sprite:", len(sprite_of), "| imagens salvas:", done, "| folhas lidas:", len(sheets))


if __name__ == "__main__":
    main()
