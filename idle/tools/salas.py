# Destruitor Idle: recorta do mapa real do Tibia (otservbr.otbm do Canary) a area de cada cacada.
# Roda na VPS:  python3 /opt/idle/src/tools/salas.py   (depois: sprites_mapa.py)
#   entrada: /opt/idle/src/otservbr.otbm, otservbr-monster.xml (onde cada monstro nasce),
#            /opt/idle/idle-scripts/idle_hunts.lua (cacadas e cacada livre)
#   saida:   /opt/idle/idle-scripts/idle_rooms.lua   (IdleRooms: tiles e spawns por sala, para o servidor montar)
#            /opt/idle/gateway/public/salas/<id>.json (a mesma sala, para a pagina desenhar)
#
# Cacadas montadas: AREA de 31x23 tiles em ate 3 andares (o de cima, o do meio e o de baixo), com as
#   posicoes reais de spawn dos monstros; escadas/rampas/buracos ficam (o personagem troca de andar).
# Cacada livre: SALA de 15x11 num andar so, em volta do lugar onde aquele monstro mais aparece.
# Sempre saem teleportes, campos magicos, armadilhas, lixeiras, caixas de correio e depots.
#
# Formato de cada tile: {dx, dy, dz, item1, item2...}; spawns: {dx, dy, dz, "Nome"}.
import json
import os
import re
import xml.etree.ElementTree as ET
from collections import defaultdict

SRC = "/opt/idle/src"
OTBM = SRC + "/otservbr.otbm"
SPAWNS = SRC + "/canary-3.6.1/data-otservbr-global/world/otservbr-monster.xml"
ITEMS = SRC + "/canary-3.6.1/data/items/items.xml"
HUNTS = "/opt/idle/idle-scripts/idle_hunts.lua"
OUT_LUA = "/opt/idle/idle-scripts/idle_rooms.lua"
OUT_JSON = "/opt/idle/gateway/public/salas"
AREA = (15, 11, 1)  # meia-largura, meia-altura, andares acima/abaixo (31x23x3)
ROOM = (7, 5, 0)  # 15x11, um andar

# ---------------------------------------------------------------- itens que nao podem ficar
bad, floorchange = set(), set()
for el in ET.parse(ITEMS).getroot().iter("item"):
    if not el.get("id"):
        continue
    iid = int(el.get("id"))
    name = (el.get("name") or "").lower()
    keys = {a.get("key"): a.get("value") for a in el.findall("attribute")}
    if keys.get("type") in ("teleport", "magicfield", "trashholder", "mailbox", "depot") \
            or re.search(r"\b(teleport|magic forcefield|field|trap|portal|mailbox|depot|dustbin)\b", name):
        bad.add(iid)
    elif "floorchange" in keys or re.search(r"\b(hole|stairs|ladder|trapdoor|ramp|rope spot|sewer grate|pitfall)\b", name):
        floorchange.add(iid)

# ---------------------------------------------------------------- cacadas
hunts_src = open(HUNTS, encoding="utf-8").read()
curated = [(m.group(1), re.findall(r'"([^"]+)"', m.group(2)))
           for m in re.finditer(r'\{ id = "([^"]+)", name = "[^"]*".*?monsters = \{ ([^}]*) \} \}', hunts_src)]
solo = re.findall(r'\{ name = "([^"]+)", class = ', hunts_src)
known = {n.lower() for n in solo} | {n.lower() for _, ms in curated for n in ms}

# ---------------------------------------------------------------- spawns reais
spawns = []  # (x, y, z, nome)
where = defaultdict(list)
for sp in ET.parse(SPAWNS).getroot().iter("monster"):
    if sp.get("centerx") is None:
        continue
    cx, cy, cz = int(sp.get("centerx")), int(sp.get("centery")), int(sp.get("centerz"))
    for m in sp.findall("monster"):
        # o Canary usa so o andar do centro do spawn (o z de cada monstro nao conta)
        p = (cx + int(m.get("x")), cy + int(m.get("y")), cz)
        spawns.append(p + (m.get("name"),))
        where[m.get("name").lower()].append(p)


def best_window(names, rx, ry):
    pts = [(p, n) for n in names for p in where.get(n.lower(), [])]
    if not pts:
        return None
    best, key = None, None
    for (cx, cy, cz), _ in pts:
        inside = [n for (x, y, z), n in pts if z == cz and abs(x - cx) <= rx - 1 and abs(y - cy) <= ry - 1]
        k = (len(set(inside)), len(inside))
        if key is None or k > key:
            best, key = (cx, cy, cz), k
    return best


windows = {}  # id -> (centro, (rx, ry, rz))
for hid, names in curated:
    c = best_window(names, AREA[0], AREA[1])
    if c:
        windows[hid] = (c, AREA)
for name in solo:
    c = best_window([name], ROOM[0], ROOM[1])
    if c:
        windows["m:" + name] = (c, ROOM)
need = set()
for rid, ((cx, cy, cz), (rx, ry, rz)) in windows.items():
    for dz in range(-rz, rz + 1):
        for dx in range(-rx, rx + 1):
            for dy in range(-ry, ry + 1):
                need.add((cx + dx, cy + dy, cz + dz))
print("areas/salas com lugar no mapa:", len(windows), "| posicoes a ler:", len(need))

# ---------------------------------------------------------------- leitura do .otbm
# no: 0xFE tipo props... filhos... 0xFF; 0xFD escapa o proximo byte
data = open(OTBM, "rb").read()
NODE_START, NODE_END, ESC = 0xFE, 0xFF, 0xFD
T_TILE_AREA, T_TILE, T_ITEM, T_HOUSETILE = 4, 5, 6, 14
tiles = {}


def unescape(b):
    if ESC not in b:
        return b
    out, i = bytearray(), 0
    while i < len(b):
        if b[i] == ESC:
            i += 1
        out.append(b[i])
        i += 1
    return bytes(out)


i, n = 4, len(data)
stack = []
area = None
cur_tile = None
while i < n:
    c = data[i]
    if c == ESC:
        i += 2
        continue
    if c == NODE_START or c == NODE_END:
        if stack and stack[-1][1] is not None:
            typ, ps, ctx = stack[-1]
            props = unescape(data[ps:i])
            stack[-1] = (typ, None, ctx)
            if typ == T_TILE_AREA:
                area = (props[0] | props[1] << 8, props[2] | props[3] << 8, props[4])
            elif typ in (T_TILE, T_HOUSETILE):
                base = 2 if typ == T_TILE else 6
                x, y, z = area[0] + props[0], area[1] + props[1], area[2]
                cur_tile = None
                if (x, y, z) in need:
                    cur_tile = [x, y, z, []]
                    j = base
                    while j < len(props):
                        attr = props[j]
                        if attr == 3:  # flags do tile
                            j += 5
                        elif attr == 9:  # item compacto (geralmente o chao)
                            cur_tile[3].append(props[j + 1] | props[j + 2] << 8)
                            j += 3
                        else:
                            break
                    tiles[(x, y, z)] = cur_tile
            elif typ == T_ITEM and ctx == "tile" and cur_tile is not None:
                cur_tile[3].append(props[0] | props[1] << 8)
        if c == NODE_START:
            typ = data[i + 1]
            parent = stack[-1][0] if stack else None
            ctx = "tile" if typ == T_ITEM and parent in (T_TILE, T_HOUSETILE) else None
            stack.append((typ, i + 2, ctx))
            i += 2
            continue
        stack.pop()
        i += 1
        continue
    i += 1
print("tiles lidos:", len(tiles))

# ---------------------------------------------------------------- monta
os.makedirs(OUT_JSON, exist_ok=True)
for f in os.listdir(OUT_JSON):
    if f.endswith(".json") or f.endswith(".png"):
        os.remove(os.path.join(OUT_JSON, f))
rooms = {}
for rid, ((cx, cy, cz), (rx, ry, rz)) in windows.items():
    rows = []
    for dz in range(-rz, rz + 1):
        for dy in range(-ry, ry + 1):
            for dx in range(-rx, rx + 1):
                t = tiles.get((cx + dx, cy + dy, cz + dz))
                if not t:
                    continue
                ids = [x for x in t[3] if x not in bad and (rz or x not in floorchange)]
                if ids:
                    rows.append([dx, dy, dz] + ids)
    base_floor = sum(1 for r in rows if r[2] == 0)
    if base_floor < (2 * rx + 1) * (2 * ry + 1) * 0.35:  # quase vazio (borda do mapa): nao serve
        continue
    sp = [[x - cx, y - cy, z - cz, nm] for (x, y, z, nm) in spawns
          if abs(x - cx) <= rx and abs(y - cy) <= ry and abs(z - cz) <= rz and nm.lower() in known] if rz else []
    rooms[rid] = {"w": 2 * rx + 1, "h": 2 * ry + 1, "floors": 2 * rz + 1, "tiles": rows, "spawns": sp, "from": [cx, cy, cz]}
    safe = re.sub(r"[^a-z0-9_-]", "_", rid.lower())
    json.dump(rooms[rid], open(os.path.join(OUT_JSON, safe + ".json"), "w"), separators=(",", ":"))


def lstr(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


lines = ["-- Gerado por tools/salas.py: areas/salas recortadas do mapa real (otservbr.otbm).",
         "-- tiles = {dx, dy, dz, item...}; spawns = {dx, dy, dz, \"Nome\"}; z = andar real do centro.",
         "IdleRooms = {}"]
for rid, r in rooms.items():
    body = ",".join("{" + ",".join(str(v) for v in row) + "}" for row in r["tiles"])
    sp = ",".join("{%d,%d,%d,%s}" % (a, b, c, lstr(nm)) for a, b, c, nm in r["spawns"])
    # uma funcao por sala: o LuaJIT aceita no maximo 65536 constantes por funcao (o arquivo inteiro passa disso)
    lines.append("IdleRooms[%s] = (function() return { z = %d, w = %d, h = %d, floors = %d, tiles = { %s }, spawns = { %s } } end)()" % (lstr(rid), r["from"][2], r["w"], r["h"], r["floors"], body, sp))
open(OUT_LUA, "w", encoding="utf-8").write("\n".join(lines) + "\n")
areas = [r for r in rooms.values() if r["floors"] > 1]
print("areas (varios andares):", len(areas), "| spawns nelas:", sum(len(r["spawns"]) for r in areas),
      "| salas de um andar:", len(rooms) - len(areas), "| lua:", os.path.getsize(OUT_LUA) // 1024, "KB")
