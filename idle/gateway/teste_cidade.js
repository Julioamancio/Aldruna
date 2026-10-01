// Teste da cidade: dois personagens entram (ficam em Thais), um anda por passos e por "andar ate",
// e cada um precisa ver o outro. Apaga as contas de teste no fim.
const crypto = require('crypto');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const base = 'http://127.0.0.1:8184/jogar/api';
const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function player(tag) {
  const rnd = crypto.randomBytes(3).toString('hex');
  const email = `teste-${rnd}@exemplo.invalid`;
  const name = 'Cidade ' + tag + [...crypto.randomBytes(4)].map((b) => 'abcdefghij'[b % 10]).join('');
  const reg = await post('/cadastrar', { email, password: crypto.randomBytes(12).toString('hex'), name, vocation: 'knight', sex: 'male' });
  const ws = new WebSocket(`ws://127.0.0.1:8184/jogar/api/ws?token=${reg.token}&char=${encodeURIComponent(name)}`);
  const me = { name, email, ws, town: null, chat: [], fx: 0 };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'state' && m.town) { me.town = m.town; me.fx += (m.town.fx || []).length; }
    if (m.t === 'chatlog') me.chat.push(...(m.global || []), ...(m.comercio || []));
    if (m.t === 'chat') me.chat.push(m.m);
    if (m.t === 'msg' && m.kind === 'erro') console.log(name, 'erro:', m.text);
  });
  await new Promise((r) => ws.on('open', r));
  return me;
}

(async () => {
  const a = await player('A');
  const b = await player('B');
  await sleep(9000);
  const pos = (p) => (p.town ? `(${p.town.me.x},${p.town.me.y},${p.town.me.z})` : 'sem cidade');
  console.log('entraram:', a.name, pos(a), '|', b.name, pos(b));
  console.log(a.name, 've:', (a.town?.players || []).map((x) => x.name).join(', ') || 'ninguem');
  a.ws.send(JSON.stringify({ t: 'step', dx: 0, dy: -1 }));
  await sleep(700);
  a.ws.send(JSON.stringify({ t: 'step', dx: 0, dy: -1 }));
  await sleep(1500);
  console.log('depois de 2 passos para o norte:', pos(a));
  a.ws.send(JSON.stringify({ t: 'walkto', steps: [[0, -1], [0, -1], [0, -1], [0, -1]] }));
  await sleep(3500);
  console.log('depois de "andar ate" 4 para o norte:', pos(a));
  console.log(b.name, 've:', (b.town?.players || []).map((x) => `${x.name} (${x.x},${x.y})`).join(', ') || 'ninguem');
  // chat: level 8 nao fala no Global; no Local, quem esta perto ouve
  a.ws.send(JSON.stringify({ t: 'chat', ch: 'global', text: 'teste global' }));
  await sleep(1800);
  a.ws.send(JSON.stringify({ t: 'chat', ch: 'local', text: 'oi, alguem ai?' }));
  await sleep(1500);
  console.log(b.name, 'ouviu no Local:', b.chat.filter((c) => c.ch === 'local').map((c) => `${c.name}: ${c.text}`).join(' | ') || 'nada');
  console.log('chat (Global/Comercio) recebido por', b.name + ':', b.chat.filter((c) => c.ch !== 'local').length, 'mensagens; ex.:', b.chat.filter((c) => c.ch !== 'local').slice(-2).map((c) => `${c.name}: ${c.text}`).join(' | '));
  console.log('povo visto por', a.name + ':', (a.town?.players || []).filter((x) => String(x.id).startsWith('b')).length, '| efeitos recebidos:', a.fx);
  for (const p of [a, b]) p.ws.close();
  await sleep(2000);
  const db = await mysql.createConnection({ host: 'db', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  for (const p of [a, b]) {
    const [[acc]] = await db.query('SELECT id FROM accounts WHERE email = ?', [p.email]);
    if (!acc) continue;
    const [pl] = await db.query('SELECT id FROM players WHERE account_id = ?', [acc.id]);
    for (const x of pl) for (const t of ['idle_state', 'idle_settings', 'idle_town', 'idle_bag', 'idle_gear']) await db.query(`DELETE FROM ${t} WHERE player_id = ?`, [x.id]).catch(() => {});
    await db.query('DELETE FROM players WHERE account_id = ?', [acc.id]).catch(() => console.log('(personagem ainda online: apaga depois)'));
    await db.query('DELETE FROM accounts WHERE id = ?', [acc.id]).catch(() => {});
  }
  console.log('contas de teste apagadas');
  await db.end();
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
