"""Monta uma folha de contato com os sprites dos itens de chao, com o id embaixo.

Serve para escolher a dedo quais chaos da CipSoft a nossa arte vai substituir:
o appearances nao traz nome para a maioria dos chaos, entao a identificacao e
visual mesmo.

Rodar no WSL (precisa de protoc/protobuf):
    wsl -d Ubuntu-24.04 -u root -- python3 .../contato_chao.py saida.png [--ate 240]
"""
import argparse

from PIL import Image, ImageDraw

import folha_sprites as fs
from ler_appearances import carrega_appearances, carrega_modulo_protobuf, sprites_de

ESCALA = 2
LEGENDA = 11
COLUNAS = 16


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("saida")
    ap.add_argument("--ate", type=int, default=256, help="quantos itens mostrar")
    ap.add_argument("--pulando", type=int, default=0)
    ap.add_argument("--ids", help="faixas/ids especificos, ex: 4526-4541,4608-4625")
    a = ap.parse_args()

    dados = carrega_appearances(carrega_modulo_protobuf())
    chaos = [o for o in dados.object if o.flags.HasField("bank") and sprites_de(o)]
    print(f"itens de chao no total: {len(chaos)}")

    if a.ids:
        querem = set()
        for parte in a.ids.split(","):
            if "-" in parte:
                ini, fim = parte.split("-")
                querem.update(range(int(ini), int(fim) + 1))
            else:
                querem.add(int(parte))
        # aqui vale qualquer item, nao so chao: as vezes o que queremos trocar
        # esta marcado de outro jeito no appearances
        recorte = [o for o in dados.object if o.id in querem and sprites_de(o)]
    else:
        recorte = chaos[a.pulando:a.pulando + a.ate]

    cat = fs.catalogo()
    cache = {}

    def sprite(sid):
        entrada, indice = fs.acha_folha(sid, cat)
        if entrada["file"] not in cache:
            bmp, _ = fs.descomprime(f"{fs.ASSETS}/{entrada['file']}")
            cache[entrada["file"]] = fs.bmp_para_imagem(bmp)
        return cache[entrada["file"]].crop(fs.caixa(indice))

    cel = fs.TAM * ESCALA
    linhas = (len(recorte) + COLUNAS - 1) // COLUNAS
    folha = Image.new("RGBA", (COLUNAS * cel, linhas * (cel + LEGENDA)),
                      (30, 30, 34, 255))
    caneta = ImageDraw.Draw(folha)

    for n, obj in enumerate(recorte):
        x, y = (n % COLUNAS) * cel, (n // COLUNAS) * (cel + LEGENDA)
        try:
            img = sprite(sprites_de(obj)[0]).resize((cel, cel), Image.NEAREST)
            folha.paste(img, (x, y), img)
        except Exception as e:  # sprite fora do catalogo: deixa a celula vazia
            caneta.text((x + 2, y + 2), "?", fill=(200, 80, 80))
        caneta.text((x + 2, y + cel), str(obj.id), fill=(210, 210, 215))

    folha.save(a.saida)
    print(f"{len(recorte)} chaos (a partir do {a.pulando}) em {a.saida}")


if __name__ == "__main__":
    main()
