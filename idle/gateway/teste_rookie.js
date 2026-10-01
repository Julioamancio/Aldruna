// Teste do comeco como no Huntera: personagem sem vocacao (level 1) caca; no level 8 escolhe a vocacao,
// ganha o kit na bolsa e veste uma peca. Roda dentro do container do gateway. Apaga as contas no fim.
const crypto = require('crypto');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const base = 'http://127.0.0.1:8184/jogar/api';
// a tela do codigo de acesso: o teste usa a mesma liberacao (cookie) que a pagina ganha
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const cookie = process.env.ACCESS_CODE ? 'dt_acesso=' + crypto.createHmac('sha256', norm(process.env.ACCESS_CODE)).update('destruitor-idle-acesso').digest('hex') : '';
const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) })).json();
const get = async (p, token) => (await fetch(base + p, { headers: { Cookie: cookie, 'x-token': token } })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let db;

async function account(tag) {
  const email = `teste-${crypto.randomBytes(3).toString('hex')}@exemplo.invalid`;
  const name = 'Rook ' + tag + [...crypto.randomBytes(4)].map((b) => 'abcdefghij'[b % 10]).join('');
  const reg = await post('/cadastrar', { email, password: crypto.randomBytes(12).toString('hex'), name, sex: 'male' });
  if (!reg.token) throw new Error('cadastro: ' + JSON.stringify(reg));
  return { email, name, token: reg.token };
}

function connect(acc) {
  const ws = new WebSocket(`ws://127.0.0.1:8184/jogar/api/ws?token=${acc.token}&char=${encodeURIComponent(acc.name)}`, { headers: { Cookie: cookie } });
  const me = { ws, st: null, settings: null, msgs: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'state') me.st = m;
    if (m.t === 'settings') me.settings = m.settings;
    if (m.t === 'msg') me.msgs.push(m.text);
  });
  return new Promise((ok, fail) => { ws.on('open', () => ok(me)); ws.on('error', fail); });
}

(async () => {
  db = await mysql.createConnection({ host: 'db', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  // 1) novo personagem: level 1, sem vocacao, mochila, barra vazia; vocacao antes do 8 nao pode
  const a = await account('A');
  const A = await connect(a);
  await sleep(9000);
  const p = A.st?.player || {};
  console.log('criado:', a.name, '| level', p.level, '| vocacao', p.vocation, '(id', p.vocId + ')', '| vida', p.hp + '/' + p.maxHp, '| barra', (A.settings?.bar || []).length, 'regras | bolsa', JSON.stringify(A.st?.gear?.bolsa));
  A.ws.send(JSON.stringify({ t: 'vocacao', voc: 'knight' }));
  await sleep(2500);
  console.log('vocacao no level 1:', A.st?.gear?.msg?.text || '(sem resposta)');
  // 1b) tutorial: arma inicial (espada) vai para a bolsa e veste; passo do tutorial fica salvo
  A.ws.send(JSON.stringify({ t: 'arma', which: 'espada' }));
  await sleep(2500);
  const esp = (A.st?.gear?.bolsa || []).find((x) => x.name === 'longsword');
  console.log('arma inicial:', A.st?.gear?.msg?.text, '| na bolsa:', esp ? 'longsword' : '(nada)');
  if (esp) {
    A.ws.send(JSON.stringify({ t: 'equip', i: esp.i }));
    await sleep(3500);
    console.log('vestiu:', A.st?.gear?.slots?.mao1?.name || '(nada)');
  }
  A.ws.send(JSON.stringify({ t: 'arma', which: 'arco' }));
  await sleep(2000);
  console.log('segunda arma:', A.st?.gear?.msg?.text);
  A.ws.send(JSON.stringify({ t: 'tut', step: 5 }));
  await sleep(500);
  // 2) cacar sem vocacao (a cacada mais facil do catalogo), com a espada
  const cat = await get('/catalogo', a.token);
  const hunt = cat.hunts.slice().sort((x, y) => x.min - y.min)[0];
  A.ws.send(JSON.stringify({ t: 'start', hunt: hunt.id }));
  await sleep(60000);
  const i = A.st?.idle || {};
  console.log('cacada sem vocacao:', hunt.name, '| cacando', !!i.hunting, '| abates', i.killCount || 0, '| xp', i.xp || 0, '| vida', i.hp + '/' + i.maxHp);
  console.log('bonus de level na ficha:', A.st?.char?.bonus + '%');
  const [[tutRow]] = await db.query('SELECT tut FROM idle_settings s JOIN players p ON p.id = s.player_id WHERE p.name = ?', [a.name]);
  console.log('passo do tutorial salvo:', tutRow && tutRow.tut);
  A.ws.send(JSON.stringify({ t: 'stop' }));
  await sleep(4000);
  A.ws.close();

  // 3) level 8 (o personagem e criado e posto no level 8 antes de entrar), escolhe Knight, ganha o kit e veste
  const b = await account('B');
  await db.query('UPDATE players SET level = 8, experience = 4200, health = 185, healthmax = 185, mana = 35, manamax = 35 WHERE name = ?', [b.name]);
  const B = await connect(b);
  await sleep(9000);
  const bank0 = B.st?.player?.bank || 0;
  B.ws.send(JSON.stringify({ t: 'vocacao', voc: 'knight' }));
  await sleep(4000);
  const g = B.st?.gear || {};
  console.log('vocacao no 8:', g.msg?.text, '| vocacao agora', B.st?.player?.vocation, '| gold', bank0, '->', B.st?.player?.bank);
  console.log('bolsa:', (g.bolsa || []).map((x) => `${x.i}:${x.name}${x.count > 1 ? ' x' + x.count : ''}${x.veste ? '' : ' (nao veste)'}`).join(', '));
  console.log('barra da vocacao:', (B.settings?.bar || []).map((x) => x.action).join(', ') || '(vazia)');
  const sword = (g.bolsa || []).find((x) => x.name === 'sword');
  if (sword) {
    B.ws.send(JSON.stringify({ t: 'equip', i: sword.i }));
    await sleep(3000);
    console.log('vestir a espada:', B.st?.gear?.msg?.text, '| mao:', B.st?.gear?.slots?.mao1?.name, '| bolsa agora', (B.st?.gear?.bolsa || []).length, 'itens');
  }
  B.ws.close();
  await sleep(2000);
  for (const acc of [a, b]) {
    const [[row]] = await db.query('SELECT id FROM accounts WHERE email = ?', [acc.email]);
    if (!row) continue;
    const [pl] = await db.query('SELECT id FROM players WHERE account_id = ?', [row.id]);
    for (const x of pl) for (const t of ['idle_state', 'idle_settings', 'idle_town', 'idle_bag', 'idle_gear', 'idle_char', 'idle_records']) await db.query(`DELETE FROM ${t} WHERE player_id = ?`, [x.id]).catch(() => {});
    await db.query('DELETE FROM players WHERE account_id = ?', [row.id]).catch(() => console.log('(personagem ainda online: apaga depois)'));
    await db.query('DELETE FROM accounts WHERE id = ?', [row.id]).catch(() => {});
  }
  console.log('contas de teste apagadas');
  await db.end();
  process.exit(0);
})().catch(async (e) => { console.error('FALHOU:', e); process.exit(1); });
