# Destruitor Idle: icones oficiais das magias (como o Huntera mostra na barra de acoes) e a lista de
# magias do Tibia (level, mana, palavras, vocacoes), tirados do OTClient (github.com/mehah/otclient):
#   modules/gamelib/spells.lua            -> SpellInfo['Default'][nome] = {clientId, level, mana, ...}
#   data/images/game/spells/spell-icons-32x32.png -> uma tira de icones 32x32; o icone da magia
#                                            fica em x = clientId * 32
# Roda na VPS:  python3 /opt/idle/src/tools/magias.py
#   gera /opt/idle/gateway/public/magias/<nome-da-magia>.png (64x64) e magias/index.json
#
# Sao artes da CipSoft: so valem com o jogo fechado (senha), como os sprites dos itens.
import json
import os
import re
import urllib.request

from PIL import Image

BASE = "https://raw.githubusercontent.com/mehah/otclient/main/"
OUT = "/opt/idle/gateway/public/magias"
VOC = {1: "S", 2: "D", 3: "P", 4: "K", 5: "S", 6: "D", 7: "P", 8: "K"}  # 9/10 = Monk (nao temos)


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=60) as r:
        return r.read()


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def main():
    lua = get("modules/gamelib/spells.lua").decode("utf-8")
    # SpellInfo = { Default = { ['Nome'] = {...}, ... } (a primeira tabela 'Default' do arquivo e outra coisa)
    start = lua.index("Default = {", lua.index("SpellInfo = {"))
    end = lua.index("\n    }", start)
    block = lua[start:end]
    spells = []
    for m in re.finditer(r"\['([^']+)'\]\s*=\s*\{([^\n]*)\}", block):
        name, body = m.group(1), m.group(2)

        def field(key, default=None):
            f = re.search(r"\b" + key + r"\s*=\s*('([^']*)'|[-\d]+|true|false)", body)
            if not f:
                return default
            v = f.group(2) if f.group(2) is not None else f.group(1)
            return int(v) if re.fullmatch(r"-?\d+", v) else (v == "true" if v in ("true", "false") else v)

        vocs = re.search(r"vocations\s*=\s*\{([^}]*)\}", body)
        letters = sorted({VOC.get(int(x)) for x in re.findall(r"\d+", vocs.group(1))} - {None}) if vocs else []
        spells.append({
            "name": name, "words": field("words", ""), "type": field("type", ""), "level": field("level", 0),
            "mana": field("mana", 0), "maglevel": field("maglevel", 0), "clientId": field("clientId", -1),
            "exhaustion": field("exhaustion", 0), "premium": field("premium", False), "voc": "".join(letters),
        })
    sheet = Image.open(__import__("io").BytesIO(get("data/images/game/spells/spell-icons-32x32.png"))).convert("RGBA")
    os.makedirs(OUT, exist_ok=True)
    done = 0
    for s in spells:
        cid = s["clientId"]
        if cid is None or cid < 0 or (cid + 1) * 32 > sheet.width:
            s["icon"] = None
            continue
        icon = sheet.crop((cid * 32, 0, cid * 32 + 32, 32)).resize((64, 64), Image.NEAREST)
        s["icon"] = slug(s["name"]) + ".png"
        icon.save(os.path.join(OUT, s["icon"]), optimize=True)
        done += 1
    json.dump(spells, open(os.path.join(OUT, "index.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    print("magias:", len(spells), "| icones:", done)


if __name__ == "__main__":
    main()
