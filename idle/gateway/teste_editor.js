'use strict';
/*
 * Teste do editor da cidade sem servidor nem banco: o Modelo da pagina (public/editor.js) e a parte da ponte
 * (editor.js: codigo do editor, edicoes, pedido de publicacao) com dados inventados.   node teste_editor.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Modelo } = require('./public/editor.js');
const Editor = require('./editor');

let falhas = 0;
async function caso(nome, fn) {
  try {
    await fn();
    console.log('OK    ' + nome);
  } catch (e) {
    falhas++;
    console.log('FALHA ' + nome + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e));
  }
}

// itens: 10/11 chao, 20 borda, 30 parede, 40/41 item comum, 50 por cima
const CAMADA = { 10: 0, 11: 0, 20: 1, 30: 2, 40: 3, 41: 3, 50: 4 };
const camadaDe = (id) => (id in CAMADA ? CAMADA[id] : 3);
const cidade = () => ({
  w: 11, h: 11, zr: [-1, 1], from: [100, 100, 7],
  tiles: [[0, 0, 0, 10, 40], [1, 0, 0, 10], [2, 0, 0, 10, 30, 50, 41], [0, 1, 0, 11], [0, 0, -1, 10]],
  flags: [[0, 0, 0, 1], [1, 0, 0, 9]],
});

(async () => {
  await caso('comeca igual a base, sem edicoes', () => {
    const m = new Modelo(cidade(), null, camadaDe);
    assert.deepStrictEqual(m.edicoes(), { tiles: {}, flags: {} });
    assert.deepStrictEqual(m.tile('0,0,0'), [10, 40]);
    assert.strictEqual(m.flags('1,0,0'), 9);
  });

  await caso('pincel: chao troca o chao, item vai no topo, sem repetir', () => {
    const m = new Modelo(cidade(), null, camadaDe);
    m.fazer('a', () => m.colocar('0,0,0', 11));
    assert.deepStrictEqual(m.tile('0,0,0'), [11, 40]);
    m.fazer('b', () => m.colocar('0,0,0', 41));
    m.fazer('c', () => m.colocar('0,0,0', 41));
    assert.deepStrictEqual(m.tile('0,0,0'), [11, 40, 41]);
    m.fazer('d', () => m.colocar('5,5,1', 10)); // tile novo
    assert.deepStrictEqual(m.tile('5,5,1'), [10]);
    m.fazer('e', () => m.colocar('6,0,0', 10)); // fora do recorte (w 11 = -5..5)
    assert.deepStrictEqual(m.tile('6,0,0'), []);
    assert.strictEqual(m.desfazerPilha.length, 3); // c (repetido) e e (fora) nao contam
  });

  await caso('borracha tira o item de cima (o desenhado por ultimo)', () => {
    const m = new Modelo(cidade(), null, camadaDe);
    assert.strictEqual(m.topo('2,0,0'), 50);
    m.fazer('x', () => m.apagarTopo('2,0,0'));
    assert.deepStrictEqual(m.tile('2,0,0'), [10, 30, 41]);
    m.fazer('x', () => m.apagarTopo('2,0,0'));
    assert.deepStrictEqual(m.tile('2,0,0'), [10, 30]);
    m.fazer('x', () => { m.apagarTopo('1,0,0'); });
    assert.deepStrictEqual(m.tile('1,0,0'), []); // tile apagado
    assert.deepStrictEqual(m.edicoes().tiles, { '1,0,0': [], '2,0,0': [10, 30] });
  });

  await caso('trocar chao (area), limpar, ordem da pilha, tirar', () => {
    const m = new Modelo(cidade(), null, camadaDe);
    m.fazer('chao', () => ['0,0,0', '1,0,0', '3,3,0'].forEach((k) => m.trocarChao(k, 11, false)));
    assert.deepStrictEqual(m.tile('0,0,0'), [11, 40]);
    assert.deepStrictEqual(m.tile('1,0,0'), [11]);
    assert.deepStrictEqual(m.tile('3,3,0'), []);
    m.fazer('chao2', () => m.trocarChao('3,3,0', 11, true));
    assert.deepStrictEqual(m.tile('3,3,0'), [11]);
    m.fazer('limpar', () => m.limpar('2,0,0', true));
    assert.deepStrictEqual(m.tile('2,0,0'), [10]);
    m.fazer('add', () => { m.colocar('2,0,0', 40); m.colocar('2,0,0', 41); });
    m.fazer('ordem', () => m.trocar('2,0,0', 1, 2));
    assert.deepStrictEqual(m.tile('2,0,0'), [10, 41, 40]);
    m.fazer('tirar', () => m.tirar('2,0,0', 0));
    assert.deepStrictEqual(m.tile('2,0,0'), [41, 40]);
  });

  await caso('zona protegida liga/desliga sem mexer nas outras flags', () => {
    const m = new Modelo(cidade(), null, camadaDe);
    m.fazer('z', () => { m.zona('1,0,0', false); m.zona('0,1,0', true); m.zona('4,4,0', true); });
    assert.strictEqual(m.flags('1,0,0'), 8);
    assert.strictEqual(m.flags('0,1,0'), 1);
    assert.strictEqual(m.flags('4,4,0'), 0); // tile vazio nao ganha zona
    assert.deepStrictEqual(m.edicoes().flags, { '0,1,0': 1, '1,0,0': 8 });
  });

  await caso('desfazer/refazer e voltar ao original tira do arquivo', () => {
    const m = new Modelo(cidade(), null, camadaDe);
    m.fazer('a', () => m.colocar('0,0,0', 41));
    m.fazer('b', () => m.zona('0,0,0', false));
    assert.deepStrictEqual(m.edicoes(), { tiles: { '0,0,0': [10, 40, 41] }, flags: { '0,0,0': 0 } });
    m.desfazer();
    assert.deepStrictEqual(m.edicoes(), { tiles: { '0,0,0': [10, 40, 41] }, flags: {} });
    m.desfazer();
    assert.deepStrictEqual(m.edicoes(), { tiles: {}, flags: {} });
    assert.strictEqual(m.desfazer(), null);
    m.refazer();
    m.refazer();
    assert.deepStrictEqual(m.edicoes(), { tiles: { '0,0,0': [10, 40, 41] }, flags: { '0,0,0': 0 } });
    m.fazer('c', () => m.apagarTopo('0,0,0')); // volta a ser igual a base
    assert.deepStrictEqual(m.edicoes().tiles, {});
    assert.strictEqual(m.refazerPilha.length, 0);
  });

  await caso('acao com arrasto (vivo) avisa tile a tile e vira um passo so', () => {
    const m = new Modelo(cidade(), null, camadaDe);
    const avisos = [];
    m.ouvir((ks) => avisos.push(ks.slice()));
    m.comecar('arrasto');
    m.acao.vivo = true;
    m.colocar('0,0,0', 41);
    m.colocar('1,0,0', 41);
    m.colocar('1,0,0', 41);
    m.terminar();
    assert.deepStrictEqual(avisos, [['0,0,0'], ['1,0,0'], []]);
    assert.strictEqual(m.desfazerPilha.length, 1);
    m.desfazer();
    assert.deepStrictEqual(m.tile('1,0,0'), [10]);
  });

  await caso('edicoes salvas carregam; cidade publicada com edbase da a mesma base', () => {
    const m = new Modelo(cidade(), null, camadaDe);
    m.fazer('a', () => { m.colocar('0,0,0', 11); m.apagarTopo('1,0,0'); m.colocar('4,4,1', 10); m.zona('0,1,0', true); });
    const ed = m.edicoes();
    // 1) editor reaberto antes de publicar: cidade.json velho + edicoes do arquivo
    const m2 = new Modelo(cidade(), JSON.parse(JSON.stringify(ed)), camadaDe);
    assert.deepStrictEqual(m2.edicoes(), ed);
    assert.deepStrictEqual(m2.tile('0,0,0'), [11, 40]);
    // 2) depois do decorar.py: cidade.json ja com as edicoes e o "edbase" (como cada tile era antes)
    const pub = cidade();
    const tiles = new Map(pub.tiles.map((t) => [t.slice(0, 3).join(','), t]));
    const edbase = { tiles: {}, flags: {} };
    for (const [k, ids] of Object.entries(ed.tiles)) {
      const t = tiles.get(k);
      edbase.tiles[k] = t ? t.slice(3) : [];
      if (ids.length) tiles.set(k, [...k.split(',').map(Number), ...ids]);
      else tiles.delete(k);
    }
    const flags = new Map(pub.flags.map((f) => [f.slice(0, 3).join(','), f[3]]));
    for (const [k, f] of Object.entries(ed.flags)) {
      edbase.flags[k] = flags.get(k) || 0;
      if (f) flags.set(k, f);
      else flags.delete(k);
    }
    pub.tiles = [...tiles.values()];
    pub.flags = [...flags].map(([k, f]) => [...k.split(',').map(Number), f]);
    pub.edbase = edbase;
    const m3 = new Modelo(pub, JSON.parse(JSON.stringify(ed)), camadaDe);
    assert.deepStrictEqual(m3.edicoes(), ed);
    // 3) o arquivo de edicoes sumiu: vale o publicado e as edicoes ja aplicadas continuam no proximo salvar
    const m4 = new Modelo(pub, null, camadaDe);
    assert.deepStrictEqual(m4.edicoes(), ed);
    assert.deepStrictEqual(m4.tile('0,0,0'), [11, 40]);
    m4.fazer('desfaz', () => m4.colocar('0,0,0', 10)); // voltar um tile editado para o original tira ele
    assert.ok(!('0,0,0' in m4.edicoes().tiles));
    // 4) o arquivo salvo depois de publicar desfez uma edicao: o editor mostra a base nesse tile
    const ed2 = JSON.parse(JSON.stringify(ed));
    delete ed2.tiles['0,0,0'];
    const m5 = new Modelo(pub, ed2, camadaDe);
    assert.deepStrictEqual(m5.tile('0,0,0'), [10, 40]);
    assert.deepStrictEqual(m5.edicoes(), ed2);
  });

  // ---------------------------------------------------------------- ponte (gateway/editor.js)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-'));
  const pub = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'));
  fs.mkdirSync(path.join(pub, 'salas'));
  fs.writeFileSync(path.join(pub, 'salas', 'cidade.json'), JSON.stringify(cidade()));
  fs.writeFileSync(path.join(pub, 'editor.html'), 'EDITOR');
  fs.writeFileSync(path.join(pub, 'editor_acesso.html'), 'CODIGO');
  fs.writeFileSync(path.join(pub, 'editor.js'), 'JS');
  fs.writeFileSync(path.join(pub, 'fogo.js'), 'FOGO');
  const CODE = 'ABCD-1234-WXYZ';
  // resposta falsa: guarda status, cabecalhos e corpo; pronta quando termina
  const fakeRes = () => {
    let done;
    const res = {
      headers: {},
      fim: new Promise((r) => (done = r)),
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      writeHead(s, h = {}) { this.status = s; for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; },
      end(d) { this.body = d ? String(d) : ''; done(); },
    };
    return res;
  };
  const send = (res, status, body) => { res.status = status; res.json = body; res.end(JSON.stringify(body)); };
  const mk = (code) => Editor.create({ send, dir, publicDir: pub, code, online: () => 2 });
  const ed = mk(CODE);
  let cookie = '';
  const chama = async (method, urlPath, body, extra = {}) => {
    const url = new URL(urlPath, 'http://x');
    const rel = url.pathname.replace(/^\/jogar/, '') || '/';
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
    const req = Object.assign(chunks, { method, socket: {}, headers: { cookie, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...extra } });
    const res = fakeRes();
    assert.ok(ed.owns(rel), 'o editor cuida de ' + rel);
    await ed.http(req, res, url, rel);
    await res.fim;
    return res;
  };

  await caso('ponte: sem o codigo so a tela do codigo responde', async () => {
    let r = await chama('GET', '/jogar/editor/');
    assert.strictEqual(r.body, 'CODIGO');
    r = await chama('GET', '/jogar/editor/editor.js');
    assert.strictEqual(r.status, 401);
    r = await chama('GET', '/jogar/editor/salas/cidade.json');
    assert.strictEqual(r.status, 401);
    r = await chama('GET', '/jogar/editor/fogo.js');
    assert.strictEqual(r.body, 'FOGO');
    r = await chama('GET', '/jogar/api/editor/edicoes');
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.json.editor, true);
    r = await chama('POST', '/jogar/api/editor/publicar', { tiles: {} });
    assert.strictEqual(r.status, 401);
    r = await chama('GET', '/jogar/editor.html');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, '/jogar/editor/');
    r = await chama('GET', '/jogar/editor');
    assert.strictEqual(r.headers.location, '/jogar/editor/');
    assert.ok(!ed.owns('/index.html') && !ed.owns('/api/entrar') && !ed.owns('/editora'));
  });

  await caso('ponte: codigo errado e codigo certo (cookie nos 2 caminhos)', async () => {
    let r = await chama('POST', '/jogar/api/editor/codigo', { codigo: 'errado' });
    assert.strictEqual(r.status, 401);
    r = await chama('POST', '/jogar/api/editor/codigo', { codigo: 'abcd 1234 wxyz' });
    assert.strictEqual(r.status, 200);
    const sc = r.headers['set-cookie'];
    assert.ok(Array.isArray(sc) && sc.length === 2);
    assert.ok(sc[0].includes('Path=/jogar/editor;') && sc[1].includes('Path=/jogar/api/editor;'), sc.join(' | '));
    assert.ok(sc.every((c) => /HttpOnly/.test(c) && /SameSite=Lax/.test(c)));
    cookie = sc[0].split(';')[0];
    r = await chama('GET', '/jogar/editor/');
    assert.strictEqual(r.body, 'EDITOR');
    r = await chama('GET', '/jogar/editor/salas/cidade.json');
    assert.strictEqual(r.status, 200);
    r = await chama('GET', '/jogar/editor/salas/..%2f..%2fserver.js');
    assert.notStrictEqual(r.status, 200);
    r = await chama('GET', '/jogar/editor/salas/cidade_base.json');
    assert.strictEqual(r.status, 404);
    // outro codigo (trocado no .env): a liberacao antiga nao vale
    const outro = mk('OUTRO-CODIGO');
    const res = fakeRes();
    await outro.http(Object.assign([], { method: 'GET', headers: { cookie }, socket: {} }), res, new URL('http://x/jogar/api/editor/edicoes'), '/api/editor/edicoes');
    await res.fim;
    assert.strictEqual(res.status, 401);
  });

  await caso('ponte: sem EDITOR_CODE o editor fica desligado', async () => {
    const off = mk('');
    const res = fakeRes();
    await off.http(Object.assign([], { method: 'GET', headers: { cookie }, socket: {} }), res, new URL('http://x/jogar/editor/'), '/editor/');
    await res.fim;
    assert.strictEqual(res.status, 404);
  });

  await caso('ponte: GET sem arquivo; POST sem JSON e invalidos sao recusados', async () => {
    let r = await chama('GET', '/jogar/api/editor/edicoes');
    assert.deepStrictEqual(r.json, { tiles: {}, flags: {}, salvo: 0 });
    r = await chama('POST', '/jogar/api/editor/publicar', { tiles: {} }, { 'content-type': 'text/plain' });
    assert.strictEqual(r.status, 415);
    for (const body of [{ tiles: { '9,0,0': [1] } }, { tiles: { '0,0,5': [1] } }, { tiles: { '0,0,0': [0] } }, { tiles: { '0,0,0': [70000] } },
      { tiles: { '0,0,0': ['1'] } }, { tiles: { 'a,b,c': [1] } }, { tiles: [] }, { flags: { '0,0,0': -1 } }, { flags: { '0,0,0': 1.5 } },
      { tiles: { '0,0,0': new Array(40).fill(1) } }]) {
      r = await chama('POST', '/jogar/api/editor/publicar', body);
      assert.strictEqual(r.status, 400, JSON.stringify(body));
    }
    r = await chama('POST', '/jogar/api/editor/publicar', '{nao e json');
    assert.strictEqual(r.status, 400);
    assert.ok(!fs.existsSync(path.join(dir, 'cidade_edicoes.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'publicar.pedido')));
  });

  let salvo1;
  await caso('ponte: publicar grava as edicoes e o pedido para o vigia', async () => {
    const r = await chama('POST', '/jogar/api/editor/publicar', { tiles: { '0,0,0': [11, 40], '-1,-2,1': [] }, flags: { '0,1,0': 1 }, base: 0 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    salvo1 = r.json.salvo;
    const f = JSON.parse(fs.readFileSync(path.join(dir, 'cidade_edicoes.json'), 'utf8'));
    assert.deepStrictEqual(f.tiles, { '0,0,0': [11, 40], '-1,-2,1': [] });
    assert.deepStrictEqual(f.flags, { '0,1,0': 1 });
    assert.strictEqual(f.salvo, salvo1);
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'publicar.pedido'), 'utf8'));
    assert.strictEqual(p.id, salvo1);
    const g = await chama('GET', '/jogar/api/editor/edicoes');
    assert.deepStrictEqual(g.json.tiles, f.tiles);
    assert.strictEqual(g.json.salvo, salvo1);
    const s = await chama('GET', '/jogar/api/editor/status');
    assert.strictEqual(s.json.pedido, true);
    assert.strictEqual(s.json.online, 2);
    const gw = JSON.parse(fs.readFileSync(path.join(dir, 'gateway.json'), 'utf8'));
    assert.strictEqual(gw.online, 2);
  });

  await caso('ponte: conflito quando outra aba publicou depois (409) e forcar; salvar = publicar', async () => {
    let r = await chama('POST', '/jogar/api/editor/publicar', { tiles: {}, flags: {}, base: 0 });
    assert.strictEqual(r.status, 409);
    r = await chama('POST', '/jogar/api/editor/salvar', { tiles: { '1,1,0': [10] }, flags: {}, base: salvo1 });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.salvo > salvo1);
    r = await chama('POST', '/jogar/api/editor/publicar', { tiles: {}, flags: {}, base: salvo1, forcar: true });
    assert.strictEqual(r.status, 200);
    assert.ok(fs.readdirSync(path.join(dir, 'historico')).length >= 1, 'guardou a versao anterior');
  });

  await caso('ponte: status le o que o vigia escreve; recarregar cria o pedido', async () => {
    fs.writeFileSync(path.join(dir, 'publicar.status.json'), JSON.stringify({ id: 5, estado: 'esperando', msg: 'x' }));
    let r = await chama('GET', '/jogar/api/editor/status');
    assert.strictEqual(r.json.status.estado, 'esperando');
    r = await chama('POST', '/jogar/api/editor/recarregar', {});
    assert.strictEqual(r.status, 200);
    assert.ok(fs.existsSync(path.join(dir, 'recarregar.agora')));
    r = await chama('GET', '/jogar/api/editor/status');
    assert.strictEqual(r.json.agora, true);
  });

  await caso('ponte: pedido grande demais (413)', async () => {
    const r = await chama('POST', '/jogar/api/editor/publicar', { tiles: {}, pad: 'x'.repeat(5 * 1024 * 1024) });
    assert.strictEqual(r.status, 413);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(pub, { recursive: true, force: true });
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  process.exit(falhas ? 1 : 0);
})();
