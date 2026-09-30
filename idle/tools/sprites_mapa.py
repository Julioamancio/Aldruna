# Destruitor Idle: imagens das salas (uma folha "atlas" por sala) para a visao da cacada.
# Roda na VPS depois do salas.py:  python3 /opt/idle/src/tools/sprites_mapa.py
#   le  /opt/idle/gateway/public/salas/<id>.json (tiles da sala) e os assets 15.11
#   gera /opt/idle/gateway/public/salas/<id>.png e acrescenta "atlas" no <id>.json:
#        atlas[id do item] = [coluna, linha, padroesX, padroesY, camada, deslocX, deslocY, altura]
#        camada: 0 chao, 1 borda do chao, 2 parede/embaixo, 3 comum, 4 por cima dos personagens
#   celula de 64x64; sprite de 32x32 vai no quadrado de baixo a direita (como o Tibia desenha)
#
# Sao artes da CipSoft: so valem com o jogo fechado (senha).
import glob
import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sprites import ASSETS, SIZES, catalog, fields, sheet, varint  # noqa: E402
from PIL import Image  # noqa: E402

ROOMS = "/opt/idle/gateway/public/salas"
COLS = 16  # celulas por linha no atlas


def parse_object(v):
    """Appearance de objeto: id, padroes/sprites do 1o frame group e as flags de desenho."""
    info = {"id": None, "px": 1, "py": 1, "pz": 1, "layers": 1, "ids": [], "order": 3, "sx": 0, "sy": 0, "elev": 0}
    for num, wt, val in fields(v):
        if num == 1 and wt == 0:
            info["id"] = val
        elif num == 2 and wt == 2 and not info["ids"]:
            for n2, w2, v2 in fields(val):
                if n2 == 3 and w2 == 2:
                    for n3, w3, v3 in fields(v2):
                        if n3 == 1 and w3 == 0:
                            info["px"] = v3
                        elif n3 == 2 and w3 == 0:
                            info["py"] = v3
                        elif n3 == 3 and w3 == 0:
                            info["pz"] = v3
                        elif n3 == 4 and w3 == 0:
                            info["layers"] = v3
                        elif n3 == 5:
                            if w3 == 0:
                                info["ids"].append(v3)
                            else:
                                i = 0
                                while i < len(v3):
                                    x, i = varint(v3, i)
                                    info["ids"].append(x)
        elif num == 3 and wt == 2:  # AppearanceFlags
            for n3, w3, v3 in fields(val):
                if n3 == 1:
                    info["order"] = 0  # bank = chao
                elif n3 == 2 and info["order"] > 1:
                    info["order"] = 1  # clip = borda do chao
                elif n3 == 3 and info["order"] > 2:
                    info["order"] = 2  # bottom = parede
                elif n3 == 4:
                    info["order"] = 4  # top = por cima
                elif n3 == 26 and w3 == 2:  # shift
                    for a, b, c in fields(v3):
                        if a == 1:
                            info["sx"] = c
                        elif a == 2:
                            info["sy"] = c
                elif n3 == 27 and w3 == 2:  # height (elevacao)
                    for a, b, c in fields(v3):
                        if a == 1:
                            info["elev"] = c
    return info


rooms = {}
need = set()
for f in glob.glob(ROOMS + "/*.json"):
    r = json.load(open(f))
    rooms[f] = r
    for row in r["tiles"]:
        need.update(row[2:])

apps = open(glob.glob(ASSETS + "/appearances-*.dat")[0], "rb").read()
objs = {}
for num, wt, v in fields(apps):
    if num == 1 and wt == 2:
        o = parse_object(v)
        if o["id"] in need and o["ids"]:
            objs[o["id"]] = o

# sprites de cada padrao (fase 0, camada 0, andar 0), lidos folha por folha
want = defaultdict(list)  # arquivo da folha -> [(sprite, item, px, py)]
entries = sorted(catalog, key=lambda c: c["firstspriteid"])
starts = [c["firstspriteid"] for c in entries]
import bisect  # noqa: E402

for oid, o in objs.items():
    for y in range(o["py"]):
        for x in range(o["px"]):
            idx = ((0 * o["pz"] + 0) * o["py"] + y) * o["px"] + x
            idx = idx * o["layers"]
            if idx < len(o["ids"]):
                sid = o["ids"][idx]
                e = entries[bisect.bisect_right(starts, sid) - 1]
                if e["firstspriteid"] <= sid <= e["lastspriteid"]:
                    want[e["file"]].append((sid, oid, x, y, e))
cells = {}  # (item, x, y) -> imagem 64x64
for f, lst in want.items():
    img = sheet(lst[0][4])
    for sid, oid, x, y, e in lst:
        w, h = SIZES[e["spritetype"]]
        cols = img.width // w
        k = sid - e["firstspriteid"]
        spr = img.crop(((k % cols) * w, (k // cols) * h, (k % cols) * w + w, (k // cols) * h + h))
        cell = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        cell.paste(spr, (64 - w, 64 - h), spr)
        cells[(oid, x, y)] = cell
print("itens:", len(objs), "| celulas:", len(cells), "| folhas lidas:", len(want))

for f, r in rooms.items():
    ids = sorted({i for row in r["tiles"] for i in row[2:] if i in objs})
    atlas, slots = {}, 0
    for oid in ids:
        o = objs[oid]
        atlas[oid] = [slots % COLS, slots // COLS, o["px"], o["py"], o["order"], o["sx"], o["sy"], o["elev"]]
        slots += o["px"] * o["py"]
    rows = max(1, (slots + COLS - 1) // COLS)
    img = Image.new("RGBA", (COLS * 64, rows * 64), (0, 0, 0, 0))
    for oid in ids:
        o = objs[oid]
        c0, r0 = atlas[oid][0], atlas[oid][1]
        k = r0 * COLS + c0
        for y in range(o["py"]):
            for x in range(o["px"]):
                cell = cells.get((oid, x, y))
                if cell:
                    kk = k + y * o["px"] + x
                    img.paste(cell, ((kk % COLS) * 64, (kk // COLS) * 64))
    img.save(f[:-5] + ".png", optimize=True)
    r["atlas"] = {str(k): v for k, v in atlas.items()}
    json.dump(r, open(f, "w"), separators=(",", ":"))
total = sum(os.path.getsize(p) for p in glob.glob(ROOMS + "/*.png"))
print("salas:", len(rooms), "| imagens:", total // 1048576, "MB")
