"""Descobre quais ids de sprite cada item de chao usa no appearances.dat.

E o mapa de-para entre "a nossa arte" e "o que o cliente desenha": para trocar
a grama do jogo inteiro basta saber quais sprites o item de grama aponta.

Rodar no WSL (tem protoc e protobuf):
    wsl -d Ubuntu-24.04 -u root -- python3 .../mapear_chao.py 4526 4527 4528
    wsl ... mapear_chao.py --nome grass
"""
import argparse
import json

from ler_appearances import carrega_appearances, carrega_modulo_protobuf, sprites_de


def descreve(a):
    nome = a.name or "(sem nome)"
    if isinstance(nome, bytes):
        nome = nome.decode("utf-8", "replace")
    return nome


def eh_chao(a):
    return a.flags.HasField("bank")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*", type=int, help="ids de item para inspecionar")
    ap.add_argument("--nome", help="filtra itens de chao cujo nome contem isto")
    ap.add_argument("--json", help="grava o de-para neste arquivo")
    a = ap.parse_args()

    dados = carrega_appearances(carrega_modulo_protobuf())

    alvos = []
    for obj in dados.object:
        if a.ids and obj.id in a.ids:
            alvos.append(obj)
        elif a.nome and eh_chao(obj) and a.nome.lower() in descreve(obj).lower():
            alvos.append(obj)

    mapa = {}
    for obj in alvos:
        ids = sprites_de(obj)
        mapa[obj.id] = {"nome": descreve(obj), "chao": eh_chao(obj), "sprites": ids}
        marca = "chao" if eh_chao(obj) else "    "
        print(f"[{marca}] item {obj.id:>6} {descreve(obj)[:34]:<34} "
              f"{len(ids):>3} sprite(s): {ids[:8]}")

    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(mapa, f, indent=2, ensure_ascii=False)
        print(f"\nde-para gravado em {a.json}")


if __name__ == "__main__":
    main()
