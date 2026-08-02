"""Troca em lote os sprites de chao do cliente pela nossa arte.

Recebe um de-para "item do Tibia -> tile nosso", resolve no appearances.dat
quais sprites cada item usa e reescreve as folhas do cliente. Agrupa por folha
para descomprimir/comprimir cada uma uma vez so.

O appearances NAO e alterado: os ids de item continuam os mesmos, entao o
servidor e o mapa seguem funcionando. So a imagem muda.

Rodar no WSL (precisa de protoc/protobuf):
    wsl -d Ubuntu-24.04 -u root -- python3 .../trocar_chao.py [--restaurar]
"""
import argparse
import os
import shutil
from collections import defaultdict

from PIL import Image

import folha_sprites as fs
from ler_appearances import carrega_appearances, carrega_modulo_protobuf, sprites_de

AQUI = os.path.dirname(os.path.abspath(__file__))
TILES = os.path.normpath(os.path.join(AQUI, "..", "..", "art_raw", "tiles32"))

# item do Tibia -> tiles nossos. Com mais de um tile, os sprites do item
# (variacoes/animacao) se revezam entre eles, o que evita o efeito papel de
# parede em areas grandes.
#
# Os ids sao os que o mapa canary.otbm REALMENTE usa - medidos com ler_mapa.py,
# nao supostos. A grama classica do Tibia (106/4526) mal aparece nele: quem
# cobre o chao aqui e 4515 e 1019. Ao trocar de mapa, medir de novo.
DE_PARA = {
    4515: ["grama", "grama_musgo"],         # grama principal (163k casas)
    1019: ["grama_musgo", "grama"],         # a outra grama (70k)
    106: ["grama"], 4526: ["grama"],        # grama classica, rara aqui
    108: ["grama_flores"],                  # grama florida
    109: ["grama_flores", "grama"],
    294: ["grama_terra"],                   # grama puida
    101: ["terra_seca", "trilha_terra"],    # terra avermelhada (476k, o mais comum)
    103: ["trilha_terra", "terra_seca"],    # terra batida (25k)
    231: ["areia"],                         # areia (32k)
    1128: ["laje_pedra", "calcada"],        # piso de pedra (334k)
    429: ["laje_pedra"], 431: ["laje_pedra"],
    410: ["calcada"], 416: ["calcada"], 430: ["calcada"],
}
# agua: a faixa 4597-4614 e toda agua parada no canary.otbm
DE_PARA.update({i: ["agua_funda"] for i in range(4597, 4615)})


def carrega_tile(nome):
    img = Image.open(f"{TILES}/{nome}.png").convert("RGBA")
    if img.size != (fs.TAM, fs.TAM):
        raise SystemExit(f"{nome}.png precisa ser {fs.TAM}x{fs.TAM}")
    return img


def restaurar():
    n = 0
    for arq in os.listdir(fs.ASSETS):
        if arq.endswith(".original"):
            shutil.copy2(f"{fs.ASSETS}/{arq}", f"{fs.ASSETS}/{arq[:-9]}")
            n += 1
    print(f"{n} folha(s) restaurada(s) a partir do backup .original")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--restaurar", action="store_true",
                    help="devolve as folhas originais da CipSoft e sai")
    ap.add_argument("--simular", action="store_true",
                    help="mostra o que faria, sem gravar nada")
    a = ap.parse_args()

    if a.restaurar:
        return restaurar()

    dados = carrega_appearances(carrega_modulo_protobuf())
    porid = {o.id: o for o in dados.object}
    cat = fs.catalogo()

    # planeja: folha -> [(posicao na folha, tile)]
    plano = defaultdict(list)
    faltando = []
    for item, nomes in DE_PARA.items():
        obj = porid.get(item)
        if obj is None:
            faltando.append(item)
            continue
        tiles = [carrega_tile(n) for n in nomes]
        for k, sid in enumerate(sprites_de(obj)):
            entrada, indice = fs.acha_folha(sid, cat)
            plano[entrada["file"]].append((indice, tiles[k % len(tiles)]))
        print(f"item {item:>5} -> {'+'.join(nomes):<26} "
              f"{len(sprites_de(obj))} sprite(s)")

    if faltando:
        print("nao encontrados no appearances:", faltando)
    print(f"\n{len(plano)} folha(s) a reescrever")
    if a.simular:
        return

    for arquivo, trocas in plano.items():
        caminho = f"{fs.ASSETS}/{arquivo}"
        if not os.path.exists(caminho + ".original"):
            shutil.copy2(caminho, caminho + ".original")
        # sempre parte do original: assim rodar de novo nao empilha alteracao
        bmp, props = fs.descomprime(caminho + ".original")
        folha = fs.bmp_para_imagem(bmp)
        for indice, tile in trocas:
            folha.paste(tile, fs.caixa(indice)[:2])
        with open(caminho, "wb") as f:
            f.write(fs.comprime(fs.imagem_para_bmp(folha, bmp), props))
        print(f"  {arquivo[:28]}... {len(trocas)} sprite(s) trocado(s)")

    print("\npronto. Para desfazer: trocar_chao.py --restaurar")


if __name__ == "__main__":
    main()
