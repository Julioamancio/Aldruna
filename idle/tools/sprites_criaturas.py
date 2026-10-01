# Destruitor Idle: sprites das criaturas (monstros e personagens) para a visao da cacada.
# Roda na VPS:  python3 /opt/idle/src/tools/sprites_criaturas.py
#   le  /root/idle-dl/things1511 e os monstros em /opt/idle/server/data-canary/monster
#   gera /opt/idle/gateway/public/criaturas/<lookType>.png   (base)
#        /opt/idle/gateway/public/criaturas/<lookType>_t.png (camada de cor, so quando o outfit tem 2 camadas)
#   cada folha: 4 linhas (norte, leste, sul, oeste) x colunas (parado + ate 4 quadros andando), celula 64x64;
#   sprite de 32x32 vai no quadrado de baixo a direita (e assim que o Tibia desenha)
#   roupas de jogador (outfits.xml): tambem <id>_a1 / <id>_a2 (addons) e <id>_m* (montado), cada uma com _t (cor)
#   montarias (mounts.xml): <clientid>.png; e os catalogos outfits.json e mounts.json (nome, premium, de onde vem)
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
XML = "/opt/idle/server/data/XML"
import xml.etree.ElementTree as ET  # noqa: E402

# roupas de jogador e montarias do servidor (o catalogo da janela de Outfit sai daqui)
OUTFITS = [o.attrib for o in ET.parse(XML + "/outfits.xml").getroot().iter("outfit") if o.get("enabled", "yes") == "yes"]
MOUNTS = [m.attrib for m in ET.parse(XML + "/mounts.xml").getroot().iter("mount")]
PLAYER = {int(o["looktype"]) for o in OUTFITS}
MOUNT_LOOKS = {int(m["clientid"]) for m in MOUNTS}

want = set(range(128, 161)) | {266, 267, 268, 269, 270, 273, 278, 279, 288, 289, 324, 325, 328, 329, 335, 336, 366, 367} | PLAYER | MOUNT_LOOKS
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


def frame(info, direction, phase, layer, addon=0, mounted=0):
    px, py, pz, layers = info["px"], info["py"], info["pz"], info["layers"]
    if layer >= layers or addon >= py or mounted >= pz:
        return None
    d = direction % px
    idx = ((((phase * pz + mounted) * py + addon) * px + d) * layers + layer)
    if idx >= len(info["ids"]):
        return None
    return sprite_img(info["ids"][idx])


apps = open(glob.glob(ASSETS + "/appearances-*.dat")[0], "rb").read()
outfits = {}
shifts = {}
for num, wt, v in fields(apps):
    if num == 2 and wt == 2:  # outfit
        oid, groups, shift = None, [], None
        for n, w, x in fields(v):
            if n == 1 and w == 0:
                oid = x
            elif n == 2 and w == 2:
                groups.append(sprite_info(x))
            elif n == 3 and w == 2:  # flags: 26 = deslocamento (o cliente desenha a criatura x/y px acima e a esquerda)
                for a, b, c in fields(x):
                    if a == 26 and b == 2:
                        shift = [0, 0]
                        for p, _, q in fields(c):
                            if p in (1, 2):
                                shift[p - 1] = q
        if oid in want and groups:
            outfits[oid] = groups
            if shift and any(shift):
                shifts[oid] = shift

os.makedirs(OUT, exist_ok=True)
made = 0
meta = {}


def save_sheet(oid, idle, moving, addon, mounted, suffix):
    """Uma folha (e a camada de cor, se tiver): parado + ate 4 quadros andando, nas 4 direcoes."""
    global made
    walk = min(4, moving["phases"]) if moving else 0
    cols = 1 + walk
    layers = min(2, idle["layers"])
    saved = False
    for layer in range(layers):
        img = Image.new("RGBA", (64 * cols, 64 * 4), (0, 0, 0, 0))
        any_px = False
        for d in range(4):
            cells = [frame(idle, d, 0, layer, addon, mounted)] + [frame(moving, d, ph, layer, addon, mounted) for ph in range(walk)]
            for c, spr in enumerate(cells):
                if spr is None:
                    continue
                if spr.getbbox():
                    any_px = True
                img.paste(spr, (64 * c + (64 - spr.width), 64 * d + (64 - spr.height)), spr)
        if any_px:
            img.save(os.path.join(OUT, "%d%s%s.png" % (oid, suffix, "_t" if layer == 1 else "")), optimize=True)
            made += 1
            saved = saved or layer == 0
    return cols, layers > 1, saved


for oid, groups in sorted(outfits.items()):
    idle = next((g for f, g in groups if f == 0), groups[0][1])
    moving = next((g for f, g in groups if f == 1), None)
    cols, color, _ = save_sheet(oid, idle, moving, 0, 0, "")
    m = {"cols": cols, "color": color}
    if oid in shifts:
        m["shift"] = shifts[oid]
    if oid in PLAYER:
        # addons (padrao Y 1 e 2) e montado (padrao Z 1), so para roupa de jogador
        m["addons"] = sum(1 for a in (1, 2) if save_sheet(oid, idle, moving, a, 0, "_a%d" % a)[2])
        if idle["pz"] > 1 and save_sheet(oid, idle, moving, 0, 1, "_m")[2]:
            m["mounted"] = True
            for a in (1, 2):
                save_sheet(oid, idle, moving, a, 1, "_m_a%d" % a)
    meta[oid] = m
json.dump(meta, open(os.path.join(OUT, "index.json"), "w"))
# catalogos da janela de Outfit (so o que tem imagem)
json.dump([{"t": int(o["looktype"]), "sex": int(o["type"]), "name": o["name"], "premium": o.get("premium") == "yes",
            "free": o.get("unlocked") == "yes", "from": o.get("from", "")} for o in OUTFITS if int(o["looktype"]) in meta],
          open(os.path.join(OUT, "outfits.json"), "w"), ensure_ascii=False)
json.dump([{"id": int(m["id"]), "t": int(m["clientid"]), "name": m["name"], "premium": m.get("premium") == "yes", "from": m.get("type", ""),
            "speed": int(m.get("speed", "10"))} for m in MOUNTS if int(m["clientid"]) in meta],
          open(os.path.join(OUT, "mounts.json"), "w"), ensure_ascii=False)
# o mesmo catalogo para o servidor conferir o que se pode vestir/comprar
def lstr(v):
    return '"' + str(v).replace("\\", "\\\\").replace('"', '\\"') + '"'


lines = ["-- Gerado por tools/sprites_criaturas.py: roupas e montarias (outfits.xml/mounts.xml) com imagem.", "IdleOutfits = {}", "IdleMounts = {}"]
for o in OUTFITS:
    if int(o["looktype"]) in meta:
        lines.append("IdleOutfits[%d] = { sex = %d, name = %s, premium = %s, free = %s, from = %s }" % (
            int(o["looktype"]), int(o["type"]), lstr(o["name"]), str(o.get("premium") == "yes").lower(), str(o.get("unlocked") == "yes").lower(), lstr(o.get("from", ""))))
for m in MOUNTS:
    if int(m["clientid"]) in meta:
        lines.append("IdleMounts[%d] = { t = %d, name = %s, premium = %s, from = %s }" % (
            int(m["id"]), int(m["clientid"]), lstr(m["name"]), str(m.get("premium") == "yes").lower(), lstr(m.get("type", ""))))
open("/opt/idle/idle-scripts/idle_outfits.lua", "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("outfits pedidos:", len(want), "| encontrados:", len(outfits), "| folhas salvas:", made,
      "| roupas de jogador:", len([o for o in OUTFITS if int(o["looktype"]) in meta]), "| montarias:", len([m for m in MOUNTS if int(m["clientid"]) in meta]))
