// Teste da loja no servidor de verdade: cria um personagem, da gold e level, compra um item,
// confere o equipamento e o banco, e apaga a conta de teste.
// Uso (dentro do container da ponte): VOC=sorcerer LEVEL=20 ITEM=3072 node teste_loja.js
const crypto = require('crypto');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');

const base = 'http://127.0.0.1:8184/jogar/api';
const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const expFor = (lv) => Math.floor((50 * (lv - 1) ** 3 - 150 * (lv - 1) ** 2 + 400 * (lv - 1)) / 3);

(async () => {
  const db = await mysql.createConnection({ host: 'db', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const L = Number(process.env.LEVEL || 20);
  const email = `loja-${crypto.randomBytes(3).toString('hex')}@exemplo.invalid`;
  const name = 'Loja ' + [...crypto.randomBytes(6)].map((b) => 'abcdefghij'[b % 10]).join('');
  const reg = await post('/cadastrar', { email, password: crypto.randomBytes(12).toString('hex'), name, vocation: process.env.VOC || 'sorcerer', sex: 'male' });
  if (reg.erro) throw new Error(reg.erro);
  await db.query('UPDATE players SET level = ?, experience = ?, balance = 20000 WHERE name = ?', [L, expFor(L), name]);

  const ws = new WebSocket(`ws://127.0.0.1:8184/jogar/api/ws?token=${reg.token}&char=${encodeURIComponent(name)}`);
  let last = null;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'state') last = m;
    if (m.t === 'msg') console.log('msg:', m.kind || 'info', m.text);
  });
  await new Promise((r) => ws.on('open', r));
  // espera o equipamento inicial aparecer (o personagem entra para gravar)
  for (let i = 0; i < 20 && !(last && last.gear); i++) await new Promise((r) => setTimeout(r, 1000));
  const show = (g) => Object.entries(g?.slots || {}).map(([k, v]) => `${k}=${v.name}${v.count > 1 ? 'x' + v.count : ''}`).join(', ');
  console.log('equipamento inicial:', show(last && last.gear), '| banco:', last && last.gear && last.gear.bank);
  const item = Number(process.env.ITEM || 3072);
  ws.send(JSON.stringify({ t: 'buy', id: item }));
  const t0 = Date.now();
  let res = null;
  while (Date.now() - t0 < 20000) {
    await new Promise((r) => setTimeout(r, 1000));
    const msg = last && last.gear && last.gear.msg;
    if (msg && msg.text) { res = msg; break; }
  }
  console.log('resultado da compra:', res ? `${res.ok ? 'OK' : 'FALHOU'} - ${res.text}` : 'sem resposta');
  console.log('equipamento depois:', show(last && last.gear), '| banco:', last && last.gear && last.gear.bank);
  ws.close();

  await new Promise((r) => setTimeout(r, 2000));
  const [[pl]] = await db.query('SELECT id, account_id FROM players WHERE name = ?', [name]);
  for (const t of ['idle_state', 'idle_settings', 'idle_gear']) await db.query(`DELETE FROM ${t} WHERE player_id = ?`, [pl.id]);
  await db.query('DELETE FROM players WHERE id = ?', [pl.id]);
  await db.query('DELETE FROM accounts WHERE id = ?', [pl.account_id]);
  console.log('conta de teste apagada');
  await db.end();
  process.exit(0);
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});
