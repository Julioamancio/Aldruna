'use strict';
/*
 * Destruitor Idle — botoes AUTO de colar e anel (janela Inventario), lado da ponte.
 *
 * A configuracao fica por personagem em `idle_settings.acc`, uma linha por peca, na ordem de prioridade:
 *
 *   colar|3081|1|self.hp.le.50.p&area.targets.ge.2|Dragon;Dragon Lord
 *   (slot | id da peca | ligada 1/0 | condicoes no formato da barra de acoes | monstros "por perto")
 *
 * O idle_acessorios.lua le isso quando a cacada comeca e a cada "reload", e troca as pecas no slot.
 * A pagina manda {t:'acessorios', cfg:{colar:[...], anel:[...]}} e recebe a mesma coisa de volta.
 */
const fs = require('fs');
const path = require('path');

const SLOTS = ['colar', 'anel'];
const SUBJ = { self: ['hp', 'mana', 'shield'], target: ['hp'], area: ['targets'] };
const OPS = ['lt', 'le', 'eq', 'ge', 'gt'];
const MAX_RULES = 20;
const MAX_CONDS = 8;
const MAX_NEAR = 5;
const MONSTER_RE = /^[A-Za-z][A-Za-z' .-]{0,39}$/;
const CATALOG = path.join(__dirname, 'public', 'itens', 'acessorios.json');

const MIGRATION = 'ALTER TABLE idle_settings ADD COLUMN IF NOT EXISTS acc TEXT NULL';

// catalogo gerado por tools/acessorios.py (id -> peca); sem ele, aceita qualquer id (o servidor confere ao vestir)
let cat = { at: 0, byId: null };
function catalog() {
  if (Date.now() - cat.at > 10 * 60 * 1000) {
    cat.at = Date.now();
    try {
      const d = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
      cat.byId = new Map((d.itens || []).map((e) => [e.id, e]));
    } catch {
      cat.byId = null;
    }
  }
  return cat.byId;
}

function parseConds(text) {
  return String(text || '')
    .split('&')
    .filter(Boolean)
    .map((c) => {
      const [subj, attr, op, val, p] = c.split('.');
      return { subj, attr, op, val: Number(val), pct: p === 'p' };
    })
    .filter((c) => SUBJ[c.subj] && SUBJ[c.subj].includes(c.attr) && OPS.includes(c.op) && Number.isFinite(c.val));
}

// texto do banco -> { colar: [{ id, on, conds, near }], anel: [...] }
function parse(text) {
  const cfg = { colar: [], anel: [] };
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^([a-z]+)\|(\d+)\|([01])\|([^|]*)\|(.*)$/);
    if (!m || !cfg[m[1]] || cfg[m[1]].length >= MAX_RULES) continue;
    const id = Number(m[2]);
    if (cfg[m[1]].some((r) => r.id === id)) continue;
    cfg[m[1]].push({ id, on: m[3] === '1', conds: parseConds(m[4]), near: m[5].split(';').filter(Boolean) });
  }
  return cfg;
}

// o que a pagina mandou -> texto do banco (confere tudo; erro em portugues para a pagina)
function serialize(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('Configuração inválida.');
  const byId = catalog();
  const lines = [];
  for (const slot of SLOTS) {
    const rules = cfg[slot] == null ? [] : cfg[slot];
    if (!Array.isArray(rules)) throw new Error('Configuração inválida.');
    if (rules.length > MAX_RULES) throw new Error(`No máximo ${MAX_RULES} peças em cada barra.`);
    const seen = new Set();
    for (const r of rules) {
      const id = Math.trunc(Number(r && r.id));
      if (!Number.isInteger(id) || id <= 0 || id > 65535) throw new Error('Peça inválida.');
      if (byId) {
        const e = byId.get(id);
        if (!e || e.slot !== slot) throw new Error('Essa peça não serve neste slot.');
      }
      if (seen.has(id)) continue;
      seen.add(id);
      const conds = (Array.isArray(r.conds) ? r.conds : []).slice(0, MAX_CONDS).map((c) => {
        if (!c || !SUBJ[c.subj] || !SUBJ[c.subj].includes(c.attr) || !OPS.includes(c.op)) throw new Error('Condição inválida.');
        const val = Math.max(0, Math.min(1000000, Math.floor(Number(c.val) || 0)));
        const pct = c.pct && (c.attr === 'hp' || c.attr === 'mana') ? '.p' : '';
        return `${c.subj}.${c.attr}.${c.op}.${val}${pct}`;
      });
      const near = [];
      for (const raw of Array.isArray(r.near) ? r.near : []) {
        const n = String(raw || '').trim().replace(/\s+/g, ' ');
        if (!MONSTER_RE.test(n)) throw new Error('Nome de monstro inválido.');
        if (!near.some((x) => x.toLowerCase() === n.toLowerCase()) && near.length < MAX_NEAR) near.push(n);
      }
      lines.push(`${slot}|${id}|${r.on ? 1 : 0}|${conds.join('&')}|${near.join(';')}`);
    }
  }
  return lines.join('\n');
}

async function load(q, playerId) {
  const [row] = await q('SELECT acc FROM idle_settings WHERE player_id = ?', [playerId]).catch(() => []);
  return parse(row && row.acc);
}

// grava; as pecas que acabaram de ser ligadas entram na lista "nao vender" da mochila
// (a Venda rapida e o Despachar loot nao levam o anel que a barra vai usar). Devolve quantas entraram.
async function save(q, playerId, cfg) {
  const text = serialize(cfg);
  const before = await load(q, playerId);
  const wasOn = new Set(SLOTS.flatMap((s) => before[s].filter((r) => r.on).map((r) => r.id)));
  const turnedOn = SLOTS.flatMap((s) => parse(text)[s].filter((r) => r.on && !wasOn.has(r.id)).map((r) => r.id));
  await q("INSERT INTO idle_settings (player_id, bar, acc) VALUES (?, '', ?) ON DUPLICATE KEY UPDATE acc = VALUES(acc)", [playerId, text]);
  if (!turnedOn.length) return 0;
  const [row] = await q('SELECT `keep` FROM idle_settings WHERE player_id = ?', [playerId]);
  const keep = String((row && row.keep) || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const add = turnedOn.filter((id) => !keep.includes(id));
  if (!add.length) return 0;
  await q('UPDATE idle_settings SET `keep` = ? WHERE player_id = ?', [[...keep, ...add].slice(0, 2000).join(','), playerId]);
  return add.length;
}

module.exports = { MIGRATION, SLOTS, parse, serialize, load, save };
