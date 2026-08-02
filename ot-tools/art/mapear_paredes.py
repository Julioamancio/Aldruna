"""Descobre quais paredes o mapa usa e qual a forma de cada uma.

Parede nao e chao: ocupa altura, tem parte transparente e vem em conjunto
(horizontal, vertical, canto, pilar, porta, janela). Antes de encomendar arte
e preciso saber quantas pecas o conjunto tem e de que tamanho e cada sprite -
foi a falta desse levantamento que quebrou a agua na primeira tentativa.

    wsl -d Ubuntu-24.04 -u root -- python3 .../mapear_paredes.py
"""
import os
from collections import Counter

import folha_sprites as fs
from ler_appearances import carrega_appearances, carrega_modulo_protobuf, sprites_de

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.normpath(os.path.join(AQUI, "..", ".."))
MAPA = os.path.join(RAIZ, "ot", "src2", "canary-3.6.1", "data-canary",
                    "world", "canary.otbm")


def nome_de(obj):
    n = obj.name
    return n.decode("utf-8", "replace") if isinstance(n, bytes) else (n or "")


def main():
    from ler_mapa import varre
    _, _, itens = varre(MAPA)

    dados = carrega_appearances(carrega_modulo_protobuf())
    porid = {o.id: o for o in dados.object}
    cat = fs.catalogo()

    tamanhos = Counter()
    print(f"{'item':>6} {'vezes':>7}  {'sprites':>7} {'sprite':>7}  nome")
    mostrados = 0
    for item, vezes in itens.most_common(400):
        obj = porid.get(item)
        if obj is None:
            continue
        f = obj.flags
        # parede: barra passagem, nao se move e bloqueia visao - o trio que
        # separa muro de mesa, arbusto ou tapete
        if not (f.unpass and f.unmove and f.unsight):
            continue
        sids = sprites_de(obj)
        if not sids:
            continue
        try:
            entrada, _ = fs.acha_folha(sids[0], cat)
        except KeyError:
            continue
        larg, alt = fs.dimensoes(entrada.get("spritetype", 0))
        tamanhos[f"{larg}x{alt}"] += 1
        if mostrados < 25:
            print(f"{item:>6} {vezes:>7}  {len(sids):>7} {larg:>3}x{alt:<3}  "
                  f"{nome_de(obj)[:38]}")
            mostrados += 1

    print(f"\nparedes distintas no mapa: {sum(tamanhos.values())}")
    print("tamanho do sprite:", dict(tamanhos))


if __name__ == "__main__":
    main()
