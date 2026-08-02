"""Le o appearances.dat do cliente e lista quais sprites cada item usa.

Serve para descobrir o conjunto MINIMO de sprites que a nossa arte precisa cobrir:
os ~280 mil sprites da CipSoft sao inviaveis de recriar, entao escolhemos as pecas
do cenario inicial e recriamos so os sprites delas.

Rodar no WSL (tem protobuf e pillow):
    wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/Users/julio/Aldruna/ot-tools/art/ler_appearances.py
"""
import os
import subprocess
import sys
import tempfile

CLIENTE = "/mnt/c/Users/julio/Aldruna/ot/src1/otclient-4.1"
ASSETS = f"{CLIENTE}/data/things/1511"
PROTO = f"{CLIENTE}/src/protobuf/appearances.proto"


def carrega_modulo_protobuf():
    """Compila o .proto em tempo de execucao e importa o modulo gerado."""
    tmp = tempfile.mkdtemp(prefix="appearances_pb_")
    subprocess.run(
        ["protoc", f"--proto_path={os.path.dirname(PROTO)}",
         f"--python_out={tmp}", os.path.basename(PROTO)],
        check=True,
    )
    sys.path.insert(0, tmp)
    import appearances_pb2  # noqa: E402  (gerado agora)
    return appearances_pb2


def carrega_appearances(pb2):
    import json
    catalogo = json.load(open(f"{ASSETS}/catalog-content.json", encoding="utf-8"))
    arq = next(e["file"] for e in catalogo if e.get("type") == "appearances")
    dados = pb2.Appearances()
    dados.ParseFromString(open(f"{ASSETS}/{arq}", "rb").read())
    return dados


def sprites_de(aparencia):
    """Todos os ids de sprite usados por uma aparencia (todos os grupos/animacoes)."""
    ids = []
    for grupo in aparencia.frame_group:
        ids.extend(grupo.sprite_info.sprite_id)
    return ids


if __name__ == "__main__":
    pb2 = carrega_modulo_protobuf()
    dados = carrega_appearances(pb2)

    print(f"objetos (itens):   {len(dados.object)}")
    print(f"criaturas:         {len(dados.outfit)}")
    print(f"efeitos:           {len(dados.effect)}")
    print(f"projeteis:         {len(dados.missile)}")

    total = set()
    for a in dados.object:
        total.update(sprites_de(a))
    print(f"\nsprites distintos usados por itens: {len(total)}")

    # exemplo concreto: a fire sword do kit
    for a in dados.object:
        if a.id == 3280:
            print(f"\nexemplo -> item 3280 ({a.name or 'sem nome'}): sprites {sprites_de(a)[:8]}")
            break
