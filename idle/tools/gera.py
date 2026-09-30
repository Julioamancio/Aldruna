# Destruitor Idle: copia os monstros cacaveis do Canary 3.6.1 e gera as cacadas calibradas.
# Roda na VPS:  python3 /opt/idle/src/gera.py
#   -> copia monstros e magias de monstro para /opt/idle/server/data-canary (reconstruir a imagem depois)
#   -> escreve /opt/idle/idle-scripts/idle_hunts.lua (IdleHuntsData = cacadas montadas, IdleSoloData = cacada livre)
#
# Monstro cacavel = esta no Bestiario e nao e chefe (ficam de fora bosses, raids, eventos, familiares e
# os que dependem de funcoes ou magias que so existem em quests do datapack global).
#
# Level indicado por vocacao = o menor level que passa nos dois testes:
#   (a) pior golpe: os 2 monstros mais fortes batendo juntos cabem em 60% da vida efetiva;
#   (b) luta longa: com 3 monstros (pull Ousado), o dano medio menos a cura por turno nao tira
#       mais de 70% da vida efetiva no tempo de matar o pull.
import re, glob, json, os, shutil, collections, math

SRC = "/opt/idle/src/canary-3.6.1"
DST = "/opt/idle/server/data-canary"
OUT = "/opt/idle/idle-scripts/idle_hunts.lua"
HERE = os.path.dirname(os.path.abspath(__file__))


def rd(f):
    return open(f, encoding="utf-8", errors="replace").read()


# ---------------------------------------------------------------- indices
core_funcs = set()
for f in glob.glob(SRC + "/data/**/*.lua", recursive=True) + glob.glob(SRC + "/data-canary/**/*.lua", recursive=True):
    core_funcs |= set(re.findall(r"^function ([A-Za-z_][A-Za-z0-9_]*)\s*\(", rd(f), re.M))

spell_file = {}  # nome da magia -> (arquivo, vem do global?)
for root in ("/data-canary/scripts/spells", "/data/scripts/spells", "/data-otservbr-global/scripts/spells/monster"):
    for f in glob.glob(SRC + root + "/**/*.lua", recursive=True):
        for n in re.findall(r'spell:name\("([^"]+)"\)', rd(f)):
            spell_file.setdefault(n.lower(), (f, "otservbr-global" in root))

prices = {}
for line in open("/opt/idle/idle-scripts/idle_prices.lua"):
    m = re.match(r"\s*\[(\d+)\] = (\d+),", line)
    if m:
        prices[int(m.group(1))] = int(m.group(2))
item_id = {}
for m in re.finditer(r'<item id="(\d+)"[^>]*?name="([^"]+)"', rd(SRC + "/data/items/items.xml")):
    item_id.setdefault(m.group(2).lower(), int(m.group(1)))
COIN = {3031: 1, 3035: 100, 3043: 10000}
BUILTIN = {"melee", "combat", "speed", "outfit", "invisible", "drunk", "firefield", "poisonfield", "energyfield",
           "condition", "strength", "effect", "physical", "healing"}


def block(s, key):
    m = re.search(r"monster\." + key + r" = \{(.*?)\n\}", s, re.S)
    return m.group(1) if m else ""


def parse(f):
    s = rd(f)
    name = re.search(r'createMonsterType\("([^"]+)"', s).group(1)

    def num(k):
        m = re.search(k + r"\s*=\s*(-?[\d.]+)", s)
        return int(float(m.group(1))) if m else 0

    melee, smax, savg, spells = 0, 0, 0.0, set()
    # uma entrada por linha (algumas tem condition = { ... } dentro)
    for line in block(s, "attacks").splitlines():
        nm = re.search(r'name = "([^"]+)"', line)
        if not nm:
            continue
        n = nm.group(1)
        mx = re.search(r"maxDamage = (-?[\d.]+)", line)
        mx = abs(int(float(mx.group(1)))) if mx else 0
        ch = re.search(r"chance = ([\d.]+)", line)
        ch = int(float(ch.group(1))) if ch else 100
        if n == "melee":
            sk, at = re.search(r"skill = (\d+)", line), re.search(r"attack = (\d+)", line)
            if not mx and sk and at:  # Weapons::getMaxMeleeDamage do Canary
                mx = int(int(sk.group(1)) * int(at.group(1)) * 0.05 + int(at.group(1)) * 0.5)
            melee = max(melee, mx)
        else:
            smax = max(smax, mx if ch >= 10 else mx // 2)  # magia rara pesa metade no pior caso
            savg += mx * ch / 100.0
            if n.lower() not in BUILTIN:
                spells.add(n.lower())
    for line in block(s, "defenses").splitlines():
        nm = re.search(r'name = "([^"]+)"', line)
        if nm and nm.group(1).lower() not in BUILTIN:
            spells.add(nm.group(1).lower())

    loot = 0.0
    for line in block(s, "loot").splitlines():
        iid, nm = re.search(r"\bid = (\d+)", line), re.search(r'name = "([^"]+)"', line)
        i = int(iid.group(1)) if iid else (item_id.get(nm.group(1).lower()) if nm else None)
        ch = re.search(r"chance = (\d+)", line)
        mc = re.search(r"maxCount = (\d+)", line)
        ch = int(ch.group(1)) / 100000.0 if ch else 0
        mc = int(mc.group(1)) if mc else 1
        loot += (COIN.get(i) or prices.get(i, 0)) * ch * ((1 + mc) / 2.0 if mc > 1 else 1)

    cls = re.search(r'class = "([^"]+)"', s)
    return {"name": name, "xp": num(r"monster\.experience"), "hp": num(r"monster\.maxHealth"), "melee": melee,
            "smax": smax, "savg": savg, "loot": loot, "spells": spells, "class": cls.group(1) if cls else "?",
            "src": s, "bestiary": "monster.Bestiary" in s,
            "boss": bool(re.search(r"rewardBoss = true", s)) or "monster.bosstiary" in s}


# ---------------------------------------------------------------- monstros
mons = {}
for f in sorted(glob.glob(SRC + "/data-canary/monster/**/*.lua", recursive=True)):
    try:
        m = parse(f)
    except AttributeError:
        continue
    m["origin"] = "canary"
    mons.setdefault(m["name"].lower(), m)

skipped = collections.Counter()
for f in sorted(glob.glob(SRC + "/data-otservbr-global/monster/**/*.lua", recursive=True)):
    if re.search(r"/(bosses|raids|event_creatures|familiars|trainers)/", f):
        continue
    try:
        m = parse(f)
    except AttributeError:
        continue
    if m["name"].lower() in mons or not m["bestiary"] or m["boss"]:
        continue
    calls = set(re.findall(r"^\s*([A-Z][A-Za-z0-9_]+)\(", m["src"], re.M)) - {"Game"}
    if [c for c in calls if c not in core_funcs]:
        skipped["funcao que so existe no global"] += 1
        continue
    loot_names = {n.lower() for n in re.findall(r'name = "([^"]+)"', block(m["src"], "loot"))}
    m["spells"] -= loot_names
    if [x for x in m["spells"] if x not in spell_file]:
        skipped["magia inexistente"] += 1
        continue
    m["origin"] = "global"
    mons[m["name"].lower()] = m

mon_dir = os.path.join(DST, "monster", "idle")
sp_dir = os.path.join(DST, "scripts", "spells", "monster", "idle")
for d in (mon_dir, sp_dir):
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)
need = set()
for m in mons.values():
    if m["origin"] != "global":
        continue
    s = re.sub(r"monster\.events = \{.*?\}\n", "", m["src"], flags=re.S)  # eventos de quest nao existem aqui
    open(os.path.join(mon_dir, re.sub(r"[^a-z0-9_]", "_", m["name"].lower()) + ".lua"), "w", encoding="utf-8").write(s)
    need |= {x for x in m["spells"] if spell_file[x][1]}
own_spells = {n for n, (f, glob_) in spell_file.items() if not glob_}
copied = set()
for x in sorted(need):
    f = spell_file[x][0]
    if f in copied:
        continue
    # um arquivo do global que redefine magia que o data-canary ja tem daria "Duplicate registered"
    if {n.lower() for n in re.findall(r'spell:name\("([^"]+)"\)', rd(f))} & own_spells:
        continue
    copied.add(f)
    shutil.copy(f, os.path.join(sp_dir, os.path.basename(f)))
print("monstros no jogo:", len(mons), "| copiados do global:", sum(1 for m in mons.values() if m["origin"] == "global"),
      "| magias copiadas:", len(copied), "| pulados:", dict(skipped))

# ---------------------------------------------------------------- level indicado
HP = {"K": lambda L: 185 + 15 * (L - 8), "P": lambda L: 185 + 10 * (L - 8), "M": lambda L: 185 + 5 * (L - 8)}
MANA = {"K": lambda L: 90 + 5 * (L - 8), "P": lambda L: 90 + 15 * (L - 8), "M": lambda L: 90 + 30 * (L - 8)}
POOL = {"K": lambda L: HP["K"](L),
        "P": lambda L: HP["P"](L) + 0.2 * MANA["P"](L),
        "M": lambda L: HP["M"](L) + (0.35 * MANA["M"](L) if L >= 14 else 0)}  # magic shield (quebra e volta em 14 s: conta 35% da mana)
# parte do corpo a corpo que cada vocacao leva: no idle o personagem fica parado e os monstros encostam,
# entao so a armadura/escudo reduz (validado em 30/09: Sorcerer lv31 morreu para Giant Spider com 0,45)
MELEE = {"K": 0.6, "P": 0.8, "M": 0.9}
HEAL = {"K": lambda L: 150 + 1.5 * L, "P": lambda L: 150 + 2 * L, "M": lambda L: 150 + 3 * L}  # pocao gratis + magia
def weapon_atk(L):
    """Ataque da arma: 25 (steel axe / spear) no level 8, subindo ate 50 conforme a loja de equipamentos."""
    return min(25 + 0.2 * (L - 8), 50)


def skill_at(L):
    """Skill tipica do Tibia por level (30 no 8, ~60 no 30, ~75 no 60, ~90 no 120, ~108 no 250).
    O personagem nasce com 30 e o servidor treina skill x4 (rateSkill)."""
    return min(30 + 22.7 * math.log(max(L, 8) / 8), 120)


def ml_at(L):
    """Magic level tipico de mago por level (8 no 8, ~50 no 30, ~85 no 100, ~105 no 200)."""
    return 8 + 30 * math.log(max(L, 8) / 8)


def dps(v, L):
    """Dano medio por turno de 2 s, pelas formulas do jogo (medido na VPS em 30/09: Knight lv10 skill 12 ~9/turno)."""
    if v == "M":
        ml = ml_at(L)
        wand = 13 + 0.3 * L
        strike = (L / 5 + ml * 1.8 + 10.5) if L >= 12 else 0  # Energy/Ice Strike, 1 por turno
        return wand + strike
    skill = skill_at(L) + (0 if v == "K" else 3)
    atk = weapon_atk(L)
    hit_max = skill * atk * 0.05 + atk * 0.5  # Weapons::getMaxMeleeDamage
    weapon = 0.35 * hit_max  # media contra erro, bloqueio e armadura do monstro
    if v == "K":
        spell = (L / 5 + 0.67 * (skill + atk)) * ((1 / 3 if L >= 16 else 0) + (1 / 3 if L >= 28 else 0))
    else:
        spell = (L / 5 + 0.67 * (skill + atk)) if L >= 23 else 0  # Ethereal Spear, 1 por turno
    return weapon + spell * 0.7


def need_level(group, v):
    hits = sorted((m["melee"] * MELEE[v] + m["smax"] for m in group), reverse=True)
    burst = hits[0] + (hits[1] if len(hits) > 1 else hits[0])
    avg_hit = sum(m["melee"] * MELEE[v] * 0.5 + m["savg"] * 0.5 for m in group) / len(group)
    hp = sum(m["hp"] for m in group) / len(group)
    for L in range(8, 1000):
        d = dps(v, L)
        turns = 3 * hp / d
        loss = max(0.0, 2 * avg_hit - HEAL[v](L)) * turns
        fast = hp / d <= 15 + hp / 250  # mata um monstro em ate 30 s + 1 s a cada 125 de vida
        if POOL[v](L) * 0.6 >= burst and loss <= POOL[v](L) * 0.7 and fast:
            return L
    return 999


def stats(group):
    lv = {v: need_level(group, v) for v in "KPM"}
    n = len(group)
    return {"lvl": {"K": lv["K"], "P": lv["P"], "S": lv["M"], "D": lv["M"]}, "min": min(lv.values()),
            "xpKill": round(sum(m["xp"] for m in group) / n), "lootKill": round(sum(m["loot"] for m in group) / n),
            "xpPerHp": round(sum(m["xp"] for m in group) / max(1, sum(m["hp"] for m in group)), 2)}


PT = json.load(open(os.path.join(HERE, "nomes_cacadas.json"), encoding="utf-8"))
curated = []
for line in open(os.path.join(HERE, "hunts_huntera.txt"), encoding="utf-8"):
    if "|" not in line:
        continue
    h, ms = line.strip().split("|")
    if h == "Falcon's Eye":  # mesmos monstros do Falcon Bastion
        continue
    group = [mons[x.strip().lower()] for x in ms.split(",") if x.strip().lower() in mons]
    if not group:
        continue
    r = stats(group)
    r.update({"id": PT[h][0], "name": PT[h][1], "monsters": [m["name"] for m in group]})
    r["max"] = max(max(r["lvl"].values()) * 2, r["min"] + 20)
    curated.append(r)
curated.sort(key=lambda x: (x["min"], x["xpKill"]))

solo = []
for m in mons.values():
    if m["xp"] > 0 and m["hp"] > 0:
        r = stats([m])
        r.update({"name": m["name"], "class": m["class"]})
        solo.append(r)
solo.sort(key=lambda x: (x["min"], x["name"]))


def q(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


lines = ["-- Gerado por tools/gera.py a partir dos monstros do Canary 3.6.1 (nao editar a mao).",
         "-- lvl = level indicado por vocacao no pull Ousado; xpKill/lootKill = media por monstro; xpPerHp = XP por ponto de vida.",
         "IdleHuntsData = {"]
for x in curated:
    lines.append("\t{ id = %s, name = %s, min = %d, max = %d, lvl = { K = %d, P = %d, S = %d, D = %d }, xpKill = %d, lootKill = %d, xpPerHp = %.2f, monsters = { %s } }," % (
        q(x["id"]), q(x["name"]), x["min"], x["max"], x["lvl"]["K"], x["lvl"]["P"], x["lvl"]["S"], x["lvl"]["D"],
        x["xpKill"], x["lootKill"], x["xpPerHp"], ", ".join(q(n) for n in x["monsters"])))
lines.append("}")
lines.append("-- Cacada livre: qualquer monstro do bestiario, sozinho.")
lines.append("IdleSoloData = {")
for x in solo:
    lines.append("\t{ name = %s, class = %s, min = %d, lvl = { K = %d, P = %d, S = %d, D = %d }, xpKill = %d, lootKill = %d, xpPerHp = %.2f }," % (
        q(x["name"]), q(x["class"]), x["min"], x["lvl"]["K"], x["lvl"]["P"], x["lvl"]["S"], x["lvl"]["D"],
        x["xpKill"], x["lootKill"], x["xpPerHp"]))
lines.append("}")
open(OUT, "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("cacadas montadas:", len(curated), "| cacada livre:", len(solo))
for x in curated:
    if x["name"] in ("Tocas das Tarântulas", "Colinas dos Ciclopes", "Covil dos Dragões", "Pico dos Dragões Lordes",
                     "Portão Infernal", "Covil da Aranha Gigante", "Cemitério dos Carniçais", "Porões dos Ratos"):
        print(" ", x["name"], x["lvl"], "xp", x["xpKill"], "loot", x["lootKill"])
