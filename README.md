# ALDRUNA

MMORPG 2D top-down estilo Tibia — original, sem nada copiado da CipSoft (mecânicas sim, expressão não: nomes, sprites, mapas, magias e história são todos próprios).

> **Este README é a memória do projeto.** Se a sessão do Claude cair ou perder contexto, ler este arquivo inteiro antes de continuar. Manter sempre atualizado a cada passo concluído (regra: commit + push sempre que possível).

## Decisões fixas (NÃO rediscutir)

- **Engine/linguagem:** Lua com **LÖVE 11.5** (Love2D). NADA de Unreal, NADA de 3D. Claude escreve todo o código; Julio só testa.
- **Visual:** 2D com sprites, tiles de 32px, câmera travada no jogador (estilo Tibia). Arte gerada por IA no Google Flow pelo Julio.
- **Idioma:** TODO o conteúdo do jogo em inglês (UI, itens, magias, NPCs, lore). Conversa com Julio em português.
- **Online:** servidor autoritativo em Lua rodando na VPS do Julio (specs ainda não informadas). Cliente Windows.
- **Mundo em camadas verticais (z-levels) como no Tibia:** andares para cima (casas, torres) e para baixo (cavernas, dungeons) — pedido do Julio em 2026-07-30. O sistema de mapa definitivo deve nascer com eixo Z (sugestão: z=7 é o chão, 0-6 subsolo, 8-14 andares altos, como Tibia).
- **Estilo de arte cinematográfica** (título/retratos): `dark medieval fantasy, painterly, highly detailed, volumetric lighting`.
- **Classes:** Warrior, Ranger, Arcanist, Druid (equivalentes funcionais de Knight/Paladin/Sorcerer/Druid do Tibia, com nomes próprios).
- **Nome do jogo:** ALDRUNA (checagem de marca INPI ainda pendente).
- **Estrutura do mundo (2026-07-30):** a ilha atual (50x40) é o MAPA INICIAL — templo, inimigos fáceis em volta, escolha de vocação. Tamanho atual aprovado para esse papel. A PRIMEIRA CIDADE (e mapas seguintes) deve ser ENORME — o sistema de mapas definitivo precisa suportar mapas muito grandes (carregamento por chunks) + z-levels, e não pode assumir mapa pequeno em memória de tela única.

## Regras de trabalho com o Julio

- **UM passo / UM prompt por resposta.** Julio executa, responde "terminei" (ou reporta erro), e só então vem o próximo.
- Formato de prompt do Flow: `Prompt N — descrição de uma linha — prompt em inglês`. Sem tutorial de ferramenta, sem explicação longa.
- Respostas curtas; não gastar tokens com planos futuros não pedidos.

## Estado atual

- [x] Identidade visual aprovada: título ALDRUNA + retratos das 4 classes (geradas no Flow, estilo painterly).
- [x] **Passo 1 — cliente base:** janela LÖVE, mapa em grid 50x40 (grama/água/pedra), movimento tile a tile com deslize suave, tecla segurada repete passo, água bloqueia, câmera centrada. Testado e aprovado pelo Julio.
- [x] **Passo 2 — terreno com sprites reais:** grama, água e pedra (4 variações cada) no mapa via atlas 4x4 (1 variação por mapa — variações do Flow só emendam consigo mesmas; as outras ficam para outras regiões). Texturas pré-processadas para seamless de verdade pelo tool `tools/seamless` (offset+blend + nivelador de luz na água).
- [x] **Bordas orgânicas grama/água:** shader de máscara com ruído — grama avança sobre a água em toda costa, sem sprite extra.
- [x] Tela cheia (resolução nativa), oceano infinito fora do mapa (sem áreas pretas), água só ao redor da ilha.
- [x] Areia e lava: 4 variações cada processadas seamless, prontas em `client/assets/` (ainda NÃO usadas no mapa — main.lua só carrega grass/water/stone).
- [ ] **Fase atual — SPRITES DE TUDO antes de qualquer sistema novo.** Ordem restante: caverna (piso) → heróis (4 classes, 4 direções) → o resto.
  - IMPORTANTE: Julio NÃO salva arquivos manualmente — ele baixa do Flow para `Downloads/` e Claude localiza (nomes tipo `Grass_ground_texture_*.jpeg`), copia para `art_raw/` + `client/assets/`, roda o tool seamless e integra. Faltando: retrato do Warrior (não estava em Downloads; pedir re-download).
- [ ] Depois dos sprites: sistemas (a definir passo a passo). Natação básica: água hoje bloqueia; nadar virá depois.

## Pipeline de arte

1. Claude manda o prompt do Flow + nome do arquivo.
2. Julio gera e salva em `art_raw/<nome>.png`.
3. Claude processa (corte em tiles/frames 32x32, ajuste) e integra no cliente.

## Estrutura

```
Aldruna/
├── client/          # cliente LÖVE (main.lua, conf.lua; futuramente sprites em client/assets/)
├── art_raw/         # imagens brutas geradas no Flow (entrada do pipeline)
├── Jogar.bat        # duplo clique para rodar o jogo
└── README.md        # este arquivo — manter atualizado
```

## Como rodar

Duplo clique em `Jogar.bat`, ou:

```powershell
& "C:\Program Files\LOVE\love.exe" "C:\Users\julio\Aldruna\client"
```

LÖVE 11.5 instalado via `winget install Love2d.Love2d`.

## Repositório

`git@github.com:Julioamancio/Aldruna.git` — commit + push a cada passo concluído.
