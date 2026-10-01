// Teste do comeco: um level 1 com a espada inicial caca ratos; mostra a cada 5 s o que ele esta fazendo
// (andando, lutando, alvo, monstros em volta, abates, vida) e o registro da cacada. Apaga a conta no fim.
const crypto = require('crypto');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const base = 'http://127.0.0.1:8184/jogar/api';
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const cookie = process.env.ACCESS_CODE ? 'dt_acesso=' + crypto.createHmac('sha256', norm(process.env.ACCESS_CODE)).update('destruitor-idle-acesso').digest('hex') : '';
const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ARMA = process.argv[2] || 'espada';
const SEGUNDOS = Number(process.argv[3] || 90);

(async () => {
  const db = await mysql.createConnection({ host: 'db', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const email = `teste-${crypto.randomBytes(3).toString('hex')}@exemplo.invalid`;
  const name = 'Rato ' + [...crypto.randomBytes(5)].map((b) => 'abcdefghij'[b % 10]).join('');
  const reg = await post('/cadastrar', { email, password: crypto.randomBytes(12).toString('hex'), name, sex: 'male' });
  const ws = new WebSocket(`ws://127.0.0.1:8184/jogar/api/ws?token=${reg.token}&char=${encodeURIComponent(name)}`, { headers: { Cookie: cookie } });
  let st = null;
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'state') st = m; });
  await new Promise((ok) => ws.on('open', ok));
  await sleep(8000);
  ws.send(JSON.stringify({ t: 'arma', which: ARMA }));
  await sleep(3000);
  for (const b of st?.gear?.bolsa || []) if (b.veste) { ws.send(JSON.stringify({ t: 'equip', i: b.i })); await sleep(3000); break; }
  console.log(name, '| arma na mao:', st?.gear?.slots?.mao1?.name, '| municao:', st?.gear?.slots?.municao?.name || '-');
  ws.send(JSON.stringify({ t: 'start', hunt: 'poroes' }));
  const t0 = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < SEGUNDOS * 1000) {
    await sleep(5000);
    const i = st?.idle || {};
    const near = (i.monsters || []).map((m) => `${m.name}${m.target ? '*' + m.hp + '/' + m.max : ''}(${m.dist})`).join(' ');
    console.log(`${Math.round((Date.now() - t0) / 1000)}s | ${i.moving || '?'} | abates ${i.killCount || 0} | xp ${i.xp || 0} | vida ${i.hp}/${i.maxHp} | level ${i.level} | perto: ${near || '-'}`);
    const log = i.log || [];
    for (const l of log.slice(lastLog)) console.log('   ', l);
    lastLog = log.length;
  }
  ws.send(JSON.stringify({ t: 'stop' }));
  await sleep(4000);
  ws.close();
  await sleep(2000);
  const [[acc]] = await db.query('SELECT id FROM accounts WHERE email = ?', [email]);
  if (acc) {
    const [pl] = await db.query('SELECT id FROM players WHERE account_id = ?', [acc.id]);
    for (const x of pl) for (const t of ['idle_state', 'idle_settings', 'idle_town', 'idle_bag', 'idle_gear', 'idle_char', 'idle_records']) await db.query(`DELETE FROM ${t} WHERE player_id = ?`, [x.id]).catch(() => {});
    await db.query('DELETE FROM players WHERE account_id = ?', [acc.id]).catch(() => console.log('(personagem ainda online)'));
    await db.query('DELETE FROM accounts WHERE id = ?', [acc.id]).catch(() => {});
  }
  await db.end();
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
