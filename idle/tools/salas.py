# Destruitor Idle: recorta do mapa real do Tibia (otservbr.otbm do Canary) uma sala por cacada.
# Roda na VPS:  python3 /opt/idle/src/tools/salas.py
#   entrada: /opt/idle/src/otservbr.otbm, otservbr-monster.xml (onde cada monstro nasce),
#            /opt/idle/idle-scripts/idle_hunts.lua (cacadas e cacada livre)
#   saida:   /opt/idle/idle-scripts/idle_rooms.lua   (IdleRooms: sala por cacada, para o servidor montar)
#            /opt/idle/gateway/public/salas/<id>.json (a mesma sala, para a pagina desenhar)
#            /opt/idle/src/salas_itens.json         (ids usados, para o sprites.py tirar as imagens)
#
# Sala = 15x11 tiles (a tela do Tibia) em volta do lugar onde os monstros da cacada mais aparecem.
# Tiram-se buracos/escadas/teleportes/campos/armadilhas (numa sala fechada so atrapalham).
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
W, H = 15, 11  # tamanho da sala
RX, RY = W // 2, H // 2

# ---------------------------------------------------------------- itens que nao podem ficar na sala
bad = set()
for el in ET.parse(ITEMS).getroot().iter("item"):
    if not el.get("id"):
        continue
    name = (el.get("name") or "").lower()
    keys = {a.get("key"): a.get("value") for a in el.findall("attribute")}
    if "floorchange" in keys or keys.get("type") in ("teleport", "magicfield", "trashholder", "mailbox", "depot") \
            or re.search(r"\b(hole|stairs|ladder|trapdoor|teleport|field|trap|sewer grate|rope spot|pitfall|portal)\b", name):
        bad.add(int(el.get("id")))

# ---------------------------------------------------------------- cacadas
hunts_src = open(HUNTS, encoding="utf-8").read()
curated = []
for m in re.finditer(r'\{ id = "([^"]+)", name = "[^"]*".*?monsters = \{ ([^}]*) \} \}', hunts_src):
    curated.append((m.group(1), re.findall(r'"([^"]+)"', m.group(2))))
solo = re.findall(r'\{ name = "([^"]+)", class = ', hunts_src)

# ---------------------------------------------------------------- onde cada monstro nasce
where = defaultdict(list)  # nome (minusculo) -> [(x, y, z)]
for sp in ET.parse(SPAWNS).getroot().iter("monster"):
    if sp.get("centerx") is None:
        continue
    cx, cy, cz = int(sp.get("centerx")), int(sp.get("centery")), int(sp.get("centerz"))
    for m in sp.findall("monster"):
        # o Canary usa so o andar do centro do spawn (o z de cada monstro nao conta)
        where[m.get("name").lower()].append((cx + int(m.get("x")), cy + int(m.get("y")), cz))


def best_window(names):
    """Centro com mais monstros da cacada numa janela 15x11 (desempate: mais tipos diferentes)."""
    pts = []
    for n in names:
        pts += [(p, n) for p in where.get(n.lower(), [])]
    if not pts:
        return None
    best, key = None, None
    for (cx, cy, cz), _ in pts:
        inside = [(n) for (x, y, z), n in pts if z == cz and abs(x - cx) <= RX - 1 and abs(y - cy) <= RY - 1]
        k = (len(set(inside)), len(inside))
        if key is None or k > key:
            best, key = (cx, cy, cz), k
    return best


windows = {}  # id da sala -> centro
for hid, names in curated:
    c = best_window(names)
    if c:
        windows[hid] = c
for name in solo:
    c = best_window([name])
    if c:
        windows["m:" + name] = c
print("salas com lugar no mapa:", len(windows), "de", len(curated) + len(solo))

need = defaultdict(list)  # (x, y, z) -> [ids de sala]
for rid, (cx, cy, cz) in windows.items():
    for dx in range(-RX, RX + 1):
        for dy in range(-RY, RY + 1):
            need[(cx + dx, cy + dy, cz)].append(rid)
areas = {((x & 0xFF00), (y & 0xFF00), z) for (x, y, z) in need}

# ---------------------------------------------------------------- leitura do .otbm
# no: 0xFE tipo props... filhos... 0xFF; 0xFD escapa o proximo byte
data = open(OTBM, "rb").read()
NODE_START, NODE_END, ESC = 0xFE, 0xFF, 0xFD
T_TILE_AREA, T_TILE, T_ITEM, T_HOUSETILE = 4, 5, 6, 14
tiles = {}
DBG = {'tiles': 0, 'areas': 0, 'zs': set()}


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


# varre marcadores com um laco simples em cima de bytes (uma passada so)
i, n = 4, len(data)
stack = []  # (tipo, props_ini, contexto)
area = None
cur_tile = None
props_start = None
while i < n:
    c = data[i]
    if c == ESC:
        i += 2
        continue
    if c == NODE_START or c == NODE_END:
        # fecha as props do no aberto (se ainda nao fechou)
        if stack and stack[-1][1] is not None:
            typ, ps, ctx = stack[-1]
            props = unescape(data[ps:i])
            stack[-1] = (typ, None, ctx)
            if typ == T_TILE_AREA:
                area = (props[0] | props[1] << 8, props[2] | props[3] << 8, props[4])
                DBG['areas'] += 1
                DBG['zs'].add(area[2])
            elif typ in (T_TILE, T_HOUSETILE):
                base = 2 if typ == T_TILE else 6
                x, y, z = area[0] + props[0], area[1] + props[1], area[2]
                DBG['tiles'] += 1
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
print("tiles lidos nas salas:", len(tiles), "| tiles no mapa:", DBG["tiles"], "| areas:", DBG["areas"], "| andares:", sorted(DBG["zs"]), "| parou em", i, "de", n)
miss = [rid for rid, c in windows.items() if not any((c[0]+dx, c[1]+dy, c[2]) in tiles for dx in range(-2,3) for dy in range(-2,3))]
print("salas sem tile no centro:", len(miss), [(r, windows[r]) for r in miss[:5]])

# ---------------------------------------------------------------- monta as salas
os.makedirs(OUT_JSON, exist_ok=True)
used = set()
rooms = {}
for rid, (cx, cy, cz) in windows.items():
    rows = []
    for dy in range(-RY, RY + 1):
        for dx in range(-RX, RX + 1):
            t = tiles.get((cx + dx, cy + dy, cz))
            if not t:
                continue
            ids = [x for x in t[3] if x not in bad]
            if not ids:
                continue
            rows.append([dx, dy] + ids)
            used.update(ids)
    if len(rows) < W * H * 0.4:  # sala quase vazia (borda do mapa): nao serve
        continue
    rooms[rid] = {"w": W, "h": H, "tiles": rows, "from": [cx, cy, cz]}
    safe = re.sub(r"[^a-z0-9_-]", "_", rid.lower())
    json.dump(rooms[rid], open(os.path.join(OUT_JSON, safe + ".json"), "w"), separators=(",", ":"))

lines = ["-- Gerado por tools/salas.py: salas recortadas do mapa real (otservbr.otbm). {dx, dy, item1, item2...}", "IdleRooms = {"]
for rid, r in rooms.items():
    body = ",".join("{" + ",".join(str(v) for v in row) + "}" for row in r["tiles"])
    lines.append('\t["%s"] = { %s },' % (rid.replace('"', '\\"'), body))
lines.append("}")
open(OUT_LUA, "w", encoding="utf-8").write("\n".join(lines) + "\n")
json.dump(sorted(used), open(SRC + "/salas_itens.json", "w"))
print("salas montadas:", len(rooms), "| itens diferentes:", len(used), "| lua:", os.path.getsize(OUT_LUA) // 1024, "KB")
