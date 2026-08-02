"""Confere se o tile que esta DENTRO do cliente e mesmo o de alta qualidade.

Le o sprite pelo mesmo caminho que o jogo le e compara com o PNG em disco.
Serve para separar "a arte esta ruim" de "a arte boa nao chegou no cliente".
"""
import json
import os

import numpy as np
from PIL import Image

import folha_sprites as fs
from ler_appearances import carrega_appearances, carrega_modulo_protobuf, sprites_de

AQUI = os.path.dirname(os.path.abspath(__file__))
TILES = os.path.normpath(os.path.join(AQUI, "..", "..", "art_raw", "tiles32"))

ALVOS = ["pack_castelo_creme_2", "pack_cidade_praca_5", "pack_caverna_cristal_5",
         "pack_templo_dourado_6", "pack_marmore_branco_7"]


def cores(img):
    return len(set(map(tuple, np.asarray(img.convert("RGB")).reshape(-1, 3))))


def main():
    with open(f"{AQUI}/atribuicao.json", encoding="utf-8") as f:
        atrib = json.load(f)
    dados = carrega_appearances(carrega_modulo_protobuf())
    porid = {o.id: o for o in dados.object}
    cat = fs.catalogo()

    for nome in ALVOS:
        item = atrib.get(nome)
        if item is None or item not in porid:
            print(f"{nome}: sem item atribuido")
            continue
        sid = sprites_de(porid[item])[0]
        entrada, indice = fs.acha_folha(sid, cat)
        bmp, _ = fs.descomprime(f"{fs.ASSETS}/{entrada['file']}")
        no_jogo = fs.bmp_para_imagem(bmp).crop(
            fs.caixa(indice, entrada.get("spritetype", 0)))
        disco = Image.open(f"{TILES}/{nome}.png").convert("RGBA")
        igual = np.array_equal(np.asarray(no_jogo.convert("RGB")),
                               np.asarray(disco.convert("RGB")))
        print(f"{nome:<28} item {item:>5} | {cores(no_jogo):>4} cores no cliente "
              f"| bate com o disco: {igual}")


if __name__ == "__main__":
    main()
