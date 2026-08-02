"""Monta um trecho de mapa com os tiles ja convertidos, no tamanho real do jogo.

Serve para julgar a arte como ela vai aparecer de verdade: 32x32 por casa, varias
casas lado a lado. Uma peca pode ser linda ampliada e virar papel de parede
ilegivel quando repetida - e aqui que isso aparece.
"""
import random

from PIL import Image

TILES = "/mnt/c/Users/julio/Aldruna/art_raw/tiles32"
TAM = 32


def carrega(nome):
    return Image.open(f"{TILES}/{nome}.png").convert("RGBA")


def monta(largura=28, altura=18, escala=3):
    t = {n: carrega(n) for n in [
        "grama", "grama_musgo", "grama_flores", "grama_terra", "trilha_terra",
        "areia", "borda_grama_areia", "agua_rasa", "agua_funda",
        "borda_agua_areia", "pedras_rio", "calcada", "folhas_chao", "raizes",
    ]}
    rnd = random.Random("previa")
    cena = Image.new("RGBA", (largura * TAM, altura * TAM))

    for y in range(altura):
        for x in range(largura):
            # riacho na vertical, com areia nas margens
            if x in (13, 14):
                peca = t["agua_funda"] if x == 13 else t["agua_rasa"]
            elif x in (12, 15):
                peca = t["borda_agua_areia"]
            elif x in (11, 16):
                peca = t["areia"]
            elif x in (10, 17):
                peca = t["borda_grama_areia"]
            # clareira de pedra no canto
            elif 2 <= x <= 7 and 2 <= y <= 6:
                peca = t["calcada"]
            # trilha horizontal saindo da clareira
            elif y in (9, 10) and x > 17:
                peca = t["trilha_terra"]
            else:
                r = rnd.random()
                peca = (t["grama"] if r > 0.45 else
                        t["grama_musgo"] if r > 0.2 else
                        t["grama_flores"] if r > 0.1 else
                        t["folhas_chao"] if r > 0.05 else t["raizes"])
            cena.paste(peca, (x * TAM, y * TAM))

    return cena.resize((largura * TAM * escala, altura * TAM * escala), Image.NEAREST)


if __name__ == "__main__":
    destino = f"{TILES}/_previa_mapa.png"
    monta().save(destino)
    print("previa em", destino)
