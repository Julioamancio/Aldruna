"""Aldruna login server.

Serviço de login HTTP que o OTClient (13+) usa antes de conectar no jogo.
O Canary não faz esse papel (o login TCP clássico só aceita protocolo 11.00),
então este script responde o JSON de sessão + lista de personagens.
Roda local agora; na VPS será o mesmo, atrás do mesmo IP do servidor.
"""

import hashlib
import json
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN = ("127.0.0.1", 8080)
GAME_IP = "127.0.0.1"
GAME_PORT = 7172
WORLD_NAME = "Aldruna"
MARIADB = r"C:\Users\julio\Aldruna\ot\db\mariadb-11.4.4-winx64\bin\mariadb.exe"
DB_ARGS = ["-uroot", "-paldruna123", "canary", "-N", "-B", "-e"]

VOCATIONS = {
    0: "None", 1: "Sorcerer", 2: "Druid", 3: "Paladin", 4: "Knight",
    5: "Master Sorcerer", 6: "Elder Druid", 7: "Royal Paladin",
    8: "Elite Knight", 9: "Monk", 10: "Exalted Monk",
}


def sql(query):
    out = subprocess.run([MARIADB] + DB_ARGS + [query], capture_output=True, text=True, timeout=10)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip())
    rows = [line.split("\t") for line in out.stdout.splitlines() if line]
    return rows


def esc(value):
    return value.replace("\\", "\\\\").replace("'", "''")


def login_response(email, password):
    rows = sql(f"SELECT id, password FROM accounts WHERE email='{esc(email)}'")
    if not rows:
        return {"errorCode": 3, "errorMessage": "Email or password is not correct."}
    account_id, stored_hash = rows[0][0], rows[0][1].lower()
    if hashlib.sha1(password.encode()).hexdigest().lower() != stored_hash:
        return {"errorCode": 3, "errorMessage": "Email or password is not correct."}

    players = sql(
        "SELECT name, level, vocation, looktype, lookhead, lookbody, looklegs, "
        f"lookfeet, lookaddons, sex FROM players WHERE account_id={account_id} AND deletion=0"
    )

    characters = []
    for name, level, voc, looktype, head, body, legs, feet, addons, sex in players:
        characters.append({
            "worldid": 0,
            "name": name,
            "ismale": sex == "1",
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
        "location": "BRA",
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
        except Exception as exc:  # DB fora do ar etc.
            payload = {"errorCode": 3, "errorMessage": f"Login server error: {exc}"}
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        print("[login]", fmt % args)


if __name__ == "__main__":
    print(f"Aldruna login server em http://{LISTEN[0]}:{LISTEN[1]} -> jogo {GAME_IP}:{GAME_PORT}")
    ThreadingHTTPServer(LISTEN, Handler).serve_forever()
