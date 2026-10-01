# Destruitor Idle

O Destruitor como **jogo idle no navegador, igual ao Huntera**: o servidor é um OT de verdade (Canary v3.6.1, a última release, protocolo 15.11) e o combate roda inteiro nele. O jogador usa só uma página web leve, no PC ou no celular, sem baixar cliente.

Decisões do Julio (30/09/2026): o idle **é** o Destruitor e usa o domínio `destruitor.com.br`; nada de cliente para baixar (o OTClient no navegador foi testado e **abandonado**: 137 MB, 1 GB de memória, interface de PC). Enquanto o jogo usa conteúdo da CipSoft, fica atrás de senha em `https://destruitor.com.br/jogar/`; a página principal ainda é o site antigo.

## Como funciona

```
página web  ──HTTP/WebSocket──▶  ponte (Node, gateway/)  ──MariaDB──▶  idle.lua (Canary)
                                       └── protocolo 15.11: um "cliente invisível" por personagem que caça
```

- **idle.lua** (`canary/scripts/idle/`, montado em `/canary/data-canary/scripts/idle` no container): cria uma **sala** por caçador (tiles gerados em x=40000, y=40000, longe do mapa), solta os **pulls** (Cauteloso 1–2, Ousado 2–4, Agressivo 4–6), fixa o **alvo** até ele morrer, e a cada segundo percorre a **barra de regras** do jogador — slots em ordem, até 8 condições cada (Você/Alvo/Área · HP/Mana/Magic shield/Alvos · < ≤ = ≥ > · valor ou %), cooldown por grupo (cura, ataque, suporte, item), o slot mais acima vence. Magias com as fórmulas oficiais do Canary; poções cobradas em gold do banco a cada uso (Lesser Health Potion grátis); loot vendido na hora pelo maior preço de NPC (`idle_prices.lua`, gerado das lojas do Canary; fica só na VPS). Para por morte, stamina, "Parar" ou **12 h sem ninguém olhando a página**.
- **Tabelas**: `idle_commands` (página → servidor: start/stop/reload), `idle_settings` (caçada, pull, alvo, distância, postura, barra, `seen`), `idle_state` (estado ao vivo em JSON a cada 2 s) e `idle_catalog` (caçadas, 60 ações e barras sugeridas, gravado no boot).
- **Ponte** (`gateway/`): contas e personagens (cadastro cria conta + personagem level 8), catálogo, WebSocket com o estado a cada 1 s, e o **cliente invisível** (`tibia.js`) que entra com o personagem e mantém a conexão viva enquanto ele caça. Um vigia a cada 5 s tira do jogo quem parou e reconecta quem ainda caça (ex.: depois de reiniciar a ponte).
- **Página** (`gateway/public/`): entrar/criar conta, personagens, e as abas Caçada (monstros com vida, alvo, log, loot, lista de caçadas), Barra (editor igual ao do Huntera, "Ordenar automaticamente", "Restaurar sugestão", "!" em magia acima do level), Analisador e Personagem. `?demo=1` abre com dados falsos para conferir a tela sem servidor.

## Estado (30/09/2026)

- [x] Servidor Canary v3.6.1 em `/opt/idle` (compose `idle`: `db`, `server`, `gateway`; tudo em 127.0.0.1).
- [x] Camada idle em Lua + ponte + página, testados de ponta a ponta com Knight, Sorcerer, Druid e Paladin (cadastro → caçar → abates, XP, loot no banco → parar → salvo no banco).
- [ ] O Julio ainda não testou pela página.
- [x] **749 monstros**: todos os que estão no Bestiário e não são chefes (o `main` do Canary tem os mesmos 1.655 da v3.6.1), mais 148 magias de monstro, gerados por `tools/gera.py`. Ficam de fora só 11 que dependem da quest Primal Ordeal (`RegisterPrimalPackBeast`).
- [x] **73 caçadas montadas** (a lista de caçadas do Huntera, com nomes próprios em `tools/nomes_cacadas.json`) e **Caçada livre** com 701 monstros (id `m:<nome>`), com busca e filtro por classe na página.
- [x] **Level indicado por vocação** calculado com os números reais dos monstros (ver "Calibragem").
- [x] **Loja de equipamentos** (161 itens, `tools/loja.py` → `idle_shop.lua`): escada por vocação e categoria (armas, varinhas/rods, escudos, capacete, armadura, calças, botas, munição), level exigido (o do item ou um derivado da força, ex.: Demon Armor → 81), preço de NPC ou proporcional ao level. Comprar equipa na hora e vende de volta o anterior pelo preço de NPC; arco/besta e armas de arremesso têm a munição reposta durante a caçada, paga em gold. Na página: equipamento atual, filtros (categoria, vocação, level, busca, ordenação) e comparação com o que está em uso. Testado no servidor (Sorcerer comprou Wand of Decay; Knight, Plate Armor).
- [x] **Imagens dos itens** (184, `tools/sprites.py` → `gateway/public/itens/<id>.png`), tiradas dos assets 15.11 (`appearances.dat` + folhas `sprites-*.bmp.lzma`). **São artes da CipSoft: só valem com o jogo fechado; trocar por arte própria antes de abrir ao público.** Rodar de novo o `sprites.py` sempre que a loja mudar.
- [x] Logo **DESTRUITOR IDLE** (`arte/logo_idle.py` troca o OTSERVER do logo do Julio por IDLE).
- [x] **Caçada andando pelo mapa real** (01/10): cada caçada montada é uma área de 31×23 em 3 andares recortada do `otservbr.otbm` (`tools/salas.py`) com os spawns reais. O personagem percorre a rota pelos grupos de spawn, ataca o que cruza o caminho, junta o pull, para para lutar, recua (paladino e mago) e troca de andar pelas escadas (escada de mão/corda viram "use"). O pull decide quanto da área acorda (Cauteloso 45%, Ousado 75%, Agressivo 100%), como no Huntera.
- [x] **Tela no formato do Huntera** (01/10): mapa em tela cheia (`view.js`), janelas flutuantes que fecham/minimizam/arrastam, dock com vida, mana, 20 slots, alvo, postura e distância; cidade de Thais recortada do mapa (`salas/cidade.json`), com o personagem andando até a chama mística (rua norte do templo) e voltando por ela ("Saindo em 5s"); escuro de caverna; tela de morte com quem matou, os últimos segundos e o replay do último minuto; "jogando agora" na barra de cima. Teste local: `?demo=1` (`&cacando=1`, `&morte=1`).
- [x] **Leilão entre jogadores** (01/10, branch `leilao`; ainda não publicado): botão "Leilão" na barra de baixo e na de cima. Anunciar um item da mochila por um preço em gold (1, 3 ou 7 dias; taxa de anúncio de 2%, mín. 20, que não volta; preço nunca abaixo do NPC; 10 ofertas, 25 no Premium), comprar tudo ou parte (a casa fica com 3%), cancelar, expirar, histórico, preço médio dos últimos negócios e valor no NPC. Só na cidade, como no Huntera. Quem mexe em mochila e gold é só o `idle_leilao.lua` (comandos `anunciar`/`comprar`/`cancelar` no `idle_commands`); o que o leilão deve a alguém (gold de venda, item de volta, item comprado) fica em `idle_auction_pending` e é entregue com o personagem no jogo e fora de caçada. Tabelas `idle_auction`, `idle_auction_history`, `idle_auction_pending`, `idle_auction_msg`. Bots: `leilao.anunciarBot()` na ponte ou `Idle.leilao.anunciarSistema()` no Lua. Testes: `node gateway/teste_leilao_local.js` (aqui) e `gateway/teste_leilao.js` (no container); `node tools/checa_lua.js` confere a sintaxe dos .lua sem luac.
- [ ] Ainda sem: postura aplicada no dano, runas, party, bestiário/prey, treino offline, despachar loot/venda rápida, blessings, vocação só no level 8 (como no Huntera), arte própria no lugar dos nomes do Tibia.

## Calibragem (tools/gera.py)

Level indicado por vocação, no pull Ousado = o menor level que passa nos três testes:
1. **Pior golpe**: os 2 monstros mais fortes batendo juntos (corpo a corpo × parte que a vocação leva + a magia mais forte; magia com chance abaixo de 10% pesa metade) cabem em 60% da vida efetiva.
2. **Luta longa**: com 3 monstros, o dano médio de 2 deles menos a cura por turno, somado no tempo de matar o pull, não passa de 70% da vida efetiva.
3. **Velocidade**: mata um monstro em até 30 s + 1 s a cada 125 de vida dele (sobreviver sem matar não serve).

Premissas (medidas no servidor em 30/09 com `gateway/valida.js`):
- Vida efetiva: Knight 15/lv; Paladin 10/lv + 20% da mana; magos 5/lv + metade da mana (Magic Shield sempre ligado a partir do 14 — é o padrão da barra sugerida).
- Parte do corpo a corpo que cada vocação leva: K 0,6, P 0,8, magos 0,9 (no idle o personagem fica parado e os monstros encostam; com 0,45 um Sorcerer lv31 morreu para Giant Spider).
- Skill por level: 30 + 22,7·ln(L/8) (30 no 8, ~72 no 50, ~92 no 120); magic level de mago: 8 + 30·ln(L/8). Personagem novo nasce com skill 30 (Knight/Paladin) ou ML 8 (magos) e o servidor treina skill ×4 e magic ×3 (`rateSkill`, `rateMagic`).
- Arma: ataque 25 no level 8 subindo até 50 (o que a loja de equipamentos vai vender — **ainda não existe**; até lá o Knight rende menos que a tabela).
- Dano por turno: arma = 35% de `Weapons::getMaxMeleeDamage` (erro, bloqueio e armadura) + magias de ataque liberadas pelo level; magos = varinha (13 + 0,3·L) + um strike por turno.
- Cura por turno: 150 (Lesser Health Potion, grátis) + K 1,5·L, P 2·L, magos 3·L.

Comparação com o Huntera (`Downloads\huntera-estudo\niveis_e_lucro_por_cacada.csv`), Knight/Paladin/magos: Covil dos Dragões 50/61/43 aqui × 35/40/40 lá; Dragões Lordes 87/109/76 × 65/75/85; Portão Infernal 228/225/157 × 130/145/175. O nosso é mais conservador de propósito ("para não morrer tentando").

## Armadilhas já pagas

- **Anti x-log do Canary**: jogador sem conexão perde o alvo a cada passo (`Player::sendPing`) e ganha 30 s de proteção quando um monstro o ataca. Por isso a ponte **mantém a conexão aberta** a caçada inteira.
- **Ping**: no Canary quem atualiza o "último pong" é o opcode **0x1E** do cliente (`playerReceivePing`); o 0x1D só pede um ping de volta. Com 0x1D o combate travava depois de 10 s.
- **Login**: `authType = "session"`; a ponte grava uma sessão de uso único em `account_sessions` (id = sha256 da chave) e apaga depois. O primeiro byte depois do cabeçalho é a quantidade de padding, depois 0x0A; o SO vai como 11 (OTClient Windows), o que liga o número de sequência nos pacotes.
- `kickIdlePlayerAfterMinutes = 30000` (o padrão de 15 min derrubaria quem caça); `forgeInfluencedLimit = 0` e `forgeFiendishLimit = 0` (a forja deixava monstros com 3,6× a vida).
- `players_online` do Canary não atualiza na hora; a ponte usa as próprias conexões.
- O `schema.sql` do Canary cria a conta GOD `@god`/`god`: apagada no banco do idle.
- Personagem só é gravado no banco ao sair: o `idle.lua` chama `player:save()` no fim da caçada.
- Trocar de alvo a cada segundo reinicia o ataque; o alvo fica fixo até morrer.

## Na VPS (aldruna-vps)

| Peça | Onde | Porta |
|---|---|---|
| Canary | `idle-server-1`, `/opt/idle/server` (+ `/opt/idle/idle-scripts` montado) | 127.0.0.1:7371/7372 |
| MariaDB 11.4 | `idle-db-1`, volume `idle_db-volume` | rede do compose |
| Ponte + página | `idle-gateway-1`, `/opt/idle/gateway` | 127.0.0.1:8184 |

nginx (`/etc/nginx/sites-available/destruitor-game`, backups em `/root/destruitor-game.nginx.bak-*`): `/jogar/` → ponte, **com senha** (usuário e senha em `/opt/idle/ACESSO.txt`); `/jogar/api/ws` fora da senha (exige o token do login).

## Publicar

Desta rede o SSH trava acima de ~20 KB, mas `tar -cz` pelo `ssh` passa bem:

```bash
tar -cz -C canary/scripts/idle idle.lua idle_events.lua idle_acessorios.lua | ssh aldruna-vps 'tar -xz -C /opt/idle/idle-scripts'
tar -cz -C gateway Dockerfile package.json server.js tibia.js acessorios.js public | ssh aldruna-vps 'tar -xz -C /opt/idle/gateway'
tar -cz -C canary/scripts/idle idle.lua idle_events.lua idle_leilao.lua | ssh aldruna-vps 'tar -xz -C /opt/idle/idle-scripts'
tar -cz -C gateway Dockerfile package.json server.js tibia.js leilao.js public | ssh aldruna-vps 'tar -xz -C /opt/idle/gateway'
tar -cz -C canary/scripts/idle idle.lua idle_events.lua | ssh aldruna-vps 'tar -xz -C /opt/idle/idle-scripts'
tar -cz -C gateway Dockerfile package.json server.js tibia.js editor.js public | ssh aldruna-vps 'tar -xz -C /opt/idle/gateway'
ssh aldruna-vps 'cd /opt/idle && docker compose up -d --build gateway && docker compose restart server'
```

Mudou só a página? Basta o `--build gateway` — e troque o `?v=` dos três arquivos no `public/index.html`, senão o navegador continua com a versão velha guardada. Refazer só a cidade (ou algumas salas): `ONLY=cidade python3 src/tools/salas.py && ONLY=cidade python3 src/tools/sprites_mapa.py` (sem o `ONLY`, o `salas.py` regrava todas as salas e o `sprites_mapa.py` precisa rodar inteiro depois). Mudou o Lua? `restart server` (os caçadores saem; a ponte reconecta quem ainda estava caçando só se o estado continuar sendo escrito — depois de reiniciar o servidor, é preciso mandar caçar de novo).

Teste de ponta a ponta (cria conta de teste, caça, para e apaga): copiar `gateway/teste_idle.js` para o container e rodar `docker compose exec -T -e VOC=sorcerer -e HUNT=trolls gateway node teste_idle.js`.

## Editor da cidade (`/jogar/editor/`)

Editor de mapa no navegador, igual ao Remere's: desenha Thais com o mesmo atlas e a mesma ordem do jogo (conferido pixel a pixel contra o `view.js`), paleta com busca e categorias (chão, bordas, paredes, decoração, plantas e natureza, luzes, móveis, outros), pincel, borracha, conta-gotas, trocar chão numa área, selecionar área e apagar, zona protegida, pilha do tile (subir/descer/apagar), desfazer/refazer, andares −2 a +2.

- **Acesso**: só com o código do editor (`EDITOR_CODE` no `.env`; o Julio lê em `/opt/idle/CODIGO_EDITOR.txt`), tela no visual do "Teste fechado" (`public/editor_acesso.html`). O cookie `dt_editor` (HMAC do código) vale para `/jogar/editor` e `/jogar/api/editor`; sem ele nem a página nem a API respondem. Fica fora do `ACCESS_CODE`.
- **Publicar na cidade**: a ponte (`gateway/editor.js`) grava `/opt/idle/editor/cidade_edicoes.json` (só o que difere da base: tiles finais e flags) e `publicar.pedido`. O vigia `tools/publicar_cidade.py` (systemd: `vps/editor/idle-cidade-publicar.path` + `.timer`) roda `decorar.py` e `sprites_mapa.py` numa pasta de preparo, guarda a cidade anterior em `/opt/idle/editor/backup/` e troca `cidade.json/png` (a pasta `salas` é montada no container: vale sem rebuild) e `cidade.otbm`/`idle_city.lua`. Depois reinicia `server` e `gateway`: na hora se ninguém está jogando, senão espera (ou o Julio clica "Reiniciar o servidor agora"). A página mostra o andamento (`publicar.status.json`).
- **Paleta**: `tools/sprites_paleta.py` (na VPS) gera `salas/paleta.png` (+ `paleta_N.png`) e `paleta.json` com ~22 mil itens de cidade e os nomes do `items.xml`. Sem ela o editor usa só os itens que já estão na cidade.
- **Teste local**: `node gateway/teste_editor.js` (modelo + rotas, sem banco). `decorar.py`, `sprites_mapa.py`, `sprites_paleta.py` e `publicar_cidade.py` aceitam os caminhos por variável de ambiente (ver o topo de cada um).

## Arquivos daqui

- `canary/scripts/idle/idle.lua`, `idle_events.lua` — a camada idle; `idle_hunts.lua` — gerado por `tools/gera.py` (não editar).
- **AUTO de colar e anel** (Inventário, como no Huntera): `idle_acessorios.lua` (troca a peça no slot a cada segundo de caçada; GlobalEvent próprio), `gateway/acessorios.js` (coluna `idle_settings.acc`, mensagem `{t:'acessorios', cfg}`), `gateway/public/acessorios.js` + `acessorios.css` (botões AUTO e a janela "Seus colares"/"Seus anéis"). Catálogo das peças: `python3 /opt/idle/src/tools/acessorios.py` grava `gateway/public/itens/acessorios.json` (rodar antes do `sprites.py`, que tira os ícones delas).
- `tools/gera.py` (+ `nomes_cacadas.json`, `hunts_huntera.txt`) — copia os monstros e gera as caçadas. Roda na VPS em `/opt/idle/src/tools`; depois `docker compose build server`.
- `gateway/` — ponte (`server.js`, `tibia.js`), página (`public/`), testes (`teste_idle.js`, `valida.js`).
- `vps/docker-compose.yml` — cópia do compose da VPS; `vps/passo1.sh` — como o `/opt/idle` nasceu (ainda cria os serviços `login` e `wsbridge`, que foram removidos).
