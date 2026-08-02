"""Mostra a forma de cada item do DE_PARA: e chao simples de 1x1 ou nao?

Um item pode usar varios sprites por tres motivos bem diferentes:
  - padrao (pattern): variacoes que o cliente sorteia por posicao no mapa;
  - animacao (phases): quadros que se alternam no tempo;
  - tamanho (width/height): o desenho ocupa MAIS DE UMA casa e cada sprite e um
    pedaco dele.

Trocar tudo por um tile 32x32 so vale no primeiro caso. No terceiro, cada
pedaco do objeto vira um chao inteiro e o resultado e desenho fora do lugar,
por cima de casa e parede. Este script separa os tres.

    wsl -d Ubuntu-24.04 -u root -- python3 .../inspecionar_itens.py
"""
from ler_appearances import carrega_appearances, carrega_modulo_protobuf
from sprites_editaveis import PAPEL
from trocar_chao import DE_PARA


def main():
    dados = carrega_appearances(carrega_modulo_protobuf())
    porid = {o.id: o for o in dados.object}

    seguros, suspeitos = [], []
    print(f"{'item':>6} {'o que e':<20} {'sprites':>7} {'tam':>7} {'padrao':>10} "
          f"{'fases':>6}  veredito")
    for item in sorted(DE_PARA):
        obj = porid.get(item)
        if obj is None:
            continue
        for g in obj.frame_group:
            si = g.sprite_info
            larg = getattr(si, "bounding_square", 0)
            w = si.pattern_width or 1
            h = si.pattern_height or 1
            d = si.pattern_depth or 1
            fases = len(si.animation.sprite_phase) if si.HasField("animation") else 1
            camadas = si.layers or 1
            n = len(si.sprite_id)
            # se largura*altura*profundidade*camadas*fases explica todos os
            # sprites, cada um e uma variacao de uma casa so - pode trocar.
            esperado = w * h * d * camadas * fases
            multi = n > esperado
            veredito = "MULTI-CASA" if multi else "chao 1x1"
            (suspeitos if multi else seguros).append(item)
            print(f"{item:>6} {PAPEL.get(item, '?'):<20} {n:>7} "
                  f"{larg or '-':>7} {f'{w}x{h}x{d}':>10} {fases:>6}  {veredito}")

    print(f"\nseguros: {len(seguros)} | suspeitos de ocupar mais de uma casa: "
          f"{len(suspeitos)}")
    if suspeitos:
        print("tirar do DE_PARA:", suspeitos)


if __name__ == "__main__":
    main()
