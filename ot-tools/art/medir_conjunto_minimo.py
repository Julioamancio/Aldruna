"""Mede quantos sprites custa um cenario inicial minimo.

Os ~280 mil sprites da CipSoft sao inviaveis de recriar. Este script mede o custo
REAL por tipo de peca (chao, parede, arvore, boneco, criatura) para dimensionar o
lote de arte propria com numero, nao com chute.
"""
import sys

sys.path.insert(0, "/mnt/c/Users/julio/Aldruna/ot-tools/art")
from ler_appearances import carrega_appearances, carrega_modulo_protobuf, sprites_de

pb2 = carrega_modulo_protobuf()
dados = carrega_appearances(pb2)

objetos = {a.id: a for a in dados.object}
criaturas = {a.id: a for a in dados.outfit}

# Amostras representativas de cada tipo de peca (ids do datapack do Canary).
AMOSTRAS = [
    ("chao de grama", 4526),
    ("chao de areia", 231),
    ("agua (animada)", 4608),
    ("piso de pedra", 431),
    ("parede de pedra", 1049),
    ("escada", 1948),
    ("arvore", 2700),
    ("arbusto", 2767),
    ("porta de madeira", 5116),
    ("espada (item de mao)", 3280),
    ("pocao", 239),
    ("mochila", 2854),
]

print(f"{'peca':<26} {'sprites':>8}  observacao")
print("-" * 60)
total_cenario = 0
for nome, item_id in AMOSTRAS:
    a = objetos.get(item_id)
    if not a:
        print(f"{nome:<26} {'?':>8}  id {item_id} nao existe")
        continue
    ids = sprites_de(a)
    animado = " (animado)" if len(ids) > 1 else ""
    print(f"{nome:<26} {len(ids):>8}  id {item_id}{animado}")
    total_cenario += len(ids)

print("-" * 60)
print(f"{'soma das amostras':<26} {total_cenario:>8}")

# Bonecos: o custo pesado, porque tem 4 direcoes x quadros de animacao.
print("\n--- criaturas / boneco do jogador ---")
for nome, out_id in [("boneco humano (128)", 128), ("boneco humano (136)", 136), ("rato", 21), ("lobo", 26)]:
    a = criaturas.get(out_id)
    if not a:
        print(f"{nome:<26} nao encontrado")
        continue
    ids = sprites_de(a)
    grupos = len(a.frame_group)
    print(f"{nome:<26} {len(ids):>8} sprites em {grupos} grupo(s) de animacao")

# Quanto isso representa em folhas de 384x384 (144 sprites de 32x32 por folha).
print("\n--- conversao para folhas ---")
for n in (500, 1000, 2000):
    print(f"  {n} sprites 32x32 = {-(-n // 144)} folhas")
