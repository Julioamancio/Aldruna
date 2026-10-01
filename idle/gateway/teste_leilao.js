// Teste do LEILAO no servidor de verdade (Canary + ponte): cria um vendedor e um comprador, anuncia, compra
// parte, cancela o resto, vende com o vendedor fora do jogo (o gold fica pendente e chega quando ele volta),
// deixa uma oferta expirar e confere banco, mochila, historico e pendencias. Apaga tudo no fim.
// Uso (dentro do container da ponte, depois de publicar):
//   docker compose cp gateway/teste_leilao.js gateway:/app/ && docker compose exec -T gateway node teste_leilao.js
// (demora uns 3 minutos: espera o vendedor sair do jogo e a varredura de ofertas vencidas)
const crypto = require('crypto');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');

const base = 'http://127.0.0.1:8184/jogar/api';
const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0;
const check = (cond, text) => {
  if (cond) ok++;
  else bad++;
  console.log(`${cond ? 'ok    ' : 'FALHOU'} ${text}`);
};

(async () => {
  const db = await mysql.createConnection({ host: 'db', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  const one = async (sql, p = []) => (await db.query(sql, p))[0][0];
  const cat = await one("SELECT data FROM idle_catalog WHERE name = 'leilao'");
  if (!cat) throw new Error('sem catalogo do leilao: o idle_leilao.lua subiu? (reiniciar o server)');
  const C = JSON.parse(cat.data);
  // um item barato e leve (o comprador precisa aguentar o peso)
  const [itemId, itemName, npc] = C.items.find(([, , n, w]) => n >= 100 && n <= 3000 && w <= 2000) || C.items[0];
  const price = npc * 2;
  console.log(`item do teste: ${itemName} (${itemId}), NPC ${npc}, anunciado a ${price}`);

  const tag = crypto.randomBytes(3).toString('hex');
  const mk = async (who) => {
    const email = `leilao-${who}-${tag}@exemplo.invalid`;
    const name = `Leilao ${who} ` + [...crypto.randomBytes(4)].map((b) => 'abcdefghij'[b % 10]).join('');
    const reg = await post('/cadastrar', { email, password: crypto.randomBytes(12).toString('hex'), name, vocation: 'knight', sex: 'male' });
    if (reg.erro) throw new Error(reg.erro);
    const p = await one('SELECT id, account_id FROM players WHERE name = ?', [name]);
    return { name, token: reg.token, id: p.id, account: p.account_id };
  };
  const A = await mk('Vende');
  const B = await mk('Compra');
  // antes de entrar: gold e mochila (o servidor le a mochila do banco quando o personagem aparece)
  await db.query('UPDATE players SET balance = 10000 WHERE id = ?', [A.id]);
  await db.query('UPDATE players SET balance = 200000 WHERE id = ?', [B.id]);
  await db.query("INSERT INTO idle_bag (player_id, updated, items, dispatch_at, data) VALUES (?, UNIX_TIMESTAMP(), ?, 0, '{}') ON DUPLICATE KEY UPDATE items = VALUES(items)", [A.id, `${itemId}:5`]);

  const conecta = (P) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:8184/jogar/api/ws?token=${P.token}&char=${encodeURIComponent(P.name)}`);
    const c = { ws, avisos: [], msgs: [], last: {} };
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'leilao') {
        c.last[m.op] = m;
        if (m.op === 'aviso' || m.op === 'recusado') c.avisos.push(m);
      }
      if (m.t === 'msg') c.msgs.push(m.text);
    });
    ws.on('open', () => resolve(c));
  });
  const pede = async (c, m) => c.ws.send(JSON.stringify({ t: 'leilao', ...m }));
  const espera = async (c, re, ms = 25000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const a = c.avisos.find((x) => re.test(x.texto));
      if (a) {
        c.avisos = c.avisos.filter((x) => x !== a);
        return a;
      }
      await sleep(500);
    }
    return null;
  };
  const bal = async (P) => Number((await one('SELECT balance FROM players WHERE id = ?', [P.id])).balance);
  const bag = async (P) => {
    const r = await one('SELECT items FROM idle_bag WHERE player_id = ?', [P.id]);
    const m = new Map(String((r && r.items) || '').split(',').filter(Boolean).map((x) => x.split(':').map(Number)));
    return m.get(itemId) || 0;
  };

  const ca = await conecta(A);
  await sleep(6000); // entra no jogo
  // 1) anunciar 3
  await pede(ca, { op: 'anunciar', item: itemId, qtd: 3, preco: price, dias: 1 });
  const a1 = await espera(ca, /está no leilão|Você|não/);
  check(a1 && a1.ok, `anunciar: ${a1 && a1.texto}`);
  const off = await one("SELECT id, `count`, fee, status FROM idle_auction WHERE seller_id = ? AND status = 'ativo' ORDER BY id DESC LIMIT 1", [A.id]);
  const fee = Math.min(C.cfg.taxaMax, Math.max(C.cfg.taxaMin, Math.floor((3 * price * C.cfg.taxaPct) / 100)));
  check(off && off.count === 3 && Number(off.fee) === fee, `oferta no banco: ${JSON.stringify(off)} (taxa esperada ${fee})`);
  check((await bag(A)) === 2, 'mochila do vendedor: 5 - 3 = 2');
  check((await bal(A)) === 10000 - fee, `banco do vendedor: 10000 - taxa = ${10000 - fee} (${await bal(A)})`);

  // 2) comprar 2 (vendedor no jogo)
  const cb = await conecta(B);
  await sleep(6000);
  await pede(cb, { op: 'comprar', id: off.id, qtd: 2 });
  const b1 = await espera(cb, /Comprou|não|Essa|Sua mochila|precisa/);
  check(b1 && b1.ok, `comprar 2: ${b1 && b1.texto}`);
  const v1 = await espera(ca, /Vendeu/);
  check(!!v1, `aviso do vendedor: ${v1 && v1.texto}`);
  await sleep(2000);
  const total = 2 * price, com = Math.floor((total * C.cfg.comissaoPct) / 100);
  check((await bal(B)) === 200000 - total, `banco do comprador: ${200000 - total} (${await bal(B)})`);
  check((await bag(B)) === 2, 'mochila do comprador: 2');
  check((await bal(A)) === 10000 - fee + total - com, `banco do vendedor depois da venda: ${10000 - fee + total - com} (${await bal(A)})`);
  const o2 = await one('SELECT `count`, status FROM idle_auction WHERE id = ?', [off.id]);
  check(o2.count === 1 && o2.status === 'ativo', `oferta ficou com 1: ${JSON.stringify(o2)}`);
  const h = await one("SELECT `count`, total, fee, buyer_id FROM idle_auction_history WHERE auction_id = ? AND tipo = 'venda'", [off.id]);
  check(h && h.count === 2 && Number(h.fee) === com && h.buyer_id === B.id, `historico da venda: ${JSON.stringify(h)}`);

  // 3) recusas: comprar a propria, comprar mais do que tem
  await pede(ca, { op: 'comprar', id: off.id, qtd: 1 });
  check(!!(await espera(ca, /própria oferta/)), 'nao compra a propria oferta');
  await sleep(900);
  await pede(cb, { op: 'comprar', id: off.id, qtd: 5 });
  check(!!(await espera(cb, /não tem mais essa quantidade/)), 'nao compra mais do que a oferta tem');

  // 4) cancelar o resto: o item volta
  await sleep(900);
  await pede(ca, { op: 'cancelar', id: off.id });
  const c1 = await espera(ca, /cancelada|não/);
  check(c1 && c1.ok, `cancelar: ${c1 && c1.texto}`);
  await sleep(1500);
  check((await bag(A)) === 3, 'mochila do vendedor: 2 + 1 de volta = 3');
  check((await one('SELECT status FROM idle_auction WHERE id = ?', [off.id])).status === 'cancelado', 'oferta cancelada');

  // 5) vendedor fora do jogo: o gold fica pendente e chega quando ele entra
  await sleep(900);
  await pede(ca, { op: 'anunciar', item: itemId, qtd: 1, preco: price, dias: 1 });
  check(!!(await espera(ca, /está no leilão/)), 'anunciou 1 para vender com o vendedor fora');
  const off2 = await one("SELECT id FROM idle_auction WHERE seller_id = ? AND status = 'ativo' ORDER BY id DESC LIMIT 1", [A.id]);
  const balA = await bal(A);
  ca.ws.close();
  console.log('esperando o vendedor sair do jogo (ate 90 s)…');
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const st = await one('SELECT updated FROM idle_town WHERE player_id = ?', [A.id]).catch(() => null);
    if (!st || Date.now() / 1000 - st.updated > 8) break;
  }
  await sleep(4000);
  await pede(cb, { op: 'comprar', id: off2.id, qtd: 1 });
  check(!!(await espera(cb, /Comprou/)), 'comprou com o vendedor fora do jogo');
  await sleep(3000);
  const pend = await one('SELECT gold, delivered FROM idle_auction_pending WHERE player_id = ? AND auction_id = ?', [A.id, off2.id]);
  const pay = price - Math.floor((price * C.cfg.comissaoPct) / 100);
  check(pend && Number(pend.gold) === pay && pend.delivered === 0, `pendente para o vendedor: ${JSON.stringify(pend)}`);
  check((await bal(A)) === balA, 'banco do vendedor nao mudou enquanto ele esta fora');
  const ca2 = await conecta(A);
  console.log('vendedor voltou: esperando a entrega…');
  for (let i = 0; i < 15 && (await one('SELECT delivered FROM idle_auction_pending WHERE player_id = ? AND auction_id = ?', [A.id, off2.id])).delivered === 0; i++) await sleep(2000);
  await sleep(1500);
  check((await bal(A)) === balA + pay, `gold entregue quando ele entrou: ${balA + pay} (${await bal(A)})`);

  // 6) oferta vencida: o item volta sozinho (a varredura roda a cada 30 s)
  await sleep(900);
  await pede(ca2, { op: 'anunciar', item: itemId, qtd: 2, preco: price, dias: 1 });
  check(!!(await espera(ca2, /está no leilão/)), 'anunciou 2 para expirar');
  const off3 = await one("SELECT id FROM idle_auction WHERE seller_id = ? AND status = 'ativo' ORDER BY id DESC LIMIT 1", [A.id]);
  const bagA = await bag(A);
  await db.query('UPDATE idle_auction SET expires = UNIX_TIMESTAMP() - 1 WHERE id = ?', [off3.id]); // so no teste
  const e1 = await espera(ca2, /expirou/, 45000);
  check(!!e1, `aviso de expirada: ${e1 && e1.texto}`);
  await sleep(1500);
  check((await one('SELECT status FROM idle_auction WHERE id = ?', [off3.id])).status === 'expirado', 'oferta expirada');
  check((await bag(A)) === bagA + 2, 'os 2 itens voltaram para a mochila');

  ca2.ws.close();
  cb.ws.close();
  // limpeza
  await sleep(2000);
  for (const P of [A, B]) {
    for (const t of ['idle_state', 'idle_settings', 'idle_gear', 'idle_bag', 'idle_char', 'idle_town', 'idle_auction_pending', 'idle_auction_msg']) await db.query(`DELETE FROM ${t} WHERE player_id = ?`, [P.id]).catch(() => {});
    await db.query('DELETE FROM idle_auction WHERE seller_id = ?', [P.id]);
    await db.query('DELETE FROM idle_auction_history WHERE seller_id = ? OR buyer_id = ?', [P.id, P.id]);
  }
  console.log('esperando os dois sairem do jogo para apagar as contas…');
  await sleep(75000);
  for (const P of [A, B]) {
    await db.query('DELETE FROM players WHERE id = ?', [P.id]);
    await db.query('DELETE FROM accounts WHERE id = ?', [P.account]);
  }
  console.log(`\n${ok} ok, ${bad} falharam (contas de teste apagadas)`);
  await db.end();
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exit(1);
});
