#!/usr/bin/env python3
"""Reempacota o OTClient 4.1 de navegador para o Destruitor Idle.

Entrada: /root/idle-dl/build-emscripten-web (release oficial) + /root/idle-dl/things1511.
Saida:   /opt/idle/web (servida em https://destruitor.com.br/jogar/).

Mudancas:
  1. poe os assets 15.11 dentro do pacote (/data/things/1511) - o download
     automatico do GitHub nao funciona dentro do navegador (CORS + COEP);
  2. init.lua: servidor unico (login HTTP em /jogar/login.php), sem clientAssets;
  3. otclient.js: todo socket vira wss://<host>/jogar/ws (a pagina e HTTPS,
     e o navegador nao abre TCP; o nginx leva ate a ponte websockify).
"""
import hashlib
import os
import re
import shutil

SRC = "/root/idle-dl/build-emscripten-web"
THINGS = "/root/idle-dl/things1511"
OUT = "/opt/idle/web"
LOGIN_URL = "https://destruitor.com.br/jogar/login.php"

KEEP = re.compile(r"^(sprites-|appearances-|catalog-content|staticdata-|staticmapdata-|proficiencies-|map-)")

js = open(os.path.join(SRC, "otclient.js"), encoding="utf-8").read()
data = open(os.path.join(SRC, "otclient.data"), "rb").read()

m = re.search(r"loadPackage\(\{files:\[(.*?)\],remote_package_size:([\de.]+),package_uuid:\"([^\"]+)\"\}\)", js, re.S)
assert m, "metadata do pacote nao encontrada"
# o minificador escreve alguns offsets como 395e3
entries = re.findall(r"\{filename:\"([^\"]+)\",start:([\de.]+),end:([\de.]+)(,audio:1)?\}", m.group(1))
assert entries and len(entries) == m.group(1).count("{filename:"), "formato de entrada inesperado"

num = lambda v: int(float(v))
files = [(name, data[num(s):num(e)], audio or "") for name, s, e, audio in entries]

# --- 2. init.lua ---------------------------------------------------------------
def patch_init(txt):
    txt = txt.replace("clientAssets = {\n        enabled = true,", "clientAssets = {\n        enabled = false,", 1)
    assert "enabled = false" in txt, "clientAssets nao desligado"
    start = txt.index("    Servers_init = {\n")
    end = txt.index("\nend\n", start)
    servers = (
        "    Servers_init = {\n"
        f"        [\"{LOGIN_URL}\"] = {{\n"
        "            port = 443,\n"
        "            protocol = 1511,\n"
        "            httpLogin = true,\n"
        "            useAuthenticator = false\n"
        "        }\n"
        "    }"
    )
    return txt[:start] + servers + txt[end:]

files = [(n, patch_init(b.decode("utf-8")).encode("utf-8") if n == "/init.lua" else b, a) for n, b, a in files]

# --- 1. assets 15.11 -----------------------------------------------------------
added = 0
for fn in sorted(os.listdir(THINGS)):
    if KEEP.match(fn):
        files.append((f"/data/things/1511/{fn}", open(os.path.join(THINGS, fn), "rb").read(), ""))
        added += 1

# --- monta o novo .data e a metadata -------------------------------------------
blob = bytearray()
meta = []
for name, content, audio in files:
    start = len(blob)
    blob += content
    meta.append(f'{{filename:"{name}",start:{start},end:{len(blob)}{audio}}}')
uuid = "sha256-" + hashlib.sha256(blob).hexdigest()
new_meta = f'loadPackage({{files:[{",".join(meta)}],remote_package_size:{len(blob)},package_uuid:"{uuid}"}})'
js = js[:m.start()] + new_meta + js[m.end():]

# pasta /data/things/1511 no sistema de arquivos virtual
anchor = 'Module["FS_createPath"]("/data","things",true,true);'
assert anchor in js, "createPath de /data/things nao encontrado"
js = js.replace(anchor, anchor + 'Module["FS_createPath"]("/data/things","1511",true,true);', 1)

# --- 3. socket -> wss://<host>/jogar/ws -----------------------------------------
old = 'var url="ws://".replace("#","//");'
assert js.count(old) == 1, "ponto do websocket nao encontrado"
new = ('var url=(typeof location!="undefined")?((location.protocol=="https:"?"wss://":"ws://")'
       '+location.host+location.pathname.replace(/[^\\/]*$/,"")+"ws"):"ws://";')
js = js.replace(old, new)

# --- grava ----------------------------------------------------------------------
tmp = OUT + ".new"
shutil.rmtree(tmp, ignore_errors=True)
os.makedirs(tmp)
open(os.path.join(tmp, "otclient.js"), "w", encoding="utf-8").write(js)
open(os.path.join(tmp, "otclient.data"), "wb").write(blob)
shutil.copy(os.path.join(SRC, "otclient.wasm"), tmp)
html = open(os.path.join(SRC, "otclient.html"), encoding="utf-8").read()
html = html.replace("<title>Loading</title>", "<title>Destruitor</title>")
open(os.path.join(tmp, "index.html"), "w", encoding="utf-8").write(html)
shutil.copy("/opt/idle/cadastro.html", tmp)
if os.path.isdir(OUT):
    shutil.rmtree(OUT + ".old", ignore_errors=True)
    os.rename(OUT, OUT + ".old")
os.rename(tmp, OUT)
print(f"{len(files)} arquivos ({added} assets 15.11), pacote {len(blob) // 1048576} MB, {uuid[:20]}...")
