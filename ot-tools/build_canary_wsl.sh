#!/bin/bash
# Compila o binario do Destruitor dentro do WSL (Ubuntu 24.04).
#
# Por que WSL: a VPS tem 2 vCPU e levava horas, competindo com o site de ingles.
# Aqui sao 12 nucleos e 47 GB. O ambiente e o mesmo da receita oficial do Canary
# (Ubuntu 24.04 / gcc 13 / cmake 3.28) - versoes mais novas quebram o vcpkg.
#
# Uso: wsl -d Ubuntu-24.04 -u root -- bash /mnt/c/Users/julio/Aldruna/ot-tools/build_canary_wsl.sh
set -euo pipefail

SRC=/mnt/c/Users/julio/Aldruna/ot/src2/canary-3.6.1
DST=/root/canary
VCPKG=/root/vcpkg

echo "=== [1/4] copiando fonte para o disco do Linux ($(date +%H:%M:%S)) ==="
# Compilar direto de /mnt/c e MUITO lento (tradutor de arquivos do Windows).
mkdir -p "$DST"
rsync -a --delete --exclude build --exclude .git --exclude '*.zip' "$SRC/" "$DST/"

echo "=== [2/4] vcpkg no commit exigido pelo projeto ($(date +%H:%M:%S)) ==="
BASELINE=$(grep '"builtin-baseline"' "$DST/vcpkg.json" | awk -F: '{print $2}' | tr -d '", ')
if [ ! -x "$VCPKG/vcpkg" ]; then
    rm -rf "$VCPKG"
    git clone -q https://github.com/Microsoft/vcpkg.git "$VCPKG"
    git -C "$VCPKG" checkout -q "$BASELINE"
    "$VCPKG/bootstrap-vcpkg.sh" -disableMetrics
fi

echo "=== [3/4] dependencias (parte mais demorada) ($(date +%H:%M:%S)) ==="
mkdir -p /root/vcpkg_manifest
cp "$DST/vcpkg.json" /root/vcpkg_manifest/
export VCPKG_ROOT="$VCPKG"
export VCPKG_MAX_CONCURRENCY=12
"$VCPKG/vcpkg" install \
    --x-manifest-root=/root/vcpkg_manifest \
    --x-install-root=/root/vcpkg_installed \
    --triplet=x64-linux --host-triplet=x64-linux

echo "=== [4/4] compilando o servidor ($(date +%H:%M:%S)) ==="
cd "$DST"
cmake --preset linux-release -DTOGGLE_BIN_FOLDER=ON \
      -DVCPKG_MANIFEST_INSTALL=OFF -DVCPKG_INSTALLED_DIR=/root/vcpkg_installed
cmake --build --preset linux-release -j 12

BIN="$DST/build/linux-release/bin/canary"
ls -la "$BIN"
echo "=== PRONTO $(date +%H:%M:%S) -> $BIN ==="
