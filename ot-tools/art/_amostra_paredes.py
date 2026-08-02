"""Painel com as paredes mais usadas, ampliadas, para decidir a arte nova."""
import os

from PIL import Image

import folha_sprites as fs
from ler_appearances import carrega_appearances, carrega_modulo_protobuf, sprites_de

AQUI = os.path.dirname(os.path.abspath(__file__))
SAIDA = os.path.normpath(os.path.join(AQUI, "..", "..", "art_raw",
                                      "_amostra_paredes.png"))
ALVOS = [1082, 1081, 4458, 4457, 4459, 5637, 5631, 1451]


def main():
    dados = carrega_appearances(carrega_modulo_protobuf())
    porid = {o.id: o for o in dados.object}
    cat = fs.catalogo()

    partes = []
    for item in ALVOS:
        obj = porid.get(item)
        if obj is None:
            continue
        sid = sprites_de(obj)[0]
        entrada, indice = fs.acha_folha(sid, cat)
        im = fs.bmp_para_imagem(fs.descomprime(
            f"{fs.ASSETS}/{entrada['file']}")[0]).crop(
            fs.caixa(indice, entrada.get("spritetype", 0)))
        partes.append((item, im.resize((im.width * 2, im.height * 2),
                                       Image.NEAREST)))

    larg = sum(p.width + 12 for _, p in partes) + 12
    alt = max(p.height for _, p in partes) + 24
    painel = Image.new("RGBA", (larg, alt), (30, 30, 34, 255))
    x = 12
    for item, im in partes:
        painel.paste(im, (x, 12), im)
        x += im.width + 12
    painel.save(SAIDA)
    print("amostra em", SAIDA)


if __name__ == "__main__":
    main()
