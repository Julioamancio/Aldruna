// Valida a calibragem das cacadas no servidor de verdade.
// Cria um personagem de teste JA no level indicado (vida, mana, magic level e skills plausiveis para o
// level, so com o equipamento inicial = pior caso), caca por SECS segundos e mede se ele aguenta.
// Uso (dentro do container da ponte):
//   CASES="sorcerer:tarantulas:8,knight:dragoes:50" SECS=60 node valida.js
const crypto = require('crypto');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');

const base = 'http://127.0.0.1:8184/jogar/api';
const SECS = Number(process.env.SECS || 60);
const expFor = (lv) => Math.floor((50 * (lv - 1) ** 3 - 150 * (lv - 1) ** 2 + 400 * (lv - 1)) / 3);
const GAIN = { knight: [15, 5], paladin: [10, 15], sorcerer: [5, 30], druid: [5, 30] };

// mesmas curvas do tools/gera.py
const skillAt = (L) => Math.round(Math.min(30 + 22.7 * Math.log(Math.max(L, 8) / 8), 120));
const mlAt = (L) => Math.round(8 + 30 * Math.log(Math.max(L, 8) / 8));

function statsFor(voc, L) {
  const [gh, gm] = GAIN[voc];
  const s = { level: L, experience: expFor(L), health: 185 + gh * (L - 8), mana: 90 + gm * (L - 8), balance: 5000 + L * L * 10 };
  const k = skillAt(L);
  if (voc === 'knight') Object.assign(s, { maglevel: Math.round(L / 12), skill_sword: k, skill_axe: k, skill_club: k, skill_shielding: k, skill_dist: 10 });
  else if (voc === 'paladin') Object.assign(s, { maglevel: Math.round(L / 4), skill_dist: k + 3, skill_shielding: Math.round(k * 0.6), skill_sword: 10, skill_axe: 10, skill_club: 10 });
  else Object.assign(s, { maglevel: mlAt(L), skill_shielding: Math.round(10 + L * 0.2), skill_dist: 10, skill_sword: 10, skill_axe: 10, skill_club: 10 });
  return s;
}

const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

async function runCase(db, voc, hunt, L) {
  const email = `valida-${crypto.randomBytes(3).toString('hex')}@exemplo.invalid`;
  const name = 'Valida ' + [...crypto.randomBytes(6)].map((b) => 'abcdefghij'[b % 10]).join('');
  const reg = await post('/cadastrar', { email, password: crypto.randomBytes(12).toString('hex'), name, vocation: voc, sex: 'male' });
  if (reg.erro) throw new Error(reg.erro);
  const st = statsFor(voc, L);
  const cols = Object.keys(st);
  await db.query(`UPDATE players SET ${cols.map((c) => c + ' = ?').join(', ')}, healthmax = ?, manamax = ? WHERE name = ?`, [...cols.map((c) => st[c]), st.health, st.mana, name]);

  const ws = new WebSocket(`ws://127.0.0.1:8184/jogar/api/ws?token=${reg.token}&char=${encodeURIComponent(name)}`);
  let last = null;
  let minHp = 100;
  let died = false;
  let started = false;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t !== 'state' || !m.idle) return;
    last = m.idle;
    if (m.idle.hunting) {
      started = true;
      minHp = Math.min(minHp, Math.round((m.idle.hp * 100) / m.idle.maxHp));
    } else if (started && m.idle.reason === 'morte') died = true;
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'start', hunt }));
  const t0 = Date.now();
  while (Date.now() - t0 < SECS * 1000 && !died) await new Promise((r) => setTimeout(r, 1000));
  const snap = last || {};
  ws.send(JSON.stringify({ t: 'stop' }));
  await new Promise((r) => setTimeout(r, 4000));
  ws.close();

  const [[pl]] = await db.query('SELECT id, account_id FROM players WHERE name = ?', [name]);
  for (const t of ['idle_state', 'idle_settings']) await db.query(`DELETE FROM ${t} WHERE player_id = ?`, [pl.id]);
  await db.query('DELETE FROM players WHERE id = ?', [pl.id]);
  await db.query('DELETE FROM accounts WHERE id = ?', [pl.account_id]);

  return {
    caso: `${voc} lv${L} em ${hunt}`,
    resultado: died ? 'MORREU' : started ? 'vivo' : 'nao comecou',
    vidaMinima: minHp + '%',
    abates: snap.killCount || 0,
    xpH: snap.xpHour || 0,
    lucroH: snap.profitHour || 0,
    gastos: snap.supplies || 0,
  };
}

(async () => {
  const db = await mysql.createConnection({ host: 'db', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const cases = (process.env.CASES || '').split(',').filter(Boolean).map((c) => c.split(':'));
  for (const [voc, hunt, lv] of cases) {
    try {
      const r = await runCase(db, voc, hunt, Number(lv));
      console.log(JSON.stringify(r));
    } catch (e) {
      console.log(JSON.stringify({ caso: `${voc} lv${lv} em ${hunt}`, erro: e.message }));
    }
  }
  await db.end();
  process.exit(0);
})();
