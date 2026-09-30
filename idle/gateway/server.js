'use strict';
/*
 * Destruitor Idle — ponte entre a pagina web e o Canary.
 *
 *   pagina  <-- HTTP/WebSocket -->  esta ponte  <-- MariaDB -->  idle.lua (Canary)
 *                                        \-- protocolo 15.11 (so para o personagem entrar)
 *
 * A pagina nunca fala com o Canary direto. Comandos vao para `idle_commands`,
 * configuracoes para `idle_settings`, e o estado ao vivo vem de `idle_state`.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const mysql = require('mysql2/promise');
const { GameLink } = require('./tibia');

const PORT = Number(process.env.PORT || 8184);
const GAME_HOST = process.env.GAME_HOST || 'server';
const GAME_PORT = Number(process.env.GAME_PORT || 7172);
const WORLD_NAME = process.env.WORLD_NAME || 'Destruitor Idle';
const PUBLIC_DIR = path.join(__dirname, 'public');
const publicKey = crypto.createPublicKey(fs.readFileSync(process.env.RSA_KEY || '/canary-key.pem'));

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'canary',
  connectionLimit: 8,
  charset: 'utf8mb4',
});
const q = async (sql, params = []) => (await pool.query(sql, params))[0];

// ----------------------------------------------------------------------------
// contas e sessoes da pagina
// ----------------------------------------------------------------------------
const sessions = new Map(); // token -> { accountId, expires }
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

const VOCATIONS = { 0: 'Sem vocação', 1: 'Sorcerer', 2: 'Druid', 3: 'Paladin', 4: 'Knight', 5: 'Master Sorcerer', 6: 'Elder Druid', 7: 'Royal Paladin', 8: 'Elite Knight' };
const VOC_LETTER = { 1: 'S', 5: 'S', 2: 'D', 6: 'D', 3: 'P', 7: 'P', 4: 'K', 8: 'K' };
const NEW_VOCATIONS = { sorcerer: 1, druid: 2, paladin: 3, knight: 4 };
const NAME_RE = /^[A-Za-z][A-Za-z ]{2,19}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const attempts = new Map(); // ip -> [timestamps] (limite de tentativas de login)
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  attempts.set(ip, list);
  return list.length > 20;
}

function newSession(accountId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { accountId, expires: Date.now() + SESSION_TTL });
  return token;
}

function auth(req) {
  const h = req.headers['x-token'] || new URL(req.url, 'http://x').searchParams.get('token');
  const s = h && sessions.get(h);
  if (!s || s.expires < Date.now()) return null;
  return s;
}

async function characters(accountId) {
  const rows = await q('SELECT id, name, level, vocation FROM players WHERE account_id = ? ORDER BY id', [accountId]);
  return rows.map((r) => ({ id: r.id, name: r.name, level: r.level, vocation: VOCATIONS[r.vocation] || '?' }));
}

function normName(raw) {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

async function createCharacter(conn, accountId, body) {
  const name = normName(body.name);
  const vocation = NEW_VOCATIONS[String(body.vocation || '').toLowerCase()];
  const sex = String(body.sex || 'male') === 'female' ? 0 : 1;
  if (!NAME_RE.test(name)) throw new Error('Nome: 3 a 20 letras, sem números nem símbolos.');
  if (!vocation) throw new Error('Escolha uma vocação.');
  const [[dup]] = await conn.query('SELECT id FROM players WHERE name = ?', [name]);
  if (dup) throw new Error('Esse nome já está em uso.');
  // level 8 como os personagens de exemplo do Canary, mas com as skills de quem ja passou pela ilha
  // inicial (no Tibia um level 8 chega com ~30 de skill); com 10 um Knight nao mata nem um ciclope
  const melee = vocation === 4 ? 30 : 10;
  const dist = vocation === 3 ? 30 : 10;
  const shield = vocation === 4 ? 25 : vocation === 3 ? 20 : 12;
  const magic = vocation === 1 || vocation === 2 ? 8 : vocation === 3 ? 3 : 1;
  await conn.query(
    `INSERT INTO players (name, group_id, account_id, level, vocation, health, healthmax, experience,
      lookbody, lookfeet, lookhead, looklegs, looktype, maglevel, mana, manamax, manaspent, town_id, conditions, cap, sex,
      skill_sword, skill_axe, skill_club, skill_dist, skill_shielding)
     VALUES (?, 1, ?, 8, ?, 185, 185, 4200, 113, 115, 95, 39, ?, ?, 90, 90, 0, 8, '', 470, ?, ?, ?, ?, ?, ?)`,
    [name, accountId, vocation, sex ? 128 : 136, magic, sex, melee, melee, melee, dist, shield]
  );
  return name;
}

// ----------------------------------------------------------------------------
// catalogo e configuracoes
// ----------------------------------------------------------------------------
let catalogCache = null;
async function catalog() {
  if (!catalogCache) {
    const [row] = await q("SELECT data FROM idle_catalog WHERE name = 'main'");
    if (!row) throw new Error('O servidor do jogo ainda não publicou o catálogo.');
    catalogCache = JSON.parse(row.data);
    catalogCache.actionByName = Object.fromEntries(catalogCache.actions.map((a) => [a.name, a]));
    setTimeout(() => (catalogCache = null), 60000);
  }
  return catalogCache;
}

const PULLS = ['cauteloso', 'ousado', 'agressivo'];
const TARGETS = ['perto', 'fraco', 'forte', 'fracopct', 'fortepct'];
const STANCES = ['defesa', 'equilibrado', 'ataque'];
const SUBJ = { self: ['hp', 'mana', 'shield'], target: ['hp'], area: ['targets'] };
const OPS = ['lt', 'le', 'eq', 'ge', 'gt'];

function parseBar(text) {
  return String(text || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [action, on, conds = ''] = line.split('|');
      return {
        action,
        enabled: on === '1',
        conds: conds
          .split('&')
          .filter(Boolean)
          .map((c) => {
            const [subj, attr, op, val, p] = c.split('.');
            return { subj, attr, op, val: Number(val), pct: p === 'p' };
          }),
      };
    });
}

function serializeBar(bar, cat) {
  if (!Array.isArray(bar)) throw new Error('Barra inválida.');
  if (bar.length > 20) throw new Error('A barra tem no máximo 20 slots.');
  return bar
    .map((slot) => {
      if (!cat.actionByName[slot.action]) throw new Error('Ação desconhecida: ' + slot.action);
      const conds = (slot.conds || []).slice(0, 8).map((c) => {
        if (!SUBJ[c.subj] || !SUBJ[c.subj].includes(c.attr) || !OPS.includes(c.op)) throw new Error('Condição inválida.');
        const val = Math.max(0, Math.min(1000000, Math.floor(Number(c.val) || 0)));
        const pct = c.pct && (c.attr === 'hp' || c.attr === 'mana') ? '.p' : '';
        return `${c.subj}.${c.attr}.${c.op}.${val}${pct}`;
      });
      return `${slot.action}|${slot.enabled ? 1 : 0}|${conds.join('&')}`;
    })
    .join('\n');
}

async function loadSettings(player) {
  const [row] = await q('SELECT hunt, pull, target, distance, stance, bar FROM idle_settings WHERE player_id = ?', [player.id]);
  const cat = await catalog();
  const letter = VOC_LETTER[player.vocation] || 'K';
  if (!row) {
    return { hunt: '', pull: 'ousado', target: 'perto', distance: letter === 'K' ? 1 : 3, stance: 'equilibrado', bar: parseBar(cat.defaultBars[letter]) };
  }
  return { hunt: row.hunt, pull: row.pull, target: row.target, distance: row.distance, stance: row.stance, bar: parseBar(row.bar || cat.defaultBars[letter]) };
}

async function saveSettings(player, s) {
  const cat = await catalog();
  if (!PULLS.includes(s.pull) || !TARGETS.includes(s.target) || !STANCES.includes(s.stance)) throw new Error('Configuração inválida.');
  const distance = Math.max(1, Math.min(4, Math.floor(Number(s.distance) || 1)));
  const bar = serializeBar(s.bar, cat);
  await q(
    `INSERT INTO idle_settings (player_id, hunt, pull, target, distance, stance, bar, seen)
     VALUES (?, '', ?, ?, ?, ?, ?, UNIX_TIMESTAMP())
     ON DUPLICATE KEY UPDATE pull = VALUES(pull), target = VALUES(target), distance = VALUES(distance), stance = VALUES(stance), bar = VALUES(bar)`,
    [player.id, s.pull, s.target, distance, s.stance, bar]
  );
}

// ----------------------------------------------------------------------------
// conexoes com o jogo: uma por personagem que esta cacando
// ----------------------------------------------------------------------------
const links = new Map(); // playerId -> { link, since }
const entering = new Map(); // playerId -> Promise

const isOnline = (playerId) => links.has(playerId);

async function ensureLink(player) {
  if (links.has(player.id)) return { ok: true };
  if (entering.has(player.id)) return entering.get(player.id);
  const job = (async () => {
    // sessao de uso unico: o Canary (authType = "session") procura sha256(chave)
    const key = crypto.randomBytes(24).toString('hex');
    const id = crypto.createHash('sha256').update(key).digest('hex');
    await q('INSERT INTO account_sessions (id, account_id, expires) VALUES (?, ?, UNIX_TIMESTAMP() + 60)', [id, player.account_id]);
    try {
      const link = new GameLink({ host: GAME_HOST, port: GAME_PORT, worldName: WORLD_NAME, sessionKey: key, character: player.name, publicKey });
      const res = await new Promise((resolve) => {
        link.once('ready', () => resolve({ ok: true }));
        link.once('fail', (error) => resolve({ ok: false, error }));
      });
      if (res.ok) {
        links.set(player.id, { link, since: Date.now(), name: player.name });
        link.on('close', (why) => {
          if (links.get(player.id)?.link === link) links.delete(player.id);
          console.log(`[link] ${player.name} desconectado ${why ? '(' + why + ')' : ''}`);
        });
        console.log(`[link] ${player.name} entrou no mundo`);
      }
      return res;
    } finally {
      await q('DELETE FROM account_sessions WHERE id = ?', [id]);
    }
  })();
  entering.set(player.id, job);
  try {
    return await job;
  } finally {
    entering.delete(player.id);
  }
}

function dropLink(playerId) {
  const l = links.get(playerId);
  if (!l) return;
  links.delete(playerId);
  l.link.logout();
}

// vigia: fecha a conexao de quem parou de cacar e reconecta quem ainda caca sem conexao
// (por exemplo depois de reiniciar esta ponte)
async function watchdog() {
  const rows = await q(
    `SELECT s.player_id, s.updated, s.data, p.name, p.account_id
       FROM idle_state s JOIN players p ON p.id = s.player_id
      WHERE s.updated > UNIX_TIMESTAMP() - 20`
  );
  const hunting = new Set();
  for (const r of rows) {
    let st;
    try {
      st = JSON.parse(r.data);
    } catch {
      continue;
    }
    if (st.hunting) {
      hunting.add(r.player_id);
      if (!links.has(r.player_id)) {
        ensureLink({ id: r.player_id, name: r.name, account_id: r.account_id }).then((res) => {
          if (!res.ok) console.log(`[link] nao reconectou ${r.name}: ${res.error}`);
        });
      }
    }
  }
  for (const [playerId, l] of links) {
    // 45 s de folga para o comando de cacar ser processado depois de entrar
    // (menos quando o jogador mandou parar: ai sai assim que a cacada acabar)
    if (!hunting.has(playerId) && (l.stopRequested || Date.now() - l.since > 45000)) {
      console.log(`[link] ${l.name} nao esta cacando: saindo do jogo`);
      dropLink(playerId);
    }
  }
}
setInterval(() => watchdog().catch((e) => console.error('[watchdog]', e.message)), 5000);

async function command(player, cmd, arg = '') {
  await q('INSERT INTO idle_commands (player_name, cmd, arg, created) VALUES (?, ?, ?, UNIX_TIMESTAMP())', [player.name, cmd, arg]);
}

// ----------------------------------------------------------------------------
// estado para a pagina
// ----------------------------------------------------------------------------
async function snapshot(player) {
  const [row] = await q(
    `SELECT level, experience, health, healthmax, mana, manamax, balance, stamina, maglevel,
            skill_fist, skill_club, skill_sword, skill_axe, skill_dist, skill_shielding, vocation
       FROM players WHERE id = ?`,
    [player.id]
  );
  const [st] = await q('SELECT updated, data FROM idle_state WHERE player_id = ?', [player.id]);
  const online = isOnline(player.id);
  const [gr] = await q('SELECT updated, data FROM idle_gear WHERE player_id = ?', [player.id]);
  const gear = gr ? { ...JSON.parse(gr.data), updated: gr.updated } : null;
  let idle = null;
  let fresh = false;
  if (st) {
    idle = JSON.parse(st.data);
    fresh = Date.now() / 1000 - st.updated < 10;
    if (idle.hunting && !fresh) {
      idle.hunting = false;
      idle.reason = idle.reason || 'servidor reiniciado';
    }
  }
  return {
    t: 'state',
    online,
    player: {
      name: player.name,
      vocation: VOCATIONS[row.vocation] || '?',
      letter: VOC_LETTER[row.vocation] || 'K',
      level: row.level,
      exp: Number(row.experience),
      hp: row.health,
      maxHp: row.healthmax,
      mana: row.mana,
      maxMana: row.manamax,
      bank: Number(row.balance),
      stamina: row.stamina,
      magic: row.maglevel,
      skills: { fist: row.skill_fist, club: row.skill_club, sword: row.skill_sword, axe: row.skill_axe, distance: row.skill_dist, shielding: row.skill_shielding },
    },
    idle,
    gear,
  };
}

// ----------------------------------------------------------------------------
// HTTP
// ----------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function send(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new Error('Pedido grande demais.');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function api(req, res, url) {
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
  const route = req.method + ' ' + url.pathname.replace(/^.*\/api\//, '/');

  if (route === 'POST /entrar') {
    if (tooManyAttempts(ip)) return send(res, 429, { erro: 'Muitas tentativas. Espere alguns minutos.' });
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase();
    const [acc] = await q('SELECT id, password FROM accounts WHERE email = ?', [email]);
    if (!acc || acc.password.toLowerCase() !== sha1(String(b.password || ''))) return send(res, 401, { erro: 'E-mail ou senha incorretos.' });
    return send(res, 200, { token: newSession(acc.id), personagens: await characters(acc.id) });
  }

  if (route === 'POST /cadastrar') {
    if (tooManyAttempts(ip)) return send(res, 429, { erro: 'Muitas tentativas. Espere alguns minutos.' });
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!EMAIL_RE.test(email)) return send(res, 400, { erro: 'E-mail inválido.' });
    if (password.length < 8) return send(res, 400, { erro: 'A senha precisa de pelo menos 8 caracteres.' });
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[dup]] = await conn.query('SELECT id FROM accounts WHERE email = ?', [email]);
      if (dup) throw new Error('Já existe uma conta com esse e-mail.');
      const [r] = await conn.query('INSERT INTO accounts (name, email, password, type, creation) VALUES (?, ?, ?, 1, UNIX_TIMESTAMP())', [email.slice(0, 32), email, sha1(password)]);
      await createCharacter(conn, r.insertId, b);
      await conn.commit();
      return send(res, 200, { token: newSession(r.insertId), personagens: await characters(r.insertId) });
    } catch (e) {
      await conn.rollback();
      return send(res, 400, { erro: e.message });
    } finally {
      conn.release();
    }
  }

  if (route === 'GET /catalogo') {
    const c = await catalog();
    const defaultBars = Object.fromEntries(Object.entries(c.defaultBars).map(([voc, text]) => [voc, parseBar(text)]));
    return send(res, 200, { hunts: c.hunts, solo: c.solo || [], shop: c.shop || [], actions: c.actions, pulls: c.pulls, maxUnwatchedHours: c.maxUnwatchedHours, defaultBars });
  }

  const s = auth(req);
  if (!s) return send(res, 401, { erro: 'Entre de novo.' });

  if (route === 'GET /personagens') return send(res, 200, { personagens: await characters(s.accountId) });

  if (route === 'POST /personagens') {
    const b = await readJson(req);
    const list = await characters(s.accountId);
    if (list.length >= 5) return send(res, 400, { erro: 'No máximo 5 personagens por conta.' });
    const conn = await pool.getConnection();
    try {
      await createCharacter(conn, s.accountId, b);
      return send(res, 200, { personagens: await characters(s.accountId) });
    } catch (e) {
      return send(res, 400, { erro: e.message });
    } finally {
      conn.release();
    }
  }

  if (route === 'POST /sair') {
    sessions.delete(req.headers['x-token']);
    return send(res, 200, {});
  }

  return send(res, 404, { erro: 'Não encontrado.' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname.replace(/^\/jogar/, '')) || '/';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Não encontrado');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.includes('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    console.error('[http]', e);
    return send(res, 500, { erro: 'Erro no servidor. Tente de novo.' });
  }
});

// ----------------------------------------------------------------------------
// WebSocket: estado ao vivo + comandos
// ----------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const s = auth(req);
  if (!url.pathname.endsWith('/api/ws') || !s) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  const [player] = await q('SELECT id, name, account_id, vocation FROM players WHERE name = ? AND account_id = ?', [url.searchParams.get('char') || '', s.accountId]);
  if (!player) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => session(ws, player));
});

function session(ws, player) {
  const say = (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
  const msg = (text, kind = 'info') => say({ t: 'msg', text, kind });

  // "alguem esta olhando": sem isso por 12 h o idle.lua encerra a cacada
  const beat = async () => {
    await q(
      `INSERT INTO idle_settings (player_id, distance, bar, seen) VALUES (?, ?, '', UNIX_TIMESTAMP())
       ON DUPLICATE KEY UPDATE seen = UNIX_TIMESTAMP()`,
      [player.id, VOC_LETTER[player.vocation] === 'K' ? 1 : 3]
    ).catch(() => {});
  };
  const push = async () => {
    try {
      say(await snapshot(player));
    } catch (e) {
      console.error('[ws] estado', e.message);
    }
  };

  beat();
  (async () => say({ t: 'settings', settings: await loadSettings(player) }))().catch(() => {});
  (async () => {
    const [g] = await q('SELECT player_id FROM idle_gear WHERE player_id = ?', [player.id]);
    if (!g) {
      await command(player, 'gear');
      await ensureLink(player);
    }
  })().catch((e) => console.error('[gear]', e.message));
  push();
  const pushTimer = setInterval(push, 400); // o personagem anda: estado a cada 0,4 s
  const beatTimer = setInterval(beat, 60000);
  ws.on('close', () => {
    clearInterval(pushTimer);
    clearInterval(beatTimer);
  });

  ws.on('message', async (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      if (m.t === 'start') {
        const cat = await catalog();
        let hunt = cat.hunts.find((h) => h.id === m.hunt);
        if (!hunt && typeof m.hunt === 'string' && m.hunt.startsWith('m:')) {
          const solo = (cat.solo || []).find((x) => 'm:' + x.name === m.hunt);
          if (solo) hunt = { id: m.hunt, name: 'Caçada livre: ' + solo.name };
        }
        if (!hunt) return msg('Caçada desconhecida.', 'erro');
        await command(player, 'start', hunt.id);
        const current = links.get(player.id);
        if (current) {
          current.stopRequested = 0;
          current.since = Date.now();
        }
        msg('Entrando em ' + hunt.name + '…');
        const res = await ensureLink(player);
        if (!res.ok) {
          await q("DELETE FROM idle_commands WHERE player_name = ? AND cmd = 'start'", [player.name]);
          return msg(res.error, 'erro');
        }
      } else if (m.t === 'stop') {
        await command(player, 'stop');
        const l = links.get(player.id);
        if (l) l.stopRequested = Date.now();
        msg('Saindo da caçada…');
      } else if (m.t === 'buy') {
        const cat = await catalog();
        const it = (cat.shop || []).find((x) => x.id === Number(m.id));
        if (!it) return msg('Esse item não está à venda.', 'erro');
        await command(player, 'buy', String(it.id));
        msg('Comprando ' + it.name + '…');
        const res = await ensureLink(player);
        if (!res.ok) {
          await q("DELETE FROM idle_commands WHERE player_name = ? AND cmd = 'buy'", [player.name]);
          return msg(res.error, 'erro');
        }
      } else if (m.t === 'settings') {
        await saveSettings(player, m.settings || {});
        await command(player, 'reload');
        say({ t: 'settings', settings: await loadSettings(player) });
        msg('Configuração salva.', 'ok');
      }
    } catch (e) {
      msg(e.message || 'Erro.', 'erro');
    }
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
}, 3600 * 1000);

server.listen(PORT, '0.0.0.0', () => console.log(`[gateway] ouvindo na porta ${PORT}, jogo em ${GAME_HOST}:${GAME_PORT} (${WORLD_NAME})`));
