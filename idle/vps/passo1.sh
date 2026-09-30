#!/bin/bash
# Passo 1 do Destruitor Idle: Canary v3.6.1 oficial separado do Destruitor, em /opt/idle.
set -e
SRC=/opt/idle/src/canary-3.6.1
cd /opt/idle
mkdir -p server login

# --- servidor: binario oficial + datapack data-canary com os monstros do global ---
if [ ! -f server/canary ]; then
    unzip -oq src/bin.zip -d server/
fi
chmod +x server/canary
rm -rf server/data server/data-canary
cp -r "$SRC/data" server/data
cp -r "$SRC/data-canary" server/data-canary
# monstros do global que o data-canary nao tem (sem sobrescrever os que ja existem)
mkdir -p server/data-canary/monster/global
( cd "$SRC/data-otservbr-global/monster" && find . -name "*.lua" ) | while read -r f; do
    base=$(basename "$f")
    if [ -z "$(find server/data-canary/monster -name "$base" -not -path "*/global/*" -print -quit)" ]; then
        mkdir -p "server/data-canary/monster/global/$(dirname "$f")"
        cp "$SRC/data-otservbr-global/monster/$f" "server/data-canary/monster/global/$f"
    fi
done
cp "$SRC/key.pem" "$SRC/schema.sql" server/
cp "$SRC/config.lua.dist" server/config.lua
sed -i \
    -e 's|^dataPackDirectory = .*|dataPackDirectory = "data-canary"|' \
    -e 's|^serverName = .*|serverName = "Destruitor Idle"|' \
    -e 's|^mapName = .*|mapName = "canary"|' \
    -e 's|^worldType = .*|worldType = "no-pvp"|' \
    -e 's|^freePremium = .*|freePremium = true|' \
    server/config.lua
cp /opt/aldruna/server/entrypoint.sh server/entrypoint.sh
cp /opt/aldruna/server/Dockerfile server/Dockerfile

# --- login HTTP (o mesmo servico do Destruitor, com as vocacoes padrao) ---
cp /opt/aldruna/login/Dockerfile login/
cp /opt/aldruna/login/login_server.py login/
python3 - <<'EOF'
import re
p = "/opt/idle/login/login_server.py"
s = open(p).read()
s = re.sub(r"VOCATIONS = \{.*?\n\}", '''VOCATIONS = {
    0: "None", 1: "Sorcerer", 2: "Druid", 3: "Paladin", 4: "Knight",
    5: "Master Sorcerer", 6: "Elder Druid", 7: "Royal Paladin",
    8: "Elite Knight", 9: "Monk", 10: "Exalted Monk",
}''', s, flags=re.S)
open(p, "w").write(s)
EOF

# --- ponte WebSocket -> TCP para o cliente do navegador ---
mkdir -p wsbridge
cat > wsbridge/Dockerfile <<'EOF'
FROM python:3.12-slim
RUN pip install --no-cache-dir websockify
CMD ["websockify", "0.0.0.0:7380", "server:7172"]
EOF

# --- segredos ---
if [ ! -f .env ]; then
    DBP=$(openssl rand -hex 16); DBR=$(openssl rand -hex 16)
    cat > .env <<EOF
WORLD_NAME=Destruitor Idle
PUBLIC_IP=127.0.0.1
CANARY_DB_NAME=canary
CANARY_DB_USER=canary
CANARY_DB_PASSWORD=$DBP
CANARY_DB_ROOT_PASSWORD=$DBR
EOF
    chmod 600 .env
fi

cat > docker-compose.yml <<'EOF'
name: idle

# Destruitor Idle: Canary v3.6.1 oficial (protocolo 15.11), separado do Destruitor.
# Nada fica aberto na internet: as portas so escutam em 127.0.0.1 e o acesso
# passa pelo nginx (login HTTP + WebSocket), protegido por senha enquanto houver
# conteudo da CipSoft.
services:
  db:
    image: mariadb:11.4
    restart: unless-stopped
    environment:
      MARIADB_DATABASE: "${CANARY_DB_NAME}"
      MARIADB_USER: "${CANARY_DB_USER}"
      MARIADB_PASSWORD: "${CANARY_DB_PASSWORD}"
      MARIADB_ROOT_PASSWORD: "${CANARY_DB_ROOT_PASSWORD}"
    networks: [idle-net]
    volumes:
      - db-volume:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 12

  server:
    build: ./server
    restart: unless-stopped
    environment:
      CANARY_DB_HOST: db
      CANARY_DB_NAME: "${CANARY_DB_NAME}"
      CANARY_DB_USER: "${CANARY_DB_USER}"
      CANARY_DB_PASSWORD: "${CANARY_DB_PASSWORD}"
      CANARY_PUBLIC_IP: "${PUBLIC_IP}"
    networks: [idle-net]
    ports:
      - "127.0.0.1:7371:7171"
      - "127.0.0.1:7372:7172"
    depends_on:
      db:
        condition: service_healthy

  login:
    build: ./login
    restart: unless-stopped
    environment:
      ALDRUNA_LISTEN_HOST: "0.0.0.0"
      ALDRUNA_LISTEN_PORT: "8081"
      ALDRUNA_GAME_IP: "${PUBLIC_IP}"
      ALDRUNA_GAME_PORT: "7172"
      ALDRUNA_WORLD_NAME: "${WORLD_NAME}"
      ALDRUNA_DB_HOST: db
      ALDRUNA_DB_PORT: "3306"
      ALDRUNA_DB_NAME: "${CANARY_DB_NAME}"
      ALDRUNA_DB_USER: "${CANARY_DB_USER}"
      ALDRUNA_DB_PASSWORD: "${CANARY_DB_PASSWORD}"
    networks: [idle-net]
    ports:
      - "127.0.0.1:8182:8081"
    depends_on:
      db:
        condition: service_healthy

  wsbridge:
    build: ./wsbridge
    restart: unless-stopped
    networks: [idle-net]
    ports:
      - "127.0.0.1:7380:7380"
    depends_on: [server]

volumes:
  db-volume:

networks:
  idle-net:
    driver: bridge
EOF

echo "monstros no datapack: $(find server/data-canary/monster -name '*.lua' | wc -l)"
docker compose build 2>&1 | tail -5
docker compose up -d 2>&1 | tail -8
