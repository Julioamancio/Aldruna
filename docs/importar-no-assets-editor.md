# Importar a nossa arte no Assets Editor

Gerado por `ot-tools/art/guia_importacao.py`. Refaca depois de
mudar o DE_PARA do `trocar_chao.py`.

**Pasta dos assets do cliente:**
`ot/src1/otclient-4.1/data/things/1511`

**Backup de fabrica (127 MB, intacto):**
`ot/backup-assets-1511-intacto` - para voltar do zero, e so
copiar por cima da pasta acima.

**Nossos tiles prontos:** `art_raw/tiles32/<nome>.png` (32x32)

## Ordem sugerida

De cima para baixo: quanto mais casas o objeto cobre, mais o
jogo muda de cara ao trocar aquela peca.

| objeto | o que e | casas no mapa | sprites | nosso arquivo |
|---|---|---|---|---|
| 101 | terra avermelhada | 476505 | 185045 | `terra_seca.png`, `trilha_terra.png` |
| 1128 | piso de pedra | 334085 | 255764, 255765, 255766, 255767 (+12) | `laje_pedra.png`, `calcada.png` |
| 4515 | grama | 163790 | 189865, 189866, 189867, 189868 | `grama.png`, `grama_musgo.png` |
| 1019 | grama | 70004 | 187067, 187068, 187069, 187070 (+12) | `grama_musgo.png`, `grama.png` |
| 231 | areia | 32752 | 185336, 185337, 185338, 185339 (+12) | `areia.png` |
| 103 | terra batida | 25456 | 185047, 185048, 185049, 185050 (+8) | `trilha_terra.png`, `terra_seca.png` |
| 410 | pedra escura | 19850 | 185615, 185616, 185617, 185618 (+4) | `calcada.png` |
| 429 | laje de pedra | 14060 | 185665, 185666, 185667, 185668 (+4) | `laje_pedra.png` |
| 416 | calcamento | 7639 | 185628, 185629, 185630, 185631 | `calcada.png` |
| 4526 | ? | 2489 | 189879 | `grama.png` |
| 106 | grama | 1652 | 185081, 185082, 185083, 185084 (+12) | `grama.png` |
| 431 | ? | 299 | 185674 | `laje_pedra.png` |
| 109 | ? | 183 | 185096, 185097, 185098, 185099 | `grama_flores.png`, `grama.png` |
| 108 | ? | 162 | 185092, 185093, 185094, 185095 | `grama_flores.png` |
| 430 | ? | 5 | 185673 | `calcada.png` |
| 294 | grama puida | 2 | 185413, 185414, 185415, 185416 | `grama_terra.png` |

## Cuidados

- **Um escritor so.** A partir de agora o Assets Editor e quem
  mexe nos assets. Nao rodar mais `trocar_chao.py` nem
  `sprites_editaveis.py importar`: os dois reconstroem a folha a
  partir do `.original` e apagariam o trabalho feito no editor.
- **Agua e animada.** Cada objeto de agua tem 14 sprites, que sao
  quadros de animacao. Por o mesmo desenho nos 14 deixa o mar
  parado; ou se desenha os 14, ou nao se mexe na agua.
- **Borda antes de chao.** Trocar um chao sem trocar as pecas de
  borda dele deixa remendo em toda divisa de terreno. Foi o que
  estragou a agua na primeira tentativa.
- **Objeto novo precisa do servidor.** Criar item novo no editor
  so aparece direito se o Canary tambem conhecer o id
  (`items.xml` do data pack).
