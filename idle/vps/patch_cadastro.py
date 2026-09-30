"""Acrescenta o cadastro (conta + personagem) ao login server do Destruitor Idle.

O cadastro so responde no caminho /cadastrar. O nginx publica /jogar/login.php
apontando fixo para /login.php, entao de fora so se chega ao /cadastrar pela
location protegida por senha (/jogar/cadastrar).
"""
p = "/opt/idle/login/login_server.py"
s = open(p).read()
if "def register_response" in s:
    raise SystemExit("cadastro ja aplicado")

REGISTER = r'''

NAME_RE = re.compile(r"^[A-Za-z][A-Za-z ]{2,19}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# vocacao escolhida no cadastro -> id do Canary
NEW_VOCATIONS = {"sorcerer": 1, "druid": 2, "paladin": 3, "knight": 4}


def register_response(body):
    email = str(body.get("email", "")).strip().lower()
    password = str(body.get("password", ""))
    name = " ".join(str(body.get("name", "")).split()).title()
    vocation = NEW_VOCATIONS.get(str(body.get("vocation", "")).lower())
    sex = 1 if str(body.get("sex", "male")).lower() == "male" else 0
    if not EMAIL_RE.match(email):
        return {"ok": False, "erro": "E-mail invalido."}
    if len(password) < 8:
        return {"ok": False, "erro": "A senha precisa de pelo menos 8 caracteres."}
    if not NAME_RE.match(name):
        return {"ok": False, "erro": "Nome: 3 a 20 letras, sem numeros nem simbolos."}
    if vocation is None:
        return {"ok": False, "erro": "Escolha uma vocacao."}
    if query("SELECT id FROM accounts WHERE email=%s", (email,)):
        return {"ok": False, "erro": "Ja existe uma conta com esse e-mail."}
    if query("SELECT id FROM players WHERE name=%s", (name,)):
        return {"ok": False, "erro": "Esse nome ja esta em uso."}

    conn = pymysql.connect(connect_timeout=10, read_timeout=10, **DB)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO accounts (name, email, password, type, creation) VALUES (%s, %s, %s, 1, %s)",
                (email[:32], email, hashlib.sha1(password.encode()).hexdigest(), int(time.time())),
            )
            account_id = cur.lastrowid
            # mesmos valores dos personagens de exemplo do Canary no level 8
            cur.execute(
                "INSERT INTO players (name, group_id, account_id, level, vocation, health, healthmax, experience,"
                " lookbody, lookfeet, lookhead, looklegs, looktype, maglevel, mana, manamax, manaspent,"
                " town_id, conditions, cap, sex) VALUES"
                " (%s, 1, %s, 8, %s, 185, 185, 4200, 113, 115, 95, 39, %s, 0, 90, 90, 0, 8, '', 470, %s)",
                (name, account_id, vocation, 128 if sex == 1 else 136, sex),
            )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "nome": name}
'''

s = s.replace("import os\n", "import os\nimport re\n", 1)
s = s.replace("\n\nclass LoginHTTPServer", REGISTER + "\n\nclass LoginHTTPServer", 1)
s = s.replace(
    '            if body.get("type") == "login" and email:',
    '            if self.path == "/cadastrar":\n'
    '                payload = register_response(body)\n'
    '            elif body.get("type") == "login" and email:',
    1,
)
assert s.count("register_response") == 2
open(p, "w").write(s)
print("cadastro aplicado")
