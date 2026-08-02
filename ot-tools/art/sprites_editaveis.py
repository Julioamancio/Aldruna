"""Tira os sprites do cliente para PNGs editaveis e devolve depois de editar.

A ideia e trabalhar a arte do jogo como arquivo comum: exporta, voce abre no
editor que quiser (Aseprite, Paint, Photoshop), salva por cima, e importa.
Cada PNG e nomeado com o id do sprite, que e o que amarra a volta.

    # exportar os chaos que mais aparecem no mapa
    python sprites_editaveis.py exportar --top-mapa 40

    # exportar sprites de itens especificos (precisa do WSL, le o appearances)
    python sprites_editaveis.py exportar --itens 4515,1019,101

    # exportar por id de sprite, sem depender do appearances
    python sprites_editaveis.py exportar --sprites 189879,189880

    # depois de editar os PNGs:
    python sprites_editaveis.py importar

Os originais do cliente ficam guardados em .original, entao
`trocar_chao.py --restaurar` desfaz tudo a qualquer momento.
"""
import argparse
import json
import os
import shutil
from collections import defaultdict

from PIL import Image, ImageDraw

import folha_sprites as fs

AQUI = os.path.dirname(os.path.abspath(__file__))
PASTA = os.path.normpath(os.path.join(AQUI, "..", "..", "art_raw", "editaveis"))
MANIFESTO = "_manifesto.json"
INDICE = "_indice.png"


def _appearances():
    """Importado so quando precisa: exige protobuf, que so existe no WSL."""
    from ler_appearances import (carrega_appearances, carrega_modulo_protobuf,
                                 sprites_de)
    return carrega_appearances(carrega_modulo_protobuf()), sprites_de


def escolhe_sprites(a):
    """Devolve [(sprite_id, rotulo)] conforme a forma de selecao pedida."""
    if a.sprites:
        return [(int(s), "") for s in a.sprites.split(",")]

    itens = None
    if a.itens:
        itens = [int(s) for s in a.itens.split(",")]
    elif a.top_mapa:
        from ler_mapa import varre
        mapa = a.mapa or os.path.normpath(os.path.join(
            AQUI, "..", "..", "ot", "src2", "canary-3.6.1",
            "data-canary", "world", "canary.otbm"))
        contagem, _ = varre(mapa)
        itens = [i for i, _ in contagem.most_common(a.top_mapa)]
        print(f"chaos mais comuns em {os.path.basename(mapa)}: {itens}")
    else:
        raise SystemExit("escolha --top-mapa, --itens ou --sprites")

    dados, sprites_de = _appearances()
    porid = {o.id: o for o in dados.object}
    saida = []
    for item in itens:
        obj = porid.get(item)
        if obj is None:
            print(f"  item {item}: nao existe no appearances")
            continue
        for n, sid in enumerate(sprites_de(obj)):
            saida.append((sid, f"item{item}_{n:02d}"))
    return saida


def exportar(a):
    alvos = escolhe_sprites(a)
    # o mesmo sprite pode ser usado por varios itens; exporta uma vez so
    unicos, rotulo = [], {}
    for sid, rot in alvos:
        if sid not in rotulo:
            unicos.append(sid)
            rotulo[sid] = rot

    os.makedirs(PASTA, exist_ok=True)
    cat = fs.catalogo()
    cache = {}

    # soma ao que ja foi exportado: exportar um segundo lote nao pode apagar o
    # primeiro, senao os PNGs antigos ficam orfaos e o importar os ignora
    manifesto = {}
    if os.path.exists(f"{PASTA}/{MANIFESTO}"):
        with open(f"{PASTA}/{MANIFESTO}", encoding="utf-8") as f:
            manifesto = json.load(f)

    novos = 0
    for sid in unicos:
        # nao reexporta por cima de um PNG que voce ja editou
        if str(sid) in manifesto and os.path.exists(f"{PASTA}/{sid}.png") and not a.refazer:
            continue
        novos += 1
        try:
            entrada, indice = fs.acha_folha(sid, cat)
        except KeyError:
            print(f"  sprite {sid}: fora do catalogo")
            continue
        arq = entrada["file"]
        if arq not in cache:
            # sempre do original: assim reexportar nao traz a nossa propria arte
            base = f"{fs.ASSETS}/{arq}"
            fonte = base + ".original" if os.path.exists(base + ".original") else base
            bmp, _ = fs.descomprime(fonte)
            cache[arq] = fs.bmp_para_imagem(bmp)
        cache[arq].crop(fs.caixa(indice)).save(f"{PASTA}/{sid}.png")
        manifesto[str(sid)] = {"rotulo": rotulo[sid], "folha": arq, "posicao": indice}

    with open(f"{PASTA}/{MANIFESTO}", "w", encoding="utf-8") as f:
        json.dump(manifesto, f, indent=2, ensure_ascii=False)

    monta_indice(sorted(manifesto, key=int), manifesto)
    print(f"\n{novos} sprite(s) novo(s); {len(manifesto)} no total em {PASTA}")
    print(f"abra {INDICE} para ver todos juntos; edite os PNGs pelo id e rode 'importar'")


def monta_indice(ids, manifesto, escala=3, colunas=16):
    """Painel de conferencia: todos os sprites com o id embaixo."""
    cel = fs.TAM * escala
    legenda = 11
    linhas = (len(ids) + colunas - 1) // colunas
    painel = Image.new("RGBA", (colunas * cel, linhas * (cel + legenda)),
                       (30, 30, 34, 255))
    caneta = ImageDraw.Draw(painel)
    for n, sid in enumerate(ids):
        x, y = (n % colunas) * cel, (n // colunas) * (cel + legenda)
        img = Image.open(f"{PASTA}/{sid}.png").resize((cel, cel), Image.NEAREST)
        painel.paste(img, (x, y), img)
        caneta.text((x + 2, y + cel), str(sid), fill=(215, 215, 220))
    painel.save(f"{PASTA}/{INDICE}")


def importar(a):
    caminho_man = f"{PASTA}/{MANIFESTO}"
    if not os.path.exists(caminho_man):
        raise SystemExit(f"nao achei {caminho_man}; rode 'exportar' antes")
    with open(caminho_man, encoding="utf-8") as f:
        manifesto = json.load(f)

    # O de-para automatico entra primeiro e os PNGs editados por cima: as duas
    # coisas partem do .original, entao tem que ser aplicadas na mesma passada
    # ou a ultima a gravar apaga a outra.
    try:
        from trocar_chao import plano_de_para
        automatico = plano_de_para()
        print(f"de-para automatico: {sum(len(v) for v in automatico.values())} sprite(s)")
    except ImportError as e:
        automatico = {}
        print(f"aviso: de-para automatico fora ({e}); rodando so os PNGs editados")

    # agrupa por folha para descomprimir cada uma uma vez so
    porfolha = defaultdict(list)
    for sid, info in manifesto.items():
        png = f"{PASTA}/{sid}.png"
        if not os.path.exists(png):
            continue
        img = Image.open(png).convert("RGBA")
        if img.size != (fs.TAM, fs.TAM):
            print(f"  {sid}.png ignorado: precisa ser {fs.TAM}x{fs.TAM}, veio {img.size}")
            continue
        porfolha[info["folha"]].append((info["posicao"], img, sid))

    editados = 0
    for arq in sorted(set(porfolha) | set(automatico)):
        caminho = f"{fs.ASSETS}/{arq}"
        if not os.path.exists(caminho + ".original"):
            shutil.copy2(caminho, caminho + ".original")
        bmp, props = fs.descomprime(caminho + ".original")
        folha = fs.bmp_para_imagem(bmp)

        for posicao, tile in automatico.get(arq, []):
            folha.paste(tile, fs.caixa(posicao)[:2])

        mao = []
        for posicao, img, sid in porfolha.get(arq, []):
            # so conta como edicao o que ficou diferente do sprite original
            if fs.bmp_para_imagem(bmp).crop(fs.caixa(posicao)).tobytes() == img.tobytes():
                continue
            folha.paste(img, fs.caixa(posicao)[:2])
            mao.append(sid)
        editados += len(mao)

        # grava sempre: assim a folha e exatamente original + de-para + edicoes,
        # nao importa o que estava la de uma rodada anterior
        with open(caminho, "wb") as f:
            f.write(fs.comprime(fs.imagem_para_bmp(folha, bmp), props))
        if mao:
            print(f"  {arq[:26]}... {len(mao)} editado(s) a mao: "
                  + ", ".join(mao[:6]) + (" ..." if len(mao) > 6 else ""))

    print(f"\n{editados} sprite(s) editado(s) por voce entraram no cliente.")
    print("feche e abra o cliente para ver (ele guarda as folhas em memoria).")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("acao", choices=["exportar", "importar"])
    ap.add_argument("--top-mapa", type=int, help="os N chaos mais comuns do mapa")
    ap.add_argument("--mapa", help="caminho de um .otbm (padrao: canary.otbm)")
    ap.add_argument("--itens", help="ids de item, ex: 4515,1019")
    ap.add_argument("--sprites", help="ids de sprite, ex: 189879,189880")
    ap.add_argument("--refazer", action="store_true",
                    help="reexporta do original por cima dos PNGs ja existentes")
    a = ap.parse_args()
    (exportar if a.acao == "exportar" else importar)(a)


if __name__ == "__main__":
    main()
