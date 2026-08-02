"""Fatia uma folha de textura NxM em tiles de 32x32, um nome por linha.

Diferente do fatiar_lote.py (que era amarrado a folhas 4x4 de 16 pecas), aqui
a grade e livre: informa-se quantas colunas e o nome de cada linha. Serve para
os packs de textura, que costumam vir como "um material por linha, varias
variacoes por coluna".

Ter varias variacoes do mesmo material importa: espalhadas pelos sprites de um
item, elas quebram o efeito papel de parede em area grande.

    python fatiar_folha.py folha.png --colunas 8 \
        --linhas grama,grama_escura,grama_seca,terra,areia,pedra,neve,agua_rasa,agua_funda,lava
"""
import argparse
import os

from PIL import Image

from comum import limpar_moldura

TAM = 32
AQUI = os.path.dirname(os.path.abspath(__file__))
SAIDA = os.path.normpath(os.path.join(AQUI, "..", "..", "art_raw", "tiles32"))


def fatia(caminho, colunas, nomes, cores, prefixo="pack"):
    folha = Image.open(caminho).convert("RGBA")
    linhas = len(nomes)
    # divisao em ponto flutuante: a folha raramente e multiplo exato da grade,
    # e arredondar por celula evita o erro ir se acumulando ate a ultima coluna
    L, A = folha.width / colunas, folha.height / linhas

    gerados = []
    for i, nome in enumerate(nomes):
        for c in range(colunas):
            caixa = (round(c * L), round(i * A), round((c + 1) * L), round((i + 1) * A))
            cel = folha.crop(caixa)
            cel = limpar_moldura(cel, max(2, cel.width // 40))
            cel = cel.resize((TAM, TAM), Image.BOX)
            cel = cel.convert("RGB").quantize(colors=cores,
                                              method=Image.MEDIANCUT).convert("RGBA")
            arq = f"{prefixo}_{nome}_{c}"
            cel.save(f"{SAIDA}/{arq}.png")
            gerados.append((arq, cel))
    return gerados


def previa(tiles, colunas, escala=4):
    linhas = (len(tiles) + colunas - 1) // colunas
    cel = TAM * escala
    p = Image.new("RGBA", (colunas * cel, linhas * cel), (30, 30, 34, 255))
    for n, (_, t) in enumerate(tiles):
        p.paste(t.resize((cel, cel), Image.NEAREST), ((n % colunas) * cel,
                                                      (n // colunas) * cel))
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folha")
    ap.add_argument("--colunas", type=int, required=True)
    ap.add_argument("--linhas", required=True, help="nomes separados por virgula")
    ap.add_argument("--prefixo", default="pack")
    ap.add_argument("--cores", type=int, default=28)
    a = ap.parse_args()

    nomes = [n.strip() for n in a.linhas.split(",")]
    os.makedirs(SAIDA, exist_ok=True)
    tiles = fatia(a.folha, a.colunas, nomes, a.cores, a.prefixo)
    previa(tiles, a.colunas).save(f"{SAIDA}/_previa_{a.prefixo}.png")
    print(f"{len(tiles)} tiles de 32x32 em {SAIDA}")
    for nome in nomes:
        print(f"  {a.prefixo}_{nome}_0 .. _{a.colunas - 1}")


if __name__ == "__main__":
    main()
