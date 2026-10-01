'use strict';
/*
 * Destruitor Idle — LEILAO na ponte.
 *
 *   pagina --{ t: 'leilao', op }--> aqui: le o livro de ofertas direto do banco e transforma anunciar /
 *   comprar / cancelar em comandos para o servidor (idle_commands). Quem tira o item da mochila e mexe
 *   no gold e so o idle_leilao.lua, no servidor (o personagem pode estar no jogo: o Lua e dono do
 *   idle_bag e do banco). O resultado volta pela tabela idle_auction_msg, que esta ponte repassa para a
 *   pagina a cada 1,5 s (mensagem na tela + { t: 'leilao', op: 'aviso' }).
 *
 * Mensagens da pagina (todas com t: 'leilao'; a resposta volta com o mesmo op e o mesmo req):
 *   abrir · lista {busca, tipo, ordem, pagina, ids} · item {item} · meus · historico · precos {ids}
 *   anunciar {item, qtd, preco, dias} · comprar {id, qtd} · cancelar {id}
 */
const R = require('./public/leilao_regras.js');

// tabelas (criadas na partida da ponte e tambem pelo idle_leilao.lua: manter os dois iguais)
const SQL = [
  `CREATE TABLE IF NOT EXISTS idle_auction (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT, seller_id INT NOT NULL, seller_name VARCHAR(255) NOT NULL,
    item_id INT NOT NULL, item_name VARCHAR(100) NOT NULL DEFAULT '', kind VARCHAR(16) NOT NULL DEFAULT '',
    \`count\` INT NOT NULL, price BIGINT NOT NULL, fee BIGINT NOT NULL DEFAULT 0,
    created INT UNSIGNED NOT NULL, expires INT UNSIGNED NOT NULL, status VARCHAR(12) NOT NULL DEFAULT 'ativo',
    origem VARCHAR(8) NOT NULL DEFAULT 'jogador', token VARCHAR(40) NOT NULL DEFAULT '', buyer_id INT NOT NULL DEFAULT 0,
    reserve_count INT NOT NULL DEFAULT 0, reserve_bank BIGINT NOT NULL DEFAULT -1, reserved_at INT UNSIGNED NOT NULL DEFAULT 0,
    closed INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (id), KEY status_expires (status, expires), KEY item_status (item_id, status, price), KEY seller_status (seller_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS idle_auction_history (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT, auction_id INT UNSIGNED NOT NULL, tipo VARCHAR(12) NOT NULL,
    item_id INT NOT NULL, item_name VARCHAR(100) NOT NULL DEFAULT '', \`count\` INT NOT NULL, price BIGINT NOT NULL,
    total BIGINT NOT NULL, fee BIGINT NOT NULL DEFAULT 0, seller_id INT NOT NULL, seller_name VARCHAR(255) NOT NULL DEFAULT '',
    buyer_id INT NOT NULL DEFAULT 0, buyer_name VARCHAR(255) NOT NULL DEFAULT '', created INT UNSIGNED NOT NULL,
    PRIMARY KEY (id), KEY item_tipo (item_id, tipo, id), KEY seller (seller_id, id), KEY buyer (buyer_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS idle_auction_pending (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT, player_id INT NOT NULL, gold BIGINT NOT NULL DEFAULT 0,
    item_id INT NOT NULL DEFAULT 0, \`count\` INT NOT NULL DEFAULT 0, motivo VARCHAR(16) NOT NULL DEFAULT '',
    auction_id INT UNSIGNED NOT NULL DEFAULT 0, texto VARCHAR(255) NOT NULL DEFAULT '', created INT UNSIGNED NOT NULL,
    delivered INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (id), KEY player_delivered (player_id, delivered)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS idle_auction_msg (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT, player_id INT NOT NULL, ok TINYINT NOT NULL DEFAULT 1,
    texto VARCHAR(255) NOT NULL, created INT UNSIGNED NOT NULL,
    PRIMARY KEY (id), KEY player_id (player_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

const POR_PAGINA = 40;
const DIAS_MEDIA = 30; // preco medio: ultimos 20 negocios dos ultimos 30 dias
const ORDEM_SQL = {
  barato: 'price ASC, id ASC',
  caro: 'price DESC, id ASC',
  termina: 'expires ASC, id ASC',
  novos: 'created DESC, id DESC',
  nome: 'item_name ASC, price ASC, id ASC',
};
const CMDS = new Set(['anunciar', 'comprar', 'cancelar']);

const agora = () => Math.floor(Date.now() / 1000);
const marcas = (n) => Array.from({ length: n }, () => '?').join(',');
const ids = (list, max = 300) => [...new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, max);

/**
 * @param {{ q: (sql: string, params?: any[]) => Promise<any>, command: Function, ensureLink: Function }} deps
 *   q = consulta no banco (a mesma da ponte); command(player, cmd, arg) grava em idle_commands;
 *   ensureLink(player) poe o personagem no jogo (o servidor so processa comando de quem esta nele).
 */
function create({ q, command, ensureLink }) {
  // ---- catalogo (itens negociaveis + regras), gravado pelo idle_leilao.lua na partida ----
  let cat = { at: 0, cfg: R.CFG, items: new Map() };
  async function catalogo() {
    if (Date.now() - cat.at < 60000) return cat;
    let row = null;
    try {
      [row] = await q("SELECT data FROM idle_catalog WHERE name = 'leilao'");
    } catch {
      row = null;
    }
    let next = { at: Date.now(), cfg: R.CFG, items: new Map() };
    if (row) {
      try {
        const d = JSON.parse(row.data);
        next = { at: Date.now(), cfg: R.cfgDe(d.cfg), items: new Map((d.items || []).map(([id, name, npc, weight, kind, lv]) => [id, { id, name, npc, weight, kind, lv }])) };
      } catch {
        /* catalogo quebrado: fica o padrao */
      }
    }
    cat = next;
    return cat;
  }
  const info = (c, id) => c.items.get(Number(id)) || null;

  // ---- preco medio por item (cache de 60 s) ----
  const statsCache = new Map(); // itemId -> { at, s }
  async function estatisticas(list) {
    const out = {};
    const falta = [];
    for (const id of ids(list)) {
      const c = statsCache.get(id);
      if (c && Date.now() - c.at < 60000) out[id] = c.s;
      else falta.push(id);
    }
    if (falta.length) {
      const rows = await q(
        `SELECT item_id, \`count\`, price FROM (
           SELECT item_id, \`count\`, price, ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY id DESC) AS rn
             FROM idle_auction_history WHERE tipo = 'venda' AND created > ? AND item_id IN (${marcas(falta.length)})
         ) x WHERE rn <= 20`,
        [agora() - DIAS_MEDIA * 86400, ...falta]
      );
      const by = new Map();
      for (const r of rows) {
        if (!by.has(r.item_id)) by.set(r.item_id, []);
        by.get(r.item_id).push({ count: Number(r.count), price: Number(r.price) });
      }
      for (const id of falta) {
        const s = R.precoMedio(by.get(id) || []);
        statsCache.set(id, { at: Date.now(), s });
        out[id] = s;
      }
      if (statsCache.size > 5000) statsCache.clear();
    }
    return out;
  }

  // menor oferta e quantidade a venda agora, por item
  async function livro(list) {
    const l = ids(list);
    if (!l.length) return {};
    const rows = await q(
      `SELECT item_id, MIN(price) AS menor, SUM(\`count\`) AS qtd, COUNT(*) AS n FROM idle_auction
        WHERE status = 'ativo' AND expires > ? AND item_id IN (${marcas(l.length)}) GROUP BY item_id`,
      [agora(), ...l]
    );
    return Object.fromEntries(rows.map((r) => [r.item_id, { menor: Number(r.menor), qtd: Number(r.qtd), n: Number(r.n) }]));
  }

  async function premium(player) {
    const [acc] = await q('SELECT a.premdays FROM accounts a JOIN players p ON p.account_id = a.id WHERE p.id = ?', [player.id]).catch(() => []);
    return !!(acc && acc.premdays > 0);
  }

  async function cacando(player) {
    const [st] = await q('SELECT updated, data FROM idle_state WHERE player_id = ?', [player.id]).catch(() => []);
    if (!st || agora() - st.updated >= 10) return false;
    try {
      return !!JSON.parse(st.data).hunting;
    } catch {
      return false;
    }
  }

  const oferta = (r, c, st, player) => {
    const it = info(c, r.item_id);
    const s = st[r.item_id];
    return {
      id: r.id, item: r.item_id, nome: r.item_name, tipo: r.kind, qtd: Number(r.count), preco: Number(r.price),
      vendedor: r.seller_name, minha: r.seller_id === player.id, termina: r.expires, criada: r.created,
      npc: it ? it.npc : 0, lv: it ? it.lv : 0, media: s ? s.media : 0, negocios: s ? s.n : 0,
    };
  };

  // ---- leituras ----
  async function lista(player, f) {
    const c = await catalogo();
    const where = ["status = 'ativo'", 'expires > ?'];
    const params = [agora()];
    const busca = String(f.busca || '').trim().toLowerCase().slice(0, 40);
    if (busca) {
      where.push("item_name LIKE ? ESCAPE '!'");
      params.push('%' + busca.replace(/[!%_]/g, '!$&') + '%');
    }
    if (R.TIPOS[f.tipo]) {
      where.push('kind = ?');
      params.push(f.tipo);
    }
    const so = ids(f.ids);
    if (Array.isArray(f.ids)) {
      if (!so.length) return { op: 'lista', total: 0, pagina: 0, por: POR_PAGINA, ofertas: [] };
      where.push(`item_id IN (${marcas(so.length)})`);
      params.push(...so);
    }
    const ordem = ORDEM_SQL[f.ordem] ? f.ordem : 'barato';
    const pagina = Math.max(0, Math.min(500, Math.floor(Number(f.pagina) || 0)));
    const w = where.join(' AND ');
    const [{ n }] = await q(`SELECT COUNT(*) AS n FROM idle_auction WHERE ${w}`, params);
    const rows = await q(
      `SELECT id, seller_id, seller_name, item_id, item_name, kind, \`count\`, price, created, expires FROM idle_auction
        WHERE ${w} ORDER BY ${ORDEM_SQL[ordem]} LIMIT ${POR_PAGINA} OFFSET ${pagina * POR_PAGINA}`,
      params
    );
    const st = await estatisticas(rows.map((r) => r.item_id));
    return { op: 'lista', total: Number(n), pagina, por: POR_PAGINA, ofertas: rows.map((r) => oferta(r, c, st, player)) };
  }

  async function item(player, itemId) {
    const c = await catalogo();
    const id = Number(itemId);
    if (!Number.isInteger(id) || id <= 0) return { op: 'item', erro: 'Item inválido.' };
    const rows = await q(
      `SELECT id, seller_id, seller_name, item_id, item_name, kind, \`count\`, price, created, expires FROM idle_auction
        WHERE status = 'ativo' AND expires > ? AND item_id = ? ORDER BY price ASC, id ASC LIMIT 60`,
      [agora(), id]
    );
    const vendas = await q(`SELECT \`count\`, price, created FROM idle_auction_history WHERE tipo = 'venda' AND item_id = ? ORDER BY id DESC LIMIT 20`, [id]);
    const st = await estatisticas([id]);
    const it = info(c, id);
    return {
      op: 'item',
      item: { id, nome: it ? it.name : rows[0] ? rows[0].item_name : '?', npc: it ? it.npc : 0, tipo: it ? it.kind : '', lv: it ? it.lv : 0, peso: it ? it.weight : 0 },
      stats: st[id],
      ofertas: rows.map((r) => oferta(r, c, st, player)),
      vendas: vendas.map((v) => ({ qtd: Number(v.count), preco: Number(v.price), quando: v.created })),
    };
  }

  async function meus(player) {
    const c = await catalogo();
    const rows = await q(
      `SELECT id, seller_id, seller_name, item_id, item_name, kind, \`count\`, price, fee, created, expires, status FROM idle_auction
        WHERE seller_id = ? AND status IN ('ativo', 'reservado') ORDER BY expires ASC, id ASC`,
      [player.id]
    );
    const [pend] = await q('SELECT COUNT(*) AS n, COALESCE(SUM(gold), 0) AS gold, COALESCE(SUM(`count`), 0) AS itens FROM idle_auction_pending WHERE player_id = ? AND delivered = 0', [player.id]);
    const prem = await premium(player);
    const st = await estatisticas(rows.map((r) => r.item_id));
    return {
      op: 'meus',
      ofertas: rows.map((r) => ({ ...oferta(r, c, st, player), taxa: Number(r.fee), status: r.status })),
      ativos: rows.length,
      limite: R.limiteAtivos(c.cfg, prem),
      premium: prem,
      pendente: { n: Number(pend.n), gold: Number(pend.gold), itens: Number(pend.itens) },
    };
  }

  async function historico(player) {
    const rows = await q(
      `SELECT id, auction_id, tipo, item_id, item_name, \`count\`, price, total, fee, seller_id, seller_name, buyer_id, buyer_name, created
         FROM idle_auction_history WHERE seller_id = ? OR buyer_id = ? ORDER BY id DESC LIMIT 80`,
      [player.id, player.id]
    );
    return {
      op: 'historico',
      linhas: rows.map((r) => {
        const comprei = r.tipo === 'venda' && r.buyer_id === player.id;
        const total = Number(r.total);
        const fee = Number(r.fee);
        return {
          id: r.id, oferta: r.auction_id, tipo: comprei ? 'compra' : r.tipo, item: r.item_id, nome: r.item_name,
          qtd: Number(r.count), preco: Number(r.price), total, taxa: fee,
          quem: comprei ? r.seller_name : r.tipo === 'venda' ? r.buyer_name : '',
          liquido: r.tipo === 'venda' ? (comprei ? -total : total - fee) : 0,
          quando: r.created,
        };
      }),
    };
  }

  // preco medio e menor oferta dos itens da mochila (aba Vender)
  async function precos(player, list) {
    const l = ids(list, 200);
    const [st, lv] = await Promise.all([estatisticas(l), livro(l)]);
    const out = {};
    for (const id of l) out[id] = { ...(st[id] || R.precoMedio([])), menor: lv[id] ? lv[id].menor : 0, aVenda: lv[id] ? lv[id].qtd : 0 };
    return { op: 'precos', precos: out };
  }

  // ---- pedidos: conferem o que der aqui e mandam para o servidor ----
  async function pedir(player, cmd, arg, texto, msg) {
    await command(player, cmd, arg);
    if (texto) msg(texto);
    const res = await ensureLink(player);
    if (!res.ok) {
      await q('DELETE FROM idle_commands WHERE player_name = ? AND cmd = ?', [player.name, cmd]).catch(() => {});
      msg(res.error || 'Não deu para entrar no jogo.', 'erro');
    }
  }

  async function anunciar(player, m, recusa, msg) {
    const c = await catalogo();
    const it = info(c, m.item);
    const [bag] = await q('SELECT items FROM idle_bag WHERE player_id = ?', [player.id]);
    const tem = it ? R.lerMochila(bag && bag.items).get(it.id) || 0 : 0;
    const [{ n }] = await q("SELECT COUNT(*) AS n FROM idle_auction WHERE seller_id = ? AND status IN ('ativo', 'reservado')", [player.id]);
    const erro = R.validarAnuncio(c.cfg, { npc: it ? it.npc : 0, tem, qtd: m.qtd, preco: m.preco, dias: m.dias, ativos: Number(n), premium: await premium(player), cacando: await cacando(player), banco: null });
    if (erro) return recusa(erro);
    const arg = [it.id, R.inteiro(m.qtd), R.inteiro(m.preco), R.inteiro(m.dias)].join(',');
    await pedir(player, 'anunciar', arg, `Anunciando ${R.inteiro(m.qtd)}× ${it.name}…`, msg);
  }

  async function comprar(player, m, recusa, msg) {
    const c = await catalogo();
    const id = R.inteiro(m.id);
    const [o] = Number.isInteger(id) ? await q('SELECT id, seller_id, item_name, `count`, price, expires, status FROM idle_auction WHERE id = ?', [id]) : [];
    const erro = R.validarCompra(c.cfg, { oferta: o && { ...o, count: Number(o.count), price: Number(o.price) }, eu: player.id, qtd: m.qtd, banco: null, agora: agora(), cacando: await cacando(player) });
    if (erro) return recusa(erro);
    await pedir(player, 'comprar', `${o.id},${R.inteiro(m.qtd)}`, `Comprando ${R.inteiro(m.qtd)}× ${o.item_name}…`, msg);
  }

  async function cancelar(player, m, recusa, msg) {
    const c = await catalogo();
    const id = R.inteiro(m.id);
    const [o] = Number.isInteger(id) ? await q('SELECT id, seller_id, status FROM idle_auction WHERE id = ?', [id]) : [];
    if (!o || (o.status !== 'ativo' && o.status !== 'reservado')) return recusa('Essa oferta não existe mais.');
    if (o.seller_id !== player.id) return recusa('Essa oferta não é sua.');
    if (o.status === 'reservado') return recusa('Essa oferta está sendo comprada agora.');
    if (c.cfg.soNaCidade && (await cacando(player))) return recusa('A casa de leilões só negocia na cidade — saia da caçada para cancelar.');
    await pedir(player, 'cancelar', String(o.id), 'Cancelando a oferta…', msg);
  }

  // ---- uma mensagem da pagina ----
  async function handle(player, m, say, msg, st) {
    const op = String(m.op || '');
    const t = Date.now();
    if (CMDS.has(op)) {
      if (t - st.cmdAt < 800) return msg('Calma: espere um pouco entre os pedidos.', 'erro');
      st.cmdAt = t;
    } else {
      st.reads = st.reads.filter((x) => t - x < 5000);
      if (st.reads.length >= 40) return; // pagina pedindo demais
      st.reads.push(t);
    }
    const res = (r) => say({ t: 'leilao', req: m.req, ...r });
    const recusa = (texto) => {
      msg(texto, 'erro');
      res({ op: 'recusado', pedido: op, texto });
    };
    if (op === 'abrir') {
      const c = await catalogo();
      return res({ op: 'cfg', cfg: c.cfg, tipos: R.TIPOS, ordens: R.ORDENS, itens: c.items.size });
    }
    if (op === 'lista') return res(await lista(player, m));
    if (op === 'item') return res(await item(player, m.item));
    if (op === 'meus') return res(await meus(player));
    if (op === 'historico') return res(await historico(player));
    if (op === 'precos') return res(await precos(player, m.ids));
    if (op === 'anunciar') return anunciar(player, m, recusa, msg);
    if (op === 'comprar') return comprar(player, m, recusa, msg);
    if (op === 'cancelar') return cancelar(player, m, recusa, msg);
  }

  // ---- avisos do servidor (resultado dos pedidos, vendas, ofertas expiradas) ----
  // uma consulta so para todas as paginas abertas, a cada 1,5 s
  const conns = new Map(); // playerId -> Set de { say, msg }
  let lastMsg = null;
  const entrega = (c, r) => {
    c.msg(r.texto, r.ok ? 'ok' : 'erro');
    c.say({ t: 'leilao', op: 'aviso', ok: !!r.ok, texto: r.texto });
  };
  async function inicio() {
    if (lastMsg == null) {
      const [r] = await q('SELECT COALESCE(MAX(id), 0) AS id FROM idle_auction_msg');
      if (lastMsg == null) lastMsg = Number(r.id);
    }
  }
  async function pollAvisos() {
    if (lastMsg == null) return inicio();
    const rows = await q('SELECT id, player_id, ok, texto FROM idle_auction_msg WHERE id > ? ORDER BY id LIMIT 500', [lastMsg]);
    let n = 0;
    for (const r of rows) {
      if (r.id <= lastMsg) continue; // outra consulta ao mesmo tempo ja entregou
      lastMsg = r.id;
      n++;
      for (const c of conns.get(r.player_id) || []) entrega(c, r);
    }
    return n;
  }
  let polling = false, pollTimer = null;
  const poll = () => {
    if (polling) return;
    polling = true;
    pollAvisos().catch(() => {}).finally(() => (polling = false));
  };
  // ao abrir a pagina: o que chegou no ultimo minuto (o resultado de um pedido feito antes de recarregar)
  async function recentes(player, c) {
    await inicio();
    const ate = lastMsg;
    const rows = await q('SELECT id, ok, texto FROM idle_auction_msg WHERE player_id = ? AND created >= ? AND id <= ? ORDER BY id LIMIT 10', [player.id, agora() - 60, ate]);
    for (const r of rows) entrega(c, r);
  }

  /** Liga o leilao a uma conexao da pagina (session() do server.js). */
  function attach(ws, player, say, msg) {
    const st = { cmdAt: 0, reads: [] };
    const c = { say, msg };
    if (!conns.has(player.id)) conns.set(player.id, new Set());
    conns.get(player.id).add(c);
    if (!pollTimer) {
      pollTimer = setInterval(poll, 1500);
      if (pollTimer.unref) pollTimer.unref();
    }
    recentes(player, c).catch(() => {});
    ws.on('close', () => {
      const set = conns.get(player.id);
      if (set) {
        set.delete(c);
        if (!set.size) conns.delete(player.id);
      }
    });
    ws.on('message', async (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!m || m.t !== 'leilao') return;
      try {
        await handle(player, m, say, msg, st);
      } catch (e) {
        console.error('[leilao]', m.op, e.message);
        say({ t: 'leilao', op: 'erro', req: m.req, pedido: m.op, texto: 'O leilão não respondeu. Tente de novo.' });
      }
    });
    return st;
  }

  /**
   * Jogadores simulados (contas de bots): anuncia em nome de um personagem sem mochila e sem taxa (o item e
   * o loot simulado do bot). Sem preco, usa o "preco justo": a mediana dos ultimos negocios do item, ou o
   * valor no NPC com 25% de margem. Nao precisa do personagem no jogo: o gold da venda fica pendente.
   *   await leilao.anunciarBot({ playerId: 123, itemId: 3381, qtd: 1 })  ->  { ok, id, preco } | { ok: false, erro }
   */
  async function anunciarBot({ playerId, itemId, qtd = 1, preco = 0, dias = 0, margem = 1.25 } = {}) {
    const c = await catalogo();
    const it = info(c, itemId);
    if (!it) return { ok: false, erro: 'Esse item não pode ser vendido no leilão.' };
    const [p] = await q('SELECT id, name FROM players WHERE id = ?', [Number(playerId) || 0]);
    if (!p) return { ok: false, erro: 'Personagem não existe.' };
    const st = (await estatisticas([it.id]))[it.id];
    const unit = R.inteiro(preco) > 0 ? R.inteiro(preco) : R.precoJusto(it.npc, st, margem);
    const d = c.cfg.dias.includes(Number(dias)) ? Number(dias) : c.cfg.diasPadrao;
    const erro = R.validarAnuncio(c.cfg, { npc: it.npc, tem: null, qtd, preco: unit, dias: d, ativos: null, premium: true, cacando: false, banco: null });
    if (erro) return { ok: false, erro };
    const t = agora();
    const r = await q(
      "INSERT INTO idle_auction (seller_id, seller_name, item_id, item_name, kind, `count`, price, fee, created, expires, status, origem) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'ativo', 'bot')",
      [p.id, p.name, it.id, it.name, it.kind, R.inteiro(qtd), unit, t, t + d * 86400]
    );
    return { ok: true, id: r && r.insertId, preco: unit };
  }

  return { attach, handle, pollAvisos, catalogo, estatisticas, lista, item, meus, historico, precos, anunciarBot };
}

module.exports = { create, SQL };
