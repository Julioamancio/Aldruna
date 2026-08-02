"""Le e grava as folhas de sprite do cliente (formato CIP .bmp.lzma).

Uma folha e um BMP 384x384 (12x12 sprites de 32x32) comprimido em LZMA1 cru,
embrulhado num cabecalho proprio da CipSoft. O formato foi lido de
src/client/spriteappearances.cpp do OTClient:

    [0x00, X)      bytes 0x00 de enchimento
    [X, X+5)       marca fixa 70 0A FA 80 24
    [X+5, 0x20)    tamanho do resto, em inteiro de 7 bits (cabecalho tem 32 bytes)
    depois:        1 byte lclppb, 4 bytes dict_size, 8 bytes ignorados, LZMA1 cru
    ao descomprimir: um BMP; os pixels sao BGRA, de baixo para cima, e
    #FF00FF significa transparente.

Uso:
    python folha_sprites.py ler <sprite_id> saida.png
    python folha_sprites.py trocar <sprite_id> novo_tile.png
"""
import argparse
import hashlib
import json
import lzma
import os
import shutil
import struct
import sys

from PIL import Image

AQUI = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.normpath(os.path.join(
    AQUI, "..", "..", "ot", "src1", "otclient-4.1", "data", "things", "1511"))

LADO = 384          # a folha e sempre 384x384
TAM = 32            # cada sprite
POR_LINHA = LADO // TAM
POR_FOLHA = POR_LINHA * POR_LINHA   # 144
MARCA = bytes([0x70, 0x0A, 0xFA, 0x80, 0x24])
MAGENTA = (255, 0, 255)


def catalogo(pasta=ASSETS):
    with open(f"{pasta}/catalog-content.json", encoding="utf-8") as f:
        return json.load(f)


def acha_folha(sprite_id, cat=None):
    """Devolve (entrada do catalogo, indice do sprite dentro da folha)."""
    for e in (cat or catalogo()):
        if e.get("type") != "sprite":
            continue
        if e["firstspriteid"] <= sprite_id <= e["lastspriteid"]:
            return e, sprite_id - e["firstspriteid"]
    raise KeyError(f"sprite {sprite_id} nao esta em nenhuma folha do catalogo")


def _le_7bits(dados, i):
    valor = shift = 0
    while True:
        b = dados[i]
        i += 1
        valor |= (b & 0x7F) << shift
        shift += 7
        if not b & 0x80:
            return valor, i


def descomprime(caminho):
    """.bmp.lzma -> bytes do BMP."""
    dados = open(caminho, "rb").read()
    i = dados.index(MARCA) + len(MARCA)
    _, i = _le_7bits(dados, i)
    i = 32  # o cabecalho da CIP tem tamanho fixo, o resto era enchimento

    lclppb = dados[i]
    dic = struct.unpack("<I", dados[i + 1:i + 5])[0]
    corpo = dados[i + 13:]        # pula tambem os 8 bytes de tamanho

    filtro = [{"id": lzma.FILTER_LZMA1, "lc": lclppb % 9,
               "lp": (lclppb // 9) % 5, "pb": (lclppb // 9) // 5,
               "dict_size": dic}]
    d = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=filtro)
    return d.decompress(corpo), (lclppb, dic)


def comprime(bmp, props):
    """bytes do BMP -> .bmp.lzma no formato que o cliente espera."""
    lclppb, dic = props
    filtro = [{"id": lzma.FILTER_LZMA1, "lc": lclppb % 9,
               "lp": (lclppb // 9) % 5, "pb": (lclppb // 9) // 5,
               "dict_size": dic}]
    # FORMAT_ALONE em modo fluxo: escreve 1+4+8 bytes de cabecalho (exatamente o
    # que o cliente le e pula) e, por nao saber o tamanho de antemao, fecha o
    # fluxo com marca de fim - que e o que o decodificador cru exige.
    c = lzma.LZMACompressor(format=lzma.FORMAT_ALONE, filters=filtro)
    miolo = c.compress(bmp) + c.flush()

    tam = len(miolo)
    sete = bytearray()
    while True:
        b = tam & 0x7F
        tam >>= 7
        sete.append(b | (0x80 if tam else 0))
        if not tam:
            break
    cab = bytearray(32)
    ini = 32 - len(MARCA) - len(sete)
    cab[ini:ini + len(MARCA)] = MARCA
    cab[ini + len(MARCA):32] = sete
    return bytes(cab) + miolo


def bmp_para_imagem(bmp):
    """Extrai a folha 384x384 RGBA do BMP (BGRA, de baixo para cima, magenta=vazio)."""
    off = struct.unpack("<I", bmp[10:14])[0]
    px = bmp[off:off + LADO * LADO * 4]
    img = Image.frombytes("RGBA", (LADO, LADO), px, "raw", "BGRA", 0, -1)
    dados = [(0, 0, 0, 0) if (r, g, b) == MAGENTA else (r, g, b, a)
             for r, g, b, a in img.getdata()]
    img.putdata(dados)
    return img


def imagem_para_bmp(img, bmp_original):
    """Reescreve os pixels do BMP mantendo o cabecalho original intacto."""
    off = struct.unpack("<I", bmp_original[10:14])[0]
    dados = [(*MAGENTA, 255) if a == 0 else (r, g, b, 255)
             for r, g, b, a in img.convert("RGBA").getdata()]
    plano = Image.new("RGBA", (LADO, LADO))
    plano.putdata(dados)
    px = plano.tobytes("raw", "BGRA", 0, -1)
    return bmp_original[:off] + px + bmp_original[off + len(px):]


def caixa(indice):
    x, y = (indice % POR_LINHA) * TAM, (indice // POR_LINHA) * TAM
    return (x, y, x + TAM, y + TAM)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("acao", choices=["ler", "trocar", "folha"])
    ap.add_argument("sprite_id", type=int)
    ap.add_argument("arquivo")
    a = ap.parse_args()

    entrada, indice = acha_folha(a.sprite_id)
    caminho = f"{ASSETS}/{entrada['file']}"
    bmp, props = descomprime(caminho)
    folha = bmp_para_imagem(bmp)
    print(f"sprite {a.sprite_id}: folha {entrada['file'][:24]}... "
          f"posicao {indice} (tipo {entrada['spritetype']})")

    if a.acao == "folha":
        folha.save(a.arquivo)
        print("folha inteira salva em", a.arquivo)
    elif a.acao == "ler":
        folha.crop(caixa(indice)).save(a.arquivo)
        print("sprite salvo em", a.arquivo)
    else:
        novo = Image.open(a.arquivo).convert("RGBA")
        if novo.size != (TAM, TAM):
            sys.exit(f"o tile precisa ser {TAM}x{TAM}, veio {novo.size}")
        # backup so na primeira troca: a segunda guardaria a folha ja alterada
        if not os.path.exists(caminho + ".original"):
            shutil.copy2(caminho, caminho + ".original")
        folha.paste(novo, caixa(indice)[:2])
        open(caminho, "wb").write(comprime(imagem_para_bmp(folha, bmp), props))
        print(f"sprite {a.sprite_id} trocado em {entrada['file'][:24]}...")
        print("sha256 do arquivo:", hashlib.sha256(
            open(caminho, "rb").read()).hexdigest()[:16])


if __name__ == "__main__":
    main()
