"""Fatia a folha 4x4 de paredes em 16 pecas com fundo transparente.

Parede nao e chao: cada peca sobe na tela (mais alta que larga) e nao preenche
a celula toda. Entao aqui, para cada celula: tira o magenta, acha a caixa do
desenho, e encaixa esse desenho num sprite de 32x64 (a base ocupa a casa, o
corpo sobe uma casa) alinhado embaixo - que e como o cliente do Tibia ancora
parede.

    python fatiar_parede.py folha.png prefixo
"""
import argparse
import os

import numpy as np
from PIL import Image

from comum import limpar_moldura

TAM = 32                      # cada peca ocupa uma casa, como o resto do chao
AQUI = os.path.dirname(os.path.abspath(__file__))
SAIDA = os.path.normpath(os.path.join(AQUI, "..", "..", "art_raw", "tiles32"))

NOMES = [
    "reta_h", "reta_v", "canto_se", "canto_so",
    "canto_ne", "canto_no", "t_sul", "t_norte",
    "t_leste", "t_oeste", "cruz", "ponta_o",
    "ponta_n", "pilar", "porta", "janela",
]


def sem_magenta(cel):
    """RGBA da celula com o magenta virado transparente."""
    px = np.asarray(cel.convert("RGB"), dtype=np.int16)
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    mag = (r > 150) & (b > 150) & (g < (r + b) // 2 - 40)
    alpha = np.where(mag, 0, 255).astype(np.uint8)
    saida = np.dstack([px.astype(np.uint8), alpha])
    return Image.fromarray(saida, "RGBA")


def encaixa(cel):
    """Reduz a celula inteira para 32x32, sem recortar.

    Recortar cada peca e reescalar sozinha deixava cada uma de um tamanho e
    quebrava o encaixe. Escalando a celula toda, todas as pecas ficam na mesma
    escala e a parede continua na posicao que o artista desenhou dentro da
    casa (embaixo, no caso das horizontais).
    """
    return cel.resize((TAM, TAM), Image.LANCZOS)


def fatiar(caminho, prefixo):
    folha = Image.open(caminho)
    L, A = folha.width / 4, folha.height / 4
    os.makedirs(SAIDA, exist_ok=True)
    gerados = []
    for i in range(16):
        cx, cy = (i % 4) * L, (i // 4) * A
        cel = folha.crop((round(cx), round(cy), round(cx + L), round(cy + A)))
        cel = limpar_moldura(cel, max(2, cel.width // 40))
        peca = encaixa(sem_magenta(cel))
        nome = f"{prefixo}_{NOMES[i]}"
        peca.save(f"{SAIDA}/{nome}.png")
        gerados.append((nome, peca))
    return gerados


def previa(tiles, escala=6):
    cel_l = cel_a = TAM * escala
    p = Image.new("RGBA", (4 * cel_l, 4 * cel_a), (40, 40, 46, 255))
    q = 12
    for y in range(0, p.height, q):
        for x in range(0, p.width, q):
            if (x // q + y // q) % 2 == 0:
                p.paste((56, 56, 64, 255), (x, y, x + q, y + q))
    for i, (_, t) in enumerate(tiles):
        amp = t.resize((cel_l, cel_a), Image.NEAREST)
        p.paste(amp, ((i % 4) * cel_l, (i // 4) * cel_a), amp)
    return p


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("folha")
    ap.add_argument("prefixo")
    a = ap.parse_args()
    tiles = fatiar(a.folha, a.prefixo)
    previa(tiles).save(f"{SAIDA}/_previa_{a.prefixo}.png")
    print(f"{len(tiles)} pecas de parede em {SAIDA}")
    for n, _ in tiles:
        print("  ", n)
