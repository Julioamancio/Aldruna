# Testa o AUTO de colar e anel sem servidor: roda o idle_acessorios.lua de verdade (e o I.parseConds do idle.lua)
# num interpretador Lua 5.1 em Python (luamini.py) sobre um Canary falso (canary_falso.lua).
#   python idle/tools/luateste/roda_acessorios.py
# Para so conferir a sintaxe de qualquer script Lua (nao ha luac nesta maquina nem na VPS):
#   python idle/tools/luateste/lualint.py idle/canary/scripts/idle/*.lua
import os
import re
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import luamini as L  # noqa: E402

SCRIPTS = os.path.join(AQUI, "..", "..", "canary", "scripts", "idle")


def ler(*p):
    return open(os.path.join(*p), encoding="utf-8").read()


def main():
    G = L.reset_globals()
    G.set("__avancar", lambda s: L.NOW.update(t=L.NOW["t"] + s))
    L.run(ler(AQUI, "canary_falso.lua"), "canary_falso.lua")
    m = re.search(r'(-- "self\.hp\.le\.75\.p&area\.targets\.ge\.2".*?\nend\n)', ler(SCRIPTS, "idle.lua"), re.S)
    if not m:
        sys.exit("I.parseConds nao achado no idle.lua")
    L.run("local I = Idle\n" + m.group(1), "idle.lua (I.parseConds)")
    L.run(ler(SCRIPTS, "idle_acessorios.lua"), "idle_acessorios.lua")
    try:
        L.run(ler(AQUI, "acessorios_cenarios.lua"), "acessorios_cenarios.lua")
    except L.LuaError as e:
        print("FALHOU:", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
