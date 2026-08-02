"""Fatia a folha 4x4 de BORDAS (fundo magenta) em 16 tiles 32x32 com alpha.

Diferente do fatiar_lote.py, aqui o magenta #FF00FF vira transparencia.
Antes de reduzir, os pixels magenta sao pintados de verde para a media de
area (BOX) nao criar franja rosa na borda; o alpha e reduzido em separado
e limiarizado.

Uso:
    python fatiar_bordas.py <folha.png> <prefixo> [--cores 24]
"""
import argparse
import os

import numpy as np
from PIL import Image

from comum import fechar_ate_borda, limpar_moldura

TAM = 32
AQUI = os.path.dirname(os.path.abspath(__file__))
SAIDA = os.path.normpath(os.path.join(AQUI, "..", "..", "art_raw", "tiles32"))

# Cor que substitui o magenta ANTES da reducao, para a media de area nao
# criar franja rosa. Deve ser um tom medio do material do lote.
FUNDOS = {
    "grama": (74, 125, 58),   # #4a7d3a
    "agua": (63, 125, 148),   # #3f7d94
    "terra": (125, 98, 64),   # #7d6240
}


def separar_magenta(folha, fundo):
    """Devolve (rgb sem magenta, mascara alpha 0-255) em resolucao cheia."""
    px = np.asarray(folha.convert("RGB"), dtype=np.int16)
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    # magenta e rosas de anti-alias: vermelho e azul altos, verde bem menor
    magenta = (r > 150) & (b > 150) & (g < (r + b) // 2 - 60)
    alpha = np.where(magenta, 0, 255).astype(np.uint8)
    rgb = px.astype(np.uint8).copy()
    rgb[magenta] = fundo
    return Image.fromarray(rgb, "RGB"), Image.fromarray(alpha, "L")


def fatiar(caminho, prefixo, cores, fundo):
    folha = Image.open(caminho)
    rgb, alpha = separar_magenta(folha, fundo)
    L = folha.width // 4
    os.makedirs(SAIDA, exist_ok=True)

    gerados = []
    for i in range(16):
        cx, cy = (i % 4) * L, (i // 4) * L
        caixa = (cx, cy, cx + L, cy + L)
        moldura = max(2, L // 64)
        t_rgb = limpar_moldura(rgb.crop(caixa), moldura).resize((TAM, TAM), Image.BOX)
        t_a = limpar_moldura(alpha.crop(caixa), moldura).resize((TAM, TAM), Image.BOX)
        # limiar: pixel e visivel se mais da metade da area original era grama
        t_a = t_a.point(lambda v: 255 if v >= 128 else 0)
        t_rgb = t_rgb.quantize(colors=cores, method=Image.MEDIANCUT).convert("RGB")
        tile = t_rgb.convert("RGBA")
        tile.putalpha(t_a)
        tile = fechar_ate_borda(tile)
        nome = f"{prefixo}_{i:02d}"
        tile.save(f"{SAIDA}/{nome}.png")
        gerados.append((nome, tile))
    return gerados


def previa(tiles, escala=8):
    """Painel sobre xadrez, para conferir a transparencia."""
    lado = 4 * TAM * escala
    p = Image.new("RGBA", (lado, lado), (40, 40, 46, 255))
    # xadrez de fundo denuncia buracos ou sobras de magenta
    q = 16
    for y in range(0, lado, q):
        for x in range(0, lado, q):
            if (x // q + y // q) % 2 == 0:
                p.paste((58, 58, 66, 255), (x, y, x + q, y + q))
    for i, (_, t) in enumerate(tiles):
        amp = t.resize((TAM * escala, TAM * escala), Image.NEAREST)
        p.paste(amp, ((i % 4) * TAM * escala, (i // 4) * TAM * escala), amp)
    return p


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("folha")
    ap.add_argument("prefixo")
    ap.add_argument("--cores", type=int, default=24)
    ap.add_argument("--material", choices=sorted(FUNDOS), default="grama",
                    help="define a cor que tapa o magenta antes da reducao")
    a = ap.parse_args()

    tiles = fatiar(a.folha, a.prefixo, a.cores, FUNDOS[a.material])
    previa(tiles).save(f"{SAIDA}/_previa_{a.prefixo}.png")
    print(f"{len(tiles)} tiles de 32x32 em {SAIDA}")
    for n, _ in tiles:
        print("  ", n)
