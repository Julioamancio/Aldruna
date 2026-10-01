'use strict';
// Testes do LEILAO que rodam nesta maquina, sem servidor e sem MariaDB:  node teste_leilao_local.js
//   1) regras (public/leilao_regras.js)
//   2) a ponte (leilao.js) contra um SQLite em memoria com as mesmas tabelas
//   3) o SQL do idle_leilao.lua: cada comando que o Lua monta e preparado no SQLite (coluna ou tabela com
//      nome errado aparece aqui) e as tabelas do Lua conferem com as da ponte
// (o teste de ponta a ponta, com o Canary de verdade, e o teste_leilao.js, dentro do container)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DatabaseSync } = require('node:sqlite');
const R = require('./public/leilao_regras.js');
const Leilao = require('./leilao.js');
const { lex } = require('../tools/checa_lua.js');

const LUA = path.join(__dirname, '..', 'canary', 'scripts', 'idle', 'idle_leilao.lua');
let passes = 0, fails = 0;
async function test(name, fn) {
  try {
    await fn();
    passes++;
    console.log('ok      ', name);
  } catch (e) {
    fails++;
    console.log('FALHOU  ', name, '\n         ' + String(e.stack || e).split('\n').slice(0, 4).join('\n         '));
  }
}
const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------- SQLite com as tabelas do jogo
function toSqlite(sql) {
  return sql
    .replace(/\)\s*ENGINE=\w+\s+DEFAULT CHARSET=\w+/i, ')')
    .replace(/`?id`?\s+INT UNSIGNED NOT NULL AUTO_INCREMENT/i, 'id INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/,\s*PRIMARY KEY \(`?id`?\)/i, '')
    .replace(/,\s*KEY `?\w+`? \([^)]*\)/g, '')
    .replace(/UNSIGNED/g, '');
}
function novoBanco() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, premdays INT NOT NULL DEFAULT 0);
    CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT NOT NULL, account_id INT NOT NULL, balance INT NOT NULL DEFAULT 0);
    CREATE TABLE idle_bag (player_id INT PRIMARY KEY, updated INT NOT NULL, items TEXT NOT NULL, dispatch_at INT NOT NULL DEFAULT 0, data TEXT NOT NULL);
    CREATE TABLE idle_state (player_id INT PRIMARY KEY, updated INT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE idle_commands (id INTEGER PRIMARY KEY AUTOINCREMENT, player_name TEXT NOT NULL, cmd TEXT NOT NULL, arg TEXT NOT NULL DEFAULT '', created INT NOT NULL);
    CREATE TABLE idle_catalog (name TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  for (const sql of Leilao.SQL) db.exec(toSqlite(sql));
  return db;
}
function makeQ(db) {
  return async (sql, params = []) => {
    const st = db.prepare(sql);
    if (/^\s*(SELECT|WITH)\b/i.test(sql)) return st.all(...params);
    const r = st.run(...params);
    return { affectedRows: r.changes, insertId: Number(r.lastInsertRowid) };
  };
}

// ---------------------------------------------------------------------------- 1) regras
(async () => {
  console.log('--- regras');
  const C = R.CFG;
  await test('taxa: 2% com minimo 20 e maximo 500 mil', () => {
    assert.strictEqual(R.taxa(C, 100), 20);
    assert.strictEqual(R.taxa(C, 1000), 20);
    assert.strictEqual(R.taxa(C, 1001), 20);
    assert.strictEqual(R.taxa(C, 10000), 200);
    assert.strictEqual(R.taxa(C, 12345), 246);
    assert.strictEqual(R.taxa(C, 2000000000), 500000);
  });
  await test('comissao 3% (arredonda para baixo) e conta do vendedor', () => {
    assert.strictEqual(R.comissao(C, 999), 29);
    const c = R.conta(C, 3, 10000);
    assert.deepStrictEqual(c, { total: 30000, taxa: 600, comissao: 900, recebe: 29100, liquido: 28500 });
  });
  await test('inteiro: aceita "1200", recusa 1.5, -3, "1e3", ""', () => {
    assert.strictEqual(R.inteiro('1200'), 1200);
    assert.strictEqual(R.inteiro(7), 7);
    for (const v of [1.5, '1e3', '', '-3', null, undefined, 'abc', {}]) assert.ok(Number.isNaN(R.inteiro(v)), String(v));
  });
  const base = { npc: 1000, tem: 5, qtd: 2, preco: 1500, dias: 7, ativos: 0, premium: false, cacando: false, banco: 100000 };
  await test('validarAnuncio: caso bom passa', () => assert.strictEqual(R.validarAnuncio(C, base), null));
  await test('validarAnuncio: cada recusa, na ordem do Lua', () => {
    const v = (x) => R.validarAnuncio(C, { ...base, ...x });
    assert.match(v({ cacando: true }), /só negocia na cidade/);
    assert.match(v({ npc: 0 }), /não pode ser vendido/);
    assert.match(v({ qtd: 0 }), /Quantidade inválida/);
    assert.match(v({ qtd: '2.5' }), /Quantidade inválida/);
    assert.match(v({ qtd: 10001, tem: 20000 }), /No máximo 10.000 unidades/);
    assert.match(v({ qtd: 6 }), /não tem essa quantidade/);
    assert.match(v({ preco: 0 }), /Ponha um preço/);
    assert.match(v({ preco: 100000001 }), /preço máximo é 100.000.000/);
    assert.match(v({ preco: 999 }), /mínimo é o valor no NPC: 1.000/);
    assert.match(v({ qtd: 100, tem: 100, preco: 30000000 }), /total da oferta passa de 2.000.000.000/);
    assert.match(v({ dias: 2 }), /1, 3 ou 7 dias/);
    assert.match(v({ ativos: 10 }), /já tem 10 ofertas ativas/);
    assert.strictEqual(v({ ativos: 10, premium: true }), null);
    assert.match(v({ ativos: 25, premium: true }), /já tem 25 ofertas ativas/);
    assert.match(v({ banco: 19 }), /taxa de 60 de gold/);
  });
  await test('validarAnuncio: sem mochila/limite/banco conhecidos (bots) nao recusa por eles', () => {
    assert.strictEqual(R.validarAnuncio(C, { ...base, tem: null, ativos: null, banco: null, qtd: 9000 }), null);
  });
  await test('validarCompra', () => {
    const o = { count: 3, price: 100, expires: 2000, seller_id: 9, status: 'ativo' };
    const v = (x) => R.validarCompra(C, { oferta: o, eu: 1, qtd: 1, banco: 1000, agora: 1000, cacando: false, ...x });
    assert.strictEqual(v({}), null);
    assert.match(v({ oferta: null }), /não existe mais/);
    assert.match(v({ oferta: { ...o, status: 'vendido' } }), /não existe mais/);
    assert.match(v({ oferta: { ...o, status: 'reservado' } }), /sendo comprada/);
    assert.match(v({ agora: 2000 }), /expirou/);
    assert.match(v({ eu: 9 }), /sua própria oferta/);
    assert.match(v({ qtd: 4 }), /não tem mais essa quantidade/);
    assert.match(v({ qtd: 0 }), /Quantidade inválida/);
    assert.match(v({ qtd: 3, banco: 299 }), /precisa de 300 de gold/);
    assert.match(v({ cacando: true }), /só negocia na cidade/);
  });
  await test('precoMedio: media ponderada, mediana resiste a um negocio fora da curva', () => {
    const s = R.precoMedio([{ count: 1, price: 4800 }, { count: 2, price: 5200 }, { count: 1, price: 5000 }, { count: 1, price: 100000 }]);
    assert.strictEqual(s.n, 4);
    assert.strictEqual(s.mediana, 5100);
    assert.strictEqual(s.media, Math.round((4800 + 10400 + 5000 + 100000) / 5));
    assert.strictEqual(s.min, 4800);
    assert.strictEqual(s.max, 100000);
    assert.deepStrictEqual(R.precoMedio([]), { n: 0, media: 0, mediana: 0, min: 0, max: 0 });
    assert.strictEqual(R.precoMedio([{ count: 5, price: 7 }]).mediana, 7);
  });
  await test('avisoPreco (+-30%) e precoJusto', () => {
    assert.strictEqual(R.avisoPreco(C, 1200, 1000), null);
    assert.match(R.avisoPreco(C, 1300, 1000).texto, /30% acima/);
    assert.match(R.avisoPreco(C, 600, 1000).texto, /40% abaixo/);
    assert.strictEqual(R.avisoPreco(C, 600, 0), null);
    assert.strictEqual(R.arredondar(1234), 1200);
    assert.strictEqual(R.arredondar(98765), 99000);
    assert.strictEqual(R.arredondar(57), 57);
    assert.strictEqual(R.precoJusto(1000, { n: 0 }), 1300); // 1000 + 25% = 1250 -> 2 algarismos: 1300
    assert.strictEqual(R.precoJusto(1000, { n: 3, mediana: 900 }), 1000); // nunca abaixo do NPC
    assert.strictEqual(R.precoJusto(1000, { n: 3, mediana: 4321 }), 4300);
  });
  await test('lerMochila e tempoRestante', () => {
    const m = R.lerMochila('3031:5,3035:2,lixo,0:3,3031:1');
    assert.strictEqual(m.get(3031), 6);
    assert.strictEqual(m.get(3035), 2);
    assert.strictEqual(m.size, 2);
    assert.strictEqual(R.tempoRestante(6 * 86400 + 4 * 3600 + 50), '6d 4h');
    assert.strictEqual(R.tempoRestante(3 * 3600 + 5 * 60), '3h 05min');
    assert.strictEqual(R.tempoRestante(12 * 60), '12min');
    assert.strictEqual(R.tempoRestante(20), 'menos de 1min');
  });

  // -------------------------------------------------------------------------- 2) ponte
  console.log('--- ponte (leilao.js) contra SQLite');
  const db = novoBanco();
  const q = makeQ(db);
  const t = now();
  const cmds = [];
  const links = { calls: 0, ok: true };
  const command = async (player, cmd, arg = '') => {
    cmds.push({ name: player.name, cmd, arg });
    await q('INSERT INTO idle_commands (player_name, cmd, arg, created) VALUES (?, ?, ?, ?)', [player.name, cmd, arg, now()]);
  };
  const ensureLink = async () => {
    links.calls++;
    return links.ok ? { ok: true } : { ok: false, error: 'O servidor do jogo não respondeu.' };
  };
  const L = Leilao.create({ q, command, ensureLink });
  const ana = { id: 1, name: 'Ana', account_id: 1 };
  const bruno = { id: 2, name: 'Bruno', account_id: 2 };
  const bot = { id: 3, name: 'Velho Jack', account_id: 3 };
  db.exec(`INSERT INTO accounts (id, premdays) VALUES (1, 0), (2, 30), (3, 0);
    INSERT INTO players (id, name, account_id, balance) VALUES (1, 'Ana', 1, 50000), (2, 'Bruno', 2, 900000), (3, 'Velho Jack', 3, 0);`);
  const catalogo = { cfg: R.CFG, items: [[3381, 'crown armor', 12000, 9900, 'armadura', 0], [3577, 'meat', 2, 1300, 'outros', 0], [3416, 'dragon shield', 4000, 6000, 'escudo', 0], [3392, 'royal helmet', 30000, 4800, 'capacete', 50], [5877, 'green dragon leather', 100, 400, 'outros', 0]] };
  db.prepare("INSERT INTO idle_catalog (name, data) VALUES ('leilao', ?)").run(JSON.stringify(catalogo));
  db.prepare('INSERT INTO idle_bag (player_id, updated, items, dispatch_at, data) VALUES (?, ?, ?, 0, ?)').run(1, t, '3381:2,3577:100,5877:3', '{}');
  const ins = db.prepare("INSERT INTO idle_auction (seller_id, seller_name, item_id, item_name, kind, `count`, price, fee, created, expires, status, origem) VALUES (?, ?, ?, ?, ?, ?, ?, 20, ?, ?, ?, 'jogador')");
  const o1 = Number(ins.run(2, 'Bruno', 3416, 'dragon shield', 'escudo', 1, 5000, t - 100, t + 86400, 'ativo').lastInsertRowid);
  const o2 = Number(ins.run(3, 'Velho Jack', 3416, 'dragon shield', 'escudo', 2, 4500, t - 50, t + 3600, 'ativo').lastInsertRowid);
  const o3 = Number(ins.run(2, 'Bruno', 3577, 'meat', 'outros', 50, 3, t - 10, t + 7 * 86400, 'ativo').lastInsertRowid);
  const o4 = Number(ins.run(2, 'Bruno', 3381, 'crown armor', 'armadura', 1, 15000, t - 9000, t - 1, 'ativo').lastInsertRowid); // vencida, ainda nao varrida
  ins.run(2, 'Bruno', 3381, 'crown armor', 'armadura', 1, 15000, t - 9000, t + 999, 'cancelado');
  const o6 = Number(ins.run(1, 'Ana', 3392, 'royal helmet', 'capacete', 1, 40000, t - 5, t + 86400, 'ativo').lastInsertRowid);
  const insH = db.prepare('INSERT INTO idle_auction_history (auction_id, tipo, item_id, item_name, `count`, price, total, fee, seller_id, seller_name, buyer_id, buyer_name, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [c, p] of [[1, 4800], [2, 5200], [1, 5000], [1, 100000]]) insH.run(99, 'venda', 3416, 'dragon shield', c, p, c * p, Math.floor((c * p * 3) / 100), 2, 'Bruno', 1, 'Ana', t - 3600);
  insH.run(98, 'venda', 3416, 'dragon shield', 1, 1, 1, 0, 2, 'Bruno', 1, 'Ana', t - 40 * 86400); // velho: fora da media
  insH.run(97, 'expirado', 3577, 'meat', 10, 3, 30, 0, 1, 'Ana', 0, '', t - 600);
  db.prepare('INSERT INTO idle_auction_pending (player_id, gold, item_id, `count`, motivo, auction_id, texto, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(1, 1940, 0, 0, 'venda', 99, 'x', t);
  db.prepare('INSERT INTO idle_auction_pending (player_id, gold, item_id, `count`, motivo, auction_id, texto, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(1, 0, 3577, 10, 'expirado', 97, 'x', t);

  await test('catalogo: regras e itens do idle_catalog', async () => {
    const c = await L.catalogo();
    assert.strictEqual(c.items.size, 5);
    assert.strictEqual(c.items.get(3392).lv, 50);
    assert.strictEqual(c.cfg.taxaPct, 2);
  });
  await test('lista: so ativas e nao vencidas, a mais barata primeiro, com media e "minha"', async () => {
    const r = await L.lista(ana, {});
    assert.strictEqual(r.total, 4);
    assert.deepStrictEqual(r.ofertas.map((o) => o.id), [o3, o2, o1, o6]);
    const ds = r.ofertas.find((o) => o.id === o1);
    assert.strictEqual(ds.npc, 4000);
    assert.strictEqual(ds.negocios, 4);
    assert.strictEqual(ds.media, Math.round((4800 + 10400 + 5000 + 100000) / 5));
    assert.strictEqual(r.ofertas.find((o) => o.id === o6).minha, true);
    assert.strictEqual(r.ofertas.find((o) => o.id === o6).lv, 50);
    assert.ok(!r.ofertas.some((o) => o.id === o4), 'oferta vencida nao aparece');
  });
  await test('lista: busca, tipo, itens que eu tenho, ordens', async () => {
    assert.deepStrictEqual((await L.lista(ana, { busca: 'DRAGON' })).ofertas.map((o) => o.id), [o2, o1]);
    assert.strictEqual((await L.lista(ana, { busca: '%' })).total, 0); // % e literal
    assert.strictEqual((await L.lista(ana, { busca: '_' })).total, 0);
    assert.deepStrictEqual((await L.lista(ana, { tipo: 'outros' })).ofertas.map((o) => o.id), [o3]);
    assert.strictEqual((await L.lista(ana, { tipo: 'nao-existe' })).total, 4); // tipo desconhecido = todos
    assert.deepStrictEqual((await L.lista(ana, { ids: [3577, 3381] })).ofertas.map((o) => o.id), [o3]);
    assert.strictEqual((await L.lista(ana, { ids: [] })).total, 0);
    assert.deepStrictEqual((await L.lista(ana, { ordem: 'caro' })).ofertas.map((o) => o.id), [o6, o1, o2, o3]);
    assert.deepStrictEqual((await L.lista(ana, { ordem: 'termina' })).ofertas.map((o) => o.id), [o2, o1, o6, o3]);
    assert.deepStrictEqual((await L.lista(ana, { ordem: 'novos' })).ofertas.map((o) => o.id), [o6, o3, o2, o1]);
    assert.deepStrictEqual((await L.lista(ana, { ordem: 'nome' })).ofertas.map((o) => o.id), [o2, o1, o3, o6]);
    assert.deepStrictEqual((await L.lista(ana, { ordem: "x'; DROP TABLE idle_auction; --" })).ofertas.map((o) => o.id), [o3, o2, o1, o6]);
  });
  await test('lista: paginas de 40', async () => {
    const db2 = novoBanco();
    const L2 = Leilao.create({ q: makeQ(db2), command, ensureLink });
    const i2 = db2.prepare("INSERT INTO idle_auction (seller_id, seller_name, item_id, item_name, kind, `count`, price, fee, created, expires, status) VALUES (2, 'Bruno', 3577, 'meat', 'outros', 1, ?, 0, ?, ?, 'ativo')");
    for (let k = 1; k <= 45; k++) i2.run(k, t, t + 999);
    const p0 = await L2.lista(ana, { pagina: 0 });
    const p1 = await L2.lista(ana, { pagina: 1 });
    assert.strictEqual(p0.total, 45);
    assert.strictEqual(p0.ofertas.length, 40);
    assert.deepStrictEqual(p1.ofertas.map((o) => o.preco), [41, 42, 43, 44, 45]);
  });
  await test('item: ofertas do item, ultimos negocios e preco medio', async () => {
    const r = await L.item(ana, 3416);
    assert.strictEqual(r.item.nome, 'dragon shield');
    assert.deepStrictEqual(r.ofertas.map((o) => o.preco), [4500, 5000]);
    assert.strictEqual(r.vendas.length, 5);
    assert.strictEqual(r.stats.mediana, 5100);
    assert.strictEqual(r.stats.n, 4);
    assert.strictEqual((await L.item(ana, 'x')).erro, 'Item inválido.');
  });
  await test('meus: ofertas ativas, limite (normal 10, Premium 25) e o que esta a receber', async () => {
    const a = await L.meus(ana);
    assert.strictEqual(a.ativos, 1);
    assert.strictEqual(a.limite, 10);
    assert.deepStrictEqual(a.pendente, { n: 2, gold: 1940, itens: 10 });
    const b = await L.meus(bruno);
    assert.strictEqual(b.ativos, 3); // o1, o3 e a vencida o4 (ate a varredura do servidor)
    assert.strictEqual(b.limite, 25);
    assert.strictEqual(b.premium, true);
  });
  await test('historico: compra do ponto de vista de quem comprou, venda de quem vendeu', async () => {
    const a = await L.historico(ana);
    assert.strictEqual(a.linhas.filter((h) => h.tipo === 'compra').length, 5);
    assert.strictEqual(a.linhas.find((h) => h.tipo === 'compra' && h.preco === 5200).liquido, -10400);
    assert.strictEqual(a.linhas.find((h) => h.tipo === 'expirado').liquido, 0);
    const b = await L.historico(bruno);
    const v = b.linhas.find((h) => h.tipo === 'venda' && h.preco === 5200);
    assert.strictEqual(v.liquido, 10400 - 312);
    assert.strictEqual(v.quem, 'Ana');
  });
  await test('precos: media, menor oferta e quanto esta a venda', async () => {
    const r = await L.precos(ana, [3416, 3577, 3381]);
    assert.strictEqual(r.precos[3416].menor, 4500);
    assert.strictEqual(r.precos[3416].aVenda, 3);
    assert.strictEqual(r.precos[3577].n, 0);
    assert.strictEqual(r.precos[3381].menor, 0); // so a vencida
  });

  // pedidos pela conexao (attach + handle), como a pagina manda
  function conexao(player) {
    const ws = new EventEmitter();
    const said = [], msgs = [];
    const st = L.attach(ws, player, (o) => said.push(o), (text, kind = 'info') => msgs.push({ text, kind }));
    const send = async (m) => {
      ws.emit('message', Buffer.from(JSON.stringify({ t: 'leilao', ...m })));
      await new Promise((r) => setTimeout(r, 30));
    };
    return { ws, said, msgs, st, send, last: () => said[said.length - 1], lastMsg: () => msgs[msgs.length - 1] };
  }
  const espera = () => new Promise((r) => setTimeout(r, 820)); // limite de 1 pedido a cada 800 ms
  const ca = conexao(ana);
  await new Promise((r) => setTimeout(r, 50));

  await test('abrir: manda as regras, tipos e ordens', async () => {
    await ca.send({ op: 'abrir', req: 1 });
    const r = ca.last();
    assert.strictEqual(r.op, 'cfg');
    assert.strictEqual(r.req, 1);
    assert.strictEqual(r.itens, 5);
    assert.ok(r.tipos.escudo && r.ordens.barato);
  });
  await test('anunciar: recusas da ponte (nem chegam ao servidor)', async () => {
    const before = cmds.length;
    const tenta = async (m, re) => {
      await espera();
      await ca.send({ op: 'anunciar', ...m });
      assert.strictEqual(ca.last().op, 'recusado', JSON.stringify(ca.last()));
      assert.match(ca.last().texto, re);
      assert.strictEqual(ca.lastMsg().kind, 'erro');
    };
    await tenta({ item: 9999, qtd: 1, preco: 10, dias: 7 }, /não pode ser vendido/);
    await tenta({ item: 3381, qtd: 3, preco: 13000, dias: 7 }, /não tem essa quantidade/);
    await tenta({ item: 3381, qtd: 1, preco: 11999, dias: 7 }, /mínimo é o valor no NPC: 12.000/);
    await tenta({ item: 3381, qtd: 1, preco: 13000, dias: 5 }, /1, 3 ou 7 dias/);
    db.prepare('INSERT INTO idle_state (player_id, updated, data) VALUES (1, ?, ?)').run(now(), JSON.stringify({ hunting: true }));
    await tenta({ item: 3381, qtd: 1, preco: 13000, dias: 7 }, /só negocia na cidade/);
    db.prepare('UPDATE idle_state SET updated = ? WHERE player_id = 1').run(now() - 60); // estado velho: nao esta cacando
    assert.strictEqual(cmds.length, before);
  });
  await test('anunciar: limite de ofertas ativas', async () => {
    const i9 = db.prepare("INSERT INTO idle_auction (seller_id, seller_name, item_id, item_name, kind, `count`, price, fee, created, expires, status) VALUES (1, 'Ana', 3577, 'meat', 'outros', 1, 5, 20, ?, ?, 'ativo')");
    const ids = [];
    for (let k = 0; k < 9; k++) ids.push(Number(i9.run(t, t + 999).lastInsertRowid));
    await espera();
    await ca.send({ op: 'anunciar', item: 3381, qtd: 1, preco: 13000, dias: 7 });
    assert.match(ca.last().texto, /já tem 10 ofertas ativas/);
    db.exec(`DELETE FROM idle_auction WHERE id IN (${ids.join(',')})`);
  });
  await test('anunciar: pedido certo vira comando para o servidor e poe o personagem no jogo', async () => {
    const before = cmds.length, lk = links.calls;
    await espera();
    await ca.send({ op: 'anunciar', item: 3381, qtd: '2', preco: '13000', dias: 3 });
    assert.strictEqual(cmds.length, before + 1);
    assert.deepStrictEqual(cmds[cmds.length - 1], { name: 'Ana', cmd: 'anunciar', arg: '3381,2,13000,3' });
    assert.strictEqual(links.calls, lk + 1);
    assert.match(ca.lastMsg().text, /Anunciando 2× crown armor/);
    const [row] = await q("SELECT arg FROM idle_commands WHERE cmd = 'anunciar' ORDER BY id DESC LIMIT 1");
    assert.strictEqual(row.arg, '3381,2,13000,3');
    assert.ok(row.arg.length <= 64, 'cabe no idle_commands.arg');
  });
  await test('pedidos seguidos: espera 800 ms entre um e outro', async () => {
    await ca.send({ op: 'cancelar', id: o6 });
    assert.match(ca.lastMsg().text, /Calma/);
  });
  await test('comprar: recusas e pedido certo', async () => {
    await espera();
    await ca.send({ op: 'comprar', id: o6, qtd: 1 });
    assert.match(ca.last().texto, /sua própria oferta/);
    await espera();
    await ca.send({ op: 'comprar', id: o4, qtd: 1 });
    assert.match(ca.last().texto, /expirou/);
    await espera();
    await ca.send({ op: 'comprar', id: o2, qtd: 3 });
    assert.match(ca.last().texto, /não tem mais essa quantidade/);
    await espera();
    await ca.send({ op: 'comprar', id: 123456, qtd: 1 });
    assert.match(ca.last().texto, /não existe mais/);
    await espera();
    await ca.send({ op: 'comprar', id: o2, qtd: 2 });
    assert.deepStrictEqual(cmds[cmds.length - 1], { name: 'Ana', cmd: 'comprar', arg: `${o2},2` });
    assert.match(ca.lastMsg().text, /Comprando 2× dragon shield/);
  });
  await test('cancelar: so a propria oferta ativa', async () => {
    await espera();
    await ca.send({ op: 'cancelar', id: o1 });
    assert.match(ca.last().texto, /não é sua/);
    await espera();
    await ca.send({ op: 'cancelar', id: o6 });
    assert.deepStrictEqual(cmds[cmds.length - 1], { name: 'Ana', cmd: 'cancelar', arg: String(o6) });
  });
  await test('sem conseguir entrar no jogo: o comando e apagado e a pagina recebe o erro', async () => {
    links.ok = false;
    await espera();
    await ca.send({ op: 'cancelar', id: o6 });
    links.ok = true;
    const [{ n }] = await q("SELECT COUNT(*) AS n FROM idle_commands WHERE player_name = 'Ana' AND cmd = 'cancelar'");
    assert.strictEqual(n, 0);
    assert.strictEqual(ca.lastMsg().kind, 'erro');
    assert.match(ca.lastMsg().text, /não respondeu/);
  });
  await test('avisos do servidor: chegam so na pagina do dono, uma vez, como aviso e como mensagem', async () => {
    const said0 = ca.said.length, msgs0 = ca.msgs.length;
    db.prepare('INSERT INTO idle_auction_msg (player_id, ok, texto, created) VALUES (1, 1, ?, ?)').run('Vendeu 1× meat.', now());
    db.prepare('INSERT INTO idle_auction_msg (player_id, ok, texto, created) VALUES (1, 0, ?, ?)').run('Essa oferta acabou de ser levada.', now());
    db.prepare('INSERT INTO idle_auction_msg (player_id, ok, texto, created) VALUES (2, 1, ?, ?)').run('de outro', now());
    await Promise.all([L.pollAvisos(), L.pollAvisos()]); // duas ao mesmo tempo nao repetem
    await L.pollAvisos();
    const novos = ca.said.slice(said0).filter((m) => m.op === 'aviso');
    assert.deepStrictEqual(novos.map((m) => m.texto), ['Vendeu 1× meat.', 'Essa oferta acabou de ser levada.']);
    assert.deepStrictEqual(novos.map((m) => m.ok), [true, false]);
    assert.deepStrictEqual(ca.msgs.slice(msgs0).map((m) => m.kind), ['ok', 'erro']);
  });
  await test('avisos: ao abrir a pagina, mostra so o que chegou no ultimo minuto', async () => {
    db.prepare('INSERT INTO idle_auction_msg (player_id, ok, texto, created) VALUES (2, 1, ?, ?)').run('antigo', now() - 600);
    db.prepare('INSERT INTO idle_auction_msg (player_id, ok, texto, created) VALUES (2, 1, ?, ?)').run('recente', now() - 5);
    await L.pollAvisos(); // Bruno sem pagina aberta: ninguem recebe
    const cb = conexao(bruno);
    await new Promise((r) => setTimeout(r, 50));
    const got = cb.said.filter((m) => m.op === 'aviso').map((m) => m.texto);
    assert.deepStrictEqual(got, ['de outro', 'recente']);
    cb.ws.emit('close');
    db.prepare('INSERT INTO idle_auction_msg (player_id, ok, texto, created) VALUES (2, 1, ?, ?)').run('depois de fechar', now());
    await L.pollAvisos();
    assert.ok(!cb.said.some((m) => m.texto === 'depois de fechar'), 'pagina fechada nao recebe');
  });
  await test('leituras pela conexao respondem com o mesmo req', async () => {
    await ca.send({ op: 'lista', busca: 'meat', req: 77 });
    assert.strictEqual(ca.last().op, 'lista');
    assert.strictEqual(ca.last().req, 77);
    await ca.send({ op: 'item', item: 3416, req: 78 });
    assert.strictEqual(ca.last().op, 'item');
    await ca.send({ op: 'meus' });
    assert.strictEqual(ca.last().op, 'meus');
    await ca.send({ op: 'historico' });
    assert.strictEqual(ca.last().op, 'historico');
    await ca.send({ op: 'precos', ids: [3416] });
    assert.strictEqual(ca.last().op, 'precos');
    const n = ca.said.length;
    ca.ws.emit('message', Buffer.from('nao e json'));
    ca.ws.emit('message', Buffer.from(JSON.stringify({ t: 'state' })));
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(ca.said.length, n, 'ignora o que nao e do leilao');
  });
  await test('bots: anunciarBot com o preco justo (sem negocios: NPC + 25%; com negocios: mediana)', async () => {
    const a = await L.anunciarBot({ playerId: 3, itemId: 5877, qtd: 3 });
    assert.ok(a.ok, a.erro);
    assert.strictEqual(a.preco, 130); // 100 * 1,25 = 125 -> 130 (2 algarismos)
    const [row] = await q('SELECT seller_id, seller_name, fee, origem, `count`, status FROM idle_auction WHERE id = ?', [a.id]);
    assert.deepStrictEqual({ ...row }, { seller_id: 3, seller_name: 'Velho Jack', fee: 0, origem: 'bot', count: 3, status: 'ativo' });
    const b = await L.anunciarBot({ playerId: 3, itemId: 3416 });
    assert.strictEqual(b.preco, 5100); // mediana dos 4 negocios
    const c = await L.anunciarBot({ playerId: 3, itemId: 3416, preco: 3000 });
    assert.ok(!c.ok && /mínimo é o valor no NPC/.test(c.erro));
    assert.ok(!(await L.anunciarBot({ playerId: 3, itemId: 1 })).ok);
    assert.ok(!(await L.anunciarBot({ playerId: 999, itemId: 3416 })).ok);
  });
  ca.ws.emit('close');

  // -------------------------------------------------------------------------- 3) SQL do Lua
  console.log('--- SQL do idle_leilao.lua');
  const toks = lex(fs.readFileSync(LUA, 'utf8'));
  const luaCreates = toks.filter((x) => x.t === 'str' && x.long && /CREATE TABLE/i.test(x.v)).map((x) => x.v);
  const cols = (sql) => {
    const name = /CREATE TABLE IF NOT EXISTS `?(\w+)`?/i.exec(sql)[1];
    const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
    const list = body.split(/,(?![^(]*\))/).map((s) => s.trim().replace(/`/g, '').replace(/\s+/g, ' ')).filter((s) => !/^(PRIMARY )?KEY /i.test(s));
    const keys = body.split(/,(?![^(]*\))/).map((s) => s.trim().replace(/`/g, '').replace(/\s+/g, ' ')).filter((s) => /^(PRIMARY )?KEY /i.test(s));
    return { name, list, keys };
  };
  await test('as tabelas do Lua sao iguais as da ponte (colunas, tipos e indices)', () => {
    assert.strictEqual(luaCreates.length, Leilao.SQL.length);
    for (const sql of Leilao.SQL) {
      const g = cols(sql);
      const l = luaCreates.map(cols).find((x) => x.name === g.name);
      assert.ok(l, 'o Lua nao cria ' + g.name);
      assert.deepStrictEqual(l.list, g.list, g.name);
      assert.deepStrictEqual(l.keys, g.keys, g.name);
    }
  });
  const ldb = new DatabaseSync(':memory:');
  ldb.exec(`CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, account_id INT, balance INT);
    CREATE TABLE idle_bag (player_id INT PRIMARY KEY, updated INT NOT NULL, items TEXT NOT NULL, dispatch_at INT NOT NULL DEFAULT 0, data TEXT NOT NULL);
    CREATE TABLE idle_catalog (name TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  for (const sql of luaCreates) ldb.exec(toSqlite(sql));
  // comandos montados com string.format("...", ...) (pedacos juntados com ..)
  const formats = [];
  for (let i = 0; i < toks.length - 5; i++) {
    if (toks[i].t === 'name' && toks[i].v === 'string' && toks[i + 1].t === '.' && toks[i + 2].v === 'format' && toks[i + 3].t === '(' && toks[i + 4].t === 'str') {
      let s = toks[i + 4].v;
      let j = i + 5;
      while (toks[j].t === '..' && toks[j + 1].t === 'str') {
        s += toks[j + 1].v;
        j += 2;
      }
      formats.push({ s, line: toks[i].line });
    }
  }
  // comandos passados direto a db.query/storeQuery/asyncQuery (o que nao e texto vira 1, ou 'x' no escapeString)
  const diretos = [];
  for (let i = 0; i < toks.length - 4; i++) {
    if (toks[i].t === 'name' && toks[i].v === 'db' && toks[i + 1].t === '.' && /^(query|storeQuery|asyncQuery)$/.test(toks[i + 2].v) && toks[i + 3].t === '(') {
      if (toks[i + 4].t === 'name' && toks[i + 4].v === 'string') continue; // string.format: ja pego acima
      if (toks[i + 4].t === 'str' && toks[i + 4].long) continue; // CREATE TABLE
      let j = i + 4, depth = 0, s = '', operand = null;
      for (; j < toks.length; j++) {
        const x = toks[j];
        if (depth === 0 && x.t === ')') break;
        if (depth === 0 && x.t === '..') {
          if (operand !== null) s += operand.startsWith('db.escapeString') ? "'x'" : operand.startsWith('CAMPOS') ? '__CAMPOS__' : operand.startsWith('where') ? '1 = 1' : '1';
          operand = null;
          continue;
        }
        if (depth === 0 && x.t === 'str' && operand === null) {
          s += x.v;
          continue;
        }
        if (x.t === '(') depth++;
        if (x.t === ')') depth--;
        operand = (operand || '') + (x.v || x.t);
      }
      if (operand !== null) s += operand.startsWith('db.escapeString') ? "'x'" : '1';
      diretos.push({ s, line: toks[i].line });
    }
  }
  const campos = (() => {
    const k = toks.findIndex((x, i) => x.t === 'local' && toks[i + 1].v === 'CAMPOS' && toks[i + 2].t === '=');
    return toks[k + 3].v;
  })();
  const fill = (s) => s
    .replace(/SET %s,/, "SET `status` = 'x',")
    .replace(/AND %s/g, 'AND 1 = 1')
    .replace(/%d/g, '1')
    .replace(/%s/g, "'x'")
    .replace(/%%/g, '%')
    .replace(/ON DUPLICATE KEY UPDATE (.*)$/s, (m, set) => 'ON CONFLICT(player_id) DO UPDATE SET ' + set.replace(/VALUES\((`?\w+`?)\)/g, 'excluded.$1'))
    .replace(/__CAMPOS__/g, campos);
  const isSql = (s) => /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s);
  const statements = [...formats, ...diretos].filter((f) => isSql(f.s));
  const fragments = formats.filter((f) => !isSql(f.s) && /`\w+`\s*(=|>=|<=|>|<|IN)/.test(f.s));
  await test(`os ${statements.length} comandos SQL do Lua preparam no SQLite (tabelas e colunas existem)`, () => {
    assert.ok(statements.length >= 20, 'achou poucos comandos: ' + statements.length);
    for (const f of statements) {
      const sql = fill(f.s);
      try {
        ldb.prepare(sql);
      } catch (e) {
        throw new Error(`linha ${f.line}: ${e.message}\n         ${sql}`);
      }
    }
  });
  await test(`os ${fragments.length} pedacos de SET/WHERE do Lua tambem`, () => {
    assert.ok(fragments.length >= 6, 'achou poucos pedacos: ' + fragments.length);
    for (const f of fragments) {
      const frag = fill(f.s);
      const sql = /,\s*`\w+`\s*=/.test(frag) && !/ AND /.test(frag) || /^`status` = '(cancelado|expirado|reservado)'/.test(frag)
        ? `UPDATE idle_auction SET ${frag}, token = 'x' WHERE id = 0`
        : `SELECT ${campos.replace(/`/g, '')} FROM idle_auction WHERE ${frag}`;
      try {
        ldb.prepare(sql);
      } catch (e) {
        throw new Error(`linha ${f.line}: ${e.message}\n         ${sql}`);
      }
    }
  });
  await test('a ponte e o Lua usam os mesmos nomes de comando e o mesmo formato de argumento', () => {
    const src = fs.readFileSync(LUA, 'utf8');
    for (const c of ['anunciar', 'comprar', 'cancelar']) assert.ok(new RegExp(`${c} = true`).test(src), c);
    assert.ok(/if #n ~= 4 then/.test(src), 'anunciar tem 4 numeros: item,qtd,preco,dias');
  });
  await test('o gancho do idle.lua esta la (exporta a mochila e chama o leilao nos comandos)', () => {
    const src = fs.readFileSync(path.join(path.dirname(LUA), 'idle.lua'), 'utf8');
    assert.ok(/I\.bagOf = bagOf/.test(src) && /I\.priceOf = priceOf/.test(src));
    assert.ok(/I\.leilao\.comando\(player, cmd, arg, id\)/.test(src));
  });
  await test('as regras do Lua (L.CFG) sao as mesmas do leilao_regras.js', () => {
    const src = fs.readFileSync(LUA, 'utf8');
    const block = /L\.CFG = \{([\s\S]*?)\n\}/.exec(src)[1];
    const lua = {};
    for (const m of block.matchAll(/(\w+) = (\{[^}]*\}|[^,\n]+?),?\s*(--.*)?$/gm)) {
      const v = m[2].trim();
      lua[m[1]] = v === 'true' ? true : v === 'false' ? false : v.startsWith('{') ? v.replace(/[{}\s]/g, '').split(',').map(Number) : Number(v);
    }
    assert.deepStrictEqual(lua, R.CFG);
  });

  console.log(`\n${passes} ok, ${fails} falharam`);
  process.exit(fails ? 1 : 0);
})();
