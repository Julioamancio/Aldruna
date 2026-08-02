"""Fatia uma folha 4x4 gerada por IA em 16 tiles de 32x32 do Destruitor.

O gerador entrega ~1024x1024 (256 px por tile). Reduzir direto para 32 com
NEAREST perde detalhe e cria serrilha; entao reduzimos por media de area (BOX)
e depois quantizamos a paleta, que e o que devolve a cara de pixel art.

Uso:
    python3 fatiar_lote.py <folha.png> <prefixo> [--cores 24]
"""
import argparse
import os

from PIL import Image

from comum import limpar_moldura

TAM = 32
AQUI = os.path.dirname(os.path.abspath(__file__))
SAIDA = os.path.normpath(os.path.join(AQUI, "..", "..", "art_raw", "tiles32"))


def fatiar(caminho, prefixo, cores, nomes=None):
    folha = Image.open(caminho).convert("RGBA")
    L = folha.width // 4
    os.makedirs(SAIDA, exist_ok=True)

    gerados = []
    for i in range(16):
        cx, cy = (i % 4) * L, (i // 4) * L
        tile = folha.crop((cx, cy, cx + L, cy + L))
        tile = limpar_moldura(tile, max(2, L // 64))
        # media de area: preserva a cor geral em vez de sortear um pixel
        tile = tile.resize((TAM, TAM), Image.BOX)
        # quantizar devolve o aspecto de paleta limitada
        tile = tile.convert("RGB").quantize(colors=cores, method=Image.MEDIANCUT)
        tile = tile.convert("RGBA")
        nome = nomes[i] if nomes else f"{prefixo}_{i:02d}"
        destino = f"{SAIDA}/{nome}.png"
        tile.save(destino)
        gerados.append((nome, tile))
    return gerados


def previa(tiles, escala=8):
    """Painel com os 16 tiles ampliados, para conferir a leitura em tela."""
    p = Image.new("RGBA", (4 * TAM * escala, 4 * TAM * escala), (24, 24, 28, 255))
    for i, (_, t) in enumerate(tiles):
        amp = t.resize((TAM * escala, TAM * escala), Image.NEAREST)
        p.paste(amp, ((i % 4) * TAM * escala, (i // 4) * TAM * escala))
    return p


NOMES_LOTE1 = [
    "grama", "grama_musgo", "grama_flores", "grama_terra",
    "trilha_terra", "terra_seca", "areia", "borda_grama_areia",
    "agua_rasa", "agua_funda", "borda_agua_areia", "pedras_rio",
    "calcada", "laje_pedra", "folhas_chao", "raizes",
]

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("folha")
    ap.add_argument("prefixo")
    ap.add_argument("--cores", type=int, default=24)
    a = ap.parse_args()

    nomes = NOMES_LOTE1 if a.prefixo == "chao" else None
    tiles = fatiar(a.folha, a.prefixo, a.cores, nomes)
    previa(tiles).save(f"{SAIDA}/_previa_{a.prefixo}.png")
    print(f"{len(tiles)} tiles de 32x32 em {SAIDA}")
    for n, _ in tiles:
        print("  ", n)
