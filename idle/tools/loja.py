# Destruitor Idle: gera a loja de equipamentos a partir do items.xml do Canary 3.6.1.
# Roda na VPS:  python3 /opt/idle/src/tools/loja.py   -> /opt/idle/idle-scripts/idle_shop.lua (IdleShopData)
#
# Por vocacao e categoria, uma "escada" de itens do mais fraco ao mais forte (no maximo MAX_PER_STEP
# por faixa de poder), com o level exigido pelo proprio item. Preco = o preco de compra de algum NPC
# do Canary, ou (se nenhum NPC vende) um preco proporcional ao poder do item.
import glob
import os
import re
import xml.etree.ElementTree as ET

SRC = "/opt/idle/src/canary-3.6.1"
OUT = "/opt/idle/idle-scripts/idle_shop.lua"

# ---------------------------------------------------------------- precos dos NPCs
buy, sell = {}, {}
for f in glob.glob(SRC + "/data-otservbr-global/npc/**/*.lua", recursive=True) + glob.glob(SRC + "/data-canary/npc/**/*.lua", recursive=True):
    s = open(f, encoding="utf-8", errors="replace").read()
    for blk in re.findall(r"\{[^{}]*clientId\s*=\s*\d+[^{}]*\}", s):
        cid = int(re.search(r"clientId\s*=\s*(\d+)", blk).group(1))
        b = re.search(r"\bbuy\s*=\s*(\d+)", blk)
        v = re.search(r"\bsell\s*=\s*(\d+)", blk)
        if b and int(b.group(1)) > 0:
            buy[cid] = min(buy.get(cid, 10 ** 9), int(b.group(1)))
        if v and int(v.group(1)) > 0:
            sell[cid] = max(sell.get(cid, 0), int(v.group(1)))

# ---------------------------------------------------------------- itens
VOC = {"sorcerer": "S", "druid": "D", "paladin": "P", "knight": "K"}
THROWING = {"spear", "hunting spear", "royal spear", "enchanted spear", "throwing knife", "throwing star", "assassin star", "viper star"}
# o comeco da escada: nada mais fraco que o equipamento inicial
MIN_POWER = {"arma": 15, "varinha": 12, "municao": 20, "escudo": 14, "capacete": 3, "armadura": 7, "calcas": 3, "botas": 1}
# level derivado da forca, para itens classicos que no Tibia nao pedem level (Demon Armor etc.)
LEVEL_FROM_POWER = {"arma": lambda p: (p - 22) * 4, "escudo": lambda p: (p - 20) * 6, "armadura": lambda p: (p - 7) * 9,
                    "capacete": lambda p: (p - 4) * 12, "calcas": lambda p: (p - 4) * 12, "botas": lambda p: (p - 1) * 25,
                    "varinha": lambda p: 0, "municao": lambda p: (p - 25) * 3}
PRICE_KIND = {"arma": 1.2, "varinha": 1.0, "escudo": 0.8, "armadura": 1.0, "capacete": 0.6, "calcas": 0.7, "botas": 0.6}



def attrs(el):
    d = {}
    for a in el.findall("attribute"):
        k = a.get("key")
        if k == "script":
            for b in a.findall("attribute"):
                d["script." + b.get("key")] = b.get("value")
        elif k:
            d[k] = a.get("value")
    return d


def num(d, k):
    try:
        return int(float(d.get(k, 0)))
    except ValueError:
        return 0


items = []
root = ET.parse(SRC + "/data/items/items.xml").getroot()
for el in root.iter("item"):
    if not el.get("id") or not el.get("name"):
        continue
    iid = int(el.get("id"))
    name = el.get("name")
    if re.search(r"broken|damaged|replica|ornate|of Sula|mean |dummy|exercise|training|test", name, re.I):
        continue
    d = attrs(el)
    wt = (d.get("weaponType") or d.get("script.weaponType") or "").lower()
    slot = (d.get("script.slot") or d.get("slotType") or "").lower()
    voc_txt = d.get("script.vocation", "")
    vocs = "".join(sorted({VOC[v] for v in re.findall(r"(sorcerer|druid|paladin|knight)", voc_txt.lower()) if v in VOC}))
    lvl = num(d, "script.level")
    it = {"id": iid, "name": name, "level": max(lvl, 1)}
    if wt in ("sword", "axe", "club"):
        atk = num(d, "attack")
        if atk <= 0:
            continue
        two = d.get("slotType", "") == "two-handed"
        it.update(kind="arma", wtype=wt, attack=atk, defense=num(d, "defense"), extradef=num(d, "extradef"), two=two, voc=vocs or "K")
        it["power"] = atk + (0 if two else num(d, "extradef"))
    elif wt == "distance":
        ammo = d.get("ammotype", "")
        atk = num(d, "attack")
        if not ammo and name.lower() not in THROWING:
            continue
        # arco/besta: o dano vem da municao (o hitchance/ataque do arco pesa pouco)
        it.update(kind="arma", wtype="distance", attack=atk, ammo=ammo, range=num(d, "range"), two=d.get("slotType", "") == "two-handed" or bool(ammo),
                  stack=not ammo, voc=vocs or "P")
        it["power"] = atk if not ammo else 30 + num(d, "attack") + 2 * num(d, "range")
    elif wt == "wand":
        lo, hi = num(d, "script.fromDamage"), num(d, "script.toDamage")
        if hi <= 0 or not vocs:
            continue
        it.update(kind="varinha", wtype="wand", minDmg=lo, maxDmg=hi, mana=num(d, "script.mana"), voc=vocs)
        it["power"] = (lo + hi) / 2
    elif wt == "ammunition" or d.get("script.weaponType", "").lower() == "ammo":
        atk = num(d, "attack")
        if atk <= 0 or not d.get("ammotype"):
            continue
        it.update(kind="municao", wtype="ammo", attack=atk, ammo=d.get("ammotype"), voc="P")
        it["power"] = atk
    elif wt == "shield":
        de = num(d, "defense")
        if de <= 0:
            continue
        it.update(kind="escudo", wtype="shield", defense=de, voc=vocs or "KP")
        it["power"] = de
    elif slot in ("head", "armor", "legs", "feet") and num(d, "armor") > 0:
        kind = {"head": "capacete", "armor": "armadura", "legs": "calcas", "feet": "botas"}[slot]
        it.update(kind=kind, wtype=slot, armor=num(d, "armor"), voc=vocs or "SDPK")
        it["power"] = num(d, "armor")
    else:
        continue
    if it["power"] < MIN_POWER[it["kind"]] and not (it["kind"] == "arma" and it["wtype"] == "distance"):
        continue
    it["level"] = max(it["level"], int(LEVEL_FROM_POWER[it["kind"]](it["power"])), 1)
    if it["kind"] == "municao":
        it["price"] = buy.get(iid) or max(1, sell.get(iid, 0) * 3, int(it["attack"] / 10))
    else:
        by_level = 300 + 6 * it["level"] ** 2 * PRICE_KIND[it["kind"]]
        it["price"] = int(max(buy.get(iid, 0), by_level, sell.get(iid, 0) * 3))
        if it.get("stack"):  # arma de arremesso se gasta: preco por unidade
            it["price"] = buy.get(iid) or max(sell.get(iid, 0) * 3, 3 + it["level"] // 4)
    items.append(it)

# ---------------------------------------------------------------- escada por vocacao e categoria
MAX_PER_STEP = 2
chosen = {}
for voc in "SDPK":
    for kind in ("arma", "varinha", "municao", "escudo", "capacete", "armadura", "calcas", "botas"):
        pool = [i for i in items if i["kind"] == kind and voc in i["voc"] and i["level"] <= 400]
        if kind == "escudo" and voc in "SD":
            pool = [i for i in pool if "spellbook" in i["name"].lower() or i["power"] <= 30]
        pool.sort(key=lambda i: (i["power"], i["level"], i["price"]))
        steps = {}
        for i in pool:
            key = round(i["power"] / (2 if kind in ("capacete", "armadura", "calcas", "botas") else 4))
            lst = steps.setdefault(key, [])
            # na mesma faixa de poder: o de menor level e depois o mais barato
            lst.append(i)
        for key, lst in steps.items():
            lst.sort(key=lambda i: (i["level"], i["price"]))
            for i in lst[:MAX_PER_STEP]:
                chosen[i["id"]] = i

shop = sorted(chosen.values(), key=lambda i: (i["kind"], i["power"], i["level"]))


def q(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


lines = ["-- Gerado por tools/loja.py a partir do items.xml e das lojas de NPC do Canary 3.6.1 (nao editar a mao).", "IdleShopData = {"]
for i in shop:
    fields = ["id = %d" % i["id"], "name = %s" % q(i["name"]), "kind = %s" % q(i["kind"]), "wtype = %s" % q(i["wtype"]),
              "voc = %s" % q(i["voc"]), "level = %d" % i["level"], "price = %d" % i["price"]]
    for k in ("attack", "defense", "extradef", "armor", "minDmg", "maxDmg", "mana", "range"):
        if i.get(k):
            fields.append("%s = %d" % (k, i[k]))
    if i.get("ammo"):
        fields.append("ammo = %s" % q(i["ammo"]))
    if i.get("two"):
        fields.append("two = true")
    if i.get("stack"):
        fields.append("stack = true")
    lines.append("\t{ " + ", ".join(fields) + " },")
lines.append("}")
open(OUT, "w", encoding="utf-8").write("\n".join(lines) + "\n")

from collections import Counter
print("itens na loja:", len(shop), dict(Counter(i["kind"] for i in shop)))
for voc in "SDPK":
    for kind in ("arma", "varinha", "armadura"):
        lst = [i for i in shop if i["kind"] == kind and voc in i["voc"]]
        if lst:
            print(voc, kind, [(i["name"], i.get("attack") or i.get("maxDmg") or i.get("armor"), "lv", i["level"], i["price"]) for i in lst[:3] + lst[-2:]])
