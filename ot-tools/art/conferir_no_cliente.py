"""Confere, item por item, quanto da nossa arte ja esta dentro do cliente.

Le os assets do jeito que o cliente le e compara com os PNGs de
art_raw/tiles32. Serve para responder "isso ja esta valendo em jogo?" sem
precisar entrar e olhar.

    wsl -d Ubuntu-24.04 -u root -- python3 .../conferir_no_cliente.py
"""
import os

import numpy as np
from PIL import Image

import folha_sprites as fs
from ler_appearances import carrega_appearances, carrega_modulo_protobuf, sprites_de
from sprites_editaveis import PAPEL
from trocar_chao import DE_PARA, TILES


def main():
    dados = carrega_appearances(carrega_modulo_protobuf())
    porid = {o.id: o for o in dados.object}
    cat = fs.catalogo()
    cache = {}

    def sprite_atual(sid):
        entrada, indice = fs.acha_folha(sid, cat)
        arq = entrada["file"]
        if arq not in cache:
            bmp, _ = fs.descomprime(f"{fs.ASSETS}/{arq}")
            cache[arq] = fs.bmp_para_imagem(bmp)
        return np.asarray(cache[arq].crop(fs.caixa(indice, entrada.get("spritetype", 0))))

    total_ok = total = 0
    print(f"{'item':>6}  {'o que e':<22} {'nossos/total':>13}")
    for item, nomes in sorted(DE_PARA.items()):
        obj = porid.get(item)
        if obj is None:
            continue
        brutos = [Image.open(f"{TILES}/{n}.png").convert("RGBA") for n in nomes]
        sids = sprites_de(obj)

        def bate(sid):
            tipo = fs.acha_folha(sid, cat)[0].get("spritetype", 0)
            atual = sprite_atual(sid)
            return any(np.array_equal(atual,
                                      np.asarray(fs.ajusta_ao_slot(b, tipo)))
                       for b in brutos)

        ok = sum(1 for s in sids if bate(s))
        total_ok += ok
        total += len(sids)
        marca = "ok" if ok == len(sids) else ("parcial" if ok else "NAO")
        print(f"{item:>6}  {PAPEL.get(item, '?'):<22} {ok:>5}/{len(sids):<7} {marca}")

    print(f"\n{total_ok} de {total} sprites de chao ja sao nossos dentro do cliente.")


if __name__ == "__main__":
    main()
