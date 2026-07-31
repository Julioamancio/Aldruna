# ALDRUNA

MMORPG 2D top-down estilo Tibia — original, sem nada copiado da CipSoft (mecânicas sim, expressão não: nomes, sprites, mapas, magias e história são todos próprios).

> **Este README é a memória do projeto.** Se a sessão do Claude cair ou perder contexto, ler este arquivo inteiro antes de continuar. Manter sempre atualizado a cada passo concluído (regra: commit + push sempre que possível).

## Decisões fixas (NÃO rediscutir)

- **Engine/linguagem:** Lua com **LÖVE 11.5** (Love2D). NADA de Unreal, NADA de 3D. Claude escreve todo o código; Julio só testa.
- **Visual:** 2D com sprites, tiles de 32px, câmera travada no jogador (estilo Tibia). Arte gerada por IA no Google Flow pelo Julio.
- **Idioma:** TODO o conteúdo do jogo em inglês (UI, itens, magias, NPCs, lore). Conversa com Julio em português.
- **Online:** servidor autoritativo em Lua rodando na VPS do Julio (specs ainda não informadas). Cliente Windows.
- **Estilo de arte cinematográfica** (título/retratos): `dark medieval fantasy, painterly, highly detailed, volumetric lighting`.
- **Classes:** Warrior, Ranger, Arcanist, Druid (equivalentes funcionais de Knight/Paladin/Sorcerer/Druid do Tibia, com nomes próprios).
- **Nome do jogo:** ALDRUNA (checagem de marca INPI ainda pendente).

## Regras de trabalho com o Julio

- **UM passo / UM prompt por resposta.** Julio executa, responde "terminei" (ou reporta erro), e só então vem o próximo.
- Formato de prompt do Flow: `Prompt N — descrição de uma linha — prompt em inglês`. Sem tutorial de ferramenta, sem explicação longa.
- Respostas curtas; não gastar tokens com planos futuros não pedidos.

## Estado atual

- [x] Identidade visual aprovada: título ALDRUNA + retratos das 4 classes (geradas no Flow, estilo painterly).
- [x] **Passo 1 — cliente base:** janela LÖVE, mapa em grid 50x40 (grama/água/pedra), movimento tile a tile com deslize suave, tecla segurada repete passo, água bloqueia, câmera centrada. Testado e aprovado pelo Julio.
- [ ] **Fase atual — SPRITES DE TUDO antes de qualquer sistema novo.** Ordem: terrenos (grama → água/mar → areia → lava → caverna → variações), depois heróis (4 classes, 4 direções), depois o resto.
  - Aguardando: `art_raw/grass.png` (Julio gera no Flow e salva; Claude corta em tiles 32x32 e integra).
- [ ] Depois dos sprites: sistemas (a definir passo a passo). Natação básica: água hoje bloqueia; nadar virá com sprite de mar.

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
