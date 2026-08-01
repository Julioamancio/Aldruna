# ALDRUNA

MMORPG 2D top-down estilo Tibia — original, sem nada copiado da CipSoft (mecânicas sim, expressão não: nomes, sprites, mapas, magias e história são todos próprios).

> **Este README é a memória do projeto.** Se a sessão do Claude cair ou perder contexto, ler este arquivo inteiro antes de continuar. Manter sempre atualizado a cada passo concluído (regra: commit + push sempre que possível).

## Decisões fixas (NÃO rediscutir)

- **PIVÔ DE STACK (2026-08-01, decisão do Julio):** Julio quer o jogo "exatamente igual ao Tibia, menos o nome e o que for ilegal". O cliente LÖVE feito à mão foi ABANDONADO (fica em `client/` como histórico). Nova stack: **servidor Canary 3.6.1 + cliente OTClient Redemption 4.1 + Remere's Map Editor**, tudo em `ot/` (fora do git — ver .gitignore). Customização via Lua/datapack, não engine própria.
  - Servidor roda de `ot/src2/canary-3.6.1/` (canary.exe + config.lua; banco MariaDB em `ot/db/`, root/aldruna123, database `canary`).
  - Cliente roda de `ot/src1/otclient-4.1/` (otclient.exe; assets protocolo 15.11 em `data/things/1511/`; servidor local pré-cadastrado no `init.lua` como `127.0.0.1`).
  - `ot/Testar.bat` sobe banco + servidor e abre o cliente. Conta de teste local: **god / god**.
  - Para teste privado local usa os assets/datapack padrão; TUDO que é da CipSoft (sprites, mapa, nomes) será trocado por arte/conteúdo próprio ANTES de abrir o servidor para outras pessoas.
- **Engine/linguagem (histórico):** cliente LÖVE 11.5 em `client/` — substituído pelo pivô acima. NADA de Unreal, NADA de 3D. Claude escreve todo o código; Julio só testa.
- **Visual:** 2D com sprites, tiles de 32px, câmera travada no jogador (estilo Tibia). Arte gerada por IA no Google Flow pelo Julio.
- **Idioma:** TODO o conteúdo do jogo em inglês (UI, itens, magias, NPCs, lore). Conversa com Julio em português.
- **Online:** servidor autoritativo em Lua rodando na VPS do Julio (specs ainda não informadas). Cliente Windows.
- **Mundo em camadas verticais (z-levels) como no Tibia:** andares para cima (casas, torres) e para baixo (cavernas, dungeons) — pedido do Julio em 2026-07-30. O sistema de mapa definitivo deve nascer com eixo Z (sugestão: z=7 é o chão, 0-6 subsolo, 8-14 andares altos, como Tibia).
- **Estilo de arte cinematográfica** (título/retratos): `dark medieval fantasy, painterly, highly detailed, volumetric lighting`.
- **Estilo dos sprites de personagem (aprovado 2026-07-30):** cartoon estilizado "chibi-heroico" pintado à mão (proporções ~3 cabeças, traço limpo, cores vivas) — NÃO realista. Pipeline: tiras horizontais de 4 frames por direção no Flow, com imagem de referência (ingrediente) para manter o mesmo personagem entre as tiras; fundo verde chroma; exigir armas visíveis em TODOS os frames.
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
- [x] Terrenos básicos COMPLETOS em `client/assets/` (4 variações seamless cada): grama, água, areia, pedra, lava, caverna, neve. No mapa só grass/water/stone por enquanto.
- [x] **Pivô OpenTibia (2026-08-01):** Canary 3.6.1 + OTClient Redemption 4.1 baixados e montados em `ot/`. MariaDB inicializado, schema carregado (conta god/god + personagens sample), config.lua apontando para o banco, servidor sobe e fica online nas portas 7171/7172, assets 15.11 copiados para o cliente, servidor local pré-cadastrado no init.lua, `ot/Testar.bat` criado.
- [ ] **Fase atual:** Julio testa login local (Testar.bat → god/god → entrar com um personagem sample e andar pelo mundo).
- [ ] Depois: (1) mapa próprio no Remere's, (2) datapack Aldruna (vocações/magias/nomes próprios em inglês), (3) deploy na VPS do Julio, (4) troca dos assets CipSoft por arte própria ANTES de abrir ao público.
- IMPORTANTE (pipeline de arte, continua valendo): Julio NÃO salva arquivos manualmente — ele baixa do Flow para `Downloads/` e Claude localiza, copia e integra.

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
