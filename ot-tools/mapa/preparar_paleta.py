"""Monta a paleta do editor: um PNG e uma ficha para cada item pintavel.

O editor roda no navegador e nao sabe ler appearances.dat nem folha .bmp.lzma.
Entao este script faz o trabalho pesado uma vez: descobre quais itens valem a
pena ter na paleta, extrai o desenho de cada um e grava tudo numa pasta que o
editor so precisa servir.

Escolha dos itens: os chaos que ja tem arte nossa, mais os objetos que mais
aparecem no mapa de exemplo - que sao justamente parede, arvore e movel, o que
falta para montar cidade.

    wsl -d Ubuntu-24.04 -u root -- python3 .../preparar_paleta.py
"""
import argparse
import json
import os
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.normpath(os.path.join(AQUI, "..", ".."))
sys.path.insert(0, os.path.join(RAIZ, "ot-tools", "art"))

import folha_sprites as fs                                    # noqa: E402
from ler_appearances import (carrega_appearances,             # noqa: E402
                             carrega_modulo_protobuf, sprites_de)
from trocar_chao import DE_PARA                               # noqa: E402

PALETA = os.path.join(AQUI, "editor", "paleta")
FICHA = os.path.join(AQUI, "editor", "paleta.json")
MAPA_EXEMPLO = os.path.join(RAIZ, "ot", "src2", "canary-3.6.1",
                            "data-canary", "world", "canary.otbm")


def nome_de(obj):
    n = obj.name
    if isinstance(n, bytes):
        n = n.decode("utf-8", "replace")
    return n or ""


# Palavra encontrada no nome -> categoria. A ordem importa: a primeira que
# casar vence, entao o que e mais especifico vem antes.
CATEGORIAS = [
    ("grama", ("grass", "lawn", "meadow")),
    ("terra", ("dirt", "earth", "mud", "soil", "gravel", "sand", "desert")),
    ("pedra", ("stone", "cobble", "rock", "granite", "slab", "pavement")),
    ("marmore", ("marble", "tile", "mosaic", "ornate")),
    ("madeira", ("wood", "plank", "parquet", "board")),
    ("agua", ("water", "sea", "ocean", "river", "swamp")),
    ("neve", ("snow", "ice", "frozen", "glacier")),
    ("lava", ("lava", "magma", "fire", "ember")),
    ("parede", ("wall", "fence", "gate", "pillar", "column", "arch")),
    ("vegetacao", ("tree", "bush", "plant", "flower", "shrub", "cactus", "mushroom")),
    ("movel", ("table", "chair", "bed", "chest", "barrel", "shelf", "cabinet",
               "stool", "bench", "lamp", "torch", "candle")),
    ("escada", ("stair", "ladder", "ramp", "hole", "sewer")),
]

# Categoria -> onde ela costuma aparecer. E o filtro grosso do editor.
AMBIENTE = {
    "grama": "exterior", "terra": "exterior", "agua": "exterior",
    "neve": "exterior", "lava": "exterior", "vegetacao": "exterior",
    "marmore": "interior", "madeira": "interior", "movel": "interior",
    "pedra": "ambos", "parede": "ambos", "escada": "ambos", "outro": "ambos",
}


def categoria_de(item, nome, e_chao):
    """Classifica pelo nome; quando o appearances nao traz nome, pelo de-para."""
    baixo = nome.lower()
    for cat, palavras in CATEGORIAS:
        if any(p in baixo for p in palavras):
            return cat
    # sem nome util: cai no material que a nossa arte pos nesse item
    tiles = DE_PARA.get(item)
    if tiles:
        alvo = tiles[0].replace("pack_", "")
        for cat, _ in CATEGORIAS:
            if alvo.startswith(cat):
                return cat
        if alvo.startswith(("laje", "calcada", "rocha", "chao_escuro")):
            return "pedra"
        if alvo.startswith("gelo"):
            return "neve"
    return "chao" if e_chao else "outro"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--objetos", type=int, default=140,
                    help="quantos objetos mais comuns do mapa entram")
    a = ap.parse_args()

    from ler_mapa import varre
    _, _, itens = varre(MAPA_EXEMPLO)
    mais_usados = [i for i, _ in itens.most_common(a.objetos)]

    dados = carrega_appearances(carrega_modulo_protobuf())
    porid = {o.id: o for o in dados.object}
    cat = fs.catalogo()
    os.makedirs(PALETA, exist_ok=True)
    cache = {}

    def desenha(sid):
        entrada, indice = fs.acha_folha(sid, cat)
        arq = entrada["file"]
        if arq not in cache:
            bmp, _ = fs.descomprime(f"{fs.ASSETS}/{arq}")
            cache[arq] = fs.bmp_para_imagem(bmp)
        return cache[arq].crop(fs.caixa(indice, entrada.get("spritetype", 0)))

    ficha = []
    for grupo, ids in (("chao", list(DE_PARA)), ("objeto", mais_usados)):
        for item in ids:
            obj = porid.get(item)
            if obj is None or not sprites_de(obj):
                continue
            if any(f["id"] == item for f in ficha):
                continue
            try:
                img = desenha(sprites_de(obj)[0])
            except Exception as e:
                print(f"  item {item}: {type(e).__name__}: {e}")
                continue
            img.save(f"{PALETA}/{item}.png")
            e_chao = obj.flags.HasField("bank")
            nome = nome_de(obj)
            # NAO chamar de `cat`: esse nome ja guarda o catalogo de sprites
            categoria = categoria_de(item, nome, e_chao)
            ficha.append({
                "id": item,
                "nome": nome or f"item {item}",
                "grupo": grupo,
                "categoria": categoria,
                "ambiente": AMBIENTE.get(categoria, "ambos"),
                "larg": img.width,
                "alt": img.height,
                "usos": itens.get(item, 0),
                # so chao pode ser pintado como base da casa
                "chao": e_chao,
            })

    ficha.sort(key=lambda f: (f["grupo"] != "chao", -f["usos"], f["id"]))
    with open(FICHA, "w", encoding="utf-8") as f:
        json.dump(ficha, f, indent=1, ensure_ascii=False)

    chaos = sum(1 for f in ficha if f["grupo"] == "chao")
    print(f"paleta: {len(ficha)} pecas ({chaos} chaos, {len(ficha) - chaos} objetos)")
    print("PNGs em", PALETA)
    print("ficha em", FICHA)


if __name__ == "__main__":
    main()
