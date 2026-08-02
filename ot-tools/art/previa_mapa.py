"""Monta um trecho de mapa com os tiles ja convertidos, no tamanho real do jogo.

Serve para julgar a arte como ela vai aparecer de verdade: 32x32 por casa, varias
casas lado a lado. Uma peca pode ser linda ampliada e virar papel de parede
ilegivel quando repetida - e aqui que isso aparece.

As bordas dos lotes 2/3/4 sao OVERLAYS com alpha: em vez de precisar de um tile
pronto para cada combinacao de vizinhos, empilhamos as pecas. Uma casa de terra
com grama ao norte e a leste recebe a peca "grama na metade de cima" mais a peca
"grama na metade da direita"; onde elas se cruzam o canto fecha sozinho.
"""
import os
import random

from PIL import Image

AQUI = os.path.dirname(os.path.abspath(__file__))
TILES = os.path.normpath(os.path.join(AQUI, "..", "..", "art_raw", "tiles32"))
TAM = 32

# Indices dentro de cada folha de borda, na ordem em que foram geradas.
LADO = {"N": 0, "L": 1, "S": 2, "O": 3}
CANTO = {"NL": 4, "SL": 5, "SO": 6, "NO": 7}

# Vizinhos: nome -> (dx, dy)
DIR = {"N": (0, -1), "L": (1, 0), "S": (0, 1), "O": (-1, 0),
       "NL": (1, -1), "SL": (1, 1), "SO": (-1, 1), "NO": (-1, -1)}


def carrega(nome):
    return Image.open(f"{TILES}/{nome}.png").convert("RGBA")


def bordas(prefixo):
    return [carrega(f"{prefixo}_{i:02d}") for i in range(16)]


def desenha_bordas(cena, x, y, mapa, material, pecas, largura, altura):
    """Empilha as pecas de borda de `material` na casa (x, y)."""
    def eh(dx, dy):
        vx, vy = x + dx, y + dy
        if not (0 <= vx < largura and 0 <= vy < altura):
            return False
        return mapa[vy][vx] == material

    ortogonais = {d: eh(*DIR[d]) for d in LADO}
    for d, tem in ortogonais.items():
        if tem:
            cena.paste(pecas[LADO[d]], (x * TAM, y * TAM), pecas[LADO[d]])

    # O canto diagonal so aparece quando nenhum dos dois lados dele ja cobriu
    # a area - senao a peca do lado ja resolveu e o canto viraria mancha.
    for d, i in CANTO.items():
        if eh(*DIR[d]) and not ortogonais[d[0]] and not ortogonais[d[1]]:
            cena.paste(pecas[i], (x * TAM, y * TAM), pecas[i])


def monta(largura=28, altura=18, escala=3):
    base = {n: carrega(n) for n in
            ["grama", "grama_musgo", "grama_flores", "areia", "trilha_terra",
             "agua_funda", "calcada", "neve", "rocha"]}
    b_grama = bordas("borda_grama")
    b_agua = bordas("borda_agua")
    b_terra = bordas("borda_terra")
    b_neve = bordas("borda_neve")
    b_rocha = bordas("borda_rocha")

    rnd = random.Random("destruitor")

    # 1) Planta o terreno logico: cada casa e grama, terra, agua ou pedra.
    mapa = [["grama"] * largura for _ in range(altura)]
    for y in range(altura):
        for x in range(largura):
            # lago no canto sudeste
            if (x - 22) ** 2 + ((y - 13) * 1.6) ** 2 < 36:
                mapa[y][x] = "agua"
            # trilha serpenteando de oeste a leste
            elif abs(y - (7 + 3 * ((x / 7.0) % 2 - 0.5))) < 1.4:
                mapa[y][x] = "terra"
            # praca de pedra a noroeste
            elif 2 <= x <= 6 and 2 <= y <= 5:
                mapa[y][x] = "pedra"
            # campo de neve a nordeste, encostando na grama e na trilha
            elif x >= 19 and y <= 4:
                mapa[y][x] = "neve"
            # afloramento de rocha no sudoeste
            elif 3 <= x <= 8 and 12 <= y <= 15:
                mapa[y][x] = "rocha"

    # 2) Pinta o chao de cada casa.
    cena = Image.new("RGBA", (largura * TAM, altura * TAM))
    for y in range(altura):
        for x in range(largura):
            tipo = mapa[y][x]
            if tipo == "grama":
                # variar a grama evita o efeito papel de parede
                peca = base[rnd.choice(
                    ["grama", "grama", "grama", "grama_musgo", "grama_flores"])]
            elif tipo == "agua":
                peca = base["agua_funda"]
            elif tipo == "terra":
                peca = base["trilha_terra"]
            elif tipo == "neve":
                peca = base["neve"]
            elif tipo == "rocha":
                peca = base["rocha"]
            else:
                peca = base["calcada"]
            cena.paste(peca, (x * TAM, y * TAM))

    # 3) Sobrepoe as bordas: cada material invade a casa do vizinho.
    for y in range(altura):
        for x in range(largura):
            tipo = mapa[y][x]
            if tipo != "grama":
                desenha_bordas(cena, x, y, mapa, "grama", b_grama, largura, altura)
            if tipo != "agua":
                desenha_bordas(cena, x, y, mapa, "agua", b_agua, largura, altura)
            if tipo != "terra":
                desenha_bordas(cena, x, y, mapa, "terra", b_terra, largura, altura)
            if tipo != "neve":
                desenha_bordas(cena, x, y, mapa, "neve", b_neve, largura, altura)
            if tipo != "rocha":
                desenha_bordas(cena, x, y, mapa, "rocha", b_rocha, largura, altura)

    return cena.resize((cena.width * escala, cena.height * escala), Image.NEAREST)


if __name__ == "__main__":
    destino = f"{TILES}/_previa_mapa.png"
    monta().save(destino)
    print("cena salva em", destino)
