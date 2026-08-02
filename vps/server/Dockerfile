# Canary v3.6.1 OFICIAL (binario da release do GitHub).
# A imagem ghcr.io/opentibiabr/canary:3.6.1 e uma armadilha: foi reconstruida
# com codigo mais novo e fala protocolo 15.25, enquanto a v3.6.1 real (e o
# nosso cliente) falam 15.11. Por isso montamos a imagem na mao.
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates mariadb-client tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /canary
COPY data ./data
COPY data-canary ./data-canary
COPY key.pem schema.sql config.lua ./
COPY canary entrypoint.sh ./
RUN chmod +x canary entrypoint.sh
EXPOSE 7171 7172
ENTRYPOINT ["/canary/entrypoint.sh"]
