'use strict';
/*
 * Editor da cidade (public/editor.html, igual ao Remere's Map Editor) - a parte da ponte.
 *
 * Acesso: codigo proprio (EDITOR_CODE, so o Julio tem), igual a tela "Teste fechado" do jogo. O codigo certo
 * grava o cookie dt_editor (HMAC do codigo) para <prefixo>/editor e <prefixo>/api/editor; sem ele so a tela do
 * codigo responde (nem a pagina nem a API). Trocar o codigo derruba as liberacoes antigas. EDITOR_CODE vazio =
 * editor desligado. Fica fora da tela "Teste fechado" (ACCESS_CODE): o codigo do editor basta.
 *
 * Paginas (servidas daqui): <prefixo>/editor/ (editor.html; sem o cookie, editor_acesso.html), editor.js,
 * editor.css, salas/cidade.json|png e salas/paleta*.
 * API:
 *   POST /api/editor/codigo      <- { codigo }                        libera este navegador (30 dias)
 *   GET  /api/editor/edicoes     -> { tiles, flags, salvo }
 *   POST /api/editor/publicar    <- { tiles, flags, base, forcar }    grava as edicoes e pede a publicacao
 *        (/api/editor/salvar faz o mesmo)
 *   GET  /api/editor/status      -> { pedido, status, online }        andamento da publicacao
 *   POST /api/editor/recarregar  reinicia o servidor do jogo agora, mesmo com gente jogando
 *
 * Arquivos em EDITOR_DIR (volume: na VPS /opt/idle/editor, gravavel pelo usuario node, uid 1000):
 *   cidade_edicoes.json  { "tiles": { "dx,dy,dz": [itens de baixo para cima] }, "flags": { "dx,dy,dz": n },
 *                        "salvo": unix } - so o que difere da base; [] apaga o tile; flags 1 = zona protegida
 *   historico/           as 30 versoes anteriores
 *   publicar.pedido      a ponte cria; o vigia na VPS (tools/publicar_cidade.py) consome e aplica:
 *                        decorar.py -> sprites_mapa.py -> cidade.json/png novos (pasta salas montada no
 *                        container: sem rebuild) -> reinicia o servidor do jogo
 *   recarregar.agora     "Recarregar agora" (o vigia reinicia mesmo com gente jogando)
 *   publicar.status.json o vigia escreve { id, estado, msg, inicio, fim, online, log }
 *   gateway.json         a ponte escreve a cada 15 s quantos estao jogando (o vigia espera dar 0)
 * "base" no publicar = o "salvo" que a pagina carregou: se outra aba publicou depois, responde 409.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BODY = 4 * 1024 * 1024;
const MAX_TILES = 40000;
const MAX_STACK = 32; // itens num tile
const KEEP_HISTORY = 30;
const KEY_RE = /^(-?\d{1,4}),(-?\d{1,4}),(-?\d{1,2})$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };
const FREE = new Set(['fogo.js', 'logo.webp', 'icon.svg']); // o visual da tela do codigo
const DATA_RE = /^salas\/(cidade\.(json|png)|paleta\.json|paleta(_\d{1,2})?\.png)$/;

function create({ send, dir, publicDir, code, online }) {
  const CODE = String(code || '').trim();
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const token = CODE ? crypto.createHmac('sha256', norm(CODE)).update('destruitor-idle-editor').digest('hex') : '';
  const file = path.join(dir, 'cidade_edicoes.json');
  const F = (n) => path.join(dir, n);

  // ---------------------------------------------------------------- codigo do editor
  const attempts = new Map(); // ip -> [tempos] (8 tentativas a cada 15 min)
  function tooMany(ip) {
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
    list.push(now);
    attempts.set(ip, list);
    return list.length > 8;
  }
  function liberado(req) {
    if (!token) return false;
    const m = String(req.headers.cookie || '').match(/(?:^|;\s*)dt_editor=([a-f0-9]{64})/);
    return !!m && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(token));
  }
  async function codigo(req, res, prefix) {
    const ip = req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || '?';
    if (tooMany(ip)) return send(res, 429, { erro: 'Muitas tentativas. Espere alguns minutos.' });
    let b;
    try {
      b = await readBody(req);
    } catch (e) {
      return send(res, e.status || 400, { erro: e.message });
    }
    const given = Buffer.from(norm(b.codigo)), want = Buffer.from(norm(CODE));
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(res, 401, { erro: 'Código errado.' });
    const c = (p) => `dt_editor=${token}; Path=${prefix}${p}; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax`;
    res.setHeader('Set-Cookie', [c('/editor'), c('/api/editor')]);
    return send(res, 200, { ok: true });
  }

  // ---------------------------------------------------------------- edicoes
  let bounds = null;
  const limits = () => {
    if (!bounds) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(publicDir, 'salas', 'cidade.json'), 'utf8'));
        bounds = { rx: r.w >> 1, ry: r.h >> 1, lo: r.zr[0], hi: r.zr[1] };
      } catch {
        bounds = { rx: 70, ry: 60, lo: -2, hi: 2 };
      }
    }
    return bounds;
  };
  function key(k) {
    const m = KEY_RE.exec(String(k));
    if (!m) return null;
    const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const b = limits();
    if (Math.abs(x) > b.rx || Math.abs(y) > b.ry || z < b.lo || z > b.hi) return null;
    return `${x},${y},${z}`;
  }
  // confere e normaliza o que a pagina mandou (erro = mensagem para a pagina)
  function validate(body) {
    if (!body || typeof body !== 'object') throw new Error('Edições inválidas.');
    const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
    const inTiles = body.tiles == null ? {} : body.tiles;
    const inFlags = body.flags == null ? {} : body.flags;
    if (!isObj(inTiles) || !isObj(inFlags)) throw new Error('Edições inválidas.');
    const tiles = {}, flags = {};
    const tk = Object.keys(inTiles), fk = Object.keys(inFlags);
    if (tk.length > MAX_TILES || fk.length > MAX_TILES) throw new Error(`No máximo ${MAX_TILES} tiles editados.`);
    for (const k of tk) {
      const nk = key(k);
      if (!nk) throw new Error(`Posição fora da cidade: ${k}`);
      const ids = inTiles[k];
      if (!Array.isArray(ids) || ids.length > MAX_STACK || !ids.every((i) => Number.isInteger(i) && i > 0 && i < 65536)) {
        throw new Error(`Itens inválidos no tile ${k}.`);
      }
      tiles[nk] = ids;
    }
    for (const k of fk) {
      const nk = key(k);
      if (!nk) throw new Error(`Posição fora da cidade: ${k}`);
      const f = inFlags[k];
      if (!Number.isInteger(f) || f < 0 || f > 0xffffffff) throw new Error(`Flags inválidas no tile ${k}.`);
      flags[nk] = f;
    }
    return { tiles, flags };
  }
  const readJsonFile = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  };
  function load() {
    const d = readJsonFile(file) || {};
    return { tiles: d.tiles || {}, flags: d.flags || {}, salvo: d.salvo || 0 };
  }
  // grava num temporario e troca (quem le nunca pega o arquivo pela metade)
  function writeAtomic(f, data) {
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data));
    fs.renameSync(tmp, f);
  }
  function save(data) {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) {
      const hist = F('historico');
      fs.mkdirSync(hist, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      fs.copyFileSync(file, path.join(hist, `cidade_edicoes-${stamp}.json`));
      const old = fs.readdirSync(hist).filter((f) => /^cidade_edicoes-.*\.json$/.test(f)).sort();
      for (const f of old.slice(0, Math.max(0, old.length - KEEP_HISTORY))) fs.unlinkSync(path.join(hist, f));
    }
    writeAtomic(file, data);
  }

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw Object.assign(new Error('Edições grandes demais.'), { status: 413 });
      chunks.push(c);
    }
    try {
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      throw Object.assign(new Error('Pedido inválido.'), { status: 400 });
    }
  }

  // quantos estao jogando (o vigia so reinicia o servidor com 0, ou com "Recarregar agora")
  if (online && token) {
    const beat = () => {
      try {
        if (fs.existsSync(dir)) writeAtomic(F('gateway.json'), { online: online(), at: Math.floor(Date.now() / 1000) });
      } catch {
        /* pasta sem permissao: o vigia trata como ninguem jogando so se o arquivo estiver velho */
      }
    };
    beat();
    const t = setInterval(beat, 15000);
    if (t.unref) t.unref();
  }

  async function api(req, res, rel) {
    const route = req.method + ' ' + rel.replace(/^\/api\/editor/, '');
    // POST so com JSON: um formulario de outro site nao consegue mandar
    if (req.method === 'POST' && !/^application\/json/i.test(String(req.headers['content-type'] || ''))) {
      return send(res, 415, { erro: 'Pedido inválido.' });
    }
    if (route === 'GET /edicoes') return send(res, 200, load());
    if (route === 'POST /publicar' || route === 'POST /salvar') {
      let body, ed;
      try {
        body = await readBody(req);
        ed = validate(body);
      } catch (e) {
        return send(res, e.status || 400, { erro: e.message });
      }
      const cur = load();
      if (!body.forcar && cur.salvo && Number(body.base || 0) !== cur.salvo) {
        return send(res, 409, { erro: 'O mapa foi publicado de outro lugar depois que você abriu o editor.', salvo: cur.salvo, conflito: true });
      }
      const salvo = Math.max(Math.floor(Date.now() / 1000), cur.salvo + 1);
      try {
        save({ tiles: ed.tiles, flags: ed.flags, salvo });
        writeAtomic(F('publicar.pedido'), { id: salvo, at: Math.floor(Date.now() / 1000) });
      } catch (e) {
        console.error('[editor] nao gravou', e.message);
        return send(res, 500, { erro: 'Não deu para gravar as edições no servidor.' });
      }
      console.log(`[editor] publicar: ${Object.keys(ed.tiles).length} tiles e ${Object.keys(ed.flags).length} flags (id ${salvo})`);
      return send(res, 200, { ok: true, salvo, tiles: Object.keys(ed.tiles).length, flags: Object.keys(ed.flags).length });
    }
    if (route === 'GET /status') {
      return send(res, 200, {
        pedido: fs.existsSync(F('publicar.pedido')),
        agora: fs.existsSync(F('recarregar.agora')),
        status: readJsonFile(F('publicar.status.json')),
        online: online ? online() : 0,
        salvo: load().salvo,
      });
    }
    if (route === 'POST /recarregar') {
      try {
        writeAtomic(F('recarregar.agora'), { at: Math.floor(Date.now() / 1000) });
      } catch {
        return send(res, 500, { erro: 'Não deu para pedir o reinício.' });
      }
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { erro: 'Não encontrado.' });
  }

  // ---------------------------------------------------------------- HTTP
  function serve(res, f, cache = 'no-cache') {
    fs.readFile(f, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Não encontrado');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': cache });
      res.end(data);
    });
  }
  // rel = caminho sem o /jogar
  const owns = (rel) => rel === '/editor' || rel.startsWith('/editor/') || rel === '/api/editor' || rel.startsWith('/api/editor/') ||
    ['/editor.html', '/editor.js', '/editor.css', '/editor_acesso.html'].includes(rel);

  async function http(req, res, url, rel) {
    const prefix = url.pathname.startsWith('/jogar') ? '/jogar' : '';
    const isApi = rel === '/api/editor' || rel.startsWith('/api/editor/');
    if (!token) {
      if (isApi) return send(res, 404, { erro: 'O editor está desligado (falta EDITOR_CODE).' });
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Editor desligado.');
    }
    if (isApi) {
      if (req.method === 'POST' && rel === '/api/editor/codigo') return codigo(req, res, prefix);
      if (!liberado(req)) return send(res, 401, { erro: 'Digite o código do editor.', editor: true });
      return api(req, res, rel);
    }
    // os arquivos do editor so existem dentro de /editor/
    if (!rel.startsWith('/editor/')) {
      res.writeHead(302, { Location: prefix + '/editor/', 'Cache-Control': 'no-store' });
      return res.end();
    }
    let f;
    try {
      f = decodeURIComponent(rel.slice('/editor/'.length)) || 'index.html';
    } catch {
      f = '?';
    }
    if (FREE.has(f)) return serve(res, path.join(publicDir, f));
    const ok = liberado(req);
    if (f === 'index.html') return serve(res, path.join(publicDir, ok ? 'editor.html' : 'editor_acesso.html'), 'no-store');
    if (!ok) {
      res.writeHead(401, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (f === 'editor.js' || f === 'editor.css') return serve(res, path.join(publicDir, f));
    if (DATA_RE.test(f)) return serve(res, path.join(publicDir, f));
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Não encontrado');
  }

  return { owns, http, validate, load };
}

module.exports = { create };
