"""Utilidades compartilhadas pelos fatiadores de folha."""

import numpy as np
from PIL import Image


def fechar_ate_borda(tile, folga_max=2):
    """Estica ate a borda do tile as formas que pararam a poucos pixels dela.

    O gerador costuma deixar 1 pixel de respiro entre a forma e a divisa da
    celula. Numa peca de overlay isso vira um fio do chao aparecendo entre duas
    casas vizinhas - o mapa fica riscado. Aqui, linha a linha, o primeiro pixel
    opaco proximo da borda e repetido ate encostar nela. So mexe em quem ja
    estava quase la, entao cantos e manchas isoladas continuam intactos.
    """
    px = np.asarray(tile.convert("RGBA")).copy()
    n = px.shape[0]

    def estica(eixo):
        # trabalha sempre "da esquerda para a direita" na visao girada
        vista = px if eixo == 0 else px.transpose(1, 0, 2)
        for i in range(n):
            linha = vista[i]
            opacos = np.flatnonzero(linha[:, 3] > 0)
            if opacos.size == 0:
                continue
            ini, fim = opacos[0], opacos[-1]
            if 0 < ini <= folga_max:
                linha[:ini] = linha[ini]
            if 0 < n - 1 - fim <= folga_max:
                linha[fim + 1:] = linha[fim]

    estica(0)
    estica(1)
    return Image.fromarray(px, "RGBA")


def limpar_moldura(cell, n=3):
    """Apaga a moldura de `n` pixels na borda da celula, esticando o miolo.

    Por que: apesar do prompt pedir "no grid lines", o gerador quase sempre
    deixa um fio de cor entre as celulas da folha 4x4. Depois de reduzir para
    32x32 esse fio vira uma linha visivel na divisa de cada casa do mapa.
    Recortar para dentro nao serve - as pecas de borda PRECISAM tocar a
    extremidade -, entao repetimos a primeira linha/coluna boa por cima do fio.
    """
    if n <= 0:
        return cell
    L, A = cell.size
    limpa = cell.copy()
    # topo e base
    limpa.paste(cell.crop((0, n, L, n + 1)).resize((L, n), Image.NEAREST), (0, 0))
    limpa.paste(cell.crop((0, A - n - 1, L, A - n)).resize((L, n), Image.NEAREST),
                (0, A - n))
    # esquerda e direita (ja sobre a imagem corrigida, para os cantos fecharem)
    base = limpa.copy()
    limpa.paste(base.crop((n, 0, n + 1, A)).resize((n, A), Image.NEAREST), (0, 0))
    limpa.paste(base.crop((L - n - 1, 0, L - n, A)).resize((n, A), Image.NEAREST),
                (L - n, 0))
    return limpa
