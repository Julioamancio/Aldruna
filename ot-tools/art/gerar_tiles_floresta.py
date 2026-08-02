"""Gera as pecas de terreno da ilha inicial (tema floresta) por codigo.

Pixel art de 32x32 feita por algoritmo: cor base + ruido determinístico + detalhes.
Sem IA e sem asset de terceiros - tudo que sai daqui e nosso, que e o requisito
para abrir o jogo ao publico ([[tibia-like-pivot]]).

Determinístico de proposito: a mesma semente gera sempre o mesmo tile, entao o
resultado e reproduzivel e versionavel.

Rodar no WSL:
    wsl -d Ubuntu-24.04 -u root -- python3 /mnt/c/Users/julio/Aldruna/ot-tools/art/gerar_tiles_floresta.py
"""
import os
import random

from PIL import Image, ImageDraw

TAM = 32
SAIDA = "/mnt/c/Users/julio/Aldruna/art_raw/gerado"

# Paleta da ilha: poucas cores por material, como pixel art classica.
PALETA = {
    "grama": ["#3f6b32", "#4a7d3a", "#568c42", "#2f5527"],
    "grama_musgo": ["#2f5a2c", "#3a6b34", "#456b3a", "#26471f"],
    "terra": ["#6b5334", "#7d613d", "#5a4529", "#8a6d45"],
    "trilha": ["#8a7350", "#9c8460", "#7a6444", "#a89272"],
    "areia": ["#c2ab7a", "#d4bd8c", "#b09968", "#e0cb9e"],
    "agua_rasa": ["#3f7d94", "#4a8ea6", "#5aa0b8", "#356b80"],
    "agua_funda": ["#255a70", "#2f6b80", "#1c4a5e", "#3a7d94"],
    "pedra": ["#6b6b6b", "#7d7d7d", "#5a5a5a", "#8a8a8a"],
    "pedra_musgo": ["#5a6b52", "#6b7d5f", "#4a5a45", "#7d8a6b"],
    "madeira": ["#7d5a34", "#8a6640", "#6b4a2c", "#9c7550"],
    "folhas": ["#5a4a2c", "#6b5a34", "#7d6b45", "#4a3a24"],
    "copa": ["#2c5527", "#3a6b32", "#1f4520", "#456b3a"],
    "casca": ["#4a3a24", "#5a452c", "#3a2c1c", "#6b5534"],
    "samambaia": ["#3a6b3a", "#457d45", "#2c552c", "#568c56"],
}


def ruido(nome, pesos=(45, 30, 15, 10)):
    """Preenche o tile com as cores da paleta em proporcao, sem anti-aliasing."""
    img = Image.new("RGBA", (TAM, TAM))
    px = img.load()
    cores = PALETA[nome]
    rnd = random.Random(nome)
    for y in range(TAM):
        for x in range(TAM):
            c = rnd.choices(cores, weights=pesos)[0]
            px[x, y] = tuple(int(c[i:i + 2], 16) for i in (1, 3, 5)) + (255,)
    return img


def salpica(img, nome_cor, quantidade, tamanho=1, semente=0):
    """Detalhes soltos: pedrinhas na terra, gravetos na grama, espuma na agua."""
    d = ImageDraw.Draw(img)
    rnd = random.Random(f"{nome_cor}{semente}")
    cores = PALETA[nome_cor]
    for _ in range(quantidade):
        x, y = rnd.randrange(TAM), rnd.randrange(TAM)
        c = rnd.choice(cores)
        d.rectangle([x, y, x + tamanho - 1, y + tamanho - 1], fill=c)
    return img


def tijolos(nome, altura=8, largura=16):
    """Parede: fiadas alternadas com junta escura."""
    img = ruido(nome, pesos=(50, 30, 15, 5))
    d = ImageDraw.Draw(img)
    junta = PALETA[nome][2]
    for i, y in enumerate(range(0, TAM, altura)):
        d.line([(0, y), (TAM, y)], fill=junta)
        desloca = 0 if i % 2 == 0 else largura // 2
        for x in range(desloca, TAM + largura, largura):
            d.line([(x, y), (x, y + altura)], fill=junta)
    return img


def copa_arvore():
    """Copa vista de cima: massa irregular de folhas com sombra embaixo."""
    img = Image.new("RGBA", (TAM, TAM), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rnd = random.Random("copa")
    for _ in range(90):
        x, y = rnd.randrange(2, TAM - 2), rnd.randrange(2, TAM - 2)
        if (x - 16) ** 2 + (y - 16) ** 2 > 15 ** 2:
            continue
        r = rnd.randrange(2, 5)
        escuro = y > 18
        cor = PALETA["copa"][2] if escuro else rnd.choice(PALETA["copa"][:2])
        d.ellipse([x - r, y - r, x + r, y + r], fill=cor)
    return img


def samambaia():
    """Vegetacao baixa: folhas em leque sobre fundo transparente."""
    img = Image.new("RGBA", (TAM, TAM), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rnd = random.Random("fern")
    for _ in range(14):
        bx, by = rnd.randrange(6, 26), rnd.randrange(18, 30)
        alt = rnd.randrange(8, 15)
        incl = rnd.randrange(-6, 7)
        cor = rnd.choice(PALETA["samambaia"][:3])
        d.line([(bx, by), (bx + incl, by - alt)], fill=cor)
    return img


def agua(frame):
    """Agua animada: mesma base, ondulacao deslocada por quadro."""
    img = ruido("agua_rasa" if frame < 2 else "agua_funda", pesos=(40, 30, 20, 10))
    d = ImageDraw.Draw(img)
    rnd = random.Random(f"onda{frame}")
    for _ in range(10):
        y = rnd.randrange(TAM)
        x = rnd.randrange(TAM)
        d.line([(x, y), (x + rnd.randrange(3, 7), y)], fill=PALETA["agua_rasa"][2])
    return img


def gera_todos():
    tiles = {}
    tiles["grama"] = salpica(ruido("grama"), "grama_musgo", 25, semente=1)
    tiles["grama_musgo"] = salpica(ruido("grama_musgo"), "copa", 20, semente=2)
    tiles["trilha"] = salpica(ruido("trilha"), "terra", 30, semente=3)
    tiles["terra"] = salpica(ruido("terra"), "pedra", 12, semente=4)
    tiles["areia"] = salpica(ruido("areia"), "terra", 15, semente=5)
    tiles["agua_rasa"] = agua(0)
    tiles["agua_funda"] = agua(2)
    tiles["piso_pedra"] = salpica(ruido("pedra"), "pedra_musgo", 18, semente=6)
    tiles["parede_pedra"] = tijolos("pedra")
    tiles["parede_musgo"] = tijolos("pedra_musgo")
    tiles["piso_madeira"] = tijolos("madeira", altura=6, largura=32)
    tiles["folhas_chao"] = salpica(ruido("folhas"), "copa", 30, semente=7)
    tiles["casca"] = tijolos("casca", altura=10, largura=8)
    tiles["copa"] = copa_arvore()
    tiles["samambaia"] = samambaia()
    return tiles


def folha_de_amostra(tiles, escala=6):
    """Painel com cada peca ampliada, para inspecao do estilo."""
    cols = 5
    linhas = (len(tiles) + cols - 1) // cols
    larg = cols * TAM * escala
    alt = linhas * TAM * escala
    folha = Image.new("RGBA", (larg, alt), (24, 24, 28, 255))
    for i, (nome, img) in enumerate(sorted(tiles.items())):
        gx, gy = (i % cols) * TAM * escala, (i // cols) * TAM * escala
        ampliada = img.resize((TAM * escala, TAM * escala), Image.NEAREST)
        folha.paste(ampliada, (gx, gy), ampliada)  # a mascara tem que ser a ampliada
    return folha


def cena_exemplo(tiles, largura=24, altura=16, escala=4):
    """Trecho de mapa: clareira com trilha, riacho e arvores - como ficaria no jogo."""
    rnd = random.Random("cena")
    cena = Image.new("RGBA", (largura * TAM, altura * TAM))
    for ty in range(altura):
        for tx in range(largura):
            if tx in (10, 11):
                base = tiles["agua_funda"] if tx == 10 else tiles["agua_rasa"]
            elif tx in (9, 12):
                base = tiles["areia"]
            elif ty in (7, 8) and tx > 12:
                base = tiles["trilha"]
            else:
                base = tiles["grama"] if rnd.random() > 0.25 else tiles["grama_musgo"]
            cena.paste(base, (tx * TAM, ty * TAM))
    # arvores e vegetacao espalhadas
    for _ in range(26):
        tx, ty = rnd.randrange(largura), rnd.randrange(altura)
        if 8 <= tx <= 13 or (ty in (7, 8) and tx > 12):
            continue
        peca = tiles["copa"] if rnd.random() > 0.4 else tiles["samambaia"]
        cena.paste(peca, (tx * TAM, ty * TAM), peca)
    return cena.resize((largura * TAM * escala, altura * TAM * escala), Image.NEAREST)


if __name__ == "__main__":
    os.makedirs(SAIDA, exist_ok=True)
    tiles = gera_todos()
    for nome, img in tiles.items():
        img.save(f"{SAIDA}/tile_{nome}.png")
    folha_de_amostra(tiles).save(f"{SAIDA}/amostra_pecas.png")
    cena_exemplo(tiles).save(f"{SAIDA}/amostra_cena.png")
    print(f"{len(tiles)} pecas geradas em {SAIDA}")
    print("  amostra_pecas.png  - cada peca ampliada")
    print("  amostra_cena.png   - trecho de mapa montado com elas")
