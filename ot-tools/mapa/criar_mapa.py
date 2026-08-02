"""Cria um mapa .otbm do zero a partir de um desenho em texto.

Em vez de depender do mapa de exemplo do Canary (uma ilha de neve cheia de
coisa que nao e nossa), aqui o mundo e desenhado por nos: cada caractere do
desenho vira uma casa, com o chao e o que estiver em cima dela.

O formato foi lido de src/io/iomap.cpp do Canary 3.6.1:

    4 bytes 0x00
    0xFE (comeco de no) + 1 byte de tipo
    u32 versao(2), u16 largura, u16 altura, u32 itens_maior(3), u32 itens_menor
    no OTBM_MAP_DATA: atributos + areas de casas
    no OTBM_TOWNS (IRMAO do MAP_DATA, nao filho) + no OTBM_WAYPOINTS
    0xFF (fim de no)

Dentro do conteudo, os bytes 0xFD/0xFE/0xFF precisam ser precedidos de 0xFD,
senao viram marcador de no e o mapa nao abre.

    python criar_mapa.py                      # gera o mapa de teste padrao
    python criar_mapa.py --saida /tmp/x.otbm
"""
import argparse
import os
from collections import defaultdict

INICIO, FIM, ESCAPE = 0xFE, 0xFF, 0xFD
NO_ROOT, NO_MAP_DATA, NO_TILE_AREA, NO_TILE, NO_ITEM = 1, 2, 4, 5, 6
NO_TOWNS, NO_TOWN, NO_WAYPOINTS = 12, 13, 15
ATTR_DESCRICAO, ATTR_ITEM = 1, 9
ATTR_SPAWN_MONSTRO, ATTR_CASAS, ATTR_SPAWN_NPC = 11, 13, 23

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.normpath(os.path.join(AQUI, "..", ".."))
MUNDO = os.path.join(RAIZ, "ot", "src2", "canary-3.6.1", "data-canary", "world")

# Cada caractere do desenho -> (chao, [o que fica em cima]).
# Os ids de chao sao os que ja tem arte nossa dentro do cliente; os objetos
# ainda sao da CipSoft, e vao sendo trocados conforme a arte for saindo.
LEGENDA = {
    ".": (4515, []),      # grama
    ",": (1019, []),      # grama escura
    "t": (101, []),       # terra avermelhada
    "-": (103, []),       # trilha de terra
    "a": (231, []),       # areia
    "~": (4609, []),      # agua
    "#": (1128, []),      # piso de pedra
    "n": (799, []),       # neve
    "r": (351, []),       # rocha de caverna
    "m": (408, []),       # assoalho de madeira
    "T": (4515, [2700]),  # grama com arvore
    "P": (1128, [1616]),  # piso com coluna
    "W": (1128, [1025]),  # parede de pedra sobre piso
}


class Escritor:
    """Escreve o OTBM cuidando do escape - a parte que mais quebra o arquivo."""

    def __init__(self):
        self.b = bytearray()

    def marcador(self, v):
        self.b.append(v)                      # cru: e delimitador de no

    def dado(self, bs):
        for x in bs:
            if x in (INICIO, FIM, ESCAPE):
                self.b.append(ESCAPE)
            self.b.append(x)

    def u8(self, v):
        self.dado(bytes([v & 0xFF]))

    def u16(self, v):
        self.dado(int(v).to_bytes(2, "little"))

    def u32(self, v):
        self.dado(int(v).to_bytes(4, "little"))

    def texto(self, s):
        bs = s.encode("utf-8")
        self.u16(len(bs))
        self.dado(bs)

    def abre(self, tipo):
        self.marcador(INICIO)
        self.u8(tipo)

    def fecha(self):
        self.marcador(FIM)


def desenho_padrao():
    """Ilha de teste: praia, campo, trilha, praca, bosque, neve e caverna."""
    L, A = 60, 44
    g = [["~"] * L for _ in range(A)]

    for y in range(A):
        for x in range(L):
            # ilha oval; fora dela fica agua
            dx, dy = (x - L / 2) / (L / 2 - 3), (y - A / 2) / (A / 2 - 3)
            d = dx * dx + dy * dy
            if d > 1.0:
                continue
            g[y][x] = "a" if d > 0.82 else "."      # faixa de areia na beira

    for y in range(A):                               # trilha leste-oeste
        for x in range(L):
            if g[y][x] == "." and abs(y - A // 2) <= 1:
                g[y][x] = "-"
    for y in range(A):                               # trilha norte-sul
        for x in range(L):
            if g[y][x] in (".", "-") and abs(x - L // 2) <= 1:
                g[y][x] = "-"

    def bloco(x0, y0, x1, y1, ch):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if 0 <= x < L and 0 <= y < A and g[y][x] not in ("~", "a"):
                    g[y][x] = ch

    bloco(24, 17, 35, 25, "#")                       # praca central
    for x, y in ((25, 18), (34, 18), (25, 24), (34, 24)):
        g[y][x] = "P"                                # colunas nos cantos
    bloco(6, 6, 15, 12, ",")                         # bosque a noroeste
    for y in range(6, 13, 2):
        for x in range(6, 16, 2):
            if g[y][x] == ",":
                g[y][x] = "T"
    bloco(44, 5, 55, 13, "n")                        # campo de neve a nordeste
    bloco(8, 30, 18, 38, "r")                        # afloramento de rocha
    bloco(40, 30, 48, 36, "m")                       # deque de madeira

    return ["".join(linha) for linha in g]


def casas_do_desenho(desenho, x0, y0, z):
    """Converte o desenho em texto para o formato que o escritor usa."""
    casas = {}
    for dy, linha in enumerate(desenho):
        for dx, ch in enumerate(linha):
            if ch in LEGENDA:
                chao, em_cima = LEGENDA[ch]
                casas[(x0 + dx, y0 + dy, z)] = (chao, list(em_cima))
    return casas


def escreve_otbm(casas, largura=2048, altura=2048,
                 descricao="Destruitor", nome_arquivos="teste",
                 cidade="Vila do Destruitor", templo=None):
    """casas: {(x, y, z): (id_do_chao, [ids em cima])} -> bytes do .otbm.

    E a forma geral: o desenho em texto e o editor visual passam os dois pelo
    mesmo caminho, entao o formato so precisa estar certo em um lugar.
    """
    e = Escritor()
    e.dado(b"\x00\x00\x00\x00")
    e.abre(NO_ROOT)
    e.u32(2)
    e.u16(largura)
    e.u16(altura)
    e.u32(3)
    e.u32(62)

    e.abre(NO_MAP_DATA)
    e.u8(ATTR_DESCRICAO)
    e.texto(descricao)
    e.u8(ATTR_SPAWN_MONSTRO)
    e.texto(f"{nome_arquivos}-monster.xml")
    e.u8(ATTR_SPAWN_NPC)
    e.texto(f"{nome_arquivos}-npc.xml")
    e.u8(ATTR_CASAS)
    e.texto(f"{nome_arquivos}-house.xml")

    # agrupadas em areas de 256x256: o deslocamento dentro da area e 1 byte
    areas = defaultdict(list)
    for (x, y, z), conteudo in casas.items():
        areas[(x >> 8 << 8, y >> 8 << 8, z)].append((x, y, conteudo))

    for (ax, ay, az), lista in sorted(areas.items()):
        e.abre(NO_TILE_AREA)
        e.u16(ax)
        e.u16(ay)
        e.u8(az)
        for x, y, (chao, em_cima) in sorted(lista):
            e.abre(NO_TILE)
            e.u8(x - ax)
            e.u8(y - ay)
            if chao:
                e.u8(ATTR_ITEM)
                e.u16(chao)
            for item in em_cima:
                e.abre(NO_ITEM)
                e.u16(item)
                e.fecha()
            e.fecha()
        e.fecha()
    e.fecha()

    if templo is None:
        # o andar do templo tem que ser o que tem mais casas, nao o de uma casa
        # qualquer: um punhado de casas soltas noutro andar mandaria o jogador
        # nascer no vazio
        from collections import Counter
        andares = Counter(c[2] for c in casas)
        z_principal = andares.most_common(1)[0][0] if andares else 7
        no_andar = [c for c in casas if c[2] == z_principal] or [(1000, 1000, 7)]
        templo = (sum(c[0] for c in no_andar) // len(no_andar),
                  sum(c[1] for c in no_andar) // len(no_andar), z_principal)

    # TOWNS e IRMAO do MAP_DATA, nao filho: o Canary le depois de fechar aquele
    e.abre(NO_TOWNS)
    e.abre(NO_TOWN)
    e.u32(1)
    e.texto(cidade)
    e.u16(templo[0])
    e.u16(templo[1])
    e.u8(templo[2])
    e.fecha()
    e.fecha()

    e.abre(NO_WAYPOINTS)
    e.fecha()
    e.fecha()
    return bytes(e.b), len(casas), templo


def monta(desenho, x0, y0, z, largura=2048, altura=2048,
          descricao="Destruitor - mapa de teste", nome_arquivos="teste",
          cidade="Vila do Teste", templo=None):
    """Atalho: desenho em texto -> bytes do .otbm."""
    casas = casas_do_desenho(desenho, x0, y0, z)
    if templo is None:
        templo = (x0 + len(desenho[0]) // 2, y0 + len(desenho) // 2, z)
    return escreve_otbm(casas, largura, altura, descricao, nome_arquivos,
                        cidade, templo)


def companheiros(pasta, nome):
    """Os XML que o Canary abre junto com o mapa; vazios, mas tem que existir."""
    arquivos = {
        f"{nome}-house.xml": '<?xml version="1.0" encoding="UTF-8"?>\n<houses/>\n',
        f"{nome}-monster.xml": '<?xml version="1.0" encoding="UTF-8"?>\n'
                               '<monsters/>\n',
        f"{nome}-npc.xml": '<?xml version="1.0" encoding="UTF-8"?>\n<npcs/>\n',
        f"{nome}-zones.xml": '<?xml version="1.0" encoding="UTF-8"?>\n<zones/>\n',
    }
    for arq, conteudo in arquivos.items():
        with open(f"{pasta}/{arq}", "w", encoding="utf-8") as f:
            f.write(conteudo)
    return list(arquivos)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nome", default="teste")
    ap.add_argument("--pasta", default=MUNDO)
    ap.add_argument("--x", type=int, default=1000)
    ap.add_argument("--y", type=int, default=1000)
    ap.add_argument("--z", type=int, default=7)
    a = ap.parse_args()

    os.makedirs(a.pasta, exist_ok=True)
    desenho = desenho_padrao()
    dados, casas, templo = monta(desenho, a.x, a.y, a.z, nome_arquivos=a.nome)

    destino = f"{a.pasta}/{a.nome}.otbm"
    with open(destino, "wb") as f:
        f.write(dados)
    extras = companheiros(a.pasta, a.nome)

    print(f"{destino}  ({len(dados)} bytes, {casas} casas)")
    print("companheiros:", ", ".join(extras))
    print(f"templo da cidade em {templo}")
    print(f"\npara usar: mapName = \"{a.nome}\" no config.lua do servidor")


if __name__ == "__main__":
    main()
