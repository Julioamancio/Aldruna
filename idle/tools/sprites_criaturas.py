# Destruitor Idle: sprites das criaturas (monstros e personagens) para a visao da cacada.
# Roda na VPS:  python3 /opt/idle/src/tools/sprites_criaturas.py
#   le  /root/idle-dl/things1511 e os monstros em /opt/idle/server/data-canary/monster
#   gera /opt/idle/gateway/public/criaturas/<lookType>.png   (base)
#        /opt/idle/gateway/public/criaturas/<lookType>_t.png (camada de cor, so quando o outfit tem 2 camadas)
#   cada folha: 4 linhas (norte, leste, sul, oeste) x colunas (parado + ate 4 quadros andando), celula 64x64;
#   sprite de 32x32 vai no quadrado de baixo a direita (e assim que o Tibia desenha)
#
# Sao artes da CipSoft: so valem com o jogo fechado (senha).
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sprites import ASSETS, fields, varint, sheet, catalog, SIZES  # noqa: E402  (reaproveita o leitor de folhas)
from PIL import Image  # noqa: E402

OUT = "/opt/idle/gateway/public/criaturas"
MONSTERS = "/opt/idle/server/data-canary/monster"

want = set(range(128, 161)) | {266, 267, 268, 269, 270, 273, 278, 279, 288, 289, 324, 325, 328, 329, 335, 336, 366, 367}
for f in glob.glob(MONSTERS + "/**/*.lua", recursive=True):
    m = re.search(r"lookType\s*=\s*(\d+)", open(f, encoding="utf-8", errors="replace").read())
    if m and int(m.group(1)) > 0:
        want.add(int(m.group(1)))


def sprite_info(frame_group):
    info = {"px": 1, "py": 1, "pz": 1, "layers": 1, "ids": [], "phases": 1}
    fixed = 0
    for num, wt, v in fields(frame_group):
        if num == 1 and wt == 0:
            fixed = v
        elif num == 3 and wt == 2:
            for n, w, x in fields(v):
                if n == 1 and w == 0:
                    info["px"] = x
                elif n == 2 and w == 0:
                    info["py"] = x
                elif n == 3 and w == 0:
                    info["pz"] = x
                elif n == 4 and w == 0:
                    info["layers"] = x
                elif n == 5:
                    if w == 0:
                        info["ids"].append(x)
                    else:
                        i = 0
                        while i < len(x):
                            val, i = varint(x, i)
                            info["ids"].append(val)
                elif n == 6 and w == 2:  # SpriteAnimation: 6 = sprite_phase (repetido)
                    info["phases"] = max(1, sum(1 for a, b, c in fields(x) if a == 6))
    return fixed, info


def sprite_img(sid):
    entry = next((c for c in catalog if c["firstspriteid"] <= sid <= c["lastspriteid"]), None)
    if not entry:
        return None
    w, h = SIZES[entry["spritetype"]]
    img = sheet(entry)
    cols = img.width // w
    k = sid - entry["firstspriteid"]
    x, y = (k % cols) * w, (k // cols) * h
    return img.crop((x, y, x + w, y + h))


def frame(info, direction, phase, layer):
    px, py, pz, layers = info["px"], info["py"], info["pz"], info["layers"]
    if layer >= layers:
        return None
    d = direction % px
    idx = ((((phase * pz + 0) * py + 0) * px + d) * layers + layer)
    if idx >= len(info["ids"]):
        return None
    return sprite_img(info["ids"][idx])


apps = open(glob.glob(ASSETS + "/appearances-*.dat")[0], "rb").read()
outfits = {}
for num, wt, v in fields(apps):
    if num == 2 and wt == 2:  # outfit
        oid, groups = None, []
        for n, w, x in fields(v):
            if n == 1 and w == 0:
                oid = x
            elif n == 2 and w == 2:
                groups.append(sprite_info(x))
        if oid in want and groups:
            outfits[oid] = groups

os.makedirs(OUT, exist_ok=True)
made = 0
meta = {}
for oid, groups in sorted(outfits.items()):
    idle = next((g for f, g in groups if f == 0), groups[0][1])
    moving = next((g for f, g in groups if f == 1), None)
    walk = min(4, moving["phases"]) if moving else 0
    cols = 1 + walk
    layers = min(2, idle["layers"])
    for layer in range(layers):
        img = Image.new("RGBA", (64 * cols, 64 * 4), (0, 0, 0, 0))
        any_px = False
        for d in range(4):
            cells = [frame(idle, d, 0, layer)] + [frame(moving, d, ph, layer) for ph in range(walk)]
            for c, spr in enumerate(cells):
                if spr is None:
                    continue
                if spr.getbbox():
                    any_px = True
                ox = 64 * c + (64 - spr.width)
                oy = 64 * d + (64 - spr.height)
                img.paste(spr, (ox, oy), spr)
        if any_px:
            img.save(os.path.join(OUT, "%d%s.png" % (oid, "_t" if layer == 1 else "")), optimize=True)
            made += 1
    meta[oid] = {"cols": cols, "color": layers > 1}
json.dump(meta, open(os.path.join(OUT, "index.json"), "w"))
print("outfits pedidos:", len(want), "| encontrados:", len(outfits), "| folhas salvas:", made)
