# Destruitor Idle

O Destruitor em modo **idle, como o Huntera**: servidor OT de verdade (Canary v3.6.1, a última release, protocolo 15.11) com o combate automático feito no servidor, jogado **no navegador** pelo OTClient 4.1 (build WebAssembly). O Destruitor "normal" (`/opt/aldruna`, cliente desktop) continua como estava; este mora em `/opt/idle` na mesma VPS (aldruna-vps, 187.77.36.21).

Decisão do Julio (30/09/2026): o idle **é** o Destruitor e usa o domínio `destruitor.com.br`. Enquanto a camada idle não fica pronta, o cliente fica em `https://destruitor.com.br/jogar/` (com senha) e a página principal continua com o site antigo.

## Estado (30/09/2026)

- [x] **Passo 1 — servidor:** Canary v3.6.1 oficial (binário `canary-linux-release.zip` + datapack `data-canary` da tag), MariaDB, login HTTP e ponte WebSocket em Docker Compose (`/opt/idle`, projeto `idle`). `worldType = no-pvp`, `freePremium = true`, `serverName = "Destruitor Idle"` (tem que ser igual ao `WORLD_NAME` do `.env`). Log confere: "Server protocol: 15.11".
- [x] **Passo 2 — cliente no navegador:** `repack_client.py` pega o `otclient-browser.zip` da release 4.1 e gera `/opt/idle/web` com os assets 15.11 dentro do pacote (137 MB, fica em cache no navegador), `init.lua` apontando para `https://destruitor.com.br/jogar/login.php` e todo socket indo para `wss://destruitor.com.br/jogar/ws`.
- [x] **Cadastro:** `https://destruitor.com.br/jogar/cadastro.html` cria conta + personagem level 8 da vocação escolhida (`patch_cadastro.py` no login server). Testado de ponta a ponta na VPS (cadastro → login → lista de personagens).
- [ ] **Passo 3 — camada idle (Lua no datapack):** salas de caça instanciadas geradas por `Game.createTile`, pulls por `Game.createMonster`, alvo automático com `player:setTarget`, barra de regras (poção se vida ≤ X, área se ≥ N monstros...), magias via `Combat` (o Canary não tem "lançar magia pelo nome" no Lua), suprimentos cobrados em gold por uso, analisador (XP/h, lucro/h), caça offline de até 12 h calculada no login.
- [ ] **Passo 4 — painel idle no cliente:** módulo OTClient (escolher caçada, editar regras, analisador) falando com o servidor por ExtendedOpcode (JSON).
- [ ] Monstros do `data-otservbr-global`: copiar para o `data-canary` derrubou o servidor (segfault; eles chamam funções que só existem nos scripts do global, ex.: `RegisterPrimalPackBeast`). Trazer só os monstros das caçadas escolhidas, com as funções que eles usam.

## Como está montado na VPS

| Peça | Onde | Porta |
|---|---|---|
| Canary | container `idle-server-1` | 127.0.0.1:7371 (login TCP), 127.0.0.1:7372 (jogo) |
| MariaDB 11.4 | `idle-db-1`, volume `idle_db-volume` | só na rede do compose |
| Login HTTP + cadastro | `idle-login-1` (`login_server.py` do Destruitor + cadastro) | 127.0.0.1:8182 |
| Ponte WebSocket → TCP | `idle-wsbridge-1` (websockify → `server:7172`) | 127.0.0.1:7380 |
| Cliente web | `/opt/idle/web` | nginx |

nginx (`/etc/nginx/sites-available/destruitor-game`, backup em `/root/destruitor-game.nginx.bak-*`):
- `/jogar/` → `/opt/idle/web`, **com senha** (`/etc/nginx/destruitor-jogar.htpasswd`, usuário e senha em `/opt/idle/ACESSO.txt` na VPS). Cabeçalhos COOP/COEP obrigatórios (o cliente usa threads/SharedArrayBuffer) e `types` com `application/wasm`.
- `/jogar/cadastrar` → cadastro, **com senha**.
- `/jogar/login.php` e `/jogar/ws` → abertos (exigem conta válida).

Nenhuma porta do idle fica aberta na internet: tudo escuta em 127.0.0.1 e passa pelo nginx.

## Armadilhas já pagas

- O `schema.sql` do Canary cria a conta **GOD `@god` / `god`** e 7 personagens de exemplo. No idle foram apagados logo depois de subir o banco. Qualquer banco novo do Canary precisa disso antes de abrir o login.
- O `client-11.zip` da release `15.11.c9d1cf` do `dudantas/tibia-client` **não** é o que o OTClient 15.11 usa (é um cliente antigo com `Tibia.spr`). Os assets certos são a pasta `assets/` da árvore da tag (baixar arquivo por arquivo pelo raw).
- O `otclient.js` minificado escreve offsets como `395e3` — o reempacotador converte com `int(float(x))`.
- Dentro do navegador o socket era `ws://<ip do mundo>:<porta>/`, bloqueado numa página HTTPS; o reempacotador troca por `wss://<host da página>/jogar/ws` (vale também dentro das threads, que usam `location` do worker).
- O download automático de assets do cliente (`clientAssets`, via API do GitHub) não funciona no navegador (CORS + COEP) — desligado no `init.lua`, os assets vão no pacote.
- Deste PC o `api.github.com` não conecta; tudo que vem do GitHub é baixado direto pela VPS.

## Arquivos daqui

- `vps/passo1.sh` — monta `/opt/idle` do zero (servidor, login, ponte, `.env`, compose) e sobe.
- `vps/repack_client.py` — gera `/opt/idle/web` a partir da release do OTClient + assets.
- `vps/patch_cadastro.py` — acrescenta o cadastro ao `login_server.py`.
- `vps/cadastro.html` — página de cadastro (vai para `/opt/idle/cadastro.html`; o reempacotador copia para o `web/`).

Mandar arquivo para a VPS desta rede: SSH trava acima de ~20 KB, mas `tr -d '\r' < arquivo | ssh aldruna-vps 'cat > destino'` funciona para scripts pequenos. Arquivos grandes: baixar direto na VPS.
