# Destruitor Idle: decoracao propria da cidade (templo, depot, sala de treino) por cima do recorte de Thais.
# Roda na VPS depois do salas.py (ONLY=cidade) e antes do sprites_mapa.py:
#   python3 /opt/idle/src/tools/decorar.py && ONLY=cidade python3 /opt/idle/src/tools/sprites_mapa.py
# Le salas/cidade_base.json (o recorte sem decoracao; criado na 1a vez a partir do cidade.json), aplica DECOR e
# grava salas/cidade.json (pagina) e idle-scripts/idle_city.lua (servidor; precisa reiniciar o server).
# Depois de DECOR/REMOVE/SWAP entram as edicoes do editor da cidade (gateway/public/editor.html), se o arquivo
# existir: EDICOES (padrao /opt/idle/editor/cidade_edicoes.json) = {"tiles": {"dx,dy,dz": [itens]}, "flags":
# {"dx,dy,dz": flags}}, so o que difere desta base (lista vazia apaga o tile; flags 1 = zona protegida).
# Coordenadas: dx, dy, dz da cidade (centro do recorte, como o tools/preview_cidade.py mostra).
# Rodar local (teste): SALAS=... ITEMS=.../items.xml OUT_LUA=... OUT_OTBM=... EDICOES=... python decorar.py
import json
import os
import re
import shutil
import struct
import xml.etree.ElementTree as ET

SALAS = os.environ.get("SALAS", "/opt/idle/gateway/public/salas")
BASE = SALAS + "/cidade_base.json"
OUT_JSON = SALAS + "/cidade.json"
OUT_LUA = os.environ.get("OUT_LUA", "/opt/idle/idle-scripts/idle_city.lua")
OUT_OTBM = os.environ.get("OUT_OTBM", "/opt/idle/idle-scripts/cidade.otbm")  # o servidor carrega com Game.loadMap (zona protegida vem junto)
ITEMS = os.environ.get("ITEMS", "/opt/idle/src/canary-3.6.1/data/items/items.xml")
EDICOES = os.environ.get("EDICOES", "/opt/idle/editor/cidade_edicoes.json")  # gravado pelo gateway (POST /api/editor/salvar)
SERVER_OTBM = "/canary/data-canary/scripts/idle/cidade.otbm"  # o mesmo arquivo visto de dentro do container
ORIGIN = (36000, 36000)                                   # onde a cidade fica no mundo (I.CITY_ORIGIN no idle.lua)

# itens (ids do Tibia 15.x)
RED_CARPET, DRAGON_STATUE, COAL_BASIN, LIT_CANDELABRUM = 2572, 747, 2110, 2912
DRAGON_BANNER, RED_TAPESTRY, POTTED_PALM, POTTED_PLANT = 10035, 2654, 30620, 30621
TRAINING_DUMMY, TARGET_DUMMY, WEAPON_RACK, ARMOR_RACK = 5787, 15710, 5852, 6111
LAVA_FOUNTAIN, DRAGON_THRONE, LIT_TORCH_BEARER = 5074, 10286, 2929
EXERCISE_DUMMY, DEMON_EXERCISE_DUMMY = 28558, 28561
FOUNTAIN = 1922
WALL_LAMP_A, WALL_LAMP_B = 2908, 2910          # lit wall lamp: A na parede de lado, B na parede de frente

DECOR = []
# o que sai da cidade: imagens que o cliente desenha com fundo branco
REMOVE = {22796}  # arena banner (o quadrado branco ao norte do depot)
# chao trocado numa area (x0, y0, x1, y1): a areia clara entre o templo e a biblioteca parece calcada branca
SWAP = [((-25, -25, 15, 25), 104, 870)]  # sand -> cobbled pavement (o mesmo da rua)


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
add(POTTED_PALM, (-6, 9), (14, 9), (-6, 13), (14, 13))
# ---------------------------------------------------------------- depot (o salao de pedra e a sala dos armarios)
# fonte azul (a do templo) no meio do salao: 4 pecas, 1922 1923 em cima e 1924 1925 embaixo
fountain(-20, -6)
add(WALL_LAMP_B, (-23, -13), (-18, -13))               # parede norte
add(WALL_LAMP_A, (-12, -4), (-12, 0))                  # pilar entre os armarios
# ---------------------------------------------------------------- sala de treino (o salao dos alvos, embaixo do depot)
# exercise dummy de verdade (funciona com as armas de exercicio); o do meio e o de demonio
add(EXERCISE_DUMMY, (-17, 10), (-13, 10), (-16, 12), (-14, 12))
add(DEMON_EXERCISE_DUMMY, (-15, 10))
add(WEAPON_RACK, (-18, 9), (-18, 12))                  # armas na parede oeste
add(ARMOR_RACK, (-12, 9), (-12, 12))                   # armaduras na parede leste
add(LIT_CANDELABRUM, (-18, 4))


def aplicar_edicoes(r, ed):
    """Aplica as edicoes do editor da cidade em r (a cidade ja com DECOR/REMOVE/SWAP).
    ed["tiles"]["dx,dy,dz"] = itens finais do tile (de baixo para cima; [] apaga o tile; tile novo e criado);
    ed["flags"]["dx,dy,dz"] = flags finais do tile (0 tira). Fora do recorte ou mal formado: ignorado.
    Guarda em r["edbase"] como cada tile/flag editado estava antes: o editor compara com isso para saber o que
    ainda difere da base (assim desfazer uma edicao antiga tira ela do arquivo). Devolve (tiles, flags)."""
    rx, ry = r["w"] // 2, r["h"] // 2
    lo, hi = r["zr"]

    def pos(k):
        try:
            x, y, z = (int(v) for v in str(k).split(","))
        except ValueError:
            return None
        return (x, y, z) if abs(x) <= rx and abs(y) <= ry and lo <= z <= hi else None

    tiles = {(t[0], t[1], t[2]): t for t in r["tiles"]}
    flags = {(f[0], f[1], f[2]): f[3] for f in r.get("flags", [])}
    base = {"tiles": {}, "flags": {}}
    nt = nf = 0
    for k, ids in (ed.get("tiles") or {}).items():
        p = pos(k)
        if p is None or not isinstance(ids, list) or not all(type(i) is int and 0 < i < 65536 for i in ids):
            print("edicao ignorada (tile):", k)
            continue
        key = "%d,%d,%d" % p
        t = tiles.get(p)
        base["tiles"][key] = list(t[3:]) if t else []
        if t:
            t[3:] = ids
        else:
            tiles[p] = list(p) + ids
            r["tiles"].append(tiles[p])
        nt += 1
    r["tiles"] = [t for t in r["tiles"] if len(t) > 3]  # tile sem item nenhum sai
    for k, f in (ed.get("flags") or {}).items():
        p = pos(k)
        if p is None or type(f) is not int or not 0 <= f < 2 ** 32:
            print("edicao ignorada (flags):", k)
            continue
        base["flags"]["%d,%d,%d" % p] = flags.get(p, 0)
        if f:
            flags[p] = f
        else:
            flags.pop(p, None)
        nf += 1
    r["flags"] = [[x, y, z, f] for (x, y, z), f in flags.items()]
    r["edbase"] = base
    return nt, nf


def main():
    if not os.path.exists(BASE):
        shutil.copy(OUT_JSON, BASE)
    r = json.load(open(BASE))
    for t in r["tiles"]:
        ids = [i for i in t[3:] if i not in REMOVE]
        for (x0, y0, x1, y1), old, new in SWAP:
            if t[2] == 0 and x0 <= t[0] <= x1 and y0 <= t[1] <= y1:
                ids = [new if i == old else i for i in ids]
        t[3:] = ids
    tiles = {(t[0], t[1], t[2]): t for t in r["tiles"]}
    n = 0
    for x, y, z, item in DECOR:
        t = tiles.get((x, y, z))
        if not t:
            continue
        t.append(item)
        n += 1
    r.pop("edbase", None)
    if os.path.exists(EDICOES):
        try:
            ed = json.load(open(EDICOES, encoding="utf-8"))
        except ValueError as e:
            raise SystemExit("edicoes do editor ilegiveis (%s): %s" % (EDICOES, e))
        nt, nf = aplicar_edicoes(r, ed)
        print("edicoes do editor:", nt, "tiles e", nf, "flags de", EDICOES)
    else:
        print("sem edicoes do editor (%s nao existe)" % EDICOES)
    r.pop("atlas", None)  # o sprites_mapa.py refaz o atlas com os itens novos
    r.setdefault("points", {})["salao"] = [-18, -3]  # meio do salao do depot (o povo fica de papo ali)
    json.dump(r, open(OUT_JSON, "w"), separators=(",", ":"))

    def lstr(s):
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

    # no servidor nao entram teleportes, campos magicos e armadilhas (o salas.py faz o mesmo)
    bad, stairs = set(), set()
    for el in ET.parse(ITEMS).getroot().iter("item"):
        keys = {a.get("key"): a.get("value") for a in el.findall("attribute")}
        name = (el.get("name") or "").lower()
        if "floorchange" in keys:
            if el.get("id"):
                stairs.add(int(el.get("id")))
            elif el.get("fromid"):
                stairs.update(range(int(el.get("fromid")), int(el.get("toid")) + 1))
            continue  # escadas e alcapoes ficam
        if keys.get("type") in ("teleport", "magicfield") or re.search(r"\b(teleport|magic forcefield|field|trap)\b", name):
            ids = [int(el.get("id"))] if el.get("id") else (range(int(el.get("fromid")), int(el.get("toid")) + 1) if el.get("fromid") else [])
            bad.update(ids)
    # escadas e alcapoes: o povo da cidade (gateway/public/povo.js) nao para nem passa por cima
    r["nowalk"] = [[t[0], t[1]] for t in r["tiles"] if t[2] == 0 and any(i in stairs for i in t[3:])]
    json.dump(r, open(OUT_JSON, "w"), separators=(",", ":"))
    rows = [t[:3] + [i for i in t[3:] if i not in bad] for t in r["tiles"]]
    rows = [t for t in rows if len(t) > 3]
    flags = {(f[0], f[1], f[2]): f[3] for f in r.get("flags", [])}
    z0 = r["from"][2]
    open(OUT_OTBM, "wb").write(otbm(rows, flags, z0))
    out = ["-- Gerado por tools/salas.py + tools/decorar.py. O mapa da cidade (com zona protegida) esta em cidade.otbm.",
           "IdleCity = { id = %s, z = %d, w = %d, h = %d, zr = { %d, %d }, otbm = %s, points = { %s } }" % (
               lstr("cidade"), z0, r["w"], r["h"], r["zr"][0], r["zr"][1], lstr(SERVER_OTBM),
               ", ".join("%s = { %d, %d }" % (k, v[0], v[1]) for k, v in r["points"].items()))]
    open(OUT_LUA, "w", encoding="utf-8").write("\n".join(out) + "\n")
    pz = sum(1 for f in flags.values() if f & 1)
    print("decoracao:", n, "itens de", len(DECOR), "| cidade:", len(rows), "tiles |", pz, "tiles de zona protegida |",
          os.path.getsize(OUT_OTBM) // 1024, "KB de mapa")


def otbm(rows, flags, z0):
    """Mapa .otbm (o formato do Remere's/Canary): raiz -> dados do mapa -> areas de 256x256 -> tiles -> itens.
    Cada tile leva as flags do mapa original (1 = zona protegida). 0xFD escapa os bytes 0xFD, 0xFE e 0xFF."""
    w = bytearray(b"OTBM")

    def raw(b):
        for c in b:
            if c in (0xFD, 0xFE, 0xFF):
                w.append(0xFD)
            w.append(c)

    def start(kind):
        w.append(0xFE)
        w.append(kind)

    def end():
        w.append(0xFF)

    def u8(v):
        raw(struct.pack("<B", v))

    def u16(v):
        raw(struct.pack("<H", v))

    def u32(v):
        raw(struct.pack("<I", v))

    start(1)  # OTBM_ROOTV1: versao 2, largura, altura, versao dos itens (3.57)
    u32(2)
    u16(65000)
    u16(65000)
    u32(3)
    u32(57)
    start(2)  # OTBM_MAP_DATA
    desc = b"Destruitor Idle - Thais"
    u8(1)  # OTBM_ATTR_DESCRIPTION
    u16(len(desc))
    raw(desc)
    areas = {}
    for t in rows:
        x, y, z = ORIGIN[0] + t[0], ORIGIN[1] + t[1], z0 + t[2]
        areas.setdefault((x & 0xFF00, y & 0xFF00, z), []).append((x, y, t))
    for (ax, ay, az), lst in sorted(areas.items()):
        start(4)  # OTBM_TILE_AREA
        u16(ax)
        u16(ay)
        u8(az)
        for x, y, t in lst:
            start(5)  # OTBM_TILE
            u8(x & 0xFF)
            u8(y & 0xFF)
            f = flags.get((t[0], t[1], t[2]), 0)
            if f:
                u8(3)  # OTBM_ATTR_TILE_FLAGS
                u32(f)
            for item in t[3:]:
                start(6)  # OTBM_ITEM
                u16(item)
                end()
            end()
        end()
    start(12)  # OTBM_TOWNS (vazio)
    end()
    start(15)  # OTBM_WAYPOINTS (vazio)
    end()
    end()  # MAP_DATA
    end()  # raiz
    return bytes(w)

if __name__ == "__main__":
    main()
