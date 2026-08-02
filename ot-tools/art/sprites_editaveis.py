"""Ponte entre a arte do jogo e o editor, sem virar copia da arte da CipSoft.

Tres passos, com as pastas separadas de proposito:

  1. exportar  -> art_raw/referencia/  o que existe hoje no cliente.
                  E arte da CipSoft. Serve para SABER quais pecas existem, o
                  tamanho e o papel de cada uma. NUNCA volta para o jogo.

  2. preparar  -> art_raw/nossos/      telas 32x32 VAZIAS com o mesmo nome, mais
                  um caderno de encargos em texto dizendo o que cada peca e.
                  E aqui que voce desenha, do zero.

  3. importar  <- art_raw/nossos/      devolve para o cliente so o que voce
                  desenhou. A pasta de referencia e ignorada.

A separacao existe porque pintar por cima do sprite original continua sendo
obra derivada, por mais que se mude. Desenhar numa tela vazia, sabendo o que a
peca precisa fazer, nao e.

    python sprites_editaveis.py exportar --top-mapa 40
    python sprites_editaveis.py preparar
    python sprites_editaveis.py importar
"""
import argparse
import json
import os
import shutil
from collections import Counter, defaultdict

from PIL import Image, ImageDraw

import folha_sprites as fs

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.normpath(os.path.join(AQUI, "..", ".."))

REFERENCIA = os.path.join(RAIZ, "art_raw", "referencia")
NOSSOS = os.path.join(RAIZ, "art_raw", "nossos")
MANIFESTO = "_manifesto.json"
INDICE = "_indice.png"
ESPEC = "_o_que_desenhar.md"

# o que cada item de chao e, para o caderno de encargos sair em portugues
PAPEL = {
    101: "terra avermelhada", 103: "terra batida", 106: "grama",
    231: "areia", 294: "grama puida", 351: "rocha de caverna",
    352: "rocha de caverna", 353: "rocha de caverna", 354: "rocha de caverna",
    355: "rocha de caverna", 408: "assoalho de madeira", 410: "pedra escura",
    416: "calcamento", 422: "piso de pedra", 429: "laje de pedra",
    499: "piso de pedra", 799: "neve", 982: "piso", 1019: "grama",
    1128: "piso de pedra", 4427: "chao escuro", 4515: "grama",
    4597: "agua", 4598: "agua", 4599: "agua", 4600: "agua", 4601: "agua",
    4602: "agua", 4609: "agua", 4610: "agua", 4611: "agua", 4612: "agua",
    4613: "agua", 4614: "agua", 4680: "agua", 4809: "gelo",
    5814: "piso", 6869: "assoalho de madeira", 7356: "piso",
    9246: "piso", 21477: "lava", 100: "lava",
}


def _appearances():
    """Importado so quando precisa: exige protobuf, que so existe no WSL."""
    from ler_appearances import (carrega_appearances, carrega_modulo_protobuf,
                                 sprites_de)
    return carrega_appearances(carrega_modulo_protobuf()), sprites_de


def escolhe_sprites(a):
    """Devolve [(sprite_id, item_id, indice do quadro)]."""
    if a.sprites:
        return [(int(s), None, 0) for s in a.sprites.split(",")]

    if a.itens:
        itens = [int(s) for s in a.itens.split(",")]
    elif a.top_mapa:
        from ler_mapa import varre
        mapa = a.mapa or os.path.join(RAIZ, "ot", "src2", "canary-3.6.1",
                                      "data-canary", "world", "canary.otbm")
        contagem, _ = varre(mapa)
        itens = [i for i, _ in contagem.most_common(a.top_mapa)]
        globals()["_USO_NO_MAPA"] = dict(contagem)
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
            saida.append((sid, item, n))
    return saida


def _carrega_manifesto(pasta):
    caminho = f"{pasta}/{MANIFESTO}"
    if os.path.exists(caminho):
        with open(caminho, encoding="utf-8") as f:
            return json.load(f)
    return {}


def exportar(a):
    alvos = escolhe_sprites(a)
    os.makedirs(REFERENCIA, exist_ok=True)
    manifesto = _carrega_manifesto(REFERENCIA)   # soma ao que ja existe
    cat = fs.catalogo()
    cache = {}
    novos = 0

    vistos = set()
    for sid, item, quadro in alvos:
        if sid in vistos:
            continue
        vistos.add(sid)
        registro = manifesto.setdefault(str(sid), {"itens": [], "quadros": []})
        if item is not None and item not in registro["itens"]:
            registro["itens"].append(item)
            registro["quadros"].append(quadro)
        try:
            entrada, indice = fs.acha_folha(sid, cat)
        except KeyError:
            print(f"  sprite {sid}: fora do catalogo")
            continue
        arq = entrada["file"]
        # onde a peca mora tem que ser anotado SEMPRE: e o que o importar usa
        # para saber onde devolver. So a extracao da imagem e que e pulavel.
        registro.update({"folha": arq, "posicao": indice})
        if os.path.exists(f"{REFERENCIA}/{sid}.png") and not a.refazer:
            continue
        if arq not in cache:
            # sempre do .original: reexportar nao pode trazer a nossa arte de volta
            base = f"{fs.ASSETS}/{arq}"
            fonte = base + ".original" if os.path.exists(base + ".original") else base
            bmp, _ = fs.descomprime(fonte)
            cache[arq] = fs.bmp_para_imagem(bmp)
        cache[arq].crop(fs.caixa(indice)).save(f"{REFERENCIA}/{sid}.png")
        novos += 1

    if _USO_NO_MAPA:
        for sid, reg in manifesto.items():
            reg["casas_no_mapa"] = sum(_USO_NO_MAPA.get(i, 0) for i in reg["itens"])

    with open(f"{REFERENCIA}/{MANIFESTO}", "w", encoding="utf-8") as f:
        json.dump(manifesto, f, indent=2, ensure_ascii=False)
    monta_indice(REFERENCIA, sorted(manifesto, key=int))

    print(f"\n{novos} novo(s); {len(manifesto)} no total em {REFERENCIA}")
    print("essa pasta e REFERENCIA (arte da CipSoft): serve para saber o que")
    print("existe, nunca para pintar por cima. Rode 'preparar' para as telas vazias.")


_USO_NO_MAPA = {}


def monta_indice(pasta, ids, escala=3, colunas=16):
    """Painel de conferencia: todos os sprites com o id embaixo."""
    if not ids:
        return
    cel, legenda = fs.TAM * escala, 11
    linhas = (len(ids) + colunas - 1) // colunas
    painel = Image.new("RGBA", (colunas * cel, linhas * (cel + legenda)),
                       (30, 30, 34, 255))
    caneta = ImageDraw.Draw(painel)
    for n, sid in enumerate(ids):
        png = f"{pasta}/{sid}.png"
        if not os.path.exists(png):
            continue
        x, y = (n % colunas) * cel, (n // colunas) * (cel + legenda)
        img = Image.open(png).convert("RGBA").resize((cel, cel), Image.NEAREST)
        painel.paste(img, (x, y), img)
        caneta.text((x + 2, y + cel), str(sid), fill=(215, 215, 220))
    painel.save(f"{pasta}/{INDICE}")


def cor_dominante(png):
    """Cor mais frequente do sprite, so como pista de paleta no caderno."""
    img = Image.open(png).convert("RGBA")
    cores = Counter(p[:3] for p in img.getdata() if p[3] > 0)
    if not cores:
        return "-"
    r, g, b = cores.most_common(1)[0][0]
    return f"#{r:02x}{g:02x}{b:02x}"


def preparar(a):
    manifesto = _carrega_manifesto(REFERENCIA)
    if not manifesto:
        raise SystemExit("rode 'exportar' antes: preciso saber quais pecas existem")
    os.makedirs(NOSSOS, exist_ok=True)

    linhas = []
    criadas = 0
    for sid in sorted(manifesto, key=int):
        reg = manifesto[sid]
        destino = f"{NOSSOS}/{sid}.png"
        if not os.path.exists(destino):
            Image.new("RGBA", (fs.TAM, fs.TAM), (0, 0, 0, 0)).save(destino)
            criadas += 1
        itens = reg.get("itens", [])
        papel = ", ".join(sorted({PAPEL.get(i, "?") for i in itens})) or "?"
        quadros = len(reg.get("quadros", [])) or 1
        ref = f"{REFERENCIA}/{sid}.png"
        linhas.append((sid, itens, papel, quadros,
                       cor_dominante(ref) if os.path.exists(ref) else "-",
                       reg.get("casas_no_mapa", 0)))

    with open(f"{NOSSOS}/{ESPEC}", "w", encoding="utf-8") as f:
        f.write("# O que desenhar\n\n")
        f.write("Cada linha e uma peca do jogo esperando a nossa versao.\n"
                "Desenhe em `<id>.png` nesta pasta: 32x32, fundo transparente,\n"
                "sem anti-alias, luz vindo do noroeste (ver docs/estilo-sprites.md).\n\n")
        f.write("A coluna de cor e so uma pista de que familia de tom a peca ocupa\n"
                "no mapa - nao e para reproduzir o desenho original.\n\n")
        f.write("| sprite | item(ns) | o que e | quadros | tom | casas no mapa |\n")
        f.write("|---|---|---|---|---|---|\n")
        for sid, itens, papel, quadros, cor, casas in sorted(
                linhas, key=lambda l: -l[5]):
            itens_txt = ", ".join(str(i) for i in itens) or "-"
            f.write(f"| {sid} | {itens_txt} | {papel} | {quadros} | {cor} | "
                    f"{casas or '-'} |\n")

    print(f"{criadas} tela(s) vazia(s) criada(s); {len(linhas)} no total em {NOSSOS}")
    print(f"abra {ESPEC} para saber o que cada arquivo precisa ser.")
    print("desenhe nas telas vazias; a pasta referencia/ fica so para consulta.")


def importar(a):
    manifesto = _carrega_manifesto(REFERENCIA)
    if not manifesto:
        raise SystemExit("rode 'exportar' antes")

    # o de-para automatico entra primeiro e a arte desenhada por cima: os dois
    # partem do .original, entao tem que ser aplicados na mesma passada
    # Excecao ampla de proposito: fora do WSL faltam protobuf e protoc, e o que
    # se perde e apenas o de-para automatico. Melhor importar a arte desenhada
    # do que abortar tudo.
    try:
        from trocar_chao import plano_de_para
        automatico = plano_de_para()
        print(f"de-para automatico: {sum(len(v) for v in automatico.values())} sprite(s)")
    except Exception as e:
        automatico = {}
        print(f"aviso: de-para automatico fora ({type(e).__name__}); so a arte desenhada."
              "\n       rode no WSL para aplicar os dois juntos.")

    porfolha = defaultdict(list)
    vazias = 0
    for sid, reg in manifesto.items():
        png = f"{NOSSOS}/{sid}.png"
        if not os.path.exists(png) or "folha" not in reg:
            continue
        img = Image.open(png).convert("RGBA")
        if img.size != (fs.TAM, fs.TAM):
            print(f"  {sid}.png ignorado: precisa ser 32x32, veio {img.size}")
            continue
        if not any(p[3] for p in img.getdata()):
            vazias += 1          # tela ainda em branco: nao desenhada
            continue
        porfolha[reg["folha"]].append((reg["posicao"], img, sid))

    desenhados = 0
    for arq in sorted(set(porfolha) | set(automatico)):
        caminho = f"{fs.ASSETS}/{arq}"
        if not os.path.exists(caminho + ".original"):
            shutil.copy2(caminho, caminho + ".original")
        bmp, props = fs.descomprime(caminho + ".original")
        folha = fs.bmp_para_imagem(bmp)

        for posicao, tile in automatico.get(arq, []):
            folha.paste(tile, fs.caixa(posicao)[:2])
        nossos = porfolha.get(arq, [])
        for posicao, img, sid in nossos:
            folha.paste(img, fs.caixa(posicao)[:2])
        desenhados += len(nossos)

        # grava sempre: a folha fica exatamente original + de-para + nossa arte
        with open(caminho, "wb") as f:
            f.write(fs.comprime(fs.imagem_para_bmp(folha, bmp), props))
        if nossos:
            print(f"  {arq[:26]}... {len(nossos)}: "
                  + ", ".join(s for _, _, s in nossos[:6])
                  + (" ..." if len(nossos) > 6 else ""))

    print(f"\n{desenhados} sprite(s) desenhado(s) por voce entraram no jogo "
          f"({vazias} tela(s) ainda em branco).")
    print("feche e abra o cliente para ver (ele guarda as folhas em memoria).")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("acao", choices=["exportar", "preparar", "importar"])
    ap.add_argument("--top-mapa", type=int, help="os N chaos mais comuns do mapa")
    ap.add_argument("--mapa", help="caminho de um .otbm (padrao: canary.otbm)")
    ap.add_argument("--itens", help="ids de item, ex: 4515,1019")
    ap.add_argument("--sprites", help="ids de sprite, ex: 189879,189880")
    ap.add_argument("--refazer", action="store_true",
                    help="reexporta do original por cima do que ja existe")
    a = ap.parse_args()
    {"exportar": exportar, "preparar": preparar, "importar": importar}[a.acao](a)


if __name__ == "__main__":
    main()
