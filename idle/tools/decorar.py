# Destruitor Idle: decoracao propria da cidade (templo, depot, sala de treino) por cima do recorte de Thais.
# Roda na VPS depois do salas.py (ONLY=cidade) e antes do sprites_mapa.py:
#   python3 /opt/idle/src/tools/decorar.py && ONLY=cidade python3 /opt/idle/src/tools/sprites_mapa.py
# Le salas/cidade_base.json (o recorte sem decoracao; criado na 1a vez a partir do cidade.json), aplica DECOR e
# grava salas/cidade.json (pagina) e idle-scripts/idle_city.lua (servidor; precisa reiniciar o server).
# Coordenadas: dx, dy, dz da cidade (centro do recorte, como o tools/preview_cidade.py mostra).
import json
import os
import re
import shutil
import xml.etree.ElementTree as ET

SALAS = "/opt/idle/gateway/public/salas"
BASE = SALAS + "/cidade_base.json"
OUT_JSON = SALAS + "/cidade.json"
OUT_LUA = "/opt/idle/idle-scripts/idle_city.lua"

# itens (ids do Tibia 15.x)
RED_CARPET, DRAGON_STATUE, COAL_BASIN, LIT_CANDELABRUM = 2572, 747, 2110, 2912
DRAGON_BANNER, RED_TAPESTRY, POTTED_PALM, POTTED_PLANT = 10035, 2654, 30620, 30621
TRAINING_DUMMY, TARGET_DUMMY, WEAPON_RACK, ARMOR_RACK = 5787, 15710, 5852, 6111
LAVA_FOUNTAIN, DRAGON_THRONE, LIT_TORCH_BEARER = 5074, 10286, 2929
EXERCISE_DUMMY, DEMON_EXERCISE_DUMMY = 28558, 28561
FOUNTAIN = 1922
WALL_LAMP_A, WALL_LAMP_B = 2908, 2910          # lit wall lamp: A na parede de lado, B na parede de frente

DECOR = []


def add(item, *cells, dz=0):
    for x, y in cells:
        DECOR.append((x, y, dz, item))


def line(item, x0, y0, x1, y1, dz=0):
    for x in range(min(x0, x1), max(x0, x1) + 1):
        for y in range(min(y0, y1), max(y0, y1) + 1):
            DECOR.append((x, y, dz, item))


# tapete ornamentado (as 9 pecas do Tibia: centro, bordas e cantos) cobrindo um retangulo
ORNATE = {"c": 17396, "l": 17397, "r": 17398, "t": 17399, "b": 17400, "tl": 17401, "tr": 17402, "bl": 17403, "br": 17404}


def carpet(x0, y0, x1, y1, dz=0):
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            v = "t" if y == y0 else "b" if y == y1 else ""
            h = "l" if x == x0 else "r" if x == x1 else ""
            DECOR.append((x, y, dz, ORNATE[(v + h) or "c"]))


def fountain(x, y, dz=0):
    for i, (ox, oy) in enumerate(((0, 0), (1, 0), (0, 1), (1, 1))):
        DECOR.append((x + ox, y + oy, dz, FOUNTAIN + i))


# ---------------------------------------------------------------- templo
add(DRAGON_STATUE, (2, 13), (6, 13))               # dois dragoes guardando o altar
add(LIT_CANDELABRUM, (2, 5), (6, 5))
add(POTTED_PALM, (-6, 9), (14, 9), (-6, 13), (14, 13))
# ---------------------------------------------------------------- depot (o salao de pedra e a sala dos armarios)
# fonte azul (a do templo) no meio do salao: 4 pecas, 1922 1923 em cima e 1924 1925 embaixo
fountain(-20, -6)
add(POTTED_PALM, (-24, -12), (-19, -12))
add(LIT_CANDELABRUM, (-15, -3))                        # na porta dos armarios
add(WALL_LAMP_B, (-23, -13), (-18, -13))               # parede norte
add(WALL_LAMP_A, (-12, -4), (-12, 0))                  # pilar entre os armarios
# ---------------------------------------------------------------- sala de treino (o salao dos alvos, embaixo do depot)
# exercise dummy de verdade (funciona com as armas de exercicio); o do meio e o de demonio
add(EXERCISE_DUMMY, (-17, 10), (-13, 10), (-16, 12), (-14, 12))
add(DEMON_EXERCISE_DUMMY, (-15, 10))
add(WEAPON_RACK, (-18, 9), (-18, 12))                  # armas na parede oeste
add(ARMOR_RACK, (-12, 9), (-12, 12))                   # armaduras na parede leste
add(LIT_CANDELABRUM, (-18, 4))

def main():
    if not os.path.exists(BASE):
        shutil.copy(OUT_JSON, BASE)
    r = json.load(open(BASE))
    tiles = {(t[0], t[1], t[2]): t for t in r["tiles"]}
    n = 0
    for x, y, z, item in DECOR:
        t = tiles.get((x, y, z))
        if not t:
            continue
        t.append(item)
        n += 1
    r.pop("atlas", None)  # o sprites_mapa.py refaz o atlas com os itens novos
    json.dump(r, open(OUT_JSON, "w"), separators=(",", ":"))

    def lstr(s):
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

    # no servidor nao entram teleportes, campos magicos e armadilhas (o salas.py faz o mesmo)
    bad = set()
    for el in ET.parse("/opt/idle/src/canary-3.6.1/data/items/items.xml").getroot().iter("item"):
        keys = {a.get("key"): a.get("value") for a in el.findall("attribute")}
        name = (el.get("name") or "").lower()
        if "floorchange" in keys:
            continue  # escadas e alcapoes ficam
        if keys.get("type") in ("teleport", "magicfield") or re.search(r"\b(teleport|magic forcefield|field|trap)\b", name):
            ids = [int(el.get("id"))] if el.get("id") else (range(int(el.get("fromid")), int(el.get("toid")) + 1) if el.get("fromid") else [])
            bad.update(ids)
    rows = [t[:3] + [i for i in t[3:] if i not in bad] for t in r["tiles"]]
    rows = [t for t in rows if len(t) > 3]
    out = ["-- Gerado por tools/salas.py + tools/decorar.py: a cidade para o servidor montar. tiles = {dx, dy, dz, item...}",
           "IdleCity = { id = %s, z = %d, w = %d, h = %d, zr = { %d, %d }, points = { %s }, tiles = {} }" % (
               lstr("cidade"), r["from"][2], r["w"], r["h"], r["zr"][0], r["zr"][1],
               ", ".join("%s = { %d, %d }" % (k, v[0], v[1]) for k, v in r["points"].items()))]
    for i in range(0, len(rows), 2500):
        chunk = ",".join("{" + ",".join(str(v) for v in row) + "}" for row in rows[i:i + 2500])
        out.append("for _, t in ipairs((function() return { %s } end)()) do IdleCity.tiles[#IdleCity.tiles + 1] = t end" % chunk)
    open(OUT_LUA, "w", encoding="utf-8").write("\n".join(out) + "\n")
    print("decoracao:", n, "itens de", len(DECOR), "| cidade:", len(rows), "tiles")


if __name__ == "__main__":
    main()
