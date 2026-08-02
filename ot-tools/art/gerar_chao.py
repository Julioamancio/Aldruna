"""Gera por codigo os chaos que faltam e, principalmente, as BORDAS deles.

Por que por codigo e nao por IA de imagem: aqui a peca encaixa por construcao.
O ruido fecha nas quatro extremidades (o tile repete sem emenda) e a divisa
entre dois materiais e a mesma funcao nos dois lados, entao a borda de cima
casa exatamente com a de baixo. Foi justamente isso que a folha gerada por IA
nao acertou, e foi o que estragou a agua em jogo.

Tudo aqui e desenhado do zero a partir de paleta e ruido - nada vem de asset
de terceiro.

    wsl -d Ubuntu-24.04 -u root -- python3 .../gerar_chao.py
    ... gerar_chao.py --so neve --previa
"""
import argparse
import math
import os
import random

from PIL import Image

TAM = 32
AQUI = os.path.dirname(os.path.abspath(__file__))
SAIDA = os.path.normpath(os.path.join(AQUI, "..", "..", "art_raw", "tiles32"))

# Paletas do mais escuro para o mais claro. Poucas cores por material, como
# manda o guia de estilo (docs/estilo-sprites.md).
PALETA = {
    "neve":        ["#b9c6d4", "#cfdae6", "#e6eef5", "#f7fbff"],
    "rocha":       ["#4a3a30", "#5e4a3c", "#72594a", "#8a6f5c"],
    "rocha_clara": ["#5a4a40", "#6e5a4c", "#82705e", "#9a8672"],
    "chao_escuro": ["#242428", "#2f2f34", "#3a3a40", "#46464d"],
    "madeira":     ["#5a3f24", "#6e4f2e", "#82603a", "#96724a"],
    "gelo":        ["#7fa8c4", "#9cc0d8", "#bcd8ea", "#dcedf7"],
    "grama":       ["#2f5527", "#3f6b32", "#4a7d3a", "#568c42"],
    "areia":       ["#b09968", "#c2ab7a", "#d4bd8c", "#e0cb9e"],
    "terra":       ["#574327", "#6b5334", "#7d6240", "#8a7350"],
}

# proporcao de cada tom, do escuro ao claro
MISTURA = {
    "neve":        (0.15, 0.30, 0.35, 0.20),
    "rocha":       (0.30, 0.30, 0.25, 0.15),
    "rocha_clara": (0.25, 0.30, 0.28, 0.17),
    "chao_escuro": (0.35, 0.30, 0.22, 0.13),
    "madeira":     (0.25, 0.30, 0.28, 0.17),
    "gelo":        (0.20, 0.28, 0.32, 0.20),
    "grama":       (0.20, 0.35, 0.30, 0.15),
    "areia":       (0.18, 0.32, 0.32, 0.18),
    "terra":       (0.25, 0.32, 0.28, 0.15),
}


def _hex(c):
    return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))


def ruido(semente, escala=4, oitavas=3):
    """Ruido de valor que FECHA nas bordas: o tile repete sem emenda.

    A malha tem `escala` pontos e o indice volta ao inicio com o modulo, entao
    a coluna 31 interpola contra a coluna 0. Sem isso todo tile mostra a
    costura quando repetido lado a lado.
    """
    campo = [[0.0] * TAM for _ in range(TAM)]
    amplitude, total = 1.0, 0.0
    for o in range(oitavas):
        n = escala * (2 ** o)
        rnd = random.Random(f"{semente}-{o}")
        malha = [[rnd.random() for _ in range(n)] for _ in range(n)]
        passo = TAM / n
        for y in range(TAM):
            for x in range(TAM):
                fx, fy = x / passo, y / passo
                x0, y0 = int(fx) % n, int(fy) % n
                x1, y1 = (x0 + 1) % n, (y0 + 1) % n
                tx, ty = fx - int(fx), fy - int(fy)
                # suavizacao classica: derivada zero nas pontas, sem facetamento
                sx = tx * tx * (3 - 2 * tx)
                sy = ty * ty * (3 - 2 * ty)
                a = malha[y0][x0] * (1 - sx) + malha[y0][x1] * sx
                b = malha[y1][x0] * (1 - sx) + malha[y1][x1] * sx
                campo[y][x] += (a * (1 - sy) + b * sy) * amplitude
        total += amplitude
        amplitude *= 0.5
    return [[v / total for v in linha] for linha in campo]


def _limiares(mistura):
    """Converte a proporcao de cada tom em cortes sobre o ruido."""
    cortes, acumulado = [], 0.0
    for p in mistura[:-1]:
        acumulado += p
        cortes.append(acumulado)
    return cortes


def tile(material, semente=None, escala=8):
    """Textura de chao 32x32, sem costura, com luz vindo do noroeste.

    A escala alta e proposital: com poucos pontos de malha o resultado vira
    mancha de nuvem, nao chao. E o granulado fino no fim quebra as faixas lisas
    que o ruido suave deixa - e o que da cara de pixel art.
    """
    semente = semente or material
    campo = ruido(semente, escala, oitavas=2)
    cores = [_hex(c) for c in PALETA[material]]
    cortes = _limiares(MISTURA[material])
    rnd = random.Random(f"{semente}-grao")

    img = Image.new("RGBA", (TAM, TAM))
    px = img.load()
    for y in range(TAM):
        for x in range(TAM):
            v = campo[y][x]
            # inclinacao suave: noroeste mais claro, sudeste mais escuro, sem
            # nunca chegar ao preto (regra 2 do guia de estilo)
            v += 0.10 * (1 - (x + y) / (2 * TAM)) - 0.05
            v += rnd.uniform(-0.06, 0.06)      # granulado
            i = sum(1 for c in cortes if v > c)
            px[x, y] = cores[min(i, len(cores) - 1)] + (255,)
    return img


# ---------------------------------------------------------------- bordas

def _perfil(semente, amplitude=2.2):
    """Ondulacao da divisa, em funcao de uma coordenada, fechando em 32.

    A mesma funcao e usada pela peca de cima e pela de baixo, entao as duas
    tem exatamente a mesma silhueta e encaixam.
    """
    rnd = random.Random(semente)
    fases = [(rnd.uniform(0, 2 * math.pi), rnd.uniform(0.5, 1.0)) for _ in range(3)]
    def f(t):
        v = 0.0
        for k, (fase, peso) in enumerate(fases, start=1):
            v += peso * math.sin(2 * math.pi * k * t / TAM + fase)
        return amplitude * v / sum(p for _, p in fases)
    return f


def mascaras(semente):
    """As 16 mascaras de borda, na mesma ordem dos lotes gerados por IA."""
    fh = _perfil(f"{semente}-h")     # ondulacao das divisas horizontais
    fv = _perfil(f"{semente}-v")     # ... e das verticais
    m = []

    def nova(teste):
        return [[teste(x, y) for x in range(TAM)] for y in range(TAM)]

    meio = TAM / 2
    m.append(nova(lambda x, y: y < meio + fh(x)))              # 0 metade de cima
    m.append(nova(lambda x, y: x > meio + fv(y)))              # 1 metade da direita
    m.append(nova(lambda x, y: y > meio + fh(x)))              # 2 metade de baixo
    m.append(nova(lambda x, y: x < meio + fv(y)))              # 3 metade da esquerda

    fr = _perfil(f"{semente}-r", 1.8)

    def canto(dx, dy):
        """Quarto de disco preso no canto, com o raio ondulando pelo angulo.

        Ondular pelo angulo (e nao por x+y, que oscila duas vezes ao atravessar
        o tile) mantem a curva continua e ainda organica.
        """
        cx = 0 if dx < 0 else TAM
        cy = 0 if dy < 0 else TAM
        def dentro(x, y):
            ex, ey = x + 0.5 - cx, y + 0.5 - cy
            ang = math.atan2(ey, ex)
            raio = meio + 2 + fr(ang * TAM / (2 * math.pi))
            return math.hypot(ex, ey) < raio
        return nova(dentro)

    m.append(canto(+1, -1))    # 4 canto superior direito
    m.append(canto(+1, +1))    # 5 inferior direito
    m.append(canto(-1, +1))    # 6 inferior esquerdo
    m.append(canto(-1, -1))    # 7 superior esquerdo
    for i in (4, 5, 6, 7):     # 8..11 cantos internos: o complemento
        m.append([[not v for v in linha] for linha in m[i]])

    faixa = 7
    m.append(nova(lambda x, y: abs(y - meio - fh(x)) < faixa))     # 12 faixa horizontal
    m.append(nova(lambda x, y: abs(x - meio - fv(y)) < faixa))     # 13 faixa vertical

    def mancha(x, y):                                              # 14 isolada
        ex, ey = x + 0.5 - meio, y + 0.5 - meio
        ang = math.atan2(ey, ex)
        return math.hypot(ex, ey) < 9 + fr(ang * TAM / (2 * math.pi))
    m.append(nova(mancha))
    m.append(m[0])                                                 # 15 igual a 0, com pedras
    return m


def _vizinho_fora(mask, x, y):
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        vx, vy = x + dx, y + dy
        if 0 <= vx < TAM and 0 <= vy < TAM and not mask[vy][vx]:
            return True
    return False


def bordas(material, semente=None):
    """As 16 pecas de sobreposicao do material, com alpha."""
    semente = semente or material
    base = tile(material, semente)
    escuro = _hex(PALETA[material][0])
    pedra = _hex(PALETA["rocha"][2])
    saida = []

    for i, mask in enumerate(mascaras(semente)):
        peca = Image.new("RGBA", (TAM, TAM), (0, 0, 0, 0))
        pb, bb = peca.load(), base.load()
        for y in range(TAM):
            for x in range(TAM):
                if not mask[y][x]:
                    continue
                # a fieira de pixels da divisa fica no tom mais escuro: e o que
                # faz a beirada parecer materia, e nao recorte de tesoura
                pb[x, y] = (escuro + (255,)) if _vizinho_fora(mask, x, y) else bb[x, y]
        if i == 15:
            rnd = random.Random(f"{semente}-pedras")
            for _ in range(6):
                x, y = rnd.randrange(TAM), rnd.randrange(TAM)
                if mask[y][x] and _vizinho_fora(mask, x, y):
                    pb[x, y] = pedra + (255,)
        saida.append(peca)
    return saida


# ---------------------------------------------------------------- saida

CHAOS = ["neve", "rocha", "rocha_clara", "chao_escuro", "madeira", "gelo"]
# So os materiais que NAO tem borda vinda dos lotes desenhados. Grama, terra e
# agua ja tem as suas em art_raw/tiles32 - gerar por cima apagaria as boas.
COM_BORDA = ["neve", "rocha"]


def previa(imgs, escala=6, colunas=8):
    cel = TAM * escala
    linhas = (len(imgs) + colunas - 1) // colunas
    p = Image.new("RGBA", (colunas * cel, linhas * cel), (40, 40, 46, 255))
    q = 12
    for y in range(0, p.height, q):        # xadrez para enxergar o alpha
        for x in range(0, p.width, q):
            if (x // q + y // q) % 2 == 0:
                p.paste((56, 56, 64, 255), (x, y, x + q, y + q))
    for n, im in enumerate(imgs):
        amp = im.resize((cel, cel), Image.NEAREST)
        p.paste(amp, ((n % colunas) * cel, (n // colunas) * cel), amp)
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--so", help="gera so este material")
    ap.add_argument("--previa", action="store_true")
    a = ap.parse_args()

    os.makedirs(SAIDA, exist_ok=True)
    feitos = []

    for mat in ([a.so] if a.so else CHAOS):
        if mat not in PALETA:
            raise SystemExit(f"material desconhecido: {mat}")
        img = tile(mat)
        img.save(f"{SAIDA}/{mat}.png")
        feitos.append(img)
        print(f"chao  {mat}.png")

    for mat in ([a.so] if a.so and a.so in COM_BORDA else COM_BORDA):
        if a.so and mat != a.so:
            continue
        pecas = bordas(mat)
        for i, p in enumerate(pecas):
            p.save(f"{SAIDA}/borda_{mat}_{i:02d}.png")
        print(f"borda {mat}: 16 pecas")
        if a.previa:
            previa(pecas).save(f"{SAIDA}/_previa_borda_{mat}.png")

    if a.previa and feitos:
        previa(feitos).save(f"{SAIDA}/_previa_chaos_novos.png")
        print(f"previas em {SAIDA}")


if __name__ == "__main__":
    main()
