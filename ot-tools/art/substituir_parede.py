"""Troca o sprite das 3 paredes da familia do jogo pela nossa arte.

Parede no Tibia sao 3 pecas: horizontal (item 1082, 64x32), vertical
(item 1081, 32x64) e o poll/pilar que junta as duas (item 1085, 64x64). Elas
ja sao os objetos mais colocados no mapa, entao trocar o sprite delas faz as
paredes do mundo inteiro virarem nossas, ja conectadas - a conexao esta na
posicao do item, que nao muda.

Corta cada peca da folha do ChatGPT no TAMANHO NATIVO do item (nao em 32x32,
que foi o erro que deixou tudo pequeno) e escreve nos sprites daquele item.

    wsl ... substituir_parede.py <folha.png>
    wsl ... substituir_parede.py --restaurar
"""
import argparse
import os

import numpy as np
from PIL import Image

import folha_sprites as fs
from ler_appearances import carrega_appearances, carrega_modulo_protobuf, sprites_de

# item do jogo -> (indice da celula, tamanho nativo do sprite).
# A folha nova (prompt_parede_pedra.txt) tem 3 celulas numa linha:
# 0 horizontal, 1 vertical, 2 poll. O corte se adapta ao numero de colunas.
PECAS = {
    1082: (0, (64, 32)),    # parede horizontal (mais usada: 10873x)
    1081: (1, (32, 64)),    # parede vertical (9740x)
    1083: (2, (64, 64)),    # canto (L)
    1085: (3, (64, 64)),    # poll/pilar que junta as paredes
}


def sem_magenta(cel):
    px = np.asarray(cel.convert("RGB"), dtype=np.int16)
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    # magenta puro E os rosas de anti-alias em volta (verde bem abaixo da media
    # de vermelho+azul). O limiar mais folgado (-15) pega a franja que sobrava.
    mag = (r > 110) & (b > 110) & (g < (r + b) // 2 - 15)
    rgb = px.astype(np.uint8).copy()
    # pinta o que vai sumir com a cor do vizinho valido mais proximo, para a
    # reducao LANCZOS nao puxar rosa de volta para a borda da peca
    rgb[mag] = 0
    alpha = np.where(mag, 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, alpha]), "RGBA")


def peca_nativa(folha, indice, destino, colunas):
    """Recorta a celula, tira o magenta e ajusta ao tamanho nativo do sprite."""
    L = folha.width / colunas
    A = folha.height                      # folha de parede e uma linha so
    cx = indice * L
    cel = sem_magenta(folha.crop((round(cx), 0, round(cx + L), round(A))))
    caixa = cel.getbbox()
    if caixa:
        cel = cel.crop(caixa)              # tira a margem magenta em volta
    return cel.resize(destino, Image.LANCZOS)


def grava_sprite(sid, imagem, cat, cache):
    """Escreve `imagem` no sprite `sid` dentro da folha .bmp.lzma dele."""
    entrada, indice = fs.acha_folha(sid, cat)
    arq = entrada["file"]
    caminho = f"{fs.ASSETS}/{arq}"
    if arq not in cache:
        if not os.path.exists(caminho + ".original"):
            import shutil
            shutil.copy2(caminho, caminho + ".original")
        bmp, props = fs.descomprime(caminho + ".original")
        cache[arq] = [fs.bmp_para_imagem(bmp), bmp, props]
    folha, bmp, _ = cache[arq]
    tipo = entrada.get("spritetype", 0)
    folha.paste(imagem, fs.caixa(indice, tipo)[:2])


def restaurar():
    import shutil
    n = 0
    for arq in os.listdir(fs.ASSETS):
        if arq.endswith(".original"):
            shutil.copy2(f"{fs.ASSETS}/{arq}", f"{fs.ASSETS}/{arq[:-9]}")
            n += 1
    print(f"{n} folha(s) restaurada(s)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folha", nargs="?")
    ap.add_argument("--restaurar", action="store_true")
    a = ap.parse_args()
    if a.restaurar:
        return restaurar()

    folha = Image.open(a.folha)
    dados = carrega_appearances(carrega_modulo_protobuf())
    porid = {o.id: o for o in dados.object}
    cat = fs.catalogo()
    cache = {}

    colunas = len(PECAS)                  # 3 celulas na linha
    for item, (indice, tam) in PECAS.items():
        obj = porid[item]
        arte = peca_nativa(folha, indice, tam, colunas)
        # escreve a mesma peca em todos os sprites unicos do item
        for sid in dict.fromkeys(sprites_de(obj)):
            grava_sprite(sid, arte, cat, cache)
        print(f"item {item}: {tam[0]}x{tam[1]} em {len(set(sprites_de(obj)))} sprite(s)")

    for arq, (folha_img, bmp, props) in cache.items():
        with open(f"{fs.ASSETS}/{arq}", "wb") as f:
            f.write(fs.comprime(fs.imagem_para_bmp(folha_img, bmp), props))
    print(f"\n{len(cache)} folha(s) gravada(s). Feche e abra o cliente.")


if __name__ == "__main__":
    main()
