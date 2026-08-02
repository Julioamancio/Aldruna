"""Hospeda as 16 pecas de parede em itens de parede 32x32 do cliente.

Parede nao e chao: no mapa ela e um ITEM colocado sobre a casa (camada de
objetos), e precisa bloquear passagem, movimento e visao. Entao o hospedeiro
tem que ser um item com essas flags e sprite 32x32 - senao a peca distorce ou
o muro fica atravessavel.

A escolha e gravada em atribuicao_paredes.json e nao muda entre execucoes.

    wsl -d Ubuntu-24.04 -u root -- python3 .../atribuir_paredes.py <prefixo>
"""
import argparse
import glob
import json
import os

import folha_sprites as fs
from ler_appearances import carrega_appearances, carrega_modulo_protobuf, sprites_de
from trocar_chao import DE_PARA, TILES

AQUI = os.path.dirname(os.path.abspath(__file__))
DESTINO = os.path.join(AQUI, "atribuicao_paredes.json")


def pecas(prefixo):
    nomes = []
    for p in sorted(glob.glob(f"{TILES}/{prefixo}_*.png")):
        nomes.append(os.path.basename(p)[:-4])
    return nomes


def hospedeiros_parede(dados, cat, usados, quantos):
    """Itens 32x32 que bloqueiam passagem/movimento/visao - ou seja, parede."""
    livres = []
    for obj in dados.object:
        if obj.id in usados:
            continue
        f = obj.flags
        if not (f.unpass and f.unmove and f.unsight):
            continue
        grupos = list(obj.frame_group)
        if len(grupos) != 1:
            continue
        sids = list(grupos[0].sprite_info.sprite_id)
        if len(sids) != 1:                 # uma peca so, sem animacao/variacao
            continue
        try:
            entrada, _ = fs.acha_folha(sids[0], cat)
        except KeyError:
            continue
        if entrada.get("spritetype", 0) != 0:
            continue
        usados.add(obj.id)
        livres.append(obj.id)
        if len(livres) >= quantos:
            break
    return livres


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prefixo", help="ex: parede_pedra")
    ap.add_argument("--refazer", action="store_true")
    a = ap.parse_args()

    atual = {}
    if os.path.exists(DESTINO) and not a.refazer:
        with open(DESTINO, encoding="utf-8") as f:
            atual = json.load(f)

    dados = carrega_appearances(carrega_modulo_protobuf())
    cat = fs.catalogo()

    faltam = [n for n in pecas(a.prefixo) if n not in atual]
    print(f"{len(atual)} peca(s) ja tinham item; faltam {len(faltam)}")
    if not faltam:
        return

    usados = set(DE_PARA) | set(atual.values())
    livres = hospedeiros_parede(dados, cat, usados, len(faltam))
    print(f"{len(livres)} item(ns) de parede 32x32 livres")
    if len(livres) < len(faltam):
        print(f"AVISO: so da para {len(livres)} de {len(faltam)}")

    for nome, item in zip(faltam, livres):
        atual[nome] = item

    with open(DESTINO, "w", encoding="utf-8") as f:
        json.dump(atual, f, indent=1, ensure_ascii=False, sort_keys=True)
    print(f"\n{len(atual)} peca(s) atribuidas; gravado em {DESTINO}")
    for nome in faltam:
        print(f"  {nome} -> item {atual.get(nome)}")


if __name__ == "__main__":
    main()
