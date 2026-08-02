"""Refatia todos os packs com a receita de qualidade atual.

Guardar aqui a grade de cada folha evita ter que lembrar de cor quantas
colunas e quais linhas cada pack tinha.
"""
import os
import subprocess
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.normpath(os.path.join(AQUI, "..", ".."))
BRUTO = os.path.join(RAIZ, "art_raw")

PACKS = [
    ("pack_chaos.png", 8, "grama,grama_escura,grama_seca,terra,areia,pedra,neve,"
                          "agua_rasa,agua_funda,lava"),
    ("pack_interior.png", 8, "marmore_branco,marmore_preto,madeira_clara,"
                             "madeira_escura,parquete,ceramica,tapete,laje_polida"),
    ("pack_metal.png", 8, "metal_liso,metal_placa,metal_lava,metal_energia,"
                          "metal_ferrugem,metal_toxico,metal_oxidado,metal_industrial"),
    ("pack_templo.png", 8, "templo_branco,templo_azul,templo_verde,templo_dourado,"
                           "templo_rosa,templo_roxo,templo_turquesa,templo_bege"),
    ("pack_santuario.png", 8, "santuario_fogo,santuario_agua,santuario_natureza,"
                              "santuario_ar,santuario_gelo,santuario_luz,"
                              "santuario_sombra,santuario_arcano"),
    ("pack_castelo.png", 8, "castelo_pedra_clara,castelo_pedra_escura,"
                            "castelo_marmore_vermelho,castelo_marmore_verde,"
                            "castelo_creme,castelo_heraldica,castelo_madeira,"
                            "castelo_masmorra"),
    ("pack_cidade.png", 8, "cidade_laje_clara,cidade_paralelepipedo,"
                           "cidade_pedra_molhada,cidade_pedra_musgo,cidade_praca,"
                           "cidade_cascalho,cidade_calcada,cidade_ruina"),
    ("pack_caverna.png", 9, "caverna_pedra,caverna_terra,caverna_lava,"
                            "caverna_cristal,caverna_agua,caverna_cogumelo,"
                            "caverna_gelo,caverna_limo"),
    ("pack_caverna2.png", 9, "caverna2_pedra,caverna2_terra,caverna2_lava,"
                             "caverna2_cristal,caverna2_agua,caverna2_cogumelo,"
                             "caverna2_gelo,caverna2_limo"),
    ("pack_magico.png", 8, "magico_arcano,magico_fogo,magico_natureza,magico_sombra,"
                           "magico_portal,magico_estelar,magico_sagrado,"
                           "magico_demoniaco"),
    ("pack_runa.png", 8, "runa_azul,runa_vermelha,runa_verde,runa_roxa,runa_portal,"
                         "runa_dourada,runa_estelar,runa_demoniaca"),
    ("pack_deco.png", 8, "deco_folhas_outono,deco_folhas_verdes,deco_pedra_musgo,"
                         "deco_raizes,deco_flores,deco_cogumelos,deco_pantano,"
                         "deco_cristais"),
]

for arquivo, colunas, linhas in PACKS:
    caminho = os.path.join(BRUTO, arquivo)
    if not os.path.exists(caminho):
        print("faltando:", arquivo)
        continue
    subprocess.run([sys.executable, os.path.join(AQUI, "fatiar_folha.py"), caminho,
                    "--colunas", str(colunas), "--linhas", linhas],
                   check=True, capture_output=True)
    print("refeito:", arquivo)
