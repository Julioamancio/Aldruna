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
const Povo = require('./public/povo.js');
const Acc = require('./acessorios'); // botoes AUTO de colar e anel
const Leilao = require('./leilao'); // leilao entre jogadores (leilao.js)
const Editor = require('./editor'); // editor da cidade: /jogar/editor/ e /jogar/api/editor/*, codigo proprio (EDITOR_CODE)

const PORT = Number(process.env.PORT || 8184);
const GAME_HOST = process.env.GAME_HOST || 'server';
const GAME_PORT = Number(process.env.GAME_PORT || 7172);
const WORLD_NAME = process.env.WORLD_NAME || 'Destruitor Idle';
// "Entrar com Google": o ID do cliente OAuth (Google Cloud > Credenciais). Vazio = botao desligado.
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
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

const tokenKey = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
function newSession(accountId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_TTL;
  sessions.set(tokenKey(token), { accountId, expires });
  // guardada no banco: reiniciar/publicar a ponte nao tira ninguem do jogo
  q('INSERT INTO idle_web_sessions (id, account_id, expires) VALUES (?, ?, ?)', [tokenKey(token), accountId, Math.floor(expires / 1000)]).catch(() => {});
  return token;
}

function auth(req) {
  const h = req.headers['x-token'] || new URL(req.url, 'http://x').searchParams.get('token');
  const s = h && sessions.get(tokenKey(h));
  if (!s || s.expires < Date.now()) return null;
  return s;
}

async function characters(accountId) {
  const rows = await q('SELECT id, name, level, vocation FROM players WHERE account_id = ? ORDER BY id', [accountId]);
  return rows.map((r) => ({ id: r.id, name: r.name, level: r.level, vocation: VOCATIONS[r.vocation] || '?' }));
}

function normName(raw) {
  // como no Tibia: so letras sem acento (Amâncio vira Amancio)
  return String(raw || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

async function createCharacter(conn, accountId, body) {
  const name = normName(body.name);
  const sex = String(body.sex || 'male') === 'female' ? 0 : 1;
  if (!NAME_RE.test(name)) throw new Error('Nome: 3 a 20 letras, sem números nem símbolos.');
  const [[dup]] = await conn.query('SELECT id FROM players WHERE name = ?', [name]);
  if (dup) throw new Error('Esse nome já está em uso.');
  // como no Huntera: comeca no level 1, sem vocacao (150 de vida, 400 oz); a vocacao se escolhe no level 8
  await conn.query(
    `INSERT INTO players (name, group_id, account_id, level, vocation, health, healthmax, experience,
      lookbody, lookfeet, lookhead, looklegs, looktype, maglevel, mana, manamax, manaspent, town_id, conditions, cap, sex)
     VALUES (?, 1, ?, 1, 0, 150, 150, 0, 113, 115, 95, 39, ?, 0, 0, 0, 0, 8, '', 400, ?)`,
    [name, accountId, sex ? 128 : 136, sex]
  );
  return name;
}

// chaves publicas do Google (renovadas a cada hora ou quando aparece uma chave nova)
let googleKeys = { at: 0, keys: [] };
async function googleKey(kid) {
  if (Date.now() - googleKeys.at > 3600 * 1000 || !googleKeys.keys.some((k) => k.kid === kid)) {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    googleKeys = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = googleKeys.keys.find((k) => k.kid === kid);
  return jwk ? crypto.createPublicKey({ key: jwk, format: 'jwk' }) : null;
}
// token de acesso do botao da pagina: o Google diz para qual site ele foi emitido e de qual e-mail e
async function verifyGoogleAccess(token) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token));
  const info = await r.json().catch(() => ({}));
  if (!r.ok || info.error) throw new Error('Não deu para confirmar sua conta Google.');
  if (info.aud !== GOOGLE_CLIENT_ID && info.azp !== GOOGLE_CLIENT_ID) throw new Error('Esse login do Google não é deste site.');
  if (!info.email || String(info.email_verified) !== 'true') throw new Error('Sua conta Google precisa ter o e-mail confirmado.');
  return info;
}
async function verifyGoogle(idToken) {
  const [h, p, sig] = idToken.split('.');
  if (!h || !p || !sig) throw new Error('Resposta do Google inválida.');
  let header, info;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    info = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Resposta do Google inválida.');
  }
  if (header.alg !== 'RS256') throw new Error('Resposta do Google inválida.');
  const key = await googleKey(header.kid);
  if (!key || !crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), key, Buffer.from(sig, 'base64url'))) throw new Error('Assinatura do Google não confere.');
  if (info.aud !== GOOGLE_CLIENT_ID) throw new Error('Esse login do Google não é deste site.');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(info.iss)) throw new Error('Resposta do Google inválida.');
  if (!info.exp || info.exp * 1000 < Date.now()) throw new Error('O login do Google expirou. Tente de novo.');
  if (!info.email || info.email_verified === false) throw new Error('Sua conta Google precisa ter o e-mail confirmado.');
  return info;
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

// keep = itens que NAO vao na Venda rapida / Despachar loot; autosell = vender sozinho quando a mochila encher
const parseKeep = (txt) => String(txt || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);

async function loadSettings(player) {
  const [row] = await q('SELECT hunt, pull, target, distance, stance, bar, `keep`, autosell, favs, tut FROM idle_settings WHERE player_id = ?', [player.id]).catch(() => q('SELECT hunt, pull, target, distance, stance, bar, `keep`, autosell, favs FROM idle_settings WHERE player_id = ?', [player.id]));
  const cat = await catalog();
  const letter = VOC_LETTER[player.vocation] || 'K';
  // sem vocacao (antes do level 8): barra vazia (o tutorial ensina a por a pocao)
  const def = player.vocation ? parseBar(cat.defaultBars[letter]) : [];
  if (!row) {
    return { hunt: '', pull: 'ousado', target: 'perto', distance: letter === 'K' ? 1 : 3, stance: 'equilibrado', bar: def, keep: [], autosell: true, favs: [], tut: 0 };
  }
  return { hunt: row.hunt, pull: row.pull, target: row.target, distance: row.distance, stance: row.stance, bar: row.bar ? parseBar(row.bar) : def, keep: parseKeep(row.keep), autosell: row.autosell !== 0, favs: String(row.favs || '').split(',').filter((x) => /^[a-z0-9_:' .-]{1,64}$/i.test(x)), tut: row.tut || 0 };
}

async function saveSettings(player, s) {
  const cat = await catalog();
  if (!PULLS.includes(s.pull) || !TARGETS.includes(s.target) || !STANCES.includes(s.stance)) throw new Error('Configuração inválida.');
  const distance = Math.max(1, Math.min(4, Math.floor(Number(s.distance) || 1)));
  const bar = serializeBar(s.bar, cat);
  const keep = [...new Set((Array.isArray(s.keep) ? s.keep : []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 100000))].slice(0, 2000).join(',');
  const autosell = s.autosell === false ? 0 : 1;
  const favs = [...new Set((Array.isArray(s.favs) ? s.favs : []).map(String).filter((x) => /^[a-z0-9_:' .-]{1,64}$/i.test(x) && !x.includes(',')))].slice(0, 200).join(',');
  await q(
    `INSERT INTO idle_settings (player_id, hunt, pull, target, distance, stance, bar, seen, \`keep\`, autosell, favs)
     VALUES (?, '', ?, ?, ?, ?, ?, UNIX_TIMESTAMP(), ?, ?, ?)
     ON DUPLICATE KEY UPDATE pull = VALUES(pull), target = VALUES(target), distance = VALUES(distance), stance = VALUES(stance), bar = VALUES(bar), \`keep\` = VALUES(\`keep\`), autosell = VALUES(autosell), favs = VALUES(favs)`,
    [player.id, s.pull, s.target, distance, s.stance, bar, keep, autosell, favs]
  );
}

// ----------------------------------------------------------------------------
// conexoes com o jogo: uma por personagem que esta cacando
// ----------------------------------------------------------------------------
const links = new Map(); // playerId -> { link, since }
// ----------------------------------------------------------------------------
// povo da cidade (aventureiros que treinam, cacam e conversam) e chat
// ----------------------------------------------------------------------------
const chatLog = { global: [], comercio: [] };
const chatSubs = new Set(); // paginas abertas: { say, player, pos, fxAt }
let chatSeq = 0;
function chatPost(m) {
  const msg = { ...m, id: ++chatSeq, at: Date.now() };
  const log = chatLog[m.ch];
  if (log) {
    log.push(msg);
    if (log.length > 60) log.shift();
  }
  for (const sub of chatSubs) {
    // Local: so quem esta perto de quem falou
    if (m.ch === 'local' && !(sub.pos && Math.abs(sub.pos.x - m.x) <= 9 && Math.abs(sub.pos.y - m.y) <= 7)) continue;
    sub.say({ t: 'chat', m: msg });
  }
}
let povo = null;
try {
  povo = Povo.create(JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'salas', 'cidade.json'), 'utf8')));
  povo.onChat = (m) => chatPost(m);
  setInterval(() => povo.tick(Date.now()), 200);
  const hunts = () => catalog().then((c) => povo.setHunts((c.hunts || []).map((h) => ({ name: h.name, min: h.min })))).catch(() => setTimeout(hunts, 30000));
  setTimeout(hunts, 5000);
  console.log(`[povo] ${povo.count()} aventureiros em Thais`);
} catch (e) {
  console.error('[povo]', e.message);
}

const recordsCache = new Map(); // playerId -> { at, data } (recordes por cacada)
const watching = new Map(); // playerId -> paginas abertas agora
// "jogando agora" da barra de cima: quem esta com a pagina aberta ou cacando (mesmo com ela fechada)
const playersOnline = () => new Set([...links.keys(), ...watching.keys()]).size;
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
    // pagina aberta: fica online em Thais (anda livre, ve os outros)
    if (watching.has(playerId)) {
      l.lastWatched = Date.now();
      continue;
    }
    // 45 s de folga para o comando de cacar ser processado depois de entrar; quem fechou a pagina
    // fica mais 1 min na cidade (menos quando mandou parar: ai sai assim que a cacada acabar)
    const idleFor = Date.now() - Math.max(l.since, l.lastWatched || 0);
    if (!hunting.has(playerId) && (l.stopRequested || idleFor > 60000)) {
      console.log(`[link] ${l.name} nao esta cacando: saindo do jogo`);
      dropLink(playerId);
    }
  }
}
setInterval(() => watchdog().catch((e) => console.error('[watchdog]', e.message)), 5000);

async function command(player, cmd, arg = '') {
  await q('INSERT INTO idle_commands (player_name, cmd, arg, created) VALUES (?, ?, ?, UNIX_TIMESTAMP())', [player.name, cmd, arg]);
}
const leilao = Leilao.create({ q, command, ensureLink });

// ----------------------------------------------------------------------------
// estado para a pagina
// ----------------------------------------------------------------------------
async function snapshot(player, sub) {
  const cache = sub && sub.cache && Date.now() - sub.cache.at < 2000 && Date.now() > (sub.fresh || 0) ? sub.cache : null;
  const [row] = cache ? [cache.row] : await q(
    `SELECT level, experience, health, healthmax, mana, manamax, balance, stamina, maglevel,
            skill_fist, skill_club, skill_sword, skill_axe, skill_dist, skill_shielding, vocation,
            looktype, lookhead, lookbody, looklegs, lookfeet
       FROM players WHERE id = ?`,
    [player.id]
  );
  const [st] = await q('SELECT updated, data FROM idle_state WHERE player_id = ?', [player.id]);
  // conta Premium (dias de premium do Canary): analisador completo, despacho a cada 30 min
  const [acc] = cache ? [cache.acc] : await q('SELECT a.premdays, a.type FROM accounts a JOIN players p ON p.account_id = a.id WHERE p.id = ?', [player.id]);
  const online = isOnline(player.id);
  const [gr] = cache ? [cache.gr] : await q('SELECT updated, data FROM idle_gear WHERE player_id = ?', [player.id]);
  const gear = gr ? { ...JSON.parse(gr.data), updated: gr.updated } : null;
  const [bg] = cache ? [cache.bg] : await q('SELECT updated, data FROM idle_bag WHERE player_id = ?', [player.id]).catch(() => []);
  const [ch] = cache ? [cache.ch] : await q('SELECT updated, data FROM idle_char WHERE player_id = ?', [player.id]).catch(() => []);
  if (sub && !cache) sub.cache = { at: Date.now(), row, acc, gr, bg, ch };
  const [tw] = await q('SELECT updated, data FROM idle_town WHERE player_id = ?', [player.id]).catch(() => []);
  const town = tw && Date.now() / 1000 - tw.updated < 6 && isOnline(player.id) ? JSON.parse(tw.data) : null;
  if (sub) sub.pos = town && town.me ? { x: town.me.x, y: town.me.y } : null;
  if (town && town.me && povo && (town.me.z || 0) === 0) {
    const now = Date.now();
    town.players = [...(town.players || []), ...povo.near(town.me.x, town.me.y)];
    town.fx = povo.events(sub ? sub.fxAt : now - 500, town.me.x, town.me.y, 14, 11, now);
    if (sub) sub.fxAt = now;
  }
  const rc = recordsCache.get(player.id);
  if (!rc || Date.now() - rc.at > 20000) {
    const rows = await q('SELECT hunt, xph, gph, kills, secs FROM idle_records WHERE player_id = ?', [player.id]).catch(() => []);
    recordsCache.set(player.id, { at: Date.now(), data: Object.fromEntries(rows.map((r) => [r.hunt, { xph: r.xph, gph: r.gph, kills: r.kills, secs: r.secs }])) });
  }
  const bag = bg ? { ...JSON.parse(bg.data), updated: bg.updated } : null;
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
    players: playersOnline(),
    // no mundo = jogadores + aventureiros andando pela cidade (o numero sobe e desce quando eles saem para cacar)
    povo: povo ? povo.bots.filter((b) => b.vis).length : 0,
    admin: !!(acc && acc.type >= 5),
    premium: !!(acc && acc.premdays > 0),
    now: Math.floor(Date.now() / 1000), // relogio do servidor (contagem do Despachar loot)
    player: {
      name: player.name,
      vocation: VOCATIONS[row.vocation] || '?',
      letter: VOC_LETTER[row.vocation] || '',
      vocId: row.vocation,
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
      look: { t: row.looktype, h: row.lookhead, b: row.lookbody, l: row.looklegs, f: row.lookfeet },
    },
    idle,
    gear,
    bag,
    char: ch ? { ...JSON.parse(ch.data), updated: ch.updated } : null,
    town,
    records: recordsCache.get(player.id)?.data || {},
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

const editor = Editor.create({ send, dir: process.env.EDITOR_DIR || '/app/editor', publicDir: PUBLIC_DIR, code: process.env.EDITOR_CODE, online: () => playersOnline() });

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

  if (route === 'GET /config') return send(res, 200, { googleClientId: GOOGLE_CLIENT_ID });

  // Entrar com Google: o navegador recebe do Google um "ID token" (JWT assinado); aqui confere a assinatura com as
  // chaves publicas do Google, se e para este site (aud) e se o e-mail e verificado. Sem conta: cria na hora.
  if (route === 'POST /google') {
    if (!GOOGLE_CLIENT_ID) return send(res, 400, { erro: 'Entrar com Google ainda não está ligado.' });
    if (tooManyAttempts(ip)) return send(res, 429, { erro: 'Muitas tentativas. Espere alguns minutos.' });
    const b = await readJson(req);
    let info;
    try {
      // botao da pagina: token de acesso (conferido no Google); One Tap/botao oficial: ID token (assinatura)
      info = b.access_token ? await verifyGoogleAccess(String(b.access_token)) : await verifyGoogle(String(b.credential || ''));
    } catch (e) {
      return send(res, 401, { erro: e.message || 'Não deu para confirmar sua conta Google.' });
    }
    const email = String(info.email).trim().toLowerCase();
    let [acc] = await q('SELECT id FROM accounts WHERE email = ?', [email]);
    let novo = false;
    if (!acc) {
      // senha aleatoria (ninguem sabe): essa conta entra pelo Google
      const [r] = await pool.query('INSERT INTO accounts (name, email, password, type, creation) VALUES (?, ?, ?, 1, UNIX_TIMESTAMP())', [email.slice(0, 32), email, sha1(crypto.randomBytes(24).toString('hex'))]);
      acc = { id: r.insertId };
      novo = true;
    }
    return send(res, 200, { token: newSession(acc.id), personagens: await characters(acc.id), novo, nome: String(info.given_name || info.name || '').slice(0, 20) });
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
    const k = tokenKey(req.headers['x-token'] || '');
    sessions.delete(k);
    await q('DELETE FROM idle_web_sessions WHERE id = ?', [k]).catch(() => {});
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

// ----------------------------------------------------------------------------
// codigo de acesso (teste fechado): sem a liberacao, so a tela do codigo e o logo.
// A liberacao e um cookie com o HMAC do codigo (trocar o codigo derruba as liberacoes antigas).
// ----------------------------------------------------------------------------
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();
const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const accessToken = ACCESS_CODE ? crypto.createHmac('sha256', normCode(ACCESS_CODE)).update('destruitor-idle-acesso').digest('hex') : '';
const GATE_FREE = new Set(['/acesso.html', '/fogo.js', '/logo.webp', '/icon.svg', '/manifest.webmanifest']);
function hasAccess(req) {
  if (!ACCESS_CODE) return true;
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)dt_acesso=([a-f0-9]{64})/);
  return !!m && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(accessToken));
}
async function gateLogin(req, res) {
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
  if (tooManyAttempts(ip)) return send(res, 429, { erro: 'Muitas tentativas. Espere alguns minutos.' });
  const b = await readJson(req);
  const given = Buffer.from(normCode(b.codigo)), want = Buffer.from(normCode(ACCESS_CODE));
  if (!ACCESS_CODE || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(res, 401, { erro: 'Código errado.' });
  res.setHeader('Set-Cookie', `dt_acesso=${accessToken}; Path=/jogar/; Max-Age=${90 * 86400}; HttpOnly; Secure; SameSite=Lax`);
  return send(res, 200, { ok: true });
}
function serveGate(res) {
  fs.readFile(path.join(PUBLIC_DIR, 'acesso.html'), (err, data) => {
    res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data || '');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const rel = url.pathname.replace(/^\/jogar/, '') || '/';
    if (editor.owns(rel)) return await editor.http(req, res, url, rel); // editor da cidade: codigo proprio (EDITOR_CODE)
    if (req.method === 'POST' && rel === '/api/acesso') return await gateLogin(req, res);
    if (!hasAccess(req)) {
      if (GATE_FREE.has(rel)) return serveStatic(req, res, url);
      if (rel.startsWith('/api/')) return send(res, 401, { erro: 'Digite o código de acesso.', acesso: true });
      if (rel === '/' || rel.endsWith('.html') || !path.extname(rel)) return serveGate(res);
      res.writeHead(401, { 'Cache-Control': 'no-store' });
      return res.end();
    }
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
  if (!url.pathname.endsWith('/api/ws') || !s || !hasAccess(req)) {
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
  const sub = { say, player, pos: null, fxAt: Date.now(), lastChat: 0 };
  chatSubs.add(sub);
  leilao.attach(ws, player, say, msg);
  say({ t: 'chatlog', global: chatLog.global.slice(-40), comercio: chatLog.comercio.slice(-25) });
  const push = async () => {
    try {
      say(await snapshot(player, sub));
    } catch (e) {
      console.error('[ws] estado', e.message);
    }
  };

  beat();
  watching.set(player.id, (watching.get(player.id) || 0) + 1);
  ensureLink(player).then((res) => {
    if (!res.ok) msg(res.error, 'erro');
  });
  (async () => say({ t: 'settings', settings: await loadSettings(player) }))().catch(() => {});
  Acc.load(q, player.id).then((cfg) => say({ t: 'acessorios', cfg })).catch(() => {});
  (async () => {
    const [g] = await q('SELECT player_id FROM idle_gear WHERE player_id = ?', [player.id]);
    if (!g) {
      await command(player, 'gear');
      await ensureLink(player);
    }
  })().catch((e) => console.error('[gear]', e.message));
  push();
  // estado a cada 0,25 s (andar responde rapido); um envio de cada vez, sem acumular
  let pushing = false;
  const pushTimer = setInterval(() => {
    if (pushing) return;
    pushing = true;
    push().finally(() => (pushing = false));
  }, 250);
  const beatTimer = setInterval(beat, 60000);
  ws.on('close', () => {
    chatSubs.delete(sub);
    clearInterval(pushTimer);
    clearInterval(beatTimer);
    const n = (watching.get(player.id) || 1) - 1;
    if (n > 0) watching.set(player.id, n);
    else watching.delete(player.id);
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
      } else if (m.t === 'step' || m.t === 'walkto' || m.t === 'stopwalk') {
        const l = links.get(player.id);
        if (!l) return;
        // teclado: um passo pelo protocolo do jogo (na hora); clique: o servidor acha o caminho ate o destino
        if (m.t === 'step') l.link.step(Math.sign(Number(m.dx) || 0), Math.sign(Number(m.dy) || 0));
        else if (m.t === 'stopwalk') {
          l.link.stopWalk();
          await command(player, 'stopwalk');
        } else if (Number.isFinite(Number(m.x)) && Number.isFinite(Number(m.y))) {
          await command(player, 'walk', `${Math.trunc(Number(m.x))},${Math.trunc(Number(m.y))}`);
        }
      } else if (m.t === 'outfit' || m.t === 'buylook' || m.t === 'char') {
        // aparencia: vestir (roupa, cores, addons, montaria) e comprar; o servidor confere tudo
        if (m.t === 'outfit') {
          const L = m.look || {};
          await command(player, 'outfit', [L.t, L.h, L.b, L.l, L.f, L.a, L.mount].map((x) => Math.trunc(Number(x) || 0)).join(','));
        } else if (m.t === 'buylook') {
          if (!['outfit', 'addon', 'mount'].includes(m.kind)) return;
          await command(player, 'buylook', `${m.kind},${Math.trunc(Number(m.id) || 0)},${Math.trunc(Number(m.addon) || 0)}`);
        } else await command(player, 'char');
        const res = await ensureLink(player);
        if (!res.ok) return msg(res.error, 'erro');
        sub.fresh = Date.now() + 3000; // a resposta do servidor chega em ate ~1 s: le sem cache ate la // a ficha nova chega no proximo estado
      } else if (m.t === 'tut') {
        // passo do tutorial (99 = pulou/terminou)
        const step = Math.max(0, Math.min(99, Math.trunc(Number(m.step) || 0)));
        await q(`INSERT INTO idle_settings (player_id, distance, bar, seen, tut) VALUES (?, 1, '', UNIX_TIMESTAMP(), ?)
                 ON DUPLICATE KEY UPDATE tut = VALUES(tut)`, [player.id, step]);
      } else if (m.t === 'arma') {
        // tutorial: a arma inicial (espada, arco ou varinha) vai para a bolsa
        if (!['espada', 'arco', 'varinha'].includes(m.which)) return;
        await command(player, 'arma', m.which);
        const res = await ensureLink(player);
        if (!res.ok) return msg(res.error, 'erro');
        sub.fresh = Date.now() + 3000; // a resposta do servidor chega em ate ~1 s: le sem cache ate la
      } else if (m.t === 'equip') {
        // vestir uma peca da bolsa (mochila de verdade)
        await command(player, 'equip', String(Math.trunc(Number(m.i))));
        const res = await ensureLink(player);
        if (!res.ok) return msg(res.error, 'erro');
        sub.fresh = Date.now() + 3000; // a resposta do servidor chega em ate ~1 s: le sem cache ate la
      } else if (m.t === 'vocacao') {
        // level 8: escolhe a vocacao (para sempre); o servidor confere e da o kit
        if (!['knight', 'paladin', 'sorcerer', 'druid'].includes(m.voc)) return;
        await command(player, 'vocacao', m.voc);
        const res = await ensureLink(player);
        if (!res.ok) return msg(res.error, 'erro');
        setTimeout(async () => {
          sub.cache = null;
          const [row] = await q('SELECT vocation FROM players WHERE id = ?', [player.id]).catch(() => []);
          if (!row || !row.vocation || player.vocation === row.vocation) return;
          player.vocation = row.vocation;
          // a barra vazia do comeco vira a barra padrao da vocacao
          const s = await loadSettings(player);
          if (!s.bar || !s.bar.length) {
            const cat = await catalog();
            s.bar = parseBar(cat.defaultBars[VOC_LETTER[row.vocation]]);
            s.distance = VOC_LETTER[row.vocation] === 'K' ? 1 : 3;
            await saveSettings(player, s);
            await command(player, 'reload');
          }
          say({ t: 'settings', settings: await loadSettings(player) });
        }, 1500);
      } else if (m.t === 'mortes') {
        const rows = await q('SELECT time, level, killed_by, is_player, mostdamage_by FROM player_deaths WHERE player_id = ? ORDER BY time DESC LIMIT 20', [player.id]).catch(() => []);
        say({ t: 'mortes', list: rows.map((r) => ({ at: r.time, level: r.level, by: r.killed_by, player: !!r.is_player, most: r.mostdamage_by })) });
      } else if (m.t === 'chat') {
        const text = String(m.text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160);
        if (!text) return;
        const ch = ['global', 'comercio', 'local'].includes(m.ch) ? m.ch : 'local';
        if (Date.now() - sub.lastChat < 1500) return msg('Calma: espere um pouco entre as mensagens.', 'erro');
        const [row] = await q('SELECT level, vocation FROM players WHERE id = ?', [player.id]);
        if (ch !== 'local' && row.level < 20) return msg('O Global e o Comércio liberam no level 20. Até lá, fale no Local.', 'erro');
        if (ch === 'local' && !sub.pos) return msg('O Local é para quem está na cidade.', 'erro');
        sub.lastChat = Date.now();
        const L = VOC_LETTER[row.vocation] || '';
        const voc = row.vocation >= 5 ? { K: 'EK', P: 'RP', S: 'MS', D: 'ED' }[L] : L;
        chatPost({ ch, name: player.name, lv: row.level, voc, text, pid: player.id, ...(ch === 'local' ? { x: sub.pos.x, y: sub.pos.y } : {}) });
      } else if (m.t === 'sell' || m.t === 'dispatch') {
        await command(player, m.t);
        msg(m.t === 'sell' ? 'Vendendo o loot…' : 'O mensageiro está levando o loot…');
        const res = await ensureLink(player);
        if (!res.ok) {
          await q('DELETE FROM idle_commands WHERE player_name = ? AND cmd = ?', [player.name, m.t]);
          return msg(res.error, 'erro');
        }
      } else if (m.t === 'settings') {
        await saveSettings(player, m.settings || {});
        await command(player, 'reload');
        say({ t: 'settings', settings: await loadSettings(player) });
        msg('Configuração salva.', 'ok');
      } else if (m.t === 'acessorios') {
        // AUTO de colar e anel: grava a ordem e as regras; a cacada em andamento recarrega
        const kept = await Acc.save(q, player.id, m.cfg);
        await command(player, 'reload');
        say({ t: 'acessorios', cfg: await Acc.load(q, player.id) });
        if (kept) say({ t: 'settings', settings: await loadSettings(player) });
        msg('Colares e anéis salvos.', 'ok');
      }
    } catch (e) {
      msg(e.message || 'Erro.', 'erro');
    }
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
  q('DELETE FROM idle_web_sessions WHERE expires < UNIX_TIMESTAMP()').catch(() => {});
}, 3600 * 1000);

(async () => {
  for (const sql of [
    'ALTER TABLE idle_settings ADD COLUMN IF NOT EXISTS `keep` TEXT NULL',
    'ALTER TABLE idle_settings ADD COLUMN IF NOT EXISTS autosell TINYINT NOT NULL DEFAULT 1',
    'ALTER TABLE idle_settings ADD COLUMN IF NOT EXISTS favs TEXT NULL',
    Acc.MIGRATION,
    'CREATE TABLE IF NOT EXISTS idle_town (player_id INT NOT NULL, updated INT UNSIGNED NOT NULL, data MEDIUMTEXT NOT NULL, PRIMARY KEY (player_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    'CREATE TABLE IF NOT EXISTS idle_records (player_id INT NOT NULL, hunt VARCHAR(64) NOT NULL, xph INT NOT NULL DEFAULT 0, gph INT NOT NULL DEFAULT 0, kills INT NOT NULL DEFAULT 0, secs INT NOT NULL DEFAULT 0, updated INT UNSIGNED NOT NULL, PRIMARY KEY (player_id, hunt)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    'CREATE TABLE IF NOT EXISTS idle_bag (player_id INT NOT NULL, updated INT UNSIGNED NOT NULL, items TEXT NOT NULL, dispatch_at INT UNSIGNED NOT NULL DEFAULT 0, data MEDIUMTEXT NOT NULL, PRIMARY KEY (player_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    'ALTER TABLE idle_settings ADD COLUMN IF NOT EXISTS tut TINYINT NOT NULL DEFAULT 0',
    'CREATE TABLE IF NOT EXISTS idle_web_sessions (id CHAR(64) NOT NULL, account_id INT NOT NULL, expires INT UNSIGNED NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    ...Leilao.SQL,
  ]) await q(sql).catch((e) => console.error('[migracao]', e.message));
  const rows = await q('SELECT id, account_id, expires FROM idle_web_sessions WHERE expires > UNIX_TIMESTAMP()').catch(() => []);
  for (const r of rows) sessions.set(r.id, { accountId: r.account_id, expires: r.expires * 1000 });
  console.log(`[gateway] ${rows.length} sessoes da pagina recuperadas | entrar com Google: ${GOOGLE_CLIENT_ID ? 'ligado' : 'desligado (falta GOOGLE_CLIENT_ID)'}`);
})();

server.listen(PORT, '0.0.0.0', () => console.log(`[gateway] ouvindo na porta ${PORT}, jogo em ${GAME_HOST}:${GAME_PORT} (${WORLD_NAME})`));
