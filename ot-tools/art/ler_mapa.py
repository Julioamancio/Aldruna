"""Le um mapa .otbm e responde onde fica cada tipo de chao.

Serve para navegar no mapa sem abrir editor: "onde tem grama?", "quantas casas
de neve existem?". O OTBM e uma arvore binaria de nos; aqui so descemos ate o
no de tile e lemos o item de chao.

Uso:
    python ler_mapa.py <mapa.otbm> --resumo
    python ler_mapa.py <mapa.otbm> --achar 106,4526 --perto 1950,1325,7
"""
import argparse
from collections import Counter, defaultdict

INICIO, FIM, ESCAPE = 0xFE, 0xFF, 0xFD

NO_MAP_DATA, NO_TILE_AREA, NO_TILE, NO_ITEM, NO_HOUSETILE = 2, 4, 5, 6, 14
ATTR_ITEM = 9


class Leitor:
    """Percorre o arquivo desfazendo o escape (0xFD) so quando le conteudo."""

    def __init__(self, dados, i=0):
        self.d = dados
        self.i = i

    def byte(self):
        b = self.d[self.i]
        self.i += 1
        if b == ESCAPE:
            b = self.d[self.i]
            self.i += 1
        return b

    def u16(self):
        return self.byte() | (self.byte() << 8)

    def u32(self):
        return self.byte() | (self.byte() << 8) | (self.byte() << 16) | (self.byte() << 24)

    def pula(self, n):
        for _ in range(n):
            self.byte()


def varre(caminho, alvo=None):
    dados = open(caminho, "rb").read()
    r = Leitor(dados, 4)            # os 4 primeiros bytes sao a versao

    contagem = Counter()
    achados = defaultdict(list)
    pilha = []
    base = (0, 0, 0)

    while r.i < len(dados):
        b = r.d[r.i]
        if b == INICIO:
            r.i += 1
            tipo = r.byte()
            pilha.append(tipo)

            if tipo == NO_TILE_AREA:
                base = (r.u16(), r.u16(), r.byte())
            elif tipo in (NO_TILE, NO_HOUSETILE):
                dx, dy = r.byte(), r.byte()
                x, y, z = base[0] + dx, base[1] + dy, base[2]
                if tipo == NO_HOUSETILE:
                    r.u32()          # id da casa
                chao = None
                while r.d[r.i] not in (INICIO, FIM):
                    attr = r.byte()
                    if attr == ATTR_ITEM:
                        chao = r.u16()
                    elif attr in (1, 6, 7):      # textos: tamanho + conteudo
                        r.pula(r.u16())
                    elif attr == 3:              # flags do tile
                        r.u32()
                    elif attr in (4, 5, 10, 11): # ids curtos
                        r.u16()
                    elif attr == 8:              # destino de teleporte
                        r.pula(5)
                    else:
                        break
                if chao is not None:
                    contagem[chao] += 1
                    if alvo and chao in alvo:
                        achados[chao].append((x, y, z))
            elif tipo == NO_ITEM:
                r.u16()
        elif b == FIM:
            r.i += 1
            if pilha:
                pilha.pop()
        else:
            r.i += 1

    return contagem, achados


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mapa")
    ap.add_argument("--resumo", action="store_true")
    ap.add_argument("--achar", help="ids de chao, ex: 106,4526")
    ap.add_argument("--perto", help="x,y,z de referencia para ordenar por distancia")
    a = ap.parse_args()

    alvo = {int(x) for x in a.achar.split(",")} if a.achar else None
    contagem, achados = varre(a.mapa, alvo)

    if a.resumo:
        print(f"tipos de chao distintos: {len(contagem)} | casas: {sum(contagem.values())}")
        print("mais comuns:")
        for item, n in contagem.most_common(25):
            print(f"  chao {item:>6}: {n:>7} casas")

    if alvo:
        ref = tuple(int(v) for v in a.perto.split(",")) if a.perto else None
        for item in sorted(alvo):
            pts = achados.get(item, [])
            print(f"\nchao {item}: {len(pts)} casas")
            if not pts:
                continue
            if ref:
                pts = sorted(pts, key=lambda p: (p[2] != ref[2],
                                                 abs(p[0] - ref[0]) + abs(p[1] - ref[1])))
                print("  mais perto de", ref, "->", pts[:5])
            else:
                print("  exemplos:", pts[:5])


if __name__ == "__main__":
    main()
