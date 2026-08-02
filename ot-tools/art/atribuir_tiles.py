"""Da um id de item do jogo para cada tile nosso que ainda nao tem.

Sem isso os tiles ficam so como PNG no disco: nao aparecem no editor nem no
jogo, porque o mapa guarda ID DE ITEM, nao imagem. Cada peca precisa morar em
algum item do cliente.

Criterio de escolha do hospedeiro: item de chao simples (1x1, sprite de 32x32,
sem animacao) que o mapa de exemplo quase nao usa. Assim ninguem perde nada
visualmente - estamos ocupando espaco vago.

A atribuicao fica gravada em atribuicao.json e nao muda entre execucoes: se
mudasse, o mapa ja desenhado passaria a mostrar outra textura.

    wsl -d Ubuntu-24.04 -u root -- python3 .../atribuir_tiles.py
"""
import argparse
import glob
import json
import os

import folha_sprites as fs
from ler_appearances import carrega_appearances, carrega_modulo_protobuf, sprites_de
from trocar_chao import DE_PARA, TILES

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.normpath(os.path.join(AQUI, "..", ".."))
DESTINO = os.path.join(AQUI, "atribuicao.json")
MAPA = os.path.join(RAIZ, "ot", "src2", "canary-3.6.1", "data-canary",
                    "world", "canary.otbm")


def tiles_nossos():
    """Os tiles de pack, na ordem do nome - determinismo importa aqui."""
    nomes = []
    for p in sorted(glob.glob(f"{TILES}/pack_*.png")):
        nomes.append(os.path.basename(p)[:-4])
    return nomes


def hospedeiros_livres(dados, cat, usados, uso_no_mapa, quantos,
                       sprites_tomados):
    """Itens de chao 1x1, 32x32, sem animacao e pouco usados no mapa.

    O filtro que realmente importa e o dos SPRITES: no Tibia varios itens
    apontam para o mesmo desenho. Hospedar um tile num item que divide sprite
    com a areia faria a areia virar aquele tile - foi exatamente o que
    aconteceu na primeira tentativa.
    """
    livres = []
    for obj in dados.object:
        if obj.id in usados or not obj.flags.HasField("bank"):
            continue
        # o hospedeiro tem que ser CAMINHAVEL: varios chaos do Tibia bloqueiam
        # passagem (parede baixa, buraco, agua) e o jogador ficaria preso em pe
        # numa textura que parece piso normal
        # unpass = bloqueia passagem. NAO usar unmove aqui: unmove quer dizer
        # "nao pode ser arrastado", o que vale para todo chao - filtrar por ele
        # zerava a lista inteira.
        if obj.flags.unpass:
            continue
        grupos = list(obj.frame_group)
        if len(grupos) != 1:
            continue
        si = grupos[0].sprite_info
        if si.HasField("animation"):
            continue                      # animado: um tile parado estragaria
        sids = list(si.sprite_id)
        if not sids or len(sids) > 16:
            continue
        if any(s in sprites_tomados for s in sids):
            continue                      # divide desenho com outro item
        try:
            entrada, _ = fs.acha_folha(sids[0], cat)
        except KeyError:
            continue
        if entrada.get("spritetype", 0) != 0:
            continue                      # so 32x32, para o tile encaixar inteiro
        sprites_tomados.update(sids)      # reserva ja, para o proximo nao pegar
        livres.append((uso_no_mapa.get(obj.id, 0), obj.id))
        if len(livres) >= quantos:
            break
    return livres


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refazer", action="store_true",
                    help="joga fora a atribuicao atual e sorteia de novo")
    a = ap.parse_args()

    atual = {}
    if os.path.exists(DESTINO) and not a.refazer:
        with open(DESTINO, encoding="utf-8") as f:
            atual = json.load(f)

    from ler_mapa import varre
    contagem, _, _ = varre(MAPA)

    dados = carrega_appearances(carrega_modulo_protobuf())
    cat = fs.catalogo()

    # ninguem pode receber duas texturas, nem roubar item que o DE_PARA ja usa
    usados = set(DE_PARA) | {v for v in atual.values()}
    faltam = [n for n in tiles_nossos() if n not in atual]
    print(f"{len(atual)} tile(s) ja tinham item; faltam {len(faltam)}")
    if not faltam:
        return

    # tudo que os itens ja mapeados desenham fica reservado
    porid = {o.id: o for o in dados.object}
    tomados = set()
    for item in usados:
        obj = porid.get(item)
        if obj:
            tomados.update(sprites_de(obj))
    print(f"{len(tomados)} sprite(s) ja reservados pelos itens mapeados")

    livres = hospedeiros_livres(dados, cat, usados, contagem, len(faltam),
                                tomados)
    print(f"{len(livres)} item(ns) de chao livres encontrados")
    if len(livres) < len(faltam):
        print(f"AVISO: so da para atribuir {len(livres)} de {len(faltam)}")

    for nome, (_, item) in zip(faltam, livres):
        atual[nome] = item

    with open(DESTINO, "w", encoding="utf-8") as f:
        json.dump(atual, f, indent=1, ensure_ascii=False, sort_keys=True)
    print(f"\n{len(atual)} tile(s) atribuidos; gravado em {DESTINO}")
    for nome in faltam[:5]:
        print(f"  {nome} -> item {atual.get(nome)}")


if __name__ == "__main__":
    main()
