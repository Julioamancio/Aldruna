# Destruitor Idle: vigia do editor da cidade. Roda NA VPS, como root, chamado pelo systemd
# (vps/editor/idle-cidade-publicar.path quando aparece um pedido, e .timer de minuto em minuto):
#   python3 /opt/idle/src/tools/publicar_cidade.py
#
# Quando o Julio clica "Publicar na cidade", a ponte grava /opt/idle/editor/cidade_edicoes.json e
# /opt/idle/editor/publicar.pedido. Este script:
#   1. consome o pedido e roda decorar.py (DECOR + edicoes) e sprites_mapa.py numa pasta de preparo
#      (a pagina nunca pega um cidade.json pela metade, sem o atlas);
#   2. guarda a versao anterior em /opt/idle/editor/backup/<data>/ (as 5 ultimas) e troca cidade.png e
#      cidade.json (a pagina; a pasta salas esta montada no container da ponte: vale sem rebuild) e
#      cidade.otbm e idle_city.lua (o servidor do jogo);
#   3. reinicia o servidor do jogo e a ponte (o Canary so le o cidade.otbm ao subir; a ponte rele o povo da
#      cidade): na hora se ninguem esta jogando (gateway.json, que a ponte grava a cada 15 s), senao espera
#      e tenta de novo a cada minuto, ou reinicia ja se o Julio clicou "Reiniciar o servidor agora"
#      (recarregar.agora).
# O andamento vai para /opt/idle/editor/publicar.status.json, que a pagina do editor mostra:
#   { id, estado: aplicando|imagens|trocando|esperando|recarregando|pronto|erro, msg, inicio, fim, online, log }
#
# Teste local (sem docker): EDITOR_DIR=... SALAS=... IDLE_SCRIPTS=... ITEMS=... ASSETS=...
#   RECARREGAR="echo reiniciaria" python publicar_cidade.py
import json
import os
import shutil
import subprocess
import sys
import time

try:
    import fcntl
except ImportError:  # Windows (so no teste local)
    fcntl = None

D = os.environ.get("EDITOR_DIR", "/opt/idle/editor")
TOOLS = os.path.dirname(os.path.abspath(__file__))
SALAS = os.environ.get("SALAS", "/opt/idle/gateway/public/salas")
SCRIPTS = os.environ.get("IDLE_SCRIPTS", "/opt/idle/idle-scripts")
COMPOSE_DIR = os.environ.get("COMPOSE_DIR", "/opt/idle")
RECARREGAR = os.environ.get("RECARREGAR", "docker compose restart server gateway")
KEEP_BACKUPS = 5

PEDIDO = os.path.join(D, "publicar.pedido")
PENDENTE = os.path.join(D, "recarregar.pendente")
AGORA = os.path.join(D, "recarregar.agora")
STATUS = os.path.join(D, "publicar.status.json")


def now():
    return int(time.time())


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def status(**kw):
    st = read_json(STATUS, {}) or {}
    if "log" in kw:
        kw["log"] = (kw["log"] or [])[-40:]
    st.update(kw)
    write_json(STATUS, st)
    print("[%s] %s: %s" % (time.strftime("%H:%M:%S"), st.get("estado"), st.get("msg")), flush=True)
    return st


def put(src, dst):
    """Troca dst por src sem nunca deixar dst pela metade (copia ao lado e renomeia)."""
    tmp = dst + ".novo"
    shutil.copyfile(src, tmp)
    os.chmod(tmp, 0o644)
    os.replace(tmp, dst)


def online():
    """Quantos estao jogando (a ponte grava a cada 15 s). Sem noticia ha 90 s: a ponte esta fora, ninguem joga."""
    g = read_json(os.path.join(D, "gateway.json"))
    if not g or now() - int(g.get("at", 0)) > 90:
        return 0
    return int(g.get("online", 0))


def run(cmd, env, log):
    r = subprocess.run(cmd, env=env, cwd=TOOLS, capture_output=True, text=True, timeout=1800)
    out = (r.stdout + r.stderr).strip().splitlines()
    log.extend(out[-15:])
    if r.returncode:
        raise RuntimeError("%s saiu com erro %d" % (os.path.basename(cmd[-1]), r.returncode))


def publicar(pedido):
    pid = int(pedido.get("id") or now())
    log = []
    status(id=pid, estado="aplicando", msg="Aplicando as edições no mapa (decorar.py)…", inicio=now(), fim=0, online=None, log=log)
    try:
        base = os.path.join(SALAS, "cidade_base.json")
        if not os.path.exists(base):
            raise RuntimeError("falta %s (o recorte de Thais sem decoracao)" % base)
        prep = os.path.join(D, "preparo")
        shutil.rmtree(prep, ignore_errors=True)
        os.makedirs(prep)
        shutil.copyfile(base, os.path.join(prep, "cidade_base.json"))
        env = dict(os.environ, SALAS=prep, OUT_LUA=os.path.join(prep, "idle_city.lua"),
                   OUT_OTBM=os.path.join(prep, "cidade.otbm"), EDICOES=os.path.join(D, "cidade_edicoes.json"))
        run([sys.executable, os.path.join(TOOLS, "decorar.py")], env, log)
        status(estado="imagens", msg="Gerando as imagens da cidade (sprites_mapa.py)…", log=log)
        run([sys.executable, os.path.join(TOOLS, "sprites_mapa.py")], dict(env, ONLY="cidade"), log)
        novo = read_json(os.path.join(prep, "cidade.json"), {})
        if not novo.get("atlas") or not os.path.exists(os.path.join(prep, "cidade.png")):
            raise RuntimeError("o sprites_mapa.py nao gerou o atlas da cidade")

        status(estado="trocando", msg="Guardando a cidade anterior e trocando os arquivos…", log=log)
        bk = os.path.join(D, "backup", time.strftime("%Y%m%d-%H%M%S"))
        os.makedirs(bk, exist_ok=True)
        for f in (os.path.join(SALAS, "cidade.json"), os.path.join(SALAS, "cidade.png"),
                  os.path.join(SCRIPTS, "cidade.otbm"), os.path.join(SCRIPTS, "idle_city.lua")):
            if os.path.exists(f):
                shutil.copyfile(f, os.path.join(bk, os.path.basename(f)))
        olds = sorted(os.listdir(os.path.join(D, "backup")))
        for old in olds[:-KEEP_BACKUPS]:
            shutil.rmtree(os.path.join(D, "backup", old), ignore_errors=True)
        # a imagem antes do json: quem ler o json novo ja acha a imagem nova
        put(os.path.join(prep, "cidade.png"), os.path.join(SALAS, "cidade.png"))
        put(os.path.join(prep, "cidade.json"), os.path.join(SALAS, "cidade.json"))
        put(os.path.join(prep, "cidade.otbm"), os.path.join(SCRIPTS, "cidade.otbm"))
        put(os.path.join(prep, "idle_city.lua"), os.path.join(SCRIPTS, "idle_city.lua"))
        shutil.rmtree(prep, ignore_errors=True)
        log.append("backup da cidade anterior: " + bk)
        write_json(PENDENTE, {"id": pid, "at": now()})
        status(estado="esperando", msg="A página do jogo já mostra a cidade nova. Falta reiniciar o servidor do jogo.", log=log)
    except Exception as e:  # noqa: BLE001 - qualquer erro vira mensagem na pagina
        status(estado="erro", msg="A publicação falhou: %s. A cidade no ar continua a anterior." % e, fim=now(), log=log)


def recarregar():
    if not os.path.exists(PENDENTE):
        if os.path.exists(AGORA):
            os.remove(AGORA)  # nada esperando reinicio
        return
    forcar = os.path.exists(AGORA)
    n = online()
    st = read_json(STATUS, {}) or {}
    pend = int((read_json(PENDENTE, {}) or {}).get("id") or 0)
    # uma publicacao mais nova falhou: a anterior (que deu certo) ainda precisa do reinicio, mas o quadro
    # da pagina continua mostrando o erro da mais nova
    calado = st.get("estado") == "erro" and int(st.get("id") or 0) > pend
    if calado and (forcar or not n):
        r = subprocess.run(RECARREGAR, shell=True, cwd=COMPOSE_DIR, capture_output=True, text=True, timeout=600)
        for f in (PENDENTE, AGORA):
            if os.path.exists(f):
                os.remove(f)
        status(log=(st.get("log") or []) + ["servidor reiniciado com a publicacao anterior (%d): %s" % (pend, "ok" if r.returncode == 0 else "erro")])
        return
    if calado:
        return
    if n and not forcar:
        status(estado="esperando", online=n,
               msg="A página do jogo já mostra a cidade nova. O servidor do jogo reinicia quando ninguém estiver jogando "
                   "(%d %s agora), ou clique em Reiniciar o servidor agora." % (n, "pessoa jogando" if n == 1 else "pessoas jogando"))
        return
    status(estado="recarregando", online=n, msg="Reiniciando o servidor do jogo e a ponte…")
    log = st.get("log") or []
    try:
        r = subprocess.run(RECARREGAR, shell=True, cwd=COMPOSE_DIR, capture_output=True, text=True, timeout=600)
        log.extend((r.stdout + r.stderr).strip().splitlines()[-10:])
        ok = r.returncode == 0
    except Exception as e:  # noqa: BLE001
        log.append(str(e))
        ok = False
    for f in (PENDENTE, AGORA):
        if os.path.exists(f):
            os.remove(f)
    if ok:
        status(estado="pronto", msg="Publicado! A cidade nova está no jogo.", fim=now(), log=log)
    else:
        status(estado="erro", msg="A cidade nova está na página, mas o servidor do jogo não reiniciou. "
                                  "Reinicie na VPS: cd /opt/idle && docker compose restart server gateway", fim=now(), log=log)


def main():
    if not os.path.isdir(D):
        return
    lock = open(os.path.join(D, ".vigia.lock"), "w")
    if fcntl:
        # outra rodada em andamento (alguem rodou a mao): espera ela acabar e segue; sair sem consumir o
        # pedido faria o .path do systemd disparar sem parar
        fcntl.flock(lock, fcntl.LOCK_EX)
    if os.path.exists(PEDIDO):
        # consome ja (o .path do systemd nao dispara de novo por ele; um pedido novo que chegar durante a
        # publicacao fica para a proxima rodada)
        tomado = PEDIDO + ".tomado"
        os.replace(PEDIDO, tomado)
        pedido = read_json(tomado, {}) or {}
        os.remove(tomado)
        publicar(pedido)
    recarregar()


if __name__ == "__main__":
    main()
