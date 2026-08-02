"""Servidor do editor de mapas: serve a interface e cuida de salvar/publicar.

O editor em si roda no navegador. Aqui ficam as tres coisas que o navegador
nao consegue fazer sozinho: entregar os PNGs da paleta, escrever o .otbm no
formato binario do Canary, e - se pedido - mandar o mapa para a VPS e
reiniciar o servidor, para o que voce acabou de desenhar estar em jogo.

    python servidor.py                # so local
    python servidor.py --publicar     # cada Salvar tambem atualiza a VPS
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.normpath(os.path.join(AQUI, "..", ".."))
EDITOR = os.path.join(AQUI, "editor")
PROJETO = os.path.join(EDITOR, "projeto.json")
MUNDO = os.path.join(RAIZ, "ot", "src2", "canary-3.6.1", "data-canary", "world")

sys.path.insert(0, AQUI)
from criar_mapa import companheiros, escreve_otbm    # noqa: E402

VPS = "aldruna-vps"
CONTAINER = "aldruna-server-1"
COMPOSE = "/opt/aldruna/docker-compose.yml"

PUBLICAR = False
NOME = "teste"


def _ssh(comando, entrada=None):
    return subprocess.run(["ssh", "-o", "BatchMode=yes", VPS, comando],
                          input=entrada, capture_output=True, timeout=180)


def publica(arquivos):
    """Manda o mapa para a VPS e reinicia o servidor do jogo.

    Reiniciar e inevitavel: o Canary le o mapa inteiro na subida e o mantem em
    memoria, entao trocar o arquivo com ele no ar nao muda nada.
    """
    passos = []
    tar = subprocess.run(["tar", "cf", "-", "-C", MUNDO] + arquivos,
                         capture_output=True, timeout=120)
    if tar.returncode:
        return ["falhou ao empacotar: " + tar.stderr.decode("utf-8", "replace")[:200]]
    r = _ssh("mkdir -p /root/mapa_teste && tar xf - -C /root/mapa_teste", tar.stdout)
    if r.returncode:
        return ["falhou o envio: " + r.stderr.decode("utf-8", "replace")[:200]]
    passos.append("enviado para a VPS")

    r = _ssh(f"for f in /root/mapa_teste/*; do docker cp \"$f\" "
             f"{CONTAINER}:/canary/data-canary/world/; done")
    if r.returncode:
        return passos + ["falhou ao copiar para o container"]
    passos.append("copiado para o container")

    r = _ssh(f"docker compose -f {COMPOSE} restart server")
    passos.append("servidor reiniciado" if not r.returncode
                  else "falhou ao reiniciar")
    return passos


def exporta(projeto):
    """projeto do editor -> .otbm em disco (e na VPS, se --publicar)."""
    casas = {}
    for chave, casa in projeto.get("casas", {}).items():
        x, y, z = (int(v) for v in chave.split(","))
        casas[(x, y, z)] = (casa.get("chao") or 0, list(casa.get("itens") or []))
    if not casas:
        return {"erro": "o mapa esta vazio"}

    templo = projeto.get("templo")
    templo = tuple(templo) if templo else None
    dados, n, templo = escreve_otbm(
        casas, nome_arquivos=NOME,
        descricao=projeto.get("descricao", "Destruitor"),
        cidade=projeto.get("cidade", "Vila do Destruitor"), templo=templo)

    os.makedirs(MUNDO, exist_ok=True)
    with open(f"{MUNDO}/{NOME}.otbm", "wb") as f:
        f.write(dados)
    extras = companheiros(MUNDO, NOME)

    resposta = {"casas": n, "templo": list(templo),
                "arquivo": f"{MUNDO}/{NOME}.otbm", "passos": []}
    if PUBLICAR:
        resposta["passos"] = publica([f"{NOME}.otbm"] + extras)
    return resposta


class Alca(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass                      # sem ruido no terminal

    def _envia(self, corpo, tipo="application/json", codigo=200):
        if isinstance(corpo, (dict, list)):
            corpo = json.dumps(corpo).encode("utf-8")
        elif isinstance(corpo, str):
            corpo = corpo.encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(corpo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(corpo)

    def _arquivo(self, caminho, tipo):
        if not os.path.isfile(caminho):
            return self._envia({"erro": "nao achei"}, codigo=404)
        with open(caminho, "rb") as f:
            self._envia(f.read(), tipo)

    def do_GET(self):
        rota = self.path.split("?")[0]
        if rota in ("/", "/index.html"):
            return self._arquivo(f"{EDITOR}/index.html", "text/html; charset=utf-8")
        if rota == "/paleta.json":
            return self._arquivo(f"{EDITOR}/paleta.json", "application/json")
        if rota.startswith("/paleta/"):
            nome = os.path.basename(rota)
            if not nome.endswith(".png"):
                return self._envia({"erro": "so png"}, codigo=400)
            return self._arquivo(f"{EDITOR}/paleta/{nome}", "image/png")
        if rota == "/api/projeto":
            if os.path.isfile(PROJETO):
                return self._arquivo(PROJETO, "application/json")
            return self._envia({"casas": {}})
        if rota == "/api/estado":
            return self._envia({"publicar": PUBLICAR, "nome": NOME})
        self._envia({"erro": "rota desconhecida"}, codigo=404)

    def do_POST(self):
        if self.path != "/api/salvar":
            return self._envia({"erro": "rota desconhecida"}, codigo=404)
        n = int(self.headers.get("Content-Length", 0))
        try:
            projeto = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError as e:
            return self._envia({"erro": f"json invalido: {e}"}, codigo=400)

        with open(PROJETO, "w", encoding="utf-8") as f:
            json.dump(projeto, f)
        try:
            self._envia(exporta(projeto))
        except Exception as e:                     # nao derruba o editor
            self._envia({"erro": f"{type(e).__name__}: {e}"}, codigo=500)


def main():
    global PUBLICAR, NOME
    ap = argparse.ArgumentParser()
    ap.add_argument("--porta", type=int, default=8090)
    ap.add_argument("--publicar", action="store_true",
                    help="cada Salvar tambem atualiza a VPS e reinicia o jogo")
    ap.add_argument("--nome", default="teste", help="nome do mapa (sem .otbm)")
    a = ap.parse_args()
    PUBLICAR, NOME = a.publicar, a.nome

    endereco = f"http://127.0.0.1:{a.porta}/"
    print("=" * 58)
    print(f"  Editor de mapas do Destruitor  ->  {endereco}")
    print("  O endereco e sempre local: o editor roda no seu PC.")
    if PUBLICAR:
        print("  MODO: PUBLICA NA VPS - cada Salvar atualiza o jogo online")
    else:
        print("  MODO: SO LOCAL - Salvar grava no disco e nada mais")
        print("  (para publicar, use o Editor_de_Mapas.bat)")
    print("=" * 58)
    print("(Ctrl+C para encerrar)")
    threading.Timer(1.0, lambda: webbrowser.open(endereco)).start()
    ThreadingHTTPServer(("127.0.0.1", a.porta), Alca).serve_forever()


if __name__ == "__main__":
    main()
