# Destruitor Idle: catalogo de colares e aneis (botoes AUTO do Inventario), tirado do items.xml do Canary 3.6.1.
# Roda na VPS:  python3 /opt/idle/src/tools/acessorios.py
#   le   /opt/idle/src/canary-3.6.1/data/items/items.xml  (+ /opt/idle/idle-scripts/idle_prices.lua, se existir)
#   gera /opt/idle/gateway/public/itens/acessorios.json
# Para testar em outro lugar:  python acessorios.py <items.xml> <saida.json> [idle_prices.lua]
#
# Cada peca sai uma vez so (a versao "de guardar"): a versao "no corpo" (transformequipto) da os bonus,
# a duracao e o id que aparece no slot. Pecas sem bonus nenhum (enfeites, medalhas, aneis de quest) ficam de fora,
# assim como as so de Monk (vocacao que o jogo nao tem).
#
# Os nomes e numeros sao da CipSoft (items.xml): o JSON fica em public/itens/, que nao vai para o git.
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

SRC = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ITEMS_XML", "/opt/idle/src/canary-3.6.1/data/items/items.xml")
OUT = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("OUT", "/opt/idle/gateway/public/itens/acessorios.json")
PRICES = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("PRICES", "/opt/idle/idle-scripts/idle_prices.lua")

SLOTS = {"necklace": "colar", "ring": "anel"}
TYPES_OK = {"", "rings", "amulets and necklaces"}
VOC = {"knight": "K", "elite knight": "K", "paladin": "P", "royal paladin": "P",
       "sorcerer": "S", "master sorcerer": "S", "druid": "D", "elder druid": "D"}

# protecao: elemento do items.xml -> nome na pagina
ELEM = [("physical", "físico"), ("fire", "fogo"), ("earth", "terra"), ("poison", "terra"), ("energy", "energia"),
        ("ice", "gelo"), ("holy", "sagrado"), ("death", "morte"), ("lifedrain", "dreno de vida"),
        ("manadrain", "dreno de mana"), ("drown", "afogamento"), ("healing", "cura")]
ALL_DMG = ["físico", "fogo", "terra", "energia", "gelo", "sagrado", "morte"]
SINGLE = {"físico": "Proteção física", "fogo": "Proteção contra fogo", "terra": "Proteção contra terra",
          "energia": "Proteção contra energia", "gelo": "Proteção contra gelo", "sagrado": "Proteção contra sagrado",
          "morte": "Proteção contra morte", "dreno de vida": "Proteção contra dreno de vida",
          "dreno de mana": "Proteção contra dreno de mana", "afogamento": "Proteção contra afogamento",
          "cura": "Proteção contra cura"}
SKILLS = [("skillsword", "Sword"), ("skillaxe", "Axe"), ("skillclub", "Club")]
OTHER_SKILLS = [("skilldist", "Distance fighting"), ("skillshield", "Shielding"), ("skillfist", "Fist fighting")]
ML = [("magiclevelpoints", "Magic level"), ("firemagiclevelpoints", "Magic level de fogo"),
      ("energymagiclevelpoints", "Magic level de energia"), ("earthmagiclevelpoints", "Magic level de terra"),
      ("icemagiclevelpoints", "Magic level de gelo"), ("holymagiclevelpoints", "Magic level sagrado"),
      ("deathmagiclevelpoints", "Magic level de morte"), ("healingmagiclevelpoints", "Magic level de cura"),
      ("physicalmagiclevelpoints", "Magic level físico")]
SPECIAL = {3057: [{"t": "Não perde itens se morrer (a peça some na morte)"}]}  # amulet of loss (script do Canary)


def read_items(path):
    """id -> {name, attrs (chaves em minusculas), script (atributos do moveevent)}"""
    out = {}
    for el in ET.parse(path).getroot().iter("item"):
        if el.get("fromid"):
            ids = range(int(el.get("fromid")), int(el.get("toid")) + 1)
        elif el.get("id"):
            ids = [int(el.get("id"))]
        else:
            continue
        attrs, script = {}, {}
        for a in el.findall("attribute"):
            k = (a.get("key") or "").lower()
            if k == "script":
                for b in a.findall("attribute"):
                    script[(b.get("key") or "").lower()] = b.get("value") or ""
            else:
                attrs[k] = a.get("value") or ""
        for i in ids:
            out[i] = {"name": el.get("name") or "", "attrs": attrs, "script": script}
    return out


def num(d, k):
    try:
        return int(float(d.get(k, "0") or 0))
    except ValueError:
        return 0


def sign(v):
    return ("+" if v > 0 else "−") + str(abs(v))


def duration(secs):
    if secs % 3600 == 0:
        h = secs // 3600
        return "%d hora%s" % (h, "" if h == 1 else "s")
    if secs >= 60:
        m, s = divmod(secs, 60)
        return "%d minuto%s" % (m, "" if m == 1 else "s") + (" e %d s" % s if s else "")
    return "%d segundos" % secs


def bonuses(a, item_id):
    out = list(SPECIAL.get(item_id, []))
    # protecao: junta os elementos com o mesmo valor ("Proteção +20% contra todos os tipos de dano")
    by_val = {}
    for key, name in ELEM:
        v = num(a, "absorbpercent" + key)
        if v and name not in by_val.get(v, []):
            by_val.setdefault(v, []).append(name)
    for v in sorted(by_val, key=lambda x: -x):
        names = by_val[v]
        if len(names) == 1:
            txt = "%s %s%%" % (SINGLE[names[0]], sign(v))
        elif set(ALL_DMG) <= set(names):
            rest = [n for n in names if n not in ALL_DMG]
            txt = "Proteção %s%% contra todos os tipos de dano" % sign(v) + (" e " + ", ".join(rest) if rest else "")
        else:
            txt = "Proteção %s%% contra %s e %s" % (sign(v), ", ".join(names[:-1]), names[-1])
        out.append({"t": txt, **({"neg": 1} if v < 0 else {})})
    # skills (sword, axe e club iguais viram uma linha so)
    melee = [(n, num(a, k)) for k, n in SKILLS if num(a, k)]
    if len(melee) == 3 and len({v for _, v in melee}) == 1:
        v = melee[0][1]
        out.append({"t": "Sword, axe e club fighting %s" % sign(v), **({"neg": 1} if v < 0 else {})})
    else:
        for n, v in melee:
            out.append({"t": "%s fighting %s" % (n, sign(v)), **({"neg": 1} if v < 0 else {})})
    for k, n in OTHER_SKILLS + ML:
        v = num(a, k)
        if v:
            out.append({"t": "%s %s" % (n, sign(v)), **({"neg": 1} if v < 0 else {})})
    v = num(a, "speed")
    if v:
        out.append({"t": "Velocidade %s" % sign(v), **({"neg": 1} if v < 0 else {})})
    if num(a, "healthgain"):
        out.append({"t": "Vida +%d a cada %s s" % (num(a, "healthgain"), round(num(a, "healthticks") / 1000) or 1)})
    if num(a, "managain"):
        out.append({"t": "Mana +%d a cada %s s" % (num(a, "managain"), round(num(a, "manaticks") / 1000) or 1)})
    for k, n in (("lifeleechamount", "Life leech"), ("manaleechamount", "Mana leech")):
        v = num(a, k)
        if v:
            out.append({"t": "%s +%s%%" % (n, ("%g" % (v / 100)).replace(".", ","))})
    for k, n in (("criticalhitchance", "Chance de crítico"), ("criticalhitamount", "Dano crítico")):
        v = num(a, k)
        if v:
            out.append({"t": "%s +%s%%" % (n, ("%g" % (v / 100)).replace(".", ","))})
    if num(a, "manashield"):
        out.append({"t": "Magic shield (a mana protege a vida)"})
    if num(a, "invisible"):
        out.append({"t": "Invisível"})
    if num(a, "suppressdrunk"):
        out.append({"t": "Imune a embriaguez"})
    v = num(a, "armor")
    if v:
        out.append({"t": "Armadura %s" % sign(v), **({"neg": 1} if v < 0 else {})})
    return out


def vocations(script):
    raw = script.get("vocation", "")
    if not raw:
        return ""
    letters = []
    for part in raw.split(","):
        name = part.split(";")[0].strip().lower()
        if name in VOC and VOC[name] not in letters:
            letters.append(VOC[name])
    if not letters:
        return None  # so Monk / sem vocacao: o jogo nao tem
    return "".join(sorted(letters, key="KPSD".index))


def prices(path):
    if not os.path.exists(path):
        return {}
    txt = open(path, encoding="utf-8").read()
    return {int(i): int(p) for i, p in re.findall(r"\[(\d+)\]\s*=\s*(\d+)", txt)}


def main():
    items = read_items(SRC)
    price = prices(PRICES)
    out, seen = [], set()
    for iid in sorted(items):
        it = items[iid]
        a, script = it["attrs"], it["script"]
        slot = SLOTS.get(script.get("slot", "").lower())
        if not slot or not it["name"] or a.get("primarytype", "").lower() not in TYPES_OK:
            continue
        if num(a, "transformdeequipto"):
            continue  # versao "no corpo": entra pelos dados da versao de guardar
        if "helmet" in it["name"].lower():
            continue  # o items.xml marca um elmo como colar
        equip = num(a, "transformequipto")
        worn = items.get(equip) if equip else None
        wa = worn["attrs"] if worn else a
        wscript = worn["script"] if worn else script
        voc = vocations(wscript) if wscript.get("vocation") else vocations(script)
        if voc is None:
            continue
        bonus = bonuses(wa, iid)
        if not bonus:
            continue  # enfeite: nao ha por que colocar no slot
        key = (slot, it["name"].lower())
        if key in seen:
            continue  # mesmo nome com outro id (versao de quest): fica a primeira
        seen.add(key)
        limit = []
        charges = num(a, "charges")
        if charges:
            limit.append("%d carga%s" % (charges, "" if charges == 1 else "s"))
        secs = num(wa, "duration")
        if secs:
            limit.append(duration(secs) + (" no slot" if equip else ""))
        after = num(wa, "decayto")
        if secs and after and after in items and items[after]["name"]:
            limit.append("depois vira " + items[after]["name"])
        level = max(num(script, "level"), num(wscript, "level"))
        entry = {"id": iid, "slot": slot, "name": it["name"], "bonus": bonus}
        if equip:
            entry["equip"] = equip
        if limit:
            entry["limite"] = ", ".join(limit)
        if level:
            entry["level"] = level
        if voc:
            entry["voc"] = voc
        if num(a, "weight"):
            entry["peso"] = num(a, "weight") / 100
        if price.get(iid):
            entry["preco"] = price[iid]
        out.append(entry)
    out.sort(key=lambda e: (e["slot"] != "colar", e.get("level", 0), e["name"].lower()))
    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"itens": out}, f, ensure_ascii=False, separators=(",", ":"))
    n = {s: sum(1 for e in out if e["slot"] == s) for s in ("colar", "anel")}
    print("colares: %d | aneis: %d | com preco de NPC: %d -> %s" % (n["colar"], n["anel"], sum(1 for e in out if "preco" in e), OUT))


if __name__ == "__main__":
    main()
