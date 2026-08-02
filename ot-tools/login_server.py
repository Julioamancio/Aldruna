"""Aldruna login server.

Servico de login HTTP que o OTClient (13+) usa antes de conectar no jogo.
O Canary nao faz esse papel (o protocollogin dele recusa clientes novos por
design), entao este servico consulta o banco e devolve sessao + personagens.

Roda igual no PC do Julio e na VPS; tudo que muda vem de variaveis de ambiente.

ATENCAO: WORLD_NAME precisa ser IDENTICO ao serverName do config.lua do Canary.
O cliente envia esse nome como identificacao antes de falar o protocolo e o
servidor derruba a conexao se nao bater (sintoma: "ERRO 10054" no cliente).
"""

import hashlib
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pymysql

LISTEN_HOST = os.environ.get("ALDRUNA_LISTEN_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("ALDRUNA_LISTEN_PORT", "8080"))
GAME_IP = os.environ.get("ALDRUNA_GAME_IP", "127.0.0.1")
GAME_PORT = int(os.environ.get("ALDRUNA_GAME_PORT", "7172"))
WORLD_NAME = os.environ.get("ALDRUNA_WORLD_NAME", "Destruitor")
WORLD_LOCATION = os.environ.get("ALDRUNA_WORLD_LOCATION", "BRA")

DB = {
    "host": os.environ.get("ALDRUNA_DB_HOST", "127.0.0.1"),
    "port": int(os.environ.get("ALDRUNA_DB_PORT", "3306")),
    "user": os.environ.get("ALDRUNA_DB_USER", "root"),
    "password": os.environ.get("ALDRUNA_DB_PASSWORD", "aldruna123"),
    "database": os.environ.get("ALDRUNA_DB_NAME", "canary"),
}

VOCATIONS = {
    0: "None", 1: "Arcanist", 2: "Druid", 3: "Ranger", 4: "Warrior",
    5: "Master Arcanist", 6: "Elder Druid", 7: "Royal Ranger",
    8: "Elite Warrior", 9: "Monk", 10: "Exalted Monk",
}


def query(sql, params=()):
    conn = pymysql.connect(connect_timeout=10, read_timeout=10, **DB)
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    finally:
        conn.close()


def login_response(email, password):
    rows = query("SELECT id, password FROM accounts WHERE email=%s", (email,))
    if not rows:
        return {"errorCode": 3, "errorMessage": "Email or password is not correct."}
    account_id, stored_hash = rows[0][0], (rows[0][1] or "").lower()
    if hashlib.sha1(password.encode()).hexdigest().lower() != stored_hash:
        return {"errorCode": 3, "errorMessage": "Email or password is not correct."}

    players = query(
        "SELECT name, level, vocation, looktype, lookhead, lookbody, looklegs, "
        "lookfeet, lookaddons, sex FROM players "
        "WHERE account_id=%s AND deletion=0 ORDER BY name",
        (account_id,),
    )

    characters = []
    for name, level, voc, looktype, head, body, legs, feet, addons, sex in players:
        characters.append({
            "worldid": 0,
            "name": name,
            "ismale": sex == 1,
            "ishidden": False,
            "ismaincharacter": False,
            "tutorial": False,
            "level": int(level),
            "vocation": VOCATIONS.get(int(voc), "None"),
            "outfitid": int(looktype),
            "headcolor": int(head),
            "torsocolor": int(body),
            "legscolor": int(legs),
            "detailcolor": int(feet),
            "addonsflags": int(addons),
            "dailyrewardstate": 0,
        })

    world = {
        "id": 0,
        "name": WORLD_NAME,
        "externaladdress": GAME_IP,
        "externalport": GAME_PORT,
        "externaladdressprotected": GAME_IP,
        "externalportprotected": GAME_PORT,
        "externaladdressunprotected": GAME_IP,
        "externalportunprotected": GAME_PORT,
        "previewstate": 0,
        "location": WORLD_LOCATION,
        "anticheatprotection": False,
        "pvptype": 0,
        "istournamentworld": False,
        "restrictedstore": False,
    }

    return {
        "session": {
            "sessionkey": f"{email}\n{password}",
            "lastlogintime": "0",
            "ispremium": True,
            "premiumuntil": int(time.time()) + 30 * 86400,
            "status": "active",
            "returnernotification": False,
            "showrewardnews": False,
            "isreturner": False,
            "fpstracking": False,
            "optiontracking": False,
            "emailcoderequestallowed": False,
        },
        "playdata": {"worlds": [world], "characters": characters},
    }


class LoginHTTPServer(ThreadingHTTPServer):
    # No Windows varias instancias conseguem ligar na mesma porta com
    # SO_REUSEADDR e o sistema sorteia quem atende - uma copia velha (apontando
    # para outra porta de jogo) derruba o login de forma intermitente.
    allow_reuse_address = False


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            body = {}
        email = body.get("email", "")
        password = body.get("password", "")
        try:
            if body.get("type") == "login" and email:
                payload = login_response(email, password)
            else:
                payload = {"errorCode": 3, "errorMessage": "Invalid request."}
        except Exception as exc:  # banco fora do ar etc.
            print(f"[login] erro: {exc}", flush=True)
            payload = {"errorCode": 3, "errorMessage": "Login server unavailable."}
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        print("[login]", fmt % args, flush=True)


if __name__ == "__main__":
    print(
        f"Aldruna login server em http://{LISTEN_HOST}:{LISTEN_PORT} "
        f"-> mundo '{WORLD_NAME}' em {GAME_IP}:{GAME_PORT}",
        flush=True,
    )
    try:
        server = LoginHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    except OSError as exc:
        raise SystemExit(f"Porta {LISTEN_PORT} ja em uso - ja existe um login server rodando. ({exc})")
    server.serve_forever()
