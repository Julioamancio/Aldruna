'use strict';
/*
 * Editor da cidade (igual ao Remere's Map Editor, so que no navegador) - Destruitor Idle.
 *
 * Desenha Thais com o mesmo atlas e a mesma ordem do jogo (view.js: chao e bordas, depois linha por linha as
 * paredes e os itens, depois o que fica por cima; andares de cima deslocados 1 tile para cima e a esquerda).
 *
 * Dados:
 *   salas/cidade.json  tiles [[dx, dy, dz, item...]], atlas, flags [[dx, dy, dz, flags]] (1 = zona protegida),
 *                      points, from, e "edbase" (como cada tile ja editado era antes; tools/decorar.py grava)
 *   salas/cidade.png   imagens dos itens da cidade (celulas 64x64, 16 colunas)
 *   salas/paleta.json  atlas (12o valor = pagina), nomes e categorias de todos os itens da paleta
 *   salas/paleta.png, paleta_1.png...   (tools/sprites_paleta.py; sem a paleta, so os itens que ja estao na cidade)
 *   ../api/editor/edicoes (GET) e ../api/editor/publicar (POST): { tiles: {"dx,dy,dz": [itens]},
 *                      flags: {"dx,dy,dz": n} } = so o que difere da base; ../api/editor/status = andamento da
 *                      publicacao na VPS (gateway/editor.js e tools/publicar_cidade.py)
 * A pagina fica em /jogar/editor/ e so abre com o codigo do editor (cookie dt_editor, tela editor_acesso.html).
 *
 * O "Modelo" (sem DOM) guarda a base, o estado atual, desfazer/refazer e calcula as edicoes; roda tambem no Node
 * (require('./public/editor.js').Modelo) para teste.
 */
(function (root, factory) {
  const E = factory();
  if (typeof module === 'object' && module.exports) module.exports = E;
  else {
    root.EditorCidade = E;
    if (typeof document !== 'undefined' && document.getElementById('mapa')) E.iniciar();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const COLS = 16;
  const PZ = 1;
  const key = (x, y, z) => x + ',' + y + ',' + z;
  const unkey = (k) => k.split(',').map(Number);
  const same = (a, b) => {
    a = a || [];
    b = b || [];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  // ==========================================================================
  // Modelo: base (a cidade sem as edicoes do editor), estado atual, desfazer/refazer e o que mudou
  // ==========================================================================
  class Modelo {
    // cidade = cidade.json; salvas = o arquivo de edicoes ({tiles, flags}) ou null se ele nao existe;
    // camadaDe(id) = 0 chao, 1 borda, 2 parede, 3 item, 4 por cima
    constructor(cidade, salvas, camadaDe) {
      this.rx = cidade.w >> 1;
      this.ry = cidade.h >> 1;
      this.zr = cidade.zr || [0, 0];
      this.camadaDe = camadaDe || (() => 3);
      const pub = new Map(), pubF = new Map(); // o que esta publicado (talvez ja com edicoes)
      for (const t of cidade.tiles) if (t.length > 3) pub.set(key(t[0], t[1], t[2]), t.slice(3));
      for (const f of cidade.flags || []) if (f[3]) pubF.set(key(f[0], f[1], f[2]), f[3]);
      this.base = new Map(pub);
      this.baseF = new Map(pubF);
      // o cidade.json publicado ja pode ter edicoes aplicadas: "edbase" diz como esses tiles eram antes
      const eb = cidade.edbase || {};
      for (const [k, ids] of Object.entries(eb.tiles || {})) {
        if (ids && ids.length) this.base.set(k, ids.slice());
        else this.base.delete(k);
      }
      for (const [k, f] of Object.entries(eb.flags || {})) {
        if (f) this.baseF.set(k, f);
        else this.baseF.delete(k);
      }
      this.cur = new Map(this.base);
      this.curF = new Map(this.baseF);
      this.touched = new Set();
      this.touchedF = new Set();
      this.desfazerPilha = [];
      this.refazerPilha = [];
      this.acao = null;
      this.ouvintes = [];
      if (salvas) this.carregar(salvas);
      else {
        // sem o arquivo de edicoes: vale o que esta publicado (as edicoes ja aplicadas continuam no proximo salvar)
        for (const k of Object.keys(eb.tiles || {})) {
          if (pub.has(k)) this.cur.set(k, pub.get(k));
          else this.cur.delete(k);
          this.touched.add(k);
        }
        for (const k of Object.keys(eb.flags || {})) {
          if (pubF.has(k)) this.curF.set(k, pubF.get(k));
          else this.curF.delete(k);
          this.touchedF.add(k);
        }
      }
    }

    // edicoes salvas (estado final de cada tile): entram como ponto de partida, sem desfazer
    carregar(ed) {
      for (const [k, ids] of Object.entries(ed.tiles || {})) {
        if (!this.dentro(k) || !Array.isArray(ids)) continue;
        if (ids.length) this.cur.set(k, ids.slice());
        else this.cur.delete(k);
        this.touched.add(k);
      }
      for (const [k, f] of Object.entries(ed.flags || {})) {
        if (!this.dentro(k)) continue;
        if (f) this.curF.set(k, f);
        else this.curF.delete(k);
        this.touchedF.add(k);
      }
    }

    dentro(k) {
      const [x, y, z] = unkey(k);
      return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) &&
        Math.abs(x) <= this.rx && Math.abs(y) <= this.ry && z >= this.zr[0] && z <= this.zr[1];
    }
    tile(k) { return this.cur.get(k) || []; }
    flags(k) { return this.curF.get(k) || 0; }
    ouvir(fn) { this.ouvintes.push(fn); }
    avisar(keys) { for (const fn of this.ouvintes) fn(keys); }

    // --- uma acao (um passo de desfazer): comecar() ... alteracoes ... terminar()
    comecar(nome) { this.acao = { nome, mud: new Map() }; }
    _guarda(k) {
      if (!this.acao) throw new Error('alteracao fora de uma acao');
      if (!this.acao.mud.has(k)) this.acao.mud.set(k, { ids: this.cur.get(k), f: this.curF.get(k) || 0 });
    }
    // troca os itens do tile (lista vazia apaga o tile)
    poe(k, ids) {
      if (!this.dentro(k) || same(this.cur.get(k), ids)) return false;
      this._guarda(k);
      if (ids.length) this.cur.set(k, ids.slice());
      else this.cur.delete(k);
      this.touched.add(k);
      if (this.acao.vivo) this.avisar([k]);
      return true;
    }
    poeFlags(k, f) {
      if (!this.dentro(k) || (this.curF.get(k) || 0) === f) return false;
      this._guarda(k);
      if (f) this.curF.set(k, f);
      else this.curF.delete(k);
      this.touchedF.add(k);
      if (this.acao.vivo) this.avisar([k]);
      return true;
    }
    terminar() {
      const a = this.acao;
      this.acao = null;
      if (!a) return null;
      for (const [k, b] of a.mud) {
        const ids = this.cur.get(k), f = this.curF.get(k) || 0;
        if (same(b.ids, ids) && b.f === f) a.mud.delete(k);
        else b.depois = { ids, f };
      }
      if (!a.mud.size) return null;
      this.desfazerPilha.push(a);
      if (this.desfazerPilha.length > 400) this.desfazerPilha.shift();
      this.refazerPilha = [];
      if (!a.vivo) this.avisar([...a.mud.keys()]);
      else this.avisar([]);
      return a;
    }
    // atalho: fazer('nome', () => { ...alteracoes... })
    fazer(nome, fn) {
      this.comecar(nome);
      try {
        fn();
      } finally {
        this.terminar();
      }
    }
    _aplica(a, lado) {
      for (const [k, c] of a.mud) {
        const s = lado === 'antes' ? c : c.depois;
        if (s.ids && s.ids.length) this.cur.set(k, s.ids);
        else this.cur.delete(k);
        if (s.f) this.curF.set(k, s.f);
        else this.curF.delete(k);
        this.touched.add(k);
        this.touchedF.add(k);
      }
      this.avisar([...a.mud.keys()]);
    }
    desfazer() {
      const a = this.desfazerPilha.pop();
      if (!a) return null;
      this._aplica(a, 'antes');
      this.refazerPilha.push(a);
      return a;
    }
    refazer() {
      const a = this.refazerPilha.pop();
      if (!a) return null;
      this._aplica(a, 'depois');
      this.desfazerPilha.push(a);
      return a;
    }

    // --- o "item de cima": o ultimo a ser desenhado (maior camada; na mesma camada, o ultimo da lista)
    indiceTopo(ids) {
      let best = -1, bl = -1;
      ids.forEach((id, i) => {
        const l = this.camadaDe(id);
        if (l >= bl) {
          bl = l;
          best = i;
        }
      });
      return best;
    }
    topo(k) {
      const ids = this.tile(k);
      const i = this.indiceTopo(ids);
      return i >= 0 ? ids[i] : null;
    }
    // ordem de desenho (de baixo para cima): indices da lista ordenados pela camada (estavel)
    ordemDesenho(ids) {
      return ids.map((id, i) => [this.camadaDe(id), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((p) => p[1]);
    }

    // --- operacoes (dentro de uma acao)
    // pincel: chao troca o chao do tile; o resto vai no topo da pilha (sem repetir o que ja esta em cima)
    colocar(k, id) {
      const ids = this.tile(k).slice();
      if (this.camadaDe(id) === 0) {
        const g = ids.findIndex((i) => this.camadaDe(i) === 0);
        if (g >= 0) {
          if (ids[g] === id) return false;
          ids[g] = id;
        } else ids.unshift(id);
      } else {
        if (ids[ids.length - 1] === id || this.topo(k) === id) return false;
        ids.push(id);
      }
      return this.poe(k, ids);
    }
    apagarTopo(k) {
      const ids = this.tile(k).slice();
      const i = this.indiceTopo(ids);
      if (i < 0) return false;
      ids.splice(i, 1);
      return this.poe(k, ids);
    }
    // troca o(s) chao(s) do tile por id; sem chao: so poe se preencher
    trocarChao(k, id, preencher) {
      const ids = this.tile(k);
      if (!ids.some((i) => this.camadaDe(i) === 0)) return preencher ? this.poe(k, [id, ...ids]) : false;
      const out = [];
      let posto = false;
      for (const i of ids) {
        if (this.camadaDe(i) === 0) {
          if (!posto) out.push(id);
          posto = true;
        } else out.push(i);
      }
      return this.poe(k, out);
    }
    limpar(k, manterChao) {
      const ids = this.tile(k);
      return this.poe(k, manterChao ? ids.filter((i) => this.camadaDe(i) === 0) : []);
    }
    zona(k, liga) {
      if (!this.tile(k).length) return false;
      const f = this.flags(k);
      return this.poeFlags(k, liga ? f | PZ : f & ~PZ);
    }
    trocar(k, i, j) {
      const ids = this.tile(k).slice();
      if (i < 0 || j < 0 || i >= ids.length || j >= ids.length || i === j) return false;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      return this.poe(k, ids);
    }
    tirar(k, i) {
      const ids = this.tile(k).slice();
      if (i < 0 || i >= ids.length) return false;
      ids.splice(i, 1);
      return this.poe(k, ids);
    }

    // --- o que difere da base (o arquivo de edicoes)
    edicoes() {
      const tiles = {}, flags = {};
      for (const k of [...this.touched].sort()) {
        const c = this.cur.get(k) || [];
        if (!same(c, this.base.get(k))) tiles[k] = c.slice();
      }
      for (const k of [...this.touchedF].sort()) {
        const c = this.curF.get(k) || 0;
        if (c !== (this.baseF.get(k) || 0)) flags[k] = c;
      }
      return { tiles, flags };
    }
    // tiles que diferem da base (para realcar no mapa)
    mudados() {
      const out = new Set();
      for (const k of this.touched) if (!same(this.cur.get(k), this.base.get(k))) out.add(k);
      for (const k of this.touchedF) if ((this.curF.get(k) || 0) !== (this.baseF.get(k) || 0)) out.add(k);
      return out;
    }
  }

  // ==========================================================================
  // Pagina
  // ==========================================================================
  const CAMADA = ['chão', 'borda', 'parede', 'item', 'por cima'];
  const CATS = [
    ['cidade', 'Na cidade'], ['chao', 'Chão'], ['bordas', 'Bordas'], ['paredes', 'Paredes'], ['decoracao', 'Decoração'],
    ['natureza', 'Plantas e natureza'], ['luzes', 'Luzes'], ['moveis', 'Móveis'], ['outros', 'Outros'], ['todas', 'Todas'],
  ];
  const ICON = {
    mao: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M11 11.5v-7a1.5 1.5 0 0 1 3 0V12"/><path d="M14 11.5V6a1.5 1.5 0 0 1 3 0v8"/><path d="M8 13l-1.6-1.8a1.6 1.6 0 0 0-2.4 2.1L8 19a5 5 0 0 0 4 2h1a5 5 0 0 0 4-5v-3"/>',
    pincel: '<path d="M18 3l3 3-9.5 9.5-3-3z"/><path d="M8.5 12.5 6 15a3 3 0 0 0-1 2.5c0 1.5-1 2.5-2 3 3 0 6-.5 7.5-2l1.5-2.5"/>',
    borracha: '<path d="M7 21h10"/><path d="M5.6 15.4 14.8 6.2a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L12 19H8.4z"/><path d="m9.5 11.5 5 5"/>',
    conta: '<path d="m14 7 3 3"/><path d="M16.5 4.5a2.1 2.1 0 0 1 3 3L17 10l-3-3z"/><path d="M14.5 8.5 6 17l-1 3 3-1 8.5-8.5"/>',
    chao: '<path d="M3 9l9-5 9 5-9 5z"/><path d="M3 14l9 5 9-5"/><path d="M7.5 11.5v0M12 9v0M16.5 11.5v0"/>',
    selecao: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M9 12h6M12 9v6"/>',
    zona: '<path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  };
  const TOOLS = [
    ['mao', 'Mão', 'H', 'Arraste para mover o mapa. Clique num tile para ver a pilha de itens.'],
    ['pincel', 'Colocar item', 'B', 'Clique ou arraste para pôr o item do pincel no topo da pilha. Chão troca o chão do tile.'],
    ['borracha', 'Borracha', 'E', 'Clique ou arraste para tirar o item de cima de cada tile.'],
    ['conta', 'Conta-gotas', 'I', 'Clique num tile para pegar o item de cima como pincel.'],
    ['chao', 'Trocar chão (área)', 'G', 'Arraste um retângulo: o chão de cada tile vira o chão do pincel.'],
    ['selecao', 'Selecionar área', 'R', 'Arraste um retângulo. Delete apaga os itens (fica o chão); Shift+Delete apaga tudo.'],
    ['zona', 'Zona protegida', 'P', 'Arraste um retângulo para marcar zona protegida. Com Shift, desmarca.'],
  ];
  const SVG = (p) => `<svg viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const ready = (im) => im && im.complete && im.naturalWidth > 0;

  function iniciar() {
    const $ = (id) => document.getElementById(id);
    const API = new URL('../api/editor/', location.href).pathname; // a pagina fica em .../editor/
    const store = {
      get(k) { try { return localStorage.getItem(k); } catch { return null; } },
      set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
    };
    const canvas = $('mapa');
    const g = canvas.getContext('2d');
    const S = {
      cidade: null, modelo: null, atlas: null, pal: null, nomes: {}, cats: {},
      fl: 0, camX: 0, camY: 0, ts: 32, W: 300, H: 300, dpr: 1,
      tool: 'mao', brush: null, hover: null, sel: null, area: null, drag: null,
      grid: false, zona: true, mud: true, pontos: true, anim: true, cima: 'jogo', preencher: false,
      salvo: 0, salvoTxt: '', mudados: new Set(), dirty: true, animVis: false, pub: null,
      palCat: 'chao', palBusca: '', palLimite: 240, keys: new Set(), space: false,
    };
    window.__editor = S; // para conferir pelo console

    // ------------------------------------------------------------------ utilidades
    let toastT = null;
    function toast(text, kind = 'info') {
      const t = $('toast');
      t.textContent = text;
      t.className = 'ed-toast show ' + kind;
      clearTimeout(toastT);
      toastT = setTimeout(() => (t.className = 'ed-toast'), 3800);
    }
    function overlay(html) {
      $('overlayCard').innerHTML = html;
      $('overlay').hidden = !html;
    }
    async function api(path, body) {
      const res = await fetch(API + path, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({ erro: 'Resposta inválida do servidor.' }));
      // a liberacao do editor venceu (ou o codigo mudou): volta para a tela do codigo
      if (res.status === 401 && data.editor && !S.unsaved) location.reload();
      if (!res.ok) throw Object.assign(new Error(data.erro || 'Erro ' + res.status), { status: res.status, data });
      return data;
    }
    const imgs = new Map();
    function loadImg(src) {
      if (!imgs.has(src)) {
        const im = new Image();
        im.onload = () => {
          S.dirty = true;
          repaintIcons();
        };
        im.src = src;
        imgs.set(src, im);
      }
      return imgs.get(src);
    }
    const nome = (id) => S.nomes[id] || 'item ' + id;

    // ------------------------------------------------------------------ itens: imagem e camada
    const resCache = new Map();
    function resolve(id) {
      if (resCache.has(id)) return resCache.get(id);
      let r = null;
      const a = S.cidade.atlas[id];
      if (a) r = { a, img: S.atlas };
      else if (S.pal && S.pal.atlas[id]) {
        const p = S.pal.atlas[id];
        r = { a: p, img: loadImg(`salas/${p[11] ? 'paleta_' + p[11] : 'paleta'}.png`) };
      }
      resCache.set(id, r);
      return r;
    }
    const camadaDe = (id) => {
      const r = resolve(id);
      return r ? r.a[4] : 3;
    };

    // ------------------------------------------------------------------ indice de desenho (por andar e linha)
    const idx = { rows: new Map(), byKey: new Map(), cover: new Set(), zc: new Map() };
    function itensDe(ids) {
      return S.modelo.ordemDesenho(ids).map((i) => ({ id: ids[i], r: resolve(ids[i]) }));
    }
    function indexar(k) {
      const ids = S.modelo.tile(k);
      let o = idx.byKey.get(k);
      if (!ids.length) {
        if (o) {
          const row = idx.rows.get(o.z + ':' + o.y);
          row.splice(row.indexOf(o), 1);
          idx.byKey.delete(k);
          idx.cover.delete(o.z + ':' + o.x + ':' + o.y);
          idx.zc.set(o.z, (idx.zc.get(o.z) || 1) - 1);
        }
        return;
      }
      if (!o) {
        const [x, y, z] = unkey(k);
        o = { k, x, y, z, items: [] };
        idx.byKey.set(k, o);
        const rk = z + ':' + y;
        if (!idx.rows.has(rk)) idx.rows.set(rk, []);
        const row = idx.rows.get(rk);
        row.push(o);
        row.sort((a, b) => a.x - b.x);
        idx.cover.add(z + ':' + x + ':' + y);
        idx.zc.set(z, (idx.zc.get(z) || 0) + 1);
      }
      o.items = itensDe(ids);
    }

    // ------------------------------------------------------------------ desenho
    function resize() {
      const wrap = $('mapWrap');
      S.W = wrap.clientWidth || 300;
      S.H = wrap.clientHeight || 300;
      S.dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(S.W * S.dpr);
      canvas.height = Math.round(S.H * S.dpr);
      S.dirty = true;
    }
    const sx = (x) => (x - S.camX) * S.ts + S.W / 2 - S.ts / 2;
    const sy = (y) => (y - S.camY) * S.ts + S.H / 2 - S.ts / 2;
    function tileAt(px, py) {
      return [Math.floor((px - S.W / 2 + S.ts / 2) / S.ts + S.camX), Math.floor((py - S.H / 2 + S.ts / 2) / S.ts + S.camY)];
    }

    function draw(now) {
      const ts = S.ts, W = S.W, H = S.H;
      g.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      g.imageSmoothingEnabled = false;
      g.globalAlpha = 1;
      g.fillStyle = '#07080b';
      g.fillRect(0, 0, W, H);
      if (!S.cidade) return;
      const from = S.cidade.from, zr = S.cidade.zr;
      const fl = S.fl, absZ = from[2] + fl;
      S.animVis = false;
      const cell = (it, wx, wy, x, y, elev) => {
        const a = it.r.a, img = it.r.img;
        if (!ready(img)) return;
        if (a[9] > 1) S.animVis = true;
        // mesma conta do view.js: fase da animacao pelo relogio e padrao pela posicao no mapa
        const ph = S.anim && a[9] > 1 ? Math.floor(now / Math.max(50, a[10] || 200)) % a[9] : 0;
        const k = a[1] * COLS + a[0] + ph * a[2] * a[3] + (((wy % a[3]) + a[3]) % a[3]) * a[2] + (((wx % a[2]) + a[2]) % a[2]);
        g.drawImage(img, (k % COLS) * 64, Math.floor(k / COLS) * 64, 64, 64, x - ts - ((a[5] + elev) * ts) / 32, y - ts - ((a[6] + elev) * ts) / 32, ts * 2, ts * 2);
      };
      const halfW = W / ts / 2 + 3, halfH = H / ts / 2 + 3;
      const drawTile = (t, k, pred) => {
        const x = sx(t.x - k), y = sy(t.y - k);
        let elev = 0;
        for (const it of t.items) {
          if (!it.r) {
            // item sem imagem (fora do atlas e da paleta): quadrado com o id
            if (pred(3)) {
              g.fillStyle = 'rgba(255,0,200,.55)';
              g.fillRect(x + ts * 0.2, y + ts * 0.2, ts * 0.6, ts * 0.6);
            }
            continue;
          }
          const L = it.r.a[4];
          if (!pred(L)) continue;
          cell(it, from[0] + t.x, from[1] + t.y, x + ts, y + ts, L === 2 || L === 3 ? elev : 0);
          if (L === 2 || L === 3) elev += it.r.a[7] || 0;
        }
      };
      // um andar inteiro, k andares acima do atual (k < 0: abaixo); porTile = como o view.js desenha os de cima
      const drawFloor = (z, k, porTile) => {
        const yMin = Math.floor(S.camY - halfH) + k, yMax = Math.ceil(S.camY + halfH) + k;
        const vis = (t) => Math.abs(t.x - k - S.camX) <= halfW;
        const row = (y) => idx.rows.get(z + ':' + y) || [];
        if (porTile) {
          for (let y = yMin; y <= yMax; y++) for (const t of row(y)) if (vis(t)) drawTile(t, k, () => true);
          return;
        }
        for (let y = yMin; y <= yMax; y++) for (const t of row(y)) if (vis(t)) drawTile(t, k, (o) => o <= 1);
        for (let y = yMin; y <= yMax; y++) for (const t of row(y)) if (vis(t)) drawTile(t, k, (o) => o === 2 || o === 3);
        for (let y = yMin; y <= yMax; y++) for (const t of row(y)) if (vis(t)) drawTile(t, k, (o) => o === 4);
      };
      if (ready(S.atlas)) {
        // em cima do chao: os andares de baixo (ate o terreo) aparecem deslocados e mais escuros
        if (absZ < 7) {
          for (let z = Math.min(7 - from[2], zr[1]); z > fl; z--) drawFloor(z, fl - z, false);
          if (7 - from[2] > fl) {
            g.fillStyle = 'rgba(0,0,0,.45)';
            g.fillRect(0, 0, W, H);
          }
        }
        drawFloor(fl, 0, false);
        // andares de cima (segundo andar, telhados), como no jogo: some quando o meio da tela esta debaixo de um teto
        if (S.cima !== 'esconder' && absZ <= 7) {
          const cx = Math.round(S.camX), cy = Math.round(S.camY);
          g.globalAlpha = S.cima === 'transparente' ? 0.4 : 1;
          for (let k = 1; absZ - k >= 0; k++) {
            const z = fl - k;
            if (z < zr[0] || !idx.zc.get(z)) break;
            if (S.cima === 'jogo' && (idx.cover.has(z + ':' + cx + ':' + cy) || idx.cover.has(z + ':' + (cx + k) + ':' + (cy + k)))) break;
            drawFloor(z, k, true);
          }
          g.globalAlpha = 1;
        }
      }
      drawOverlays(now, halfW, halfH);
    }

    function drawOverlays(now, halfW, halfH) {
      const ts = S.ts, W = S.W, H = S.H, fl = S.fl;
      const x0 = Math.floor(S.camX - halfW), x1 = Math.ceil(S.camX + halfW);
      const y0 = Math.floor(S.camY - halfH), y1 = Math.ceil(S.camY + halfH);
      // zona protegida do andar atual
      if (S.zona) {
        g.fillStyle = 'rgba(40,220,110,.24)';
        for (const [k, f] of S.modelo.curF) {
          if (!(f & PZ)) continue;
          const [x, y, z] = unkey(k);
          if (z !== fl || x < x0 || x > x1 || y < y0 || y > y1 || !idx.byKey.has(k)) continue;
          g.fillRect(sx(x), sy(y), ts, ts);
        }
      }
      // o que mudou em relacao a base
      if (S.mud && S.mudados.size) {
        g.strokeStyle = 'rgba(255,196,64,.9)';
        g.lineWidth = Math.max(1, ts / 20);
        for (const k of S.mudados) {
          const [x, y, z] = unkey(k);
          if (z !== fl || x < x0 || x > x1 || y < y0 || y > y1) continue;
          g.strokeRect(sx(x) + 1.5, sy(y) + 1.5, ts - 3, ts - 3);
        }
      }
      if (S.grid && ts >= 6) {
        g.strokeStyle = 'rgba(255,255,255,.13)';
        g.lineWidth = 1;
        g.beginPath();
        for (let x = x0; x <= x1 + 1; x++) {
          const px = Math.round(sx(x)) + 0.5;
          g.moveTo(px, 0);
          g.lineTo(px, H);
        }
        for (let y = y0; y <= y1 + 1; y++) {
          const py = Math.round(sy(y)) + 0.5;
          g.moveTo(0, py);
          g.lineTo(W, py);
        }
        g.stroke();
        // borda do recorte da cidade
        const m = S.modelo;
        g.strokeStyle = 'rgba(224,106,90,.7)';
        g.strokeRect(sx(-m.rx), sy(-m.ry), (2 * m.rx + 1) * ts, (2 * m.ry + 1) * ts);
      }
      // pontos da cidade (templo, depot, chama, salao)
      if (S.pontos && fl === 0 && S.cidade.points) {
        const label = { temple: 'Templo', depot: 'Depot', flame: 'Chama mística', salao: 'Salão' };
        g.font = 'bold 11px system-ui, sans-serif';
        g.textAlign = 'center';
        for (const [n, p] of Object.entries(S.cidade.points)) {
          const cx = sx(p[0]) + ts / 2, cy = sy(p[1]) + ts / 2;
          g.fillStyle = 'rgba(120,200,255,.85)';
          g.beginPath();
          g.arc(cx, cy, Math.max(3, ts * 0.14), 0, Math.PI * 2);
          g.fill();
          g.lineWidth = 3;
          g.strokeStyle = '#000';
          g.strokeText(label[n] || n, cx, cy - Math.max(6, ts * 0.3));
          g.fillStyle = '#bfe6ff';
          g.fillText(label[n] || n, cx, cy - Math.max(6, ts * 0.3));
        }
      }
      // tile selecionado
      if (S.sel) {
        const [x, y, z] = unkey(S.sel);
        if (z === fl) {
          g.strokeStyle = '#ffffff';
          g.lineWidth = 2;
          g.setLineDash([5, 3]);
          g.strokeRect(sx(x) + 1, sy(y) + 1, ts - 2, ts - 2);
          g.setLineDash([]);
        }
      }
      // area selecionada ou sendo arrastada
      const rect = S.drag && S.drag.rect ? S.drag.rect : S.area && S.area.z === fl ? S.area : null;
      if (rect) {
        const ax = Math.min(rect.x0, rect.x1), bx = Math.max(rect.x0, rect.x1);
        const ay = Math.min(rect.y0, rect.y1), by = Math.max(rect.y0, rect.y1);
        const color = S.drag && S.drag.rect ? (S.drag.tool === 'zona' ? (S.drag.desliga ? '#e06a5a' : '#3fc77a') : S.drag.tool === 'chao' ? '#f0c46a' : '#8ab4ff') : '#8ab4ff';
        g.fillStyle = color + '33';
        g.fillRect(sx(ax), sy(ay), (bx - ax + 1) * ts, (by - ay + 1) * ts);
        g.strokeStyle = color;
        g.lineWidth = 2;
        g.strokeRect(sx(ax) + 1, sy(ay) + 1, (bx - ax + 1) * ts - 2, (by - ay + 1) * ts - 2);
      }
      // tile embaixo do mouse (com o item do pincel, meio transparente)
      if (S.hover && !(S.drag && S.drag.pan)) {
        const [hx, hy] = S.hover;
        if (S.tool === 'pincel' && S.brush) {
          const r = resolve(S.brush);
          if (r && ready(r.img)) {
            const a = r.a, from = S.cidade.from;
            const k = a[1] * COLS + a[0] + (((from[1] + hy) % a[3] + a[3]) % a[3]) * a[2] + (((from[0] + hx) % a[2] + a[2]) % a[2]);
            g.globalAlpha = 0.6;
            g.drawImage(r.img, (k % COLS) * 64, Math.floor(k / COLS) * 64, 64, 64, sx(hx) - ts - (a[5] * ts) / 32, sy(hy) - ts - (a[6] * ts) / 32, ts * 2, ts * 2);
            g.globalAlpha = 1;
          }
        }
        g.strokeStyle = S.tool === 'borracha' ? '#ff8a7a' : '#ffe08a';
        g.lineWidth = 1.5;
        g.strokeRect(sx(hx) + 0.75, sy(hy) + 0.75, ts - 1.5, ts - 1.5);
      }
    }

    let lastDraw = 0, lastT = 0;
    function loop(now) {
      // WASD / setas seguradas: o mapa anda (12 tiles por segundo)
      const dt = Math.min(0.1, (now - (lastT || now)) / 1000);
      lastT = now;
      if (S.keys.size) {
        const v = 14 * dt;
        let dx = 0, dy = 0;
        if (S.keys.has('w')) dy -= v;
        if (S.keys.has('s')) dy += v;
        if (S.keys.has('a')) dx -= v;
        if (S.keys.has('d')) dx += v;
        if (dx || dy) {
          S.camX = clampX(S.camX + dx);
          S.camY = clampY(S.camY + dy);
          S.dirty = true;
        }
      }
      if (S.dirty || (S.anim && S.animVis && now - lastDraw > 90)) {
        S.dirty = false;
        lastDraw = now;
        draw(now);
      }
      requestAnimationFrame(loop);
    }
    const clampX = (x) => Math.max(-S.modelo.rx - 5, Math.min(S.modelo.rx + 5, x));
    const clampY = (y) => Math.max(-S.modelo.ry - 5, Math.min(S.modelo.ry + 5, y));

    // ------------------------------------------------------------------ icones (paleta, pincel, pilha)
    const off = document.createElement('canvas');
    off.width = off.height = 64;
    const offG = off.getContext('2d', { willReadFrequently: true });
    const bbCache = new Map();
    const pendentes = new Set();
    function pintaIcone(cv, id) {
      const c = cv.getContext('2d');
      c.clearRect(0, 0, cv.width, cv.height);
      if (id == null) return true;
      const r = resolve(id);
      if (!r) {
        c.fillStyle = 'rgba(255,0,200,.5)';
        c.fillRect(cv.width * 0.25, cv.height * 0.25, cv.width * 0.5, cv.height * 0.5);
        return true;
      }
      if (!ready(r.img)) {
        cv._id = id;
        pendentes.add(cv);
        return false;
      }
      const a = r.a, k = a[1] * COLS + a[0];
      const ox = (k % COLS) * 64, oy = Math.floor(k / COLS) * 64;
      let bb = bbCache.get(id);
      if (!bb) {
        offG.clearRect(0, 0, 64, 64);
        offG.drawImage(r.img, ox, oy, 64, 64, 0, 0, 64, 64);
        const d = offG.getImageData(0, 0, 64, 64).data;
        let x0 = 64, y0 = 64, x1 = -1, y1 = -1;
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (d[(y * 64 + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
        bb = x1 < 0 ? [32, 32, 32, 32] : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
        bbCache.set(id, bb);
      }
      const s = Math.min((cv.width - 2) / bb[2], (cv.height - 2) / bb[3], 2);
      c.imageSmoothingEnabled = false;
      c.drawImage(r.img, ox + bb[0], oy + bb[1], bb[2], bb[3], (cv.width - bb[2] * s) / 2, (cv.height - bb[3] * s) / 2, bb[2] * s, bb[3] * s);
      return true;
    }
    function repaintIcons() {
      for (const cv of [...pendentes]) {
        if (!cv.isConnected) {
          pendentes.delete(cv);
          continue;
        }
        if (pintaIcone(cv, cv._id)) pendentes.delete(cv);
      }
    }

    // ------------------------------------------------------------------ paleta
    function listaCategoria(cat) {
      if (cat === 'todas') {
        const all = new Set(S.cats.cidade);
        for (const [c] of CATS) if (S.cats[c] && c !== 'cidade') for (const id of S.cats[c]) all.add(id);
        return [...all];
      }
      return S.cats[cat] || [];
    }
    function renderCats() {
      $('palCats').innerHTML = CATS.filter(([c]) => c === 'todas' || (S.cats[c] && S.cats[c].length))
        .map(([c, label]) => `<button type="button" role="tab" data-cat="${c}" class="${c === S.palCat ? 'on' : ''}" aria-selected="${c === S.palCat}">${label}</button>`).join('');
    }
    function renderPalette() {
      const q = norm(S.palBusca.trim());
      let list = listaCategoria(S.palCat);
      if (q) {
        const words = q.split(/\s+/);
        list = list.filter((id) => (/^\d+$/.test(q) ? String(id).startsWith(q) : words.every((w) => norm(nome(id)).includes(w))));
        if (/^\d+$/.test(q)) list.sort((a, b) => (String(a) === q ? -1 : String(b) === q ? 1 : a - b));
      }
      const shown = list.slice(0, S.palLimite);
      $('palInfo').textContent = list.length ? `${list.length.toLocaleString('pt-BR')} ${list.length === 1 ? 'item' : 'itens'}` : 'Nenhum item.';
      const grid = $('palGrid');
      grid.innerHTML = shown.map((id) => `<button type="button" data-id="${id}" class="${id === S.brush ? 'on' : ''}" title="${esc(nome(id))} (${id})"><canvas width="40" height="40"></canvas></button>`).join('');
      grid.querySelectorAll('button').forEach((b) => pintaIcone(b.firstChild, Number(b.dataset.id)));
      const more = list.length - shown.length;
      $('palMais').hidden = more <= 0;
      $('palMais').textContent = `Mostrar mais (${more.toLocaleString('pt-BR')})`;
    }
    function setBrush(id, quiet) {
      S.brush = id;
      pintaIcone($('brushIcon'), id);
      const r = id != null ? resolve(id) : null;
      $('brushTxt').innerHTML = id == null ? 'Nenhum item. Escolha na paleta ou use o conta-gotas.'
        : `<b>${esc(nome(id))}</b>#${id} · ${r ? CAMADA[r.a[4]] : 'sem imagem'}${r && r.a[8] ? ' · bloqueia' : ''}`;
      $('palGrid').querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.id) === id));
      // escolher na paleta liga o pincel (menos com uma area selecionada: ai o chao serve para "Trocar o chao")
      if (!quiet && S.tool !== 'pincel' && S.tool !== 'chao' && !(S.tool === 'selecao' && S.area)) setTool('pincel');
      S.dirty = true;
      renderPanel();
    }

    // ------------------------------------------------------------------ ferramentas
    function renderTools() {
      $('tools').innerHTML = TOOLS.map(([id, label, k], i) => `<button type="button" data-tool="${id}" class="${id === S.tool ? 'on' : ''}" title="${label} (${k} ou ${i + 1})" aria-label="${label}" aria-pressed="${id === S.tool}">${SVG(ICON[id])}<span class="k">${i + 1}</span></button>`).join('');
      const t = TOOLS.find((x) => x[0] === S.tool);
      $('toolHint').innerHTML = `<b>${t[1]}.</b> ${t[3]}`;
      $('optPreencherWrap').hidden = S.tool !== 'chao';
      canvas.classList.toggle('pan', S.tool === 'mao');
    }
    function setTool(id) {
      S.tool = id;
      if (id !== 'selecao') S.area = null;
      renderTools();
      renderPanel();
      S.dirty = true;
    }

    // ------------------------------------------------------------------ painel da direita
    function coordTxt(x, y, z) {
      const f = S.cidade.from;
      return `<span class="ed-coords"><b>${x}, ${y}</b> · andar ${z}<small>Tibia ${f[0] + x}, ${f[1] + y}, ${f[2] + z} · servidor ${36000 + x}, ${36000 + y}, ${f[2] + z}</small></span>`;
    }
    const flagTxt = (f) => [f & 1 ? 'zona protegida' : '', f & 4 ? 'sem PvP' : '', f & 8 ? 'sem logout' : '', f & 16 ? 'zona PvP' : ''].filter(Boolean).join(', ');
    const BT = {
      up: '<path d="m6 15 6-6 6 6"/>',
      down: '<path d="m6 9 6 6 6-6"/>',
      del: '<path d="M6 6l12 12M18 6 6 18"/>',
    };
    function renderPanel() {
      const p = $('painel');
      const parts = [];
      if (S.area && S.tool === 'selecao') {
        const a = S.area;
        const n = areaKeys(a).filter((k) => S.modelo.tile(k).length).length;
        parts.push(`<section class="ed-box"><h2>Área selecionada</h2>
          <div class="ed-coords"><b>${Math.min(a.x0, a.x1)}, ${Math.min(a.y0, a.y1)}</b> até <b>${Math.max(a.x0, a.x1)}, ${Math.max(a.y0, a.y1)}</b> · andar ${a.z}<small>${n} tiles com itens</small></div>
          <div class="ed-row">
            <button type="button" class="ed-btn" data-area="limpar">Apagar itens (fica o chão)</button>
            <button type="button" class="ed-btn danger" data-area="tudo">Apagar tudo</button>
            <button type="button" class="ed-btn" data-area="pz1">Marcar zona protegida</button>
            <button type="button" class="ed-btn" data-area="pz0">Tirar zona protegida</button>
            <button type="button" class="ed-btn" data-area="chao" ${S.brush != null && camadaDe(S.brush) === 0 ? '' : 'disabled'}>Trocar o chão pelo pincel</button>
          </div></section>`);
      }
      if (S.sel) {
        const [x, y, z] = unkey(S.sel);
        const ids = S.modelo.tile(S.sel);
        const f = S.modelo.flags(S.sel);
        const ordem = S.modelo.ordemDesenho(ids).reverse(); // de cima para baixo
        const rows = ordem.map((i, p2) => {
          const id = ids[i], L = camadaDe(id);
          const up = p2 > 0 && camadaDe(ids[ordem[p2 - 1]]) === L ? ordem[p2 - 1] : -1;
          const dn = p2 < ordem.length - 1 && camadaDe(ids[ordem[p2 + 1]]) === L ? ordem[p2 + 1] : -1;
          const r = resolve(id);
          return `<li class="${id === S.brush ? 'brush' : ''}"><canvas width="36" height="36" data-icon="${id}" data-pick="${id}" title="Usar como pincel"></canvas>
            <div class="nm" data-pick="${id}" title="Usar como pincel"><b>${esc(nome(id))}</b><small>#${id} · ${CAMADA[L]}${r && r.a[8] ? ' · bloqueia' : ''}</small></div>
            <div class="bt">
              <button type="button" data-swap="${i},${up}" ${up < 0 ? 'disabled' : ''} title="Subir (a ordem só vale entre itens da mesma camada)" aria-label="Subir">${SVG(BT.up)}</button>
              <button type="button" data-swap="${i},${dn}" ${dn < 0 ? 'disabled' : ''} title="Descer" aria-label="Descer">${SVG(BT.down)}</button>
              <button type="button" data-tirar="${i}" title="Apagar este item" aria-label="Apagar">${SVG(BT.del)}</button>
            </div></li>`;
        }).join('');
        parts.push(`<section class="ed-box"><h2>Tile selecionado</h2>${coordTxt(x, y, z)}
          <div class="ed-row"><label class="ed-chk"><input type="checkbox" id="selPz" ${f & PZ ? 'checked' : ''} ${ids.length ? '' : 'disabled'}> Zona protegida</label>
          ${f & ~PZ ? `<span class="ed-tag">${esc(flagTxt(f & ~PZ))}</span>` : ''}</div>
          ${ids.length ? `<ul class="ed-stack">${rows}</ul>
          <div class="ed-row"><button type="button" class="ed-btn" data-sel="topo" ${S.brush == null ? 'disabled' : ''}>Pôr o pincel aqui</button>
          <button type="button" class="ed-btn danger" data-sel="limpar">Apagar o tile</button></div>
          <p class="ed-note">A pilha está na ordem em que o jogo desenha (o de cima por último). Clique num item para usá-lo como pincel.</p>`
            : `<p class="ed-empty">Tile vazio.</p>${S.brush != null ? '<div class="ed-row"><button type="button" class="ed-btn" data-sel="topo">Pôr o pincel aqui</button></div>' : ''}`}
          </section>`);
      }
      if (!parts.length) {
        parts.push(`<section class="ed-box"><h2>Como usar</h2><ul class="ed-keys">
          <li><b>Arrastar</b> (Mão), <b>botão do meio/direito</b> ou <b>Espaço</b> + arrastar: mover o mapa</li>
          <li><b>WASD</b> ou <b>setas</b>: andar pelo mapa · <b>roda</b>: zoom</li>
          <li><b>PageUp/PageDown</b>: andar de cima/de baixo</li>
          <li><b>1–7</b> ou <b>H B E I G R P</b>: ferramentas</li>
          <li><b>Ctrl+Z</b> desfazer · <b>Ctrl+Y</b> refazer · <b>Ctrl+S</b> publicar</li>
          <li><b>Delete</b>: apaga a área selecionada (fica o chão) · <b>Shift+Delete</b>: tudo</li>
          <li><b>Esc</b>: tira a seleção</li></ul>
          <p class="ed-note"><b>Publicar na cidade</b> manda as edições para a cidade oficial: a página do jogo mostra na hora e o servidor do jogo reinicia para carregar a cidade nova (espera ninguém estar jogando, ou você manda reiniciar).</p></section>`);
      }
      p.innerHTML = parts.join('');
      p.querySelectorAll('canvas[data-icon]').forEach((c) => pintaIcone(c, Number(c.dataset.icon)));
    }

    // ------------------------------------------------------------------ status
    function renderStatus() {
      if (!S.hover) {
        $('stPos').textContent = '—';
        $('stItens').textContent = '';
      } else {
        const [x, y] = S.hover, z = S.fl, k = key(x, y, z), f = S.cidade.from;
        $('stPos').textContent = `${x}, ${y}, ${z}  ·  Tibia ${f[0] + x}, ${f[1] + y}, ${f[2] + z}`;
        const ids = S.modelo.tile(k);
        const fl = S.modelo.flags(k);
        const txt = S.modelo.ordemDesenho(ids).reverse().map((i) => `${nome(ids[i])} (${ids[i]})`).join(' · ');
        $('stItens').textContent = (fl & PZ ? '[zona protegida] ' : '') + (txt || 'vazio');
      }
    }
    function renderEd() {
      const ed = S.modelo.edicoes();
      const n = Object.keys(ed.tiles).length, nf = Object.keys(ed.flags).length;
      const txt = JSON.stringify(ed);
      const dirty = txt !== S.salvoTxt;
      $('stEd').textContent = `${n} ${n === 1 ? 'tile alterado' : 'tiles alterados'}${nf ? ` · ${nf} de zona` : ''}${dirty ? ' · não publicado' : ' · publicado'}`;
      $('btnSalvar').classList.toggle('dirty', dirty);
      $('btnSalvar').disabled = !!S.enviando;
      $('btnUndo').disabled = !S.modelo.desfazerPilha.length;
      $('btnRedo').disabled = !S.modelo.refazerPilha.length;
      const la = S.modelo.desfazerPilha[S.modelo.desfazerPilha.length - 1];
      const lr = S.modelo.refazerPilha[S.modelo.refazerPilha.length - 1];
      $('btnUndo').title = la ? `Desfazer: ${la.nome} (Ctrl+Z)` : 'Desfazer (Ctrl+Z)';
      $('btnRedo').title = lr ? `Refazer: ${lr.nome} (Ctrl+Y)` : 'Refazer (Ctrl+Y)';
      S.unsaved = dirty;
    }
    function renderFloors() {
      const [lo, hi] = S.cidade.zr, f = S.cidade.from;
      let html = '';
      for (let z = lo; z <= hi; z++) html += `<button type="button" data-z="${z}" class="${z === S.fl ? 'on' : ''}" title="Andar ${z} (Tibia z=${f[2] + z})">${z > 0 ? '+' + z : z}<span class="z">z${f[2] + z}</span></button>`;
      $('floors').innerHTML = html;
    }
    function setFloor(z) {
      const [lo, hi] = S.cidade.zr;
      z = Math.max(lo, Math.min(hi, z));
      if (z === S.fl) return;
      S.fl = z;
      S.area = null;
      renderFloors();
      renderStatus();
      renderPanel();
      S.dirty = true;
    }

    // ------------------------------------------------------------------ acoes
    function areaKeys(a) {
      const out = [];
      for (let y = Math.min(a.y0, a.y1); y <= Math.max(a.y0, a.y1); y++)
        for (let x = Math.min(a.x0, a.x1); x <= Math.max(a.x0, a.x1); x++) out.push(key(x, y, a.z));
      return out;
    }
    function areaAcao(tipo) {
      const a = S.area;
      if (!a) return;
      const m = S.modelo, ks = areaKeys(a);
      if (tipo === 'chao') {
        if (S.brush == null || camadaDe(S.brush) !== 0) return toast('Escolha um chão na paleta primeiro.', 'erro');
        m.fazer('Trocar o chão da área', () => ks.forEach((k) => m.trocarChao(k, S.brush, S.preencher)));
      } else if (tipo === 'limpar') m.fazer('Apagar itens da área', () => ks.forEach((k) => m.limpar(k, true)));
      else if (tipo === 'tudo') m.fazer('Apagar a área', () => ks.forEach((k) => m.limpar(k, false)));
      else if (tipo === 'pz1') m.fazer('Marcar zona protegida', () => ks.forEach((k) => m.zona(k, true)));
      else if (tipo === 'pz0') m.fazer('Tirar zona protegida', () => ks.forEach((k) => m.zona(k, false)));
    }
    function desfazer() {
      const a = S.modelo.desfazer();
      if (a) toast('Desfeito: ' + a.nome);
    }
    function refazer() {
      const a = S.modelo.refazer();
      if (a) toast('Refeito: ' + a.nome);
    }
    // Publicar na cidade: a ponte grava as edicoes e o vigia da VPS aplica (decorar.py -> sprites_mapa.py ->
    // cidade nova na pagina -> servidor do jogo reiniciado); o andamento aparece no quadro "Publicação"
    async function publicar(forcar) {
      if (S.enviando) return;
      const ed = S.modelo.edicoes();
      const txt = JSON.stringify(ed);
      const n = Object.keys(ed.tiles).length, nf = Object.keys(ed.flags).length;
      if (!forcar && !confirm(`Publicar na cidade oficial do jogo?\n\n${n} ${n === 1 ? 'tile alterado' : 'tiles alterados'}${nf ? ` e ${nf} de zona protegida` : ''} em relação ao mapa original.\nO servidor do jogo reinicia para carregar a cidade nova (espera ninguém estar jogando).`)) return;
      S.enviando = true;
      renderEd();
      try {
        const r = await api('publicar', { ...ed, base: S.salvo, forcar: !!forcar });
        S.salvo = r.salvo;
        S.salvoTxt = txt;
        toast('Edições enviadas. Publicando na cidade…', 'ok');
        acompanhar(r.salvo);
      } catch (e) {
        if (e.status === 409 && !forcar) {
          S.enviando = false;
          if (confirm('O mapa foi publicado de outro lugar (outra aba?) depois que você abriu o editor. Publicar mesmo assim troca aquelas edições por estas. Publicar mesmo assim?')) return publicar(true);
        } else toast(e.message || 'Não deu para publicar.', 'erro');
      } finally {
        S.enviando = false;
        renderEd();
      }
    }

    // andamento da publicacao (o vigia na VPS escreve o estado; aqui so se le)
    const PUB_ATIVO = new Set(['fila', 'aplicando', 'imagens', 'trocando', 'recarregando', 'semconexao']);
    let pollT = null, pollGen = 0;
    function acompanhar(id) {
      clearTimeout(pollT);
      const gen = ++pollGen; // so a ultima chamada continua consultando
      const desde = Date.now();
      const tick = async () => {
        let st;
        try {
          st = await api('status');
        } catch (e) {
          if (gen !== pollGen) return;
          // a ponte reinicia junto com o servidor do jogo: tenta de novo
          pubShow({ estado: 'semconexao', msg: 'A ponte não respondeu (pode estar reiniciando). Tentando de novo…' });
          pollT = setTimeout(tick, 3000);
          return;
        }
        if (gen !== pollGen) return;
        const s = st.status && st.status.id >= id ? st.status : null;
        let p;
        if (st.pedido || !s) {
          p = { estado: 'fila', msg: Date.now() - desde > 90000
            ? 'O vigia da publicação não pegou o pedido em 90 s. Confira na VPS o serviço idle-cidade-publicar (systemctl status idle-cidade-publicar.path).'
            : 'Na fila: esperando o vigia da VPS pegar o pedido…' };
        } else p = { ...s, online: st.online, agora: st.agora };
        pubShow(p);
        if (p.estado === 'pronto') toast('Publicado! A cidade nova está no jogo.', 'ok');
        else if (p.estado === 'erro') toast('A publicação falhou. Veja o quadro Publicação.', 'erro');
        if (p.estado === 'pronto' || p.estado === 'erro') return;
        pollT = setTimeout(tick, p.estado === 'esperando' ? 6000 : 2000);
      };
      tick();
    }
    const PUB_TITULO = {
      fila: 'Na fila', aplicando: 'Aplicando as edições', imagens: 'Gerando as imagens', trocando: 'Trocando os arquivos',
      esperando: 'Esperando para reiniciar', recarregando: 'Reiniciando o servidor', pronto: 'Publicado', erro: 'Falhou', semconexao: 'Sem resposta',
    };
    function pubShow(p) {
      S.pub = p;
      const el = $('pub');
      if (!p) {
        el.hidden = true;
        return;
      }
      const ativo = PUB_ATIVO.has(p.estado);
      const log = p.estado === 'erro' && p.log && p.log.length ? `<pre class="ed-log">${esc(p.log.slice(-12).join('\n'))}</pre>` : '';
      el.className = 'ed-pub ' + p.estado;
      el.innerHTML = `<div class="ed-pubhead">${ativo ? '<span class="ed-spin" aria-hidden="true"></span>' : ''}<b>Publicação: ${esc(PUB_TITULO[p.estado] || p.estado)}</b>
        ${ativo ? '' : '<button type="button" class="ed-x" data-pub="fechar" aria-label="Fechar">×</button>'}</div>
        <p>${esc(p.msg || '')}</p>${log}
        ${p.estado === 'esperando' ? `<div class="ed-row"><button type="button" class="ed-btn" data-pub="agora" ${p.agora ? 'disabled' : ''}>${p.agora ? 'Reinício pedido…' : 'Reiniciar o servidor agora'}</button></div>` : ''}`;
      el.hidden = false;
    }
    $('pub').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-pub]');
      if (!b) return;
      if (b.dataset.pub === 'fechar') return pubShow(null);
      if (!confirm('Reiniciar o servidor do jogo agora? Quem estiver jogando sai (as caçadas em andamento param).')) return;
      try {
        await api('recarregar', {});
        toast('Reinício pedido. O vigia reinicia o servidor em instantes.');
        acompanhar(S.salvo);
      } catch (err) {
        toast(err.message, 'erro');
      }
    });
    function baixar() {
      const blob = new Blob([JSON.stringify(S.modelo.edicoes(), null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'cidade_edicoes.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);
    }
    function irPara(txt) {
      const n = String(txt).match(/-?\d+/g);
      if (!n || n.length < 2) return toast('Digite x, y (da cidade, ex.: 4, 11, ou do Tibia, ex.: 32369, 32241).', 'erro');
      let [x, y, z] = n.map(Number);
      const f = S.cidade.from;
      if (Math.abs(x) > 1000) {
        x -= f[0];
        y -= f[1];
        if (z != null) z -= f[2];
      }
      S.camX = clampX(x);
      S.camY = clampY(y);
      if (z != null) setFloor(z);
      S.sel = key(x, y, S.fl);
      renderPanel();
      S.dirty = true;
    }

    // ------------------------------------------------------------------ mouse
    function pintar(tile, tool) {
      const k = key(tile[0], tile[1], S.fl);
      const d = S.drag;
      if (d.feitos.has(k)) return;
      d.feitos.add(k);
      if (tool === 'pincel') S.modelo.colocar(k, S.brush);
      else S.modelo.apagarTopo(k);
    }
    // todos os tiles na linha entre dois tiles (mouse rapido nao pula tiles)
    function linha(a, b) {
      const out = [];
      let [x0, y0] = a;
      const [x1, y1] = b;
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx2 = x0 < x1 ? 1 : -1, sy2 = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (let guard = 0; guard < 400; guard++) {
        out.push([x0, y0]);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) {
          err += dy;
          x0 += sx2;
        }
        if (e2 <= dx) {
          err += dx;
          y0 += sy2;
        }
      }
      return out;
    }
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      if (!S.modelo) return;
      canvas.setPointerCapture(e.pointerId);
      const [px, py] = pos(e);
      const tile = tileAt(px, py);
      const pan = e.button === 1 || e.button === 2 || (e.button === 0 && (S.tool === 'mao' || S.space));
      if (pan) {
        S.drag = { pan: true, px, py, camX: S.camX, camY: S.camY, moved: false, click: e.button === 0 && S.tool === 'mao' && !S.space, tile };
        canvas.classList.add('panning');
        return;
      }
      if (e.button !== 0) return;
      const tool = S.tool;
      if (tool === 'conta') {
        const id = S.modelo.topo(key(tile[0], tile[1], S.fl));
        if (id == null) return toast('Esse tile está vazio.');
        setBrush(id, true);
        setTool('pincel');
        toast(`Pincel: ${nome(id)} (${id})`);
        return;
      }
      if (tool === 'pincel' || tool === 'borracha') {
        if (tool === 'pincel' && S.brush == null) return toast('Escolha um item na paleta primeiro.', 'erro');
        S.drag = { tool, last: tile, feitos: new Set() };
        S.modelo.comecar(tool === 'pincel' ? 'Colocar ' + nome(S.brush) : 'Borracha');
        S.modelo.acao.vivo = true; // redesenha a cada tile durante o arrasto
        pintar(tile, tool);
        return;
      }
      if (tool === 'chao' && (S.brush == null || camadaDe(S.brush) !== 0)) return toast('Escolha um chão na paleta primeiro (categoria Chão).', 'erro');
      // ferramentas de retangulo: chao, selecao, zona
      S.drag = { tool, rect: { x0: tile[0], y0: tile[1], x1: tile[0], y1: tile[1], z: S.fl }, desliga: e.shiftKey };
      S.dirty = true;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!S.modelo) return;
      const [px, py] = pos(e);
      const tile = tileAt(px, py);
      const d = S.drag;
      if (d && d.pan) {
        const dx = px - d.px, dy = py - d.py;
        if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
        S.camX = clampX(d.camX - dx / S.ts);
        S.camY = clampY(d.camY - dy / S.ts);
        S.dirty = true;
        return;
      }
      if (!S.hover || S.hover[0] !== tile[0] || S.hover[1] !== tile[1]) {
        S.hover = tile;
        renderStatus();
        S.dirty = true;
      }
      if (d && d.feitos) {
        for (const t of linha(d.last, tile)) pintar(t, d.tool);
        d.last = tile;
      } else if (d && d.rect) {
        d.rect.x1 = tile[0];
        d.rect.y1 = tile[1];
        d.desliga = e.shiftKey;
        S.dirty = true;
      }
    });
    const fim = (e) => {
      const d = S.drag;
      if (!d) return;
      S.drag = null;
      canvas.classList.remove('panning');
      if (d.pan) {
        if (d.click && !d.moved) {
          S.sel = key(d.tile[0], d.tile[1], S.fl);
          renderPanel();
        }
        S.dirty = true;
        return;
      }
      if (d.feitos) {
        S.modelo.terminar();
        return;
      }
      if (d.rect) {
        const r = d.rect;
        if (d.tool === 'selecao') {
          S.area = r;
          S.sel = r.x0 === r.x1 && r.y0 === r.y1 ? key(r.x0, r.y0, r.z) : null;
          renderPanel();
        } else {
          const m = S.modelo, ks = areaKeys(r);
          if (d.tool === 'chao') m.fazer('Trocar chão', () => ks.forEach((k) => m.trocarChao(k, S.brush, S.preencher)));
          else if (d.tool === 'zona') m.fazer(e && e.shiftKey || d.desliga ? 'Tirar zona protegida' : 'Marcar zona protegida', () => ks.forEach((k) => m.zona(k, !(d.desliga || (e && e.shiftKey)))));
        }
        S.dirty = true;
      }
    };
    canvas.addEventListener('pointerup', fim);
    canvas.addEventListener('pointercancel', () => {
      if (S.drag && S.drag.feitos) S.modelo.terminar();
      S.drag = null;
      canvas.classList.remove('panning');
    });
    canvas.addEventListener('pointerleave', () => {
      if (!S.drag) {
        S.hover = null;
        renderStatus();
        S.dirty = true;
      }
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [px, py] = pos(e);
      // o tile embaixo do mouse fica no lugar
      const wx = (px - S.W / 2 + S.ts / 2) / S.ts + S.camX, wy = (py - S.H / 2 + S.ts / 2) / S.ts + S.camY;
      const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      S.ts = Math.max(6, Math.min(96, S.ts * f));
      S.camX = clampX(wx - (px - S.W / 2 + S.ts / 2) / S.ts);
      S.camY = clampY(wy - (py - S.H / 2 + S.ts / 2) / S.ts);
      S.dirty = true;
    }, { passive: false });

    // ------------------------------------------------------------------ teclado
    const MOVE = { w: 'w', arrowup: 'w', a: 'a', arrowleft: 'a', s: 's', arrowdown: 's', d: 'd', arrowright: 'd' };
    const TOOLKEY = { h: 'mao', b: 'pincel', e: 'borracha', i: 'conta', g: 'chao', r: 'selecao', p: 'zona' };
    window.addEventListener('keydown', (e) => {
      if (!S.modelo) return;
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|SELECT|TEXTAREA/.test(tag) && e.target.type !== 'checkbox') return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === 'z' && !e.shiftKey) desfazer();
        else if (k === 'y' || (k === 'z' && e.shiftKey)) refazer();
        else if (k === 's') publicar();
        else return;
        e.preventDefault();
        return;
      }
      if (MOVE[k]) {
        S.keys.add(MOVE[k]);
        e.preventDefault();
      } else if (k === ' ') {
        S.space = true;
        canvas.classList.add('pan');
        e.preventDefault();
      } else if (k === 'pageup') {
        setFloor(S.fl - 1);
        e.preventDefault();
      } else if (k === 'pagedown') {
        setFloor(S.fl + 1);
        e.preventDefault();
      } else if (TOOLKEY[k]) setTool(TOOLKEY[k]);
      else if (/^[1-7]$/.test(k)) setTool(TOOLS[Number(k) - 1][0]);
      else if (k === '+' || k === '=') {
        S.ts = Math.min(96, S.ts * 1.15);
        S.dirty = true;
      } else if (k === '-') {
        S.ts = Math.max(6, S.ts / 1.15);
        S.dirty = true;
      } else if ((k === 'delete' || k === 'backspace') && S.area) {
        areaAcao(e.shiftKey ? 'tudo' : 'limpar');
        e.preventDefault();
      } else if (k === 'escape') {
        S.area = null;
        S.sel = null;
        S.drag = null;
        renderPanel();
        S.dirty = true;
      }
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (MOVE[k]) S.keys.delete(MOVE[k]);
      if (k === ' ' && S.space) {
        S.space = false;
        canvas.classList.toggle('pan', S.tool === 'mao');
        e.preventDefault(); // nao "clica" o botao que estiver com o foco
      }
    });
    window.addEventListener('blur', () => {
      S.keys.clear();
      S.space = false;
    });
    window.addEventListener('beforeunload', (e) => {
      if (S.unsaved) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // ------------------------------------------------------------------ botoes
    $('tools').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tool]');
      if (b) setTool(b.dataset.tool);
    });
    $('floors').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-z]');
      if (b) setFloor(Number(b.dataset.z));
    });
    $('palCats').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-cat]');
      if (!b) return;
      S.palCat = b.dataset.cat;
      S.palLimite = 240;
      store.set('ed_cat', S.palCat);
      renderCats();
      renderPalette();
      $('palGrid').scrollTop = 0;
    });
    let buscaT = null;
    $('palBusca').addEventListener('input', (e) => {
      clearTimeout(buscaT);
      buscaT = setTimeout(() => {
        S.palBusca = e.target.value;
        S.palLimite = 240;
        renderPalette();
        $('palGrid').scrollTop = 0;
      }, 120);
    });
    $('palGrid').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-id]');
      if (b) setBrush(Number(b.dataset.id));
    });
    $('palMais').addEventListener('click', () => {
      S.palLimite += 480;
      renderPalette();
    });
    $('painel').addEventListener('click', (e) => {
      const m = S.modelo;
      const t = e.target.closest('[data-swap],[data-tirar],[data-pick],[data-sel],[data-area]');
      if (!t) return;
      if (t.dataset.area) return areaAcao(t.dataset.area);
      if (t.dataset.pick) return setBrush(Number(t.dataset.pick), true);
      const k = S.sel;
      if (!k) return;
      if (t.dataset.swap) {
        const [i, j] = t.dataset.swap.split(',').map(Number);
        m.fazer('Mudar a ordem da pilha', () => m.trocar(k, i, j));
      } else if (t.dataset.tirar) {
        const i = Number(t.dataset.tirar);
        m.fazer('Apagar ' + nome(m.tile(k)[i]), () => m.tirar(k, i));
      } else if (t.dataset.sel === 'limpar') m.fazer('Apagar o tile', () => m.limpar(k, false));
      else if (t.dataset.sel === 'topo' && S.brush != null) m.fazer('Colocar ' + nome(S.brush), () => m.colocar(k, S.brush));
    });
    $('painel').addEventListener('change', (e) => {
      if (e.target.id === 'selPz' && S.sel) {
        const on = e.target.checked;
        S.modelo.fazer(on ? 'Marcar zona protegida' : 'Tirar zona protegida', () => S.modelo.zona(S.sel, on));
      }
    });
    $('btnUndo').addEventListener('click', desfazer);
    $('btnRedo').addEventListener('click', refazer);
    $('btnSalvar').addEventListener('click', () => publicar());
    $('btnBaixar').addEventListener('click', baixar);
    $('goto').addEventListener('submit', (e) => {
      e.preventDefault();
      irPara($('gotoIn').value);
      $('gotoIn').blur();
    });
    const opt = (id, prop, ls) => {
      const el = $(id);
      const saved = store.get(ls);
      if (saved != null) el[el.type === 'checkbox' ? 'checked' : 'value'] = el.type === 'checkbox' ? saved === '1' : saved;
      const read = () => {
        S[prop] = el.type === 'checkbox' ? el.checked : el.value;
        store.set(ls, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
        S.dirty = true;
      };
      el.addEventListener('change', read);
      read();
    };
    opt('optGrid', 'grid', 'ed_grid');
    opt('optZona', 'zona', 'ed_zona');
    opt('optMud', 'mud', 'ed_mud');
    opt('optPontos', 'pontos', 'ed_pontos');
    opt('optAnim', 'anim', 'ed_anim');
    opt('optCima', 'cima', 'ed_cima');
    opt('optPreencher', 'preencher', 'ed_preencher');

    // ------------------------------------------------------------------ inicio
    async function boot() {
      renderTools();
      overlay('<h1>Carregando a cidade…</h1><p>Mapa, imagens e paleta.</p>');
      let cidade, pal, ed;
      try {
        [cidade, pal, ed] = await Promise.all([
          fetch('salas/cidade.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)),
          fetch('salas/paleta.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          api('edicoes'),
        ]);
      } catch (e) {
        overlay(`<h1>Não deu para abrir</h1><p>${esc(e.message)}</p><p><a href="./">Tentar de novo</a></p>`);
        return;
      }
      if (!cidade || !cidade.atlas) {
        overlay('<h1>A cidade não está publicada</h1><p>Falta salas/cidade.json (com o atlas) no servidor.</p>');
        return;
      }
      S.cidade = cidade;
      S.atlas = loadImg('salas/cidade.png');
      S.pal = pal;
      S.nomes = (pal && pal.nomes) || {};
      S.salvo = ed.salvo || 0;
      // sem arquivo salvo (ou sem a resposta da ponte): parte do que esta publicado
      S.modelo = new Modelo(cidade, ed.salvo ? ed : null, camadaDe);
      S.salvoTxt = JSON.stringify(S.modelo.edicoes());
      // categorias: as da paleta + os itens que ja estao na cidade (sem paleta, pela camada do atlas)
      const cityIds = Object.keys(cidade.atlas).map(Number);
      S.cats = pal && pal.cats ? { ...pal.cats } : {};
      S.cats.cidade = cityIds.slice().sort((a, b) => cidade.atlas[a][4] - cidade.atlas[b][4] || nome(a).localeCompare(nome(b)) || a - b);
      if (!pal) {
        const byLayer = { 0: 'chao', 1: 'bordas', 2: 'paredes', 3: 'decoracao', 4: 'outros' };
        for (const id of S.cats.cidade) (S.cats[byLayer[cidade.atlas[id][4]]] = S.cats[byLayer[cidade.atlas[id][4]]] || []).push(id);
      }
      const savedCat = store.get('ed_cat');
      S.palCat = savedCat && S.cats[savedCat] ? savedCat : S.cats.chao ? 'chao' : 'cidade';
      for (const k of S.modelo.cur.keys()) indexar(k);
      S.mudados = S.modelo.mudados();
      S.modelo.ouvir((keys) => {
        for (const k of keys) indexar(k);
        S.mudados = S.modelo.mudados();
        S.dirty = true;
        renderEd();
        renderStatus();
        if (S.sel && (keys.includes(S.sel) || !keys.length || S.area)) renderPanel();
        else if (S.area) renderPanel();
      });
      const t = (cidade.points && cidade.points.temple) || [0, 0];
      S.camX = t[0];
      S.camY = t[1];
      resize();
      if (window.ResizeObserver) new ResizeObserver(resize).observe($('mapWrap'));
      else window.addEventListener('resize', resize);
      renderFloors();
      renderCats();
      renderPalette();
      setBrush(null, true);
      renderPanel();
      renderEd();
      overlay('');
      if (!pal) {
        $('banner').textContent = 'Sem a paleta completa (salas/paleta.json): só os itens que já estão na cidade.';
        $('banner').hidden = false;
        setTimeout(() => ($('banner').hidden = true), 12000);
      }
      // publicacao em andamento (aberto de novo no meio dela): continua mostrando
      api('status').then((st) => {
        const s = st.status;
        if (st.pedido) acompanhar(S.salvo);
        else if (s && s.estado !== 'pronto' && s.estado !== 'erro') acompanhar(s.id);
      }).catch(() => {});
      S.desenhar = (t) => draw(t == null ? performance.now() : t); // teste: desenha na hora (sem esperar o quadro)
      requestAnimationFrame(loop);
    }
    boot();
  }

  return { Modelo, iniciar, key, unkey };
});
