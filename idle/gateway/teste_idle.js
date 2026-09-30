// Teste de ponta a ponta: cadastra, caca 45 s, para e apaga a conta de teste.
const crypto = require('crypto');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const base = 'http://127.0.0.1:8184/jogar/api';
const rnd = crypto.randomBytes(3).toString('hex');
const email = `teste-${rnd}@exemplo.invalid`, password = crypto.randomBytes(12).toString('hex');
const name = 'Teste ' + [...crypto.randomBytes(6)].map(b => 'abcdefghij'[b % 10]).join('');
const post = async (p, body, token) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-token': token } : {}) }, body: JSON.stringify(body) })).json();
(async () => {
  const reg = await post('/cadastrar', { email, password, name, vocation: process.env.VOC || 'knight', sex: 'male' });
  console.log('cadastro:', reg.erro || 'ok', (reg.personagens || []).map(c => `${c.name} lv${c.level} ${c.vocation}`).join());
  const ws = new WebSocket(`ws://127.0.0.1:8184/jogar/api/ws?token=${reg.token}&char=${encodeURIComponent(reg.personagens[0].name)}`);
  let last = null;
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'msg') console.log('msg:', m.kind, m.text); if (m.t === 'state') last = m; if (m.t === 'settings') console.log('barra:', m.settings.bar.length, 'slots, distancia', m.settings.distance); });
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'start', hunt: process.env.HUNT || 'esgoto' }));
  for (let i = 0; i < Number(process.env.STEPS || 9); i++) {
    await new Promise(r => setTimeout(r, 5000));
    const s = last && last.idle;
    if (!s) { console.log(`${(i + 1) * 5}s: online=${last && last.online} sem estado`); continue; }
    console.log(`${(i + 1) * 5}s: online=${last.online} cacando=${s.hunting} ${s.hunting ? `hp ${s.hp}/${s.maxHp} xp ${s.xp} loot ${s.loot} gastos ${s.supplies} abates ${s.killCount} monstros [${s.monsters.map(m => m.name + ' ' + m.hp + '/' + m.max).join(', ')}]` : 'motivo=' + s.reason}`);
  }
  if (last && last.idle && last.idle.log) console.log('log:\n  ' + last.idle.log.slice(-8).join('\n  '));
  if (last && last.idle && last.idle.lastLoot) console.log('loot:', last.idle.lastLoot.slice(0, 4).join(' | '));
  ws.send(JSON.stringify({ t: 'stop' }));
  await new Promise(r => setTimeout(r, 6000));
  console.log('depois de parar: online=', last.online, 'cacando=', last.idle && last.idle.hunting, 'motivo=', last.idle && last.idle.reason, 'xp da sessao=', last.idle && last.idle.xp);
  ws.close();
  const db = await mysql.createConnection({ host: 'db', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  await new Promise(r => setTimeout(r, 3000));
  const [[acc]] = await db.query('SELECT id FROM accounts WHERE email = ?', [email]);
  const [[pl]] = await db.query('SELECT id, level, experience, balance FROM players WHERE account_id = ?', [acc.id]);
  console.log('no banco depois de sair: level', pl.level, 'exp', pl.experience, 'banco', pl.balance);
  for (const t of ['idle_state', 'idle_settings']) await db.query(`DELETE FROM ${t} WHERE player_id = ?`, [pl.id]);
  await db.query('DELETE FROM players WHERE account_id = ?', [acc.id]);
  await db.query('DELETE FROM accounts WHERE id = ?', [acc.id]);
  console.log('conta de teste apagada');
  await db.end(); process.exit(0);
})().catch(e => { console.error('FALHOU:', e); process.exit(1); });
