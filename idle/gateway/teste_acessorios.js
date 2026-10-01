'use strict';
// Testa gateway/acessorios.js sem banco: parse/serialize ida e volta, validacao e o "nao vender" das pecas ligadas.
//   node idle/gateway/teste_acessorios.js
// Com public/itens/acessorios.json (tools/acessorios.py) tambem confere se a peca e do slot certo.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Acc = require('./acessorios');
const HAS_CAT = fs.existsSync(path.join(__dirname, 'public', 'itens', 'acessorios.json'));

let ok = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(() => { ok++; console.log('ok  ', name); }, (e) => { console.log('FALHOU', name, e.message); process.exitCode = 1; });

// banco falso: so a linha de idle_settings do personagem 7
function fakeDb(row) {
  const db = { row: { ...row }, sql: [] };
  db.q = async (sql, p = []) => {
    db.sql.push(sql);
    if (/^SELECT acc/.test(sql)) return db.row ? [{ acc: db.row.acc ?? null }] : [];
    if (/^SELECT `keep`/.test(sql)) return db.row ? [{ keep: db.row.keep ?? null }] : [];
    if (/^INSERT INTO idle_settings/.test(sql)) { db.row = db.row || {}; db.row.acc = p[1]; return []; }
    if (/^UPDATE idle_settings SET `keep`/.test(sql)) { db.row.keep = p[0]; return []; }
    throw new Error('sql inesperado: ' + sql);
  };
  return db;
}

const cfg = {
  colar: [
    { id: 3081, on: true, conds: [{ subj: 'self', attr: 'hp', op: 'le', val: 40, pct: true }, { subj: 'area', attr: 'targets', op: 'ge', val: 3, pct: true }], near: ['Dragon Lord', 'dragon lord', 'Dragon'] },
    { id: 3572, on: true, conds: [], near: [] },
    { id: 3084, on: false, conds: [{ subj: 'target', attr: 'hp', op: 'gt', val: 2000000, pct: false }], near: [] },
  ],
  anel: [{ id: 3053, on: true, conds: [{ subj: 'area', attr: 'targets', op: 'ge', val: 2 }], near: [] }, { id: 3048, on: true }],
};

(async () => {
  await t('serialize gera o formato que o Lua le', () => {
    const txt = Acc.serialize(cfg);
    assert.strictEqual(txt.split('\n').length, 5);
    assert.strictEqual(txt.split('\n')[0], 'colar|3081|1|self.hp.le.40.p&area.targets.ge.3|Dragon Lord;Dragon');
    assert.strictEqual(txt.split('\n')[2], 'colar|3084|0|target.hp.gt.1000000|');
    assert.strictEqual(txt.split('\n')[4], 'anel|3048|1||');
    // a linha bate com o padrao do idle_acessorios.lua: ^(%a+)|(%d+)|([01])|([^|]*)|(.*)$
    for (const line of txt.split('\n')) assert.ok(/^[A-Za-z]+\|\d+\|[01]\|[^|]*\|.*$/.test(line), line);
    // e cada condicao bate com o I.parseConds: ^(%a+)%.(%a+)%.(%a+)%.(%d+)%.?(p?)$
    for (const line of txt.split('\n')) for (const c of line.split('|')[3].split('&').filter(Boolean)) assert.ok(/^[A-Za-z]+\.[A-Za-z]+\.[A-Za-z]+\.\d+\.?p?$/.test(c), c);
  });

  await t('parse(serialize(x)) devolve a mesma configuracao', () => {
    const back = Acc.parse(Acc.serialize(cfg));
    assert.deepStrictEqual(back.colar.map((r) => r.id), [3081, 3572, 3084]);
    assert.deepStrictEqual(back.colar[0].conds[1], { subj: 'area', attr: 'targets', op: 'ge', val: 3, pct: false });
    assert.deepStrictEqual(back.colar[0].near, ['Dragon Lord', 'Dragon']);
    assert.strictEqual(back.colar[2].on, false);
    assert.deepStrictEqual(back.anel[1], { id: 3048, on: true, conds: [], near: [] });
    assert.strictEqual(Acc.serialize(back), Acc.serialize(cfg));
  });

  await t('parse aguenta lixo e vazio', () => {
    assert.deepStrictEqual(Acc.parse(null), { colar: [], anel: [] });
    assert.deepStrictEqual(Acc.parse('xx|1|1||\ncolar|abc|1||\nanel|3048|1|self.foo.le.1|\n'), { colar: [], anel: [{ id: 3048, on: true, conds: [], near: [] }] });
  });

  await t('recusa peca do slot errado, condicao invalida e monstro com simbolo', () => {
    if (HAS_CAT) assert.throws(() => Acc.serialize({ colar: [{ id: 3048, on: true }] }), /não serve neste slot/);
    else console.log('     (sem itens/acessorios.json: nao confere o slot da peca)');
    assert.throws(() => Acc.serialize({ anel: [{ id: 3048, on: true, conds: [{ subj: 'area', attr: 'hp', op: 'ge', val: 1 }] }] }), /Condição inválida/);
    assert.throws(() => Acc.serialize({ anel: [{ id: 3048, on: true, near: ['Dragon|1'] }] }), /monstro/);
    assert.throws(() => Acc.serialize({ anel: [{ id: 3048, on: true, near: ['a;b'] }] }), /monstro/);
    assert.throws(() => Acc.serialize({ anel: Array.from({ length: 21 }, () => ({ id: 3048 })) }), /No máximo 20/);
    assert.throws(() => Acc.serialize('x'), /inválida/);
  });

  await t('repetida entra uma vez; limites de condicoes e monstros', () => {
    const txt = Acc.serialize({ anel: [{ id: 3048, on: true, conds: Array.from({ length: 12 }, () => ({ subj: 'self', attr: 'hp', op: 'le', val: 5, pct: true })), near: ['A', 'B', 'C', 'D', 'E', 'F'] }, { id: 3048, on: false }] });
    assert.strictEqual(txt.split('\n').length, 1);
    assert.strictEqual(txt.split('|')[3].split('&').length, 8);
    assert.strictEqual(txt.split('|')[4].split(';').length, 5);
  });

  await t('save grava e poe as pecas recem-ligadas no "nao vender"', async () => {
    const db = fakeDb({ acc: 'anel|3048|1||', keep: '5877,3048' });
    const n = await Acc.save(db.q, 7, cfg);
    // 3081, 3572 e 3053 foram ligadas agora (3048 ja estava ligado; 3084 esta desligado)
    assert.strictEqual(n, 3);
    assert.strictEqual(db.row.keep, '5877,3048,3081,3572,3053');
    assert.strictEqual(db.row.acc, Acc.serialize(cfg));
    // salvar de novo nao mexe no keep (o jogador pode ter desmarcado na Venda rapida)
    db.row.keep = '5877';
    assert.strictEqual(await Acc.save(db.q, 7, cfg), 0);
    assert.strictEqual(db.row.keep, '5877');
    assert.deepStrictEqual((await Acc.load(db.q, 7)).colar.map((r) => r.id), [3081, 3572, 3084]);
  });

  await t('save com configuracao invalida nao grava nada', async () => {
    const db = fakeDb({ acc: '', keep: '' });
    await assert.rejects(() => Acc.save(db.q, 7, { anel: [{ id: 3048, on: true, conds: [{ subj: 'x' }] }] }), /Condição inválida/);
    assert.strictEqual(db.sql.length, 0);
  });

  console.log(`\n${ok} testes passaram`);
})();
