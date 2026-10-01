# Destruitor Idle: paleta do editor da cidade (gateway/public/editor.html) - as imagens dos itens que fazem
# sentido numa cidade (chao, bordas, paredes, decoracao, plantas/natureza, luzes, moveis), mesmo os que ainda
# nao estao no mapa.
# Roda na VPS:  python3 /opt/idle/src/tools/sprites_paleta.py
#   le  ASSETS (appearances-*.dat + catalog-content.json + sprites-*.bmp.lzma, o mesmo do sprites.py)
#       ITEMS  (items.xml do Canary: os nomes)
#       SALAS/cidade.json (os itens que ja estao na cidade tambem ganham nome)
#   gera SALAS/paleta.png (+ paleta_1.png, paleta_2.png...: paginas de no maximo 256 linhas) e SALAS/paleta.json:
#        atlas[id] = [coluna, linha, padroesX, padroesY, camada, deslocX, deslocY, altura, bloqueia, 1, 0, pagina]
#                    (o mesmo formato do atlas das salas, tools/sprites_mapa.py; so a 1a fase das animacoes
#                     e, no fim, a pagina: paleta.png = 0, paleta_1.png = 1...)
#        nomes[id] = nome do items.xml (itens da paleta e da cidade); cats[categoria] = [ids]; paginas = quantas
# Rodar local: ASSETS=... ITEMS=... SALAS=... python sprites_paleta.py   (LIMITE=500: so os 500 primeiros, teste)
#
# Ficam de fora: itens sem nome, corpos, poças, roupas, municao, empilhaveis, campos magicos, teleportes,
# armadilhas e o que se carrega na mochila (armas, pocoes, runas...), menos a decoracao pegavel (vasos,
# candelabros, livros, caixas...). Sao artes da CipSoft: so valem com o jogo fechado (senha).
import bisect
import glob
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sprites import ASSETS, SIZES, catalog, fields, sheet, varint  # noqa: E402
from PIL import Image  # noqa: E402

SALAS = os.environ.get("SALAS", "/opt/idle/gateway/public/salas")
ITEMS = os.environ.get("ITEMS", "/opt/idle/src/canary-3.6.1/data/items/items.xml")
LIMITE = int(os.environ.get("LIMITE", "0"))  # teste: so os N primeiros itens
COLS = 16           # celulas por linha (igual ao atlas das salas)
ROWS_PAGE = 256     # linhas por pagina: 1024 x 16384 px, o navegador carrega bem

# categorias, na ordem em que aparecem no editor (a paleta fica nessa ordem: cada categoria cai em poucas paginas)
CATS = ["chao", "bordas", "paredes", "decoracao", "natureza", "luzes", "moveis", "outros"]

BAD_NAME = re.compile(r"\b(field|fields|teleport|trap|portal|magic wall|wild growth|remains|dead|corpse|blood|splash|slime|"
                      r"void|nothing|unknown|soul core|rune|potion|coin|coins|fluid|pool|reserved sprite|old tibia item|"
                      r"event item|test|forcefield)\b", re.I)
# luz de verdade (o resto que brilha, como paredes de cristal, cai na categoria pelo nome)
LIGHT = re.compile(r"\b(lamps?|lanterns?|torch|torches|candles?|candelabrum|candelabra|candlestick|chandelier|basin|"
                   r"campfire|bonfire|fire|fireplace|brazier|lit|light|lights|beacon|lamppost|street lamp|oven|furnace|"
                   r"forge|pagoda|lampion|fireworks)\b", re.I)
# pegavel que e enfeite (fica na paleta)
DECOR_TAKE = re.compile(r"\b(candelabrum|candlestick|lamp|lantern|vase|amphora|flower|flowers|pillow|cushion|book|books|"
                        r"scroll|parchment|document|bottle|jug|cup|mug|pottery|bowl|bucket|basket|pot|rubbish|bone|bones|"
                        r"skull|twig|wood|fur|plate|barrel|crate|box|chest|trunk|statue|statuette|figurine|trophy|doll|"
                        r"globe|clock|hourglass|lute|harp|drum|picture|painting|mirror|carpet|rug)\b", re.I)
# mercado: categorias de coisa de mochila (armaduras, armas, pocoes, runas, comida, joias, produtos de criatura...)
INV_MARKET = {1, 2, 3, 6, 7, 8, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27}
MARKET_DECOR = 5

NATURE = re.compile(r"\b(trees?|bush|bushes|plants?|flowers?|fern|palm|cactus|reeds?|vines?|moss|mushrooms?|stones?|rocks?|"
                    r"boulder|pebbles?|stump|log|logs|branch|branches|grass|leaves|coral|shell|hay|straw|roots?|thorn|"
                    r"jungle|lily|sunflower|rose|tulip|blossom|mountain|hill|crystals?|snow|ice|sand|mud|swamp|water|"
                    r"waterfall|lava|dirt|earth|bamboo|willow|oak|pine|fir|birch|cypress|dead tree|shrub|weeds?|nettle|"
                    r"clover|daisy|orchid|seaweed|kelp|algae|geyser|stalagmite|stalactite)\b", re.I)
WALL = re.compile(r"\b(wall|walls|window|windows|door|doors|gate|gates|archway|arch|pillar|pillars|column|columns|fence|"
                  r"railing|railings|bars|grating|grate|roof|roofs|battlement|parapet|palisade|buttress|beam|frame|"
                  r"framework|staircase|stairs|ladder|ramp|bridge|wooden planks)\b", re.I)
FURNITURE = re.compile(r"\b(table|tables|chair|chairs|bed|beds|chest|wardrobe|drawers?|cupboard|shelf|shelves|bookcase|"
                       r"bench|stool|throne|desk|trough|barrel|crate|box|sofa|couch|cabinet|counter|locker|mailbox|depot|"
                       r"oven|stove|piano|harp|pedestal|dresser|rack|wardrobe|coffin|sarcophagus|cradle|hammock|bathtub|"
                       r"tub|basin|sink|anvil|forge|furnace|loom|spinning wheel|easel|bar|tavern|cot|bunk|trunk|kitchen|"
                       r"cooking|pot|cauldron)\b", re.I)
DECOR = re.compile(r"\b(statue|statues|banner|tapestry|carpet|rug|painting|picture|mirror|vase|trophy|flag|sign|signs|"
                   r"ornament|ornamented|fountain|altar|skull|bones?|dummy|figurine|bust|sculpture|monument|obelisk|"
                   r"tombstone|gravestone|grave|tomb|shrine|well|clock|globe|map|chart|decoration|decorative|curtain|"
                   r"drapery|wreath|garland|bell|lantern|candle|book|books|scroll|bottle|amphora|pottery|skeleton|web|"
                   r"cobweb|chain|chains|rope|net|sack|sacks|pile|heap|rubbish|trash|debris|rubble)\b", re.I)


def parse(v):
    """Appearance de objeto: id, padroes e sprites da 1a fase do 1o frame group e as flags que importam."""
    o = {"id": None, "px": 1, "py": 1, "pz": 1, "layers": 1, "ids": [], "order": 3, "sx": 0, "sy": 0, "elev": 0,
         "block": 0, "take": False, "light": 0, "market": None, "skip": False, "bank": False, "clip": False,
         "bottom": False, "rotate": False, "container": False}
    for num, wt, val in fields(v):
        if num == 1 and wt == 0:
            o["id"] = val
        elif num == 2 and wt == 2 and not o["ids"]:
            for n2, w2, v2 in fields(val):
                if n2 == 3 and w2 == 2:
                    for n3, w3, v3 in fields(v2):
                        if n3 == 1 and w3 == 0:
                            o["px"] = v3
                        elif n3 == 2 and w3 == 0:
                            o["py"] = v3
                        elif n3 == 3 and w3 == 0:
                            o["pz"] = v3
                        elif n3 == 4 and w3 == 0:
                            o["layers"] = v3
                        elif n3 == 5:
                            if w3 == 0:
                                o["ids"].append(v3)
                            else:
                                i = 0
                                while i < len(v3):
                                    x, i = varint(v3, i)
                                    o["ids"].append(x)
        elif num == 3 and wt == 2:  # AppearanceFlags
            for n3, w3, v3 in fields(val):
                if n3 == 1:
                    o["order"], o["bank"] = 0, True
                elif n3 == 2:
                    o["clip"] = True
                    if o["order"] > 1:
                        o["order"] = 1
                elif n3 == 3:
                    o["bottom"] = True
                    if o["order"] > 2:
                        o["order"] = 2
                elif n3 == 4:
                    o["order"] = 4
                elif n3 == 5:
                    o["container"] = True
                elif n3 == 13:
                    o["block"] = 1
                elif n3 == 18:
                    o["take"] = True
                elif n3 == 22:
                    o["rotate"] = True
                elif n3 == 23 and w3 == 2:  # light: brilho e cor
                    for a, b, c in fields(v3):
                        if a == 1 and b == 0:
                            o["light"] = c
                elif n3 == 26 and w3 == 2:  # shift
                    for a, b, c in fields(v3):
                        if a == 1:
                            o["sx"] = c
                        elif a == 2:
                            o["sy"] = c
                elif n3 == 27 and w3 == 2:  # height (elevacao)
                    for a, b, c in fields(v3):
                        if a == 1:
                            o["elev"] = c
                elif n3 == 36 and w3 == 2:  # market: categoria
                    for a, b, c in fields(v3):
                        if a == 1 and b == 0:
                            o["market"] = c
                # 6 empilhavel, 12 poca, 19 liquido, 34 roupa, 42/43 corpo, 45 municao, 54/55 some com o tempo
                elif n3 in (6, 12, 19, 34, 42, 43, 45, 54, 55):
                    o["skip"] = True
    return o


def keep(o, name):
    if not name or o["skip"] or not o["ids"] or BAD_NAME.search(name):
        return False
    if o["take"]:
        if o["market"] in INV_MARKET:
            return False
        return o["market"] == MARKET_DECOR or bool(DECOR_TAKE.search(name))
    return True


def category(o, name):
    if o["bank"]:
        return "chao"
    if o["clip"]:
        return "decoracao" if re.search(r"\b(carpet|rug)\b", name, re.I) else "bordas"
    if o["light"] > 0 and LIGHT.search(name):
        return "luzes"
    if WALL.search(name):
        return "paredes"
    if NATURE.search(name):
        return "natureza"
    if FURNITURE.search(name) or (o["container"] and not o["take"]):
        return "moveis"
    if DECOR.search(name) or o["market"] == MARKET_DECOR:
        return "decoracao"
    if o["bottom"]:
        return "paredes"
    if o["rotate"]:
        return "moveis"
    return "outros"


def main():
    names = {}
    for el in ET.parse(ITEMS).getroot().iter("item"):
        nm = (el.get("name") or "").strip()
        if el.get("id"):
            names[int(el.get("id"))] = nm
        elif el.get("fromid") and el.get("toid"):
            for i in range(int(el.get("fromid")), int(el.get("toid")) + 1):
                names.setdefault(i, nm)
    city = set()
    cpath = os.path.join(SALAS, "cidade.json")
    if os.path.exists(cpath):
        for t in json.load(open(cpath))["tiles"]:
            city.update(t[3:])

    apps = open(glob.glob(ASSETS + "/appearances-*.dat")[0], "rb").read()
    objs = []
    for num, wt, v in fields(apps):
        if num == 1 and wt == 2:
            o = parse(v)
            if keep(o, names.get(o["id"], "")):
                o["cat"] = category(o, names[o["id"]])
                objs.append(o)
    objs.sort(key=lambda o: (CATS.index(o["cat"]), names[o["id"]].lower(), o["id"]))
    if LIMITE:
        objs = objs[:LIMITE]

    # celulas de cada item: padroes x padroes da 1a fase (camada 0, andar 0); itens com os mesmos sprites dividem
    entries = sorted(catalog, key=lambda c: c["firstspriteid"])
    starts = [c["firstspriteid"] for c in entries]

    def sprite_list(o):
        out = []
        for y in range(o["py"]):
            for x in range(o["px"]):
                idx = ((0 * o["pz"] + 0) * o["py"] + y) * o["px"] + x
                idx *= o["layers"]
                out.append(o["ids"][idx] if idx < len(o["ids"]) else None)
        return tuple(out)

    atlas, seen, slot = {}, {}, 0
    for o in objs:
        sl = sprite_list(o)
        n = len(sl)
        if sl in seen:
            k = seen[sl]
        else:
            # o item nao atravessa a virada de pagina (as celulas dele ficam juntas, numa folha so)
            room = ROWS_PAGE * COLS - slot % (ROWS_PAGE * COLS)
            if n > room:
                slot += room
            k = seen[sl] = slot
            slot += n
            o["fresh"] = True
        page, kk = divmod(k, ROWS_PAGE * COLS)
        o["k"] = k
        atlas[o["id"]] = [kk % COLS, kk // COLS, o["px"], o["py"], o["order"], o["sx"], o["sy"], o["elev"], o["block"], 1, 0, page]
    pages = max(1, (slot + ROWS_PAGE * COLS - 1) // (ROWS_PAGE * COLS))

    # pagina por pagina (uma imagem de 1024 x 16384 de cada vez na memoria), lendo cada folha uma vez por pagina
    empty = set()
    for p in range(pages):
        lo, hi = p * ROWS_PAGE * COLS, (p + 1) * ROWS_PAGE * COLS
        used = min(slot, hi) - lo
        rows = max(1, (used + COLS - 1) // COLS)
        img = Image.new("RGBA", (COLS * 64, rows * 64), (0, 0, 0, 0))
        want = {}
        for o in objs:
            if not o.get("fresh") or not (lo <= o["k"] < hi):
                continue
            for j, sid in enumerate(sprite_list(o)):
                if sid is None:
                    continue
                e = entries[bisect.bisect_right(starts, sid) - 1]
                if e["firstspriteid"] <= sid <= e["lastspriteid"]:
                    want.setdefault(e["file"], []).append((sid, o["k"] - lo + j, e))
        for f, lst in want.items():
            sh = sheet(lst[0][2])
            for sid, kk, e in lst:
                w, h = SIZES[e["spritetype"]]
                cols = sh.width // w
                n = sid - e["firstspriteid"]
                spr = sh.crop(((n % cols) * w, (n // cols) * h, (n % cols) * w + w, (n // cols) * h + h))
                img.paste(spr, ((kk % COLS) * 64 + 64 - w, (kk // COLS) * 64 + 64 - h), spr)
        # itens sem desenho nenhum (sprite vazio) saem da paleta
        for o in objs:
            if o.get("fresh") and lo <= o["k"] < hi:
                kk = o["k"] - lo
                n = o["px"] * o["py"]
                if all(img.crop(((c % COLS) * 64, (c // COLS) * 64, (c % COLS) * 64 + 64, (c // COLS) * 64 + 64)).getbbox() is None
                       for c in range(kk, kk + n)):
                    empty.add(o["k"])
        out = os.path.join(SALAS, "paleta.png" if p == 0 else "paleta_%d.png" % p)
        img.save(out, optimize=True)
        print("pagina", p, "|", rows, "linhas |", len(want), "folhas |", os.path.getsize(out) // 1024, "KB")

    cats = {c: [] for c in CATS}
    for o in objs:
        if o["k"] in empty:
            atlas.pop(o["id"], None)
            continue
        cats[o["cat"]].append(o["id"])
    nomes = {str(i): names[i] for i in atlas}
    for i in city:
        if names.get(i):
            nomes[str(i)] = names[i]
    data = {"atlas": {str(k): v for k, v in atlas.items()}, "nomes": nomes, "cats": cats, "paginas": pages}
    json.dump(data, open(os.path.join(SALAS, "paleta.json"), "w"), separators=(",", ":"))
    # paginas que sobraram de uma paleta maior (rodada anterior)
    for f in glob.glob(os.path.join(SALAS, "paleta_*.png")):
        m = re.search(r"paleta_(\d+)\.png$", f)
        if m and int(m.group(1)) >= pages:
            os.remove(f)
    print("paleta:", len(atlas), "itens |", slot, "celulas |", pages, "paginas |",
          ", ".join("%s %d" % (c, len(v)) for c, v in cats.items()), "| nomes:", len(nomes),
          "| json:", os.path.getsize(os.path.join(SALAS, "paleta.json")) // 1024, "KB")


if __name__ == "__main__":
    main()
