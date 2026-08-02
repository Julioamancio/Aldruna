#!/bin/bash
# Entrada do container do servidor na VPS.
#
# Ajusta o config.lua a partir das variaveis de ambiente ANTES de subir o canary.
# Motivo: o config.lua vem sincronizado do PC do Julio (onde o banco e local e o
# IP e 127.0.0.1). Sem esta correcao o servidor sobe na VPS procurando banco em
# 127.0.0.1 e morre com "MySQL Error: Can't connect to server".
set -e

DB_HOST="${CANARY_DB_HOST:-db}"
DB_USER="${CANARY_DB_USER:-canary}"
DB_PASS="${CANARY_DB_PASSWORD}"
DB_NAME="${CANARY_DB_NAME:-canary}"
PUBLIC_IP="${CANARY_PUBLIC_IP:-127.0.0.1}"

echo "[entrypoint] ajustando config.lua para o ambiente da VPS"
sed -i \
    -e "s|^mysqlHost = .*|mysqlHost = \"$DB_HOST\"|" \
    -e "s|^mysqlUser = .*|mysqlUser = \"$DB_USER\"|" \
    -e "s|^mysqlPass = .*|mysqlPass = \"$DB_PASS\"|" \
    -e "s|^mysqlDatabase = .*|mysqlDatabase = \"$DB_NAME\"|" \
    -e "s|^ip = .*|ip = \"$PUBLIC_IP\"|" \
    /canary/config.lua

echo "[entrypoint] aguardando banco em $DB_HOST..."
until mariadb -h "$DB_HOST" -u"$DB_USER" -p"$DB_PASS" -e "SELECT 1" "$DB_NAME" >/dev/null 2>&1; do
    sleep 2
done

if ! mariadb -h "$DB_HOST" -u"$DB_USER" -p"$DB_PASS" -N -e "SHOW TABLES LIKE 'accounts'" "$DB_NAME" | grep -q accounts; then
    echo "[entrypoint] banco vazio - importando schema.sql"
    mariadb -h "$DB_HOST" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" < /canary/schema.sql
fi

cd /canary
exec ./canary
