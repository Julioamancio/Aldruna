#!/bin/bash
# Libera UM endereco IP a acessar o jogo (portas 7171/7172/8081) e bloqueia o resto.
#
# Enquanto o servidor usa sprites e mapa da CipSoft ele NAO pode ficar aberto ao
# publico. As regras vao na cadeia DOCKER-USER porque o Docker publica portas por
# fora do INPUT/ufw - uma regra em ufw nao teria efeito nenhum aqui.
#
# Uso: ./liberar-ip.sh 191.185.119.204
set -e

NOVO_IP="$1"
PORTAS="7171,7172,8081"

if [ -z "$NOVO_IP" ]; then
    echo "Uso: $0 <IP>"
    echo "IPs liberados hoje:"
    iptables -L DOCKER-USER -n --line-numbers | grep RETURN || echo "  (nenhum)"
    exit 1
fi

# Limpa regras nossas anteriores (marcadas pelo comentario aldruna)
while iptables -L DOCKER-USER -n --line-numbers | grep -q "aldruna"; do
    LINHA=$(iptables -L DOCKER-USER -n --line-numbers | grep "aldruna" | head -1 | awk '{print $1}')
    iptables -D DOCKER-USER "$LINHA"
done

# Bloqueia todo mundo nas portas do jogo...
iptables -I DOCKER-USER -p tcp -m multiport --dports "$PORTAS" \
    -m comment --comment "aldruna-bloqueia" -j DROP
# ...e abre so para o IP informado (inserido depois, fica ACIMA do DROP)
iptables -I DOCKER-USER -p tcp -m multiport --dports "$PORTAS" -s "$NOVO_IP" \
    -m comment --comment "aldruna-libera" -j RETURN

mkdir -p /etc/iptables
iptables-save >/etc/iptables/rules.v4

echo "Acesso ao jogo liberado apenas para $NOVO_IP (portas $PORTAS)."
