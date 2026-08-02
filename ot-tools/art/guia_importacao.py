"""Gera o guia de importacao: que arquivo nosso entra em que objeto do jogo.

E o elo que falta para trabalhar no Assets Editor: la voce busca o objeto pelo
id e manda importar um PNG. Sem esta tabela, nao da para saber qual dos nossos
tiles corresponde a qual objeto, nem quais valem o esforco.

A ordem e por quantas casas do mapa o objeto cobre - o topo da lista e o que
muda a cara do jogo mais rapido.

Rodar no WSL (le o appearances):
    wsl -d Ubuntu-24.04 -u root -- python3 .../guia_importacao.py
"""
import json
import os

import folha_sprites as fs
from ler_appearances import carrega_appearances, carrega_modulo_protobuf, sprites_de
from sprites_editaveis import PAPEL
from trocar_chao import DE_PARA

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.normpath(os.path.join(AQUI, "..", ".."))
DESTINO = os.path.join(RAIZ, "docs", "importar-no-assets-editor.md")
USO = os.path.join(AQUI, "_uso_no_mapa.json")


def main():
    uso = {}
    if os.path.exists(USO):
        uso = {int(k): v for k, v in json.load(open(USO)).items()}

    dados = carrega_appearances(carrega_modulo_protobuf())
    porid = {o.id: o for o in dados.object}
    cat = fs.catalogo()

    linhas = []
    for item, tiles in DE_PARA.items():
        obj = porid.get(item)
        if obj is None:
            continue
        sids = sprites_de(obj)
        folhas = set()
        for s in sids:
            try:
                folhas.add(fs.acha_folha(s, cat)[0]["file"][:16] + "...")
            except KeyError:
                pass
        linhas.append({
            "item": item,
            "papel": PAPEL.get(item, "?"),
            "casas": uso.get(item, 0),
            "tiles": tiles,
            "sprites": sids,
            "folhas": len(folhas),
        })
    linhas.sort(key=lambda l: -l["casas"])

    with open(DESTINO, "w", encoding="utf-8") as f:
        f.write("# Importar a nossa arte no Assets Editor\n\n")
        f.write("Gerado por `ot-tools/art/guia_importacao.py`. Refaca depois de\n"
                "mudar o DE_PARA do `trocar_chao.py`.\n\n")
        f.write("**Pasta dos assets do cliente:**\n"
                "`ot/src1/otclient-4.1/data/things/1511`\n\n")
        f.write("**Backup de fabrica (127 MB, intacto):**\n"
                "`ot/backup-assets-1511-intacto` - para voltar do zero, e so\n"
                "copiar por cima da pasta acima.\n\n")
        f.write("**Nossos tiles prontos:** `art_raw/tiles32/<nome>.png` (32x32)\n\n")
        f.write("## Ordem sugerida\n\n")
        f.write("De cima para baixo: quanto mais casas o objeto cobre, mais o\n"
                "jogo muda de cara ao trocar aquela peca.\n\n")
        f.write("| objeto | o que e | casas no mapa | sprites | nosso arquivo |\n")
        f.write("|---|---|---|---|---|\n")
        for l in linhas:
            arquivos = ", ".join(f"`{t}.png`" for t in l["tiles"])
            amostra = ", ".join(str(s) for s in l["sprites"][:4])
            if len(l["sprites"]) > 4:
                amostra += f" (+{len(l['sprites']) - 4})"
            f.write(f"| {l['item']} | {l['papel']} | "
                    f"{l['casas'] or '-'} | {amostra} | {arquivos} |\n")

        f.write("\n## Cuidados\n\n")
        f.write("- **Um escritor so.** A partir de agora o Assets Editor e quem\n"
                "  mexe nos assets. Nao rodar mais `trocar_chao.py` nem\n"
                "  `sprites_editaveis.py importar`: os dois reconstroem a folha a\n"
                "  partir do `.original` e apagariam o trabalho feito no editor.\n")
        f.write("- **Agua e animada.** Cada objeto de agua tem 14 sprites, que sao\n"
                "  quadros de animacao. Por o mesmo desenho nos 14 deixa o mar\n"
                "  parado; ou se desenha os 14, ou nao se mexe na agua.\n")
        f.write("- **Borda antes de chao.** Trocar um chao sem trocar as pecas de\n"
                "  borda dele deixa remendo em toda divisa de terreno. Foi o que\n"
                "  estragou a agua na primeira tentativa.\n")
        f.write("- **Objeto novo precisa do servidor.** Criar item novo no editor\n"
                "  so aparece direito se o Canary tambem conhecer o id\n"
                "  (`items.xml` do data pack).\n")

    print(f"guia com {len(linhas)} objetos em {DESTINO}")
    for l in linhas[:6]:
        print(f"  {l['item']:>5} {l['papel']:<20} {l['casas']:>7} casas")


if __name__ == "__main__":
    main()
