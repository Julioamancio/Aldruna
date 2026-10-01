'use strict';
/*
 * Visao da cacada: desenha a sala (recorte do mapa real), o personagem e os monstros com os sprites do
 * Tibia, nome e vida em cima, alvo, numeros de dano/cura/XP e efeitos das magias.
 *
 * Dados:
 *   salas/<sala>.json  -> tiles {dx, dy, itens...}, "from" (posicao no mapa real) e "atlas" de cada item
 *                         [coluna, linha, padroesX, padroesY, camada, deslocX, deslocY, altura]
 *   salas/<sala>.png   -> as imagens dos itens da sala (celulas de 64x64)
 *   criaturas/<look>.png (+ _t.png, camada de cor) -> 4 linhas (N, L, S, O) x (parado + andando)
 * Estado (a cada 0,4 s): idle.me {x, y, z, dir, look}, idle.monsters[{id, x, y, z, dir, look, hp, max, target}], idle.fx[]
 *
 * Tela cheia: a camera segue o personagem e o mapa cobre todo o espaco da pagina (como no Huntera).
 * Cidade (setTown): recorte de Thais; o personagem fica parado e anda sozinho ate a chama mistica
 * (walkToFlame) quando a cacada comeca. Abaixo do chao (andar > 7) o mapa fica escuro, com luz em volta
 * do personagem e um brilho vermelho embaixo de cada monstro.
 */
(() => {
  const COLS = 16;
  const ELEM_COLOR = { phys: '#ff4040', fire: '#ff8c1a', energy: '#b16bff', earth: '#57d657', ice: '#6fd3ff', holy: '#fff27a', death: '#9a9a9a', drown: '#6fb2ff', drain: '#ff4d8a', mana: '#5a8cff' };
  const imgCache = new Map();
  const jsonCache = new Map();
  let creatureIndex = null;

  function loadImg(src) {
    if (!imgCache.has(src)) {
      const im = new Image();
      im.src = src;
      imgCache.set(src, im);
    }
    return imgCache.get(src);
  }
  async function loadJson(src) {
    if (!jsonCache.has(src)) jsonCache.set(src, fetch(src).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    return jsonCache.get(src);
  }
  const ready = (im) => im && im.complete && im.naturalWidth > 0;
  const safe = (id) => String(id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const MYSTIC_FLAME = 1959;
  const STEP8 = [[0, -1, 0], [1, 0, 1], [0, 1, 2], [-1, 0, 3], [1, -1, 1], [1, 1, 1], [-1, 1, 3], [-1, -1, 3]]; // dx, dy, direcao do sprite

  // ---- cores de outfit do Tibia (mesma formula do OTClient: Color::getOutfitColor)
  function outfitColor(color) {
    const SI = 7, H = 19;
    if (color >= H * SI) color = 0;
    let l1 = 0, l2 = 0, l3 = 0;
    if (color % H !== 0) {
      l1 = (color % H) / 18;
      l2 = 1; l3 = 1;
      switch (Math.floor(color / H)) {
        case 0: l2 = 0.25; l3 = 1; break;
        case 1: l2 = 0.25; l3 = 0.75; break;
        case 2: l2 = 0.5; l3 = 0.75; break;
        case 3: l2 = 0.667; l3 = 0.75; break;
        case 4: l2 = 1; l3 = 1; break;
        case 5: l2 = 1; l3 = 0.75; break;
        case 6: l2 = 1; l3 = 0.5; break;
      }
    } else {
      l3 = 1 - color / H / SI;
    }
    if (l3 === 0) return [0, 0, 0];
    if (l2 === 0) { const v = Math.round(l3 * 255); return [v, v, v]; }
    let r = 0, g = 0, b = 0;
    if (l1 < 1 / 6) { r = l3; b = l3 * (1 - l2); g = b + (l3 - b) * 6 * l1; }
    else if (l1 < 2 / 6) { g = l3; b = l3 * (1 - l2); r = g - (l3 - b) * (6 * l1 - 1); }
    else if (l1 < 3 / 6) { g = l3; r = l3 * (1 - l2); b = r + (l3 - r) * (6 * l1 - 2); }
    else if (l1 < 4 / 6) { b = l3; r = l3 * (1 - l2); g = b - (l3 - r) * (6 * l1 - 3); }
    else if (l1 < 5 / 6) { b = l3; g = l3 * (1 - l2); r = g + (l3 - g) * (6 * l1 - 4); }
    else { r = l3; g = l3 * (1 - l2); b = r - (l3 - g) * (6 * l1 - 5); }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  // folha da criatura ja pintada com as cores do outfit (cache por look+cores)
  const tinted = new Map();
  function creatureSheet(look) {
    if (!look || !look.t || !creatureIndex) return null;
    const meta = creatureIndex[look.t];
    if (!meta) return null;
    const base = loadImg(`criaturas/${look.t}.png`);
    if (!ready(base)) return null;
    if (!meta.color) return { img: base, cols: meta.cols };
    const key = `${look.t}:${look.h}:${look.b}:${look.l}:${look.f}`;
    if (tinted.has(key)) return tinted.get(key);
    const tpl = loadImg(`criaturas/${look.t}_t.png`);
    if (!ready(tpl)) return { img: base, cols: meta.cols };
    const w = base.naturalWidth, h = base.naturalHeight;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.drawImage(base, 0, 0);
    const bd = g.getImageData(0, 0, w, h);
    const t = document.createElement('canvas');
    t.width = w; t.height = h;
    const tg = t.getContext('2d');
    tg.drawImage(tpl, 0, 0);
    const td = tg.getImageData(0, 0, w, h).data;
    const cols = { head: outfitColor(look.h || 0), body: outfitColor(look.b || 0), legs: outfitColor(look.l || 0), feet: outfitColor(look.f || 0) };
    const d = bd.data;
    for (let i = 0; i < d.length; i += 4) {
      if (td[i + 3] === 0) continue;
      const R = td[i] > 128, G = td[i + 1] > 128, B = td[i + 2] > 128;
      const col = R && G && !B ? cols.head : R && !G && !B ? cols.body : !R && G && !B ? cols.legs : !R && !G && B ? cols.feet : null;
      if (!col) continue;
      d[i] = (d[i] * col[0]) / 255;
      d[i + 1] = (d[i + 1] * col[1]) / 255;
      d[i + 2] = (d[i + 2] * col[2]) / 255;
    }
    g.putImageData(bd, 0, 0);
    const out = { img: c, cols: meta.cols };
    tinted.set(key, out);
    return out;
  }

  // ------------------------------------------------------------------------
  class GameView {
    constructor(wrap) {
      this.wrap = wrap;
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'gameview';
      wrap.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.room = null;
      this.roomId = null;
      this.atlas = null;
      this.ents = new Map(); // id -> {x, y, px, py, t0, dir, look, walk}
      this.floats = [];
      this.flashes = [];
      this.shots = [];
      this.state = null;
      this.alive = true;
      if (!creatureIndex) loadJson('criaturas/index.json').then((j) => (creatureIndex = j || {}));
      this.resize();
      this.onResize = () => this.resize();
      window.addEventListener('resize', this.onResize);
      if (window.ResizeObserver) {
        this.ro = new ResizeObserver(() => this.resize());
        this.ro.observe(wrap);
      }
      this.mode = 'hunt';
      const loop = (t) => {
        if (!this.alive) return;
        this.draw(t);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    destroy() {
      this.alive = false;
      window.removeEventListener('resize', this.onResize);
      if (this.ro) this.ro.disconnect();
      this.canvas.remove();
    }

    resize() {
      // o mapa cobre todo o espaco; no PC ~19 tiles de largura, no celular 11
      const w = this.wrap.clientWidth || 360, h = this.wrap.clientHeight || 300;
      this.ts = Math.max(24, Math.round(w < 760 ? w / 11 : Math.max(w / 19, h / 13)));
      this.W = w;
      this.H = h;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.imageSmoothingEnabled = false;
      this.dark = null;
    }

    async setRoom(id) {
      if (id === this.roomId) return;
      this.roomId = id;
      this.room = null;
      if (!id || id[0] === '#') return;
      const r = await loadJson(`salas/${safe(id)}.json`);
      if (this.roomId !== id || !r) return;
      this.atlas = loadImg(`salas/${safe(id)}.png`);
      // tiles ordenados por linha e coluna; itens de cada tile pela camada
      r.sorted = r.tiles.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]).map((t) => ({
        x: t[0], y: t[1], z: t[2],
        items: t.slice(3).map((id2) => ({ id: id2, a: r.atlas[id2] })).filter((it) => it.a).sort((p, q) => p.a[4] - q.a[4]),
      }));
      // indice por andar e linha (so as linhas visiveis sao desenhadas) e o que cobre cada posicao
      r.grid = new Map();
      r.cover = new Set();
      r.zs = new Set(r.sorted.map((t) => t.z || 0));
      for (const t of r.sorted) {
        const k = (t.z || 0) + ':' + t.y;
        if (!r.grid.has(k)) r.grid.set(k, []);
        r.grid.get(k).push(t);
        r.cover.add((t.z || 0) + ':' + t.x + ':' + t.y);
      }
      // onde se anda: tem chao e nenhum item que bloqueia (so o andar do meio)
      r.walk = new Set();
      for (const t of r.sorted) {
        if ((t.z || 0) !== 0) continue;
        if (t.items.some((it) => it.a[4] === 0) && !t.items.some((it) => it.a[8])) r.walk.add(t.x + ',' + t.y);
      }
      if (r.points) this.placeFlame(r);
      this.room = r;
      if (this.onRoom) this.onRoom(r);
    }

    // chama mistica da cidade: no tile livre mais perto do ponto marcado
    placeFlame(r) {
      const want = r.points.flame;
      let best = null, bd = 1e9;
      for (const k of r.walk) {
        const [x, y] = k.split(',').map(Number);
        const d = Math.abs(x - want[0]) + Math.abs(y - want[1]);
        if (d < bd) { bd = d; best = [x, y]; }
      }
      if (!best) return;
      r.flame = best;
      const a = r.atlas[MYSTIC_FLAME];
      const t = r.sorted.find((q) => q.x === best[0] && q.y === best[1] && (q.z || 0) === 0);
      if (a && t) t.items.push({ id: MYSTIC_FLAME, a, flame: true });
    }

    // caminho curto por tiles livres (8 direcoes)
    path(from, to) {
      const r = this.room;
      if (!r || !r.walk) return null;
      const key = (x, y) => x + ',' + y;
      const goal = key(to[0], to[1]);
      const prev = new Map([[key(from[0], from[1]), null]]);
      const queue = [from];
      while (queue.length) {
        const [x, y] = queue.shift();
        if (key(x, y) === goal) break;
        for (const [dx, dy] of STEP8) {
          const nk = key(x + dx, y + dy);
          if (prev.has(nk) || (!r.walk.has(nk) && nk !== goal)) continue;
          if (dx && dy && (!r.walk.has(key(x + dx, y)) || !r.walk.has(key(x, y + dy)))) continue; // sem cortar quina
          prev.set(nk, key(x, y));
          queue.push([x + dx, y + dy]);
        }
      }
      if (!prev.has(goal)) return null;
      const out = [];
      for (let k = goal; k; k = prev.get(k)) out.unshift(k.split(',').map(Number));
      return out.slice(1);
    }

    // ------------------------------------------------------------------ cidade
    // mostra a cidade com o personagem parado (no ponto dado, ou no templo)
    setTown(look, name, hp, max, at) {
      this.mode = 'town';
      this.state = null;
      this.floor = 0;
      this.walking = null;
      this.ents.clear();
      this.floats = [];
      this.flashes = [];
      this.shots = [];
      const place = (r) => {
        const p = at === 'flame' && r.flame ? r.flame : r.points ? r.points.temple : [0, 0];
        const now = performance.now();
        this.ents.set('me', { x: p[0], y: p[1], px: p[0], py: p[1], t0: now, dir: 2, look, walkT: 0, me: true, name, hp, max });
        if (at === 'flame') this.flashes.push({ ent: 'me', color: '#9ad8ff', at: now, radius: 1.2 });
      };
      this.onRoom = place;
      if (this.roomId === 'cidade' && this.room) place(this.room);
      else this.setRoom('cidade');
    }

    // Thais de verdade: posicoes vindas do servidor (eu e os jogadores por perto)
    updateTown(town, name) {
      if (this.mode !== 'live') {
        this.mode = 'live';
        this.walking = null;
        this.onRoom = null;
        this.ents.clear();
      }
      if (this.roomId !== 'cidade') this.setRoom('cidade');
      const now = performance.now();
      const seen = new Set();
      const floor = town.me ? town.me.z || 0 : 0;
      if (floor !== this.floor) {
        this.floor = floor;
        this.ents.clear();
      }
      // a posicao nova entra na fila de passos: os passos do rastro depois do ultimo tile conhecido,
      // cada um com o tempo que durou no servidor; longe demais (teleporte) aparece direto no lugar
      const put = (id, x, y, dir, look, extra, trail, ms) => {
        seen.add(id);
        let e = this.ents.get(id);
        if (!e) {
          e = { x, y, px: x, py: y, t0: now, dir, look, walkT: 0, dur: ms || 400, q: [] };
          this.ents.set(id, e);
        }
        e.q = e.q || [];
        const end = e.q.length ? e.q[e.q.length - 1] : [e.x, e.y];
        if (end[0] !== x || end[1] !== y) {
          let steps = null;
          if (trail && trail.length) {
            const keys = trail.map((t) => t[0] + ',' + t[1]);
            const i = keys.lastIndexOf(end[0] + ',' + end[1]);
            if (i >= 0) steps = trail.slice(i + 1).map((t) => [t[0], t[1], t[3] || ms || 400]);
          }
          if (!steps && Math.max(Math.abs(end[0] - x), Math.abs(end[1] - y)) <= 1) steps = [[x, y, ms || 400]];
          if (steps && steps.length && steps.length <= 12) e.q.push(...steps);
          else {
            e.q = [];
            e.x = e.px = x;
            e.y = e.py = y;
            e.t0 = now;
          }
        } else if (!e.q.length) e.dir = dir;
        e.look = look;
        Object.assign(e, extra);
      };
      if (town.me) put('me', town.me.x, town.me.y, town.me.dir, town.me.look, { me: true, name, hp: town.hp, max: town.maxHp }, town.me.trail, town.me.ms);
      for (const o of town.players || []) {
        if ((o.z || 0) !== floor) continue;
        put('p' + o.id, o.x, o.y, o.dir, o.look, { name: o.name + (o.lv ? ` [${o.lv}${o.voc ? ' ' + o.voc : ''}]` : ''), hp: o.hp ?? 100, max: 100, other: true }, o.trail, o.ms);
      }
      for (const id of [...this.ents.keys()]) if (!seen.has(id)) this.ents.delete(id);
      for (const f of town.fx || []) this.townFx(f, now);
    }

    // passo do teclado na hora (se o tile e livre); o servidor confirma pelo rastro ou corrige
    predictStep(dx, dy, ms) {
      const me = this.ents.get('me');
      const r = this.room;
      if (!me || !r || !r.walk || this.mode !== 'live') return;
      me.q = me.q || [];
      if (me.q.length > 1) return;
      const end = me.q.length ? me.q[me.q.length - 1] : [me.x, me.y];
      const nx = end[0] + dx, ny = end[1] + dy;
      if ((this.floor || 0) === 0 && !r.walk.has(nx + ',' + ny)) return;
      me.q.push([nx, ny, ms || me.dur || 300]);
    }

    // anda a fila de passos: um passo de cada vez, no tempo de cada um (atrasado, anda um pouco mais rapido)
    advance(e, now) {
      if (!e.q || !e.q.length || now < e.t0 + (e.dur || 0)) return;
      const [nx, ny, ms] = e.q.shift();
      const start = Math.max(e.t0 + (e.dur || 0), now - 60);
      const dx = nx - e.x, dy = ny - e.y;
      e.px = e.x;
      e.py = e.y;
      e.x = nx;
      e.y = ny;
      e.t0 = start;
      e.dur = ms * (e.q.length > 2 ? 0.6 : 1);
      e.walkT = start;
      if (dx || dy) e.dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
    }

    // efeito na cidade: tiro de treino, golpe no boneco, chama mistica, fala
    townFx(f, now) {
      if (f.k === 'shot') this.shots.push({ a: [f.fx, f.fy], b: [f.x, f.y], color: f.c || '#fff', at: now });
      else if (f.k === 'hit') this.flashes.push({ x: f.x, y: f.y, color: f.c || '#fff', at: now, radius: 0.5 });
      else if (f.k === 'flame') this.flashes.push({ x: f.x, y: f.y, color: '#9ad8ff', at: now, radius: 1.4 });
      else if (f.k === 'say') this.say('p' + f.bot, f.text);
    }

    // fala em amarelo em cima do personagem (some em alguns segundos)
    say(id, text) {
      const e = this.ents.get(id);
      if (e) e.say = { text: String(text || ''), at: performance.now() };
    }

    // tile (da sala) embaixo de um ponto da tela
    tileAt(px, py) {
      if (this.camX == null) return null;
      return [Math.floor((px - this.W / 2 + this.ts / 2) / this.ts + this.camX), Math.floor((py - this.H / 2 + this.ts / 2) / this.ts + this.camY)];
    }

    // marca o destino do clique por um instante
    markTarget(x, y) {
      this.target = { x, y, at: performance.now() };
    }

    // fundo das telas de entrada: a cidade viva, com aventureiros andando pelas ruas e a camera
    // acompanhando um deles (looks = [{t, h, b, l, f}, ...]; o primeiro e o da camera)
    showcase(looks) {
      this.mode = 'show';
      this.walkers = [];
      this.ents.clear();
      this.onRoom = (r) => {
        this.cells = [...r.walk].map((k) => k.split(',').map(Number));
        const pick = () => this.cells[Math.floor(Math.random() * this.cells.length)];
        const now = performance.now();
        // a camera acompanha um aventureiro que sai do templo, vai ao depot, volta ao templo (e de novo);
        // os outros andam pelas ruas no caminho entre os dois
        const P = r.points || {};
        const temple = P.temple || [0, 0], depot = P.depot || [0, 0];
        const nearWalk = (p) => this.cells.reduce((b, c) => (Math.abs(c[0] - p[0]) + Math.abs(c[1] - p[1]) < Math.abs(b[0] - p[0]) + Math.abs(b[1] - p[1]) ? c : b), this.cells[0]);
        const route = [nearWalk(depot), nearWalk(temple)];
        const x0 = Math.min(temple[0], depot[0]) - 12, x1 = Math.max(temple[0], depot[0]) + 12;
        const y0 = Math.min(temple[1], depot[1]) - 10, y1 = Math.max(temple[1], depot[1]) + 10;
        const start = nearWalk(temple);
        this.cells = this.cells.filter(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
        this.ents.set('me', { x: start[0], y: start[1], px: start[0], py: start[1], t0: now, dir: 0, look: looks[0], walkT: 0, noName: true });
        this.walkers.push({ id: 'me', steps: [], next: now + 1500, stepMs: 230, route, ri: 0 });
        looks.slice(1).forEach((look, i) => {
          const p = pick();
          const id = 'w' + i;
          this.ents.set(id, { x: p[0], y: p[1], px: p[0], py: p[1], t0: now, dir: 2, look, walkT: 0, noName: true });
          this.walkers.push({ id, steps: [], next: now + Math.random() * 1500, stepMs: 220 + Math.random() * 80 });
        });
      };
      this.setRoom('cidade');
    }

    stepShow(now) {
      for (const w of this.walkers || []) {
        const e = this.ents.get(w.id);
        if (!e || now < w.next || !this.cells) continue;
        if (!w.steps.length && w.route) {
          // o da camera: templo -> depot -> templo..., parando um pouco em cada um
          const goal = w.route[w.ri++ % w.route.length];
          w.steps = this.path([Math.round(e.x), Math.round(e.y)], goal) || [];
          w.next = now + 2500 + Math.random() * 2000;
          continue;
        }
        if (!w.steps.length) {
          // outro destino por perto e uma pausa, como um jogador olhando a cidade
          for (let t = 0; t < 8 && !w.steps.length; t++) {
            const c = this.cells[Math.floor(Math.random() * this.cells.length)];
            if (Math.abs(c[0] - e.x) + Math.abs(c[1] - e.y) > 26) continue;
            w.steps = this.path([Math.round(e.x), Math.round(e.y)], c) || [];
          }
          w.next = now + 500 + Math.random() * 2500;
          continue;
        }
        const [x, y] = w.steps.shift();
        const dx = x - e.x, dy = y - e.y;
        e.px = e.x; e.py = e.y;
        e.x = x; e.y = y; e.t0 = now; e.walkT = now;
        e.dur = w.stepMs * (dx && dy ? 1.4 : 1);
        e.dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
        w.next = now + e.dur;
      }
    }

    // anda ate a chama mistica; chama onArrive quando entra nela. Devolve quantos ms a caminhada leva
    // (0 = sem caminho), para a pagina garantir a entrada mesmo com a aba em segundo plano.
    walkToFlame(onArrive, stepMs = 200) {
      const r = this.room, me = this.ents.get('me');
      if (!r || !r.flame || !me) return 0;
      const steps = this.path([Math.round(me.x), Math.round(me.y)], r.flame);
      if (!steps) return 0;
      this.walking = { steps, stepMs, next: performance.now(), onArrive };
      let ms = 0, px = me.x, py = me.y;
      for (const [x, y] of steps) {
        ms += stepMs * (x !== px && y !== py ? 1.4 : 1);
        px = x; py = y;
      }
      return Math.max(1, Math.round(ms));
    }

    stopWalk() {
      this.walking = null;
    }

    // termina a caminhada na hora (aba que ficou em segundo plano)
    finishWalk() {
      const w = this.walking, me = this.ents.get('me');
      if (!w) return;
      if (me && w.steps.length) {
        const [x, y] = w.steps[w.steps.length - 1];
        me.x = me.px = x; me.y = me.py = y;
      }
      w.steps = [];
      w.next = 0;
      this.stepWalk(performance.now());
    }

    // um passo por vez no ritmo do relogio; se os quadros atrasarem, recupera os passos (chega na hora certa)
    stepWalk(now) {
      for (let guard = 0; guard < 60; guard++) {
        const w = this.walking, me = this.ents.get('me');
        if (!w || !me || now < w.next) return;
        if (!w.steps.length) {
          this.walking = null;
          this.flashes.push({ ent: 'me', color: '#9ad8ff', at: now, radius: 1.4 });
          if (w.onArrive) w.onArrive();
          return;
        }
        const at = Math.max(w.next, now - 1000);
        const [x, y] = w.steps.shift();
        const dx = x - me.x, dy = y - me.y;
        me.px = me.x; me.py = me.y;
        me.x = x; me.y = y; me.t0 = at; me.walkT = at;
        me.dur = w.stepMs * (dx && dy ? 1.4 : 1);
        me.dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
        w.next = at + me.dur;
      }
    }

    update(idle) {
      if (this.mode === 'town') {
        this.mode = 'hunt';
        this.walking = null;
        this.onRoom = null;
        this.ents.clear();
      }
      this.state = idle;
      this.setRoom(idle.room);
      const now = performance.now();
      const seen = new Set();
      const put = (id, x, y, dir, look, extra) => {
        seen.add(id);
        const e = this.ents.get(id) || { x, y, px: x, py: y, t0: now, dir, look, walkT: 0 };
        const moved = e.x !== x || e.y !== y;
        e.px = this.lerpX(e, now); e.py = this.lerpY(e, now);
        e.x = x; e.y = y; e.t0 = now; e.dir = dir; e.look = look;
        if (moved) e.walkT = now;
        Object.assign(e, extra);
        this.ents.set(id, e);
      };
      const floor = idle.me ? idle.me.z || 0 : 0;
      if (floor !== this.floor) {
        this.floor = floor;
        this.ents.clear(); // mudou de andar: nada de deslizar entre andares
      }
      if (idle.me) put('me', idle.me.x, idle.me.y, idle.me.dir, idle.me.look, { me: true, name: S_NAME(), hp: idle.hp, max: idle.maxHp });
      for (const m of (idle.monsters || []).filter((q) => (q.z || 0) === floor)) put(m.id, m.x, m.y, m.dir, m.look, { name: m.name, hp: m.hp, max: m.max, target: m.target, me: false });
      for (const id of [...this.ents.keys()]) if (!seen.has(id)) this.ents.delete(id);

      // eventos do ultimo segundo -> numeros subindo, flashes e projeteis (espalhados no segundo)
      const elemOf = {};
      for (const f of idle.fx || []) if (f.k === 'elem' || (f.k === 'cast' && f.to)) elemOf[f.id || f.to] = f.e;
      let delay = 0;
      for (const f of idle.fx || []) {
        delay += 120;
        const at = now + Math.min(delay, 900);
        if (f.k === 'dmg') {
          const e = this.ents.get(f.id);
          if (e) this.floats.push({ ent: f.id, text: String(f.v), color: ELEM_COLOR[elemOf[f.id] || 'phys'], at });
        } else if (f.k === 'hurt') {
          this.floats.push({ ent: 'me', text: String(f.v), color: '#ff4040', at });
        } else if (f.k === 'heal') {
          this.floats.push({ ent: 'me', text: '+' + f.v, color: '#60f060', at });
        } else if (f.k === 'xp') {
          this.floats.push({ ent: 'me', text: '+' + f.v + ' XP', color: '#ffffff', at, big: true });
        } else if (f.k === 'cast') {
          const color = ELEM_COLOR[f.e] || (f.kind === 'heal' || f.kind === 'potion' ? '#60f060' : '#ffffff');
          if (f.to && (f.kind === 'attack')) this.shots.push({ from: 'me', to: f.to, color, at });
          if (f.kind === 'area') this.flashes.push({ ent: 'me', color, at, radius: 3 });
          else if (f.to && f.kind === 'attack') this.flashes.push({ ent: f.to, color, at: at + 220, radius: 0.7 });
          else this.flashes.push({ ent: 'me', color, at, radius: 0.8 });
        }
      }
      if (this.floats.length > 80) this.floats.splice(0, this.floats.length - 80);
    }

    lerpX(e, now) { const k = Math.min(1, (now - e.t0) / (e.dur || 400)); return e.px + (e.x - e.px) * k; }
    lerpY(e, now) { const k = Math.min(1, (now - e.t0) / (e.dur || 400)); return e.py + (e.y - e.py) * k; }

    // ------------------------------------------------------------------ desenho
    draw() {
      const g = this.ctx, ts = this.ts, now = performance.now();
      const W = this.W, H = this.H;
      this.stepWalk(now);
      if (this.mode === 'live') for (const e of this.ents.values()) this.advance(e, now);
      if (this.mode === 'show') this.stepShow(now);
      g.fillStyle = '#07080b';
      g.fillRect(0, 0, W, H);
      const me = this.ents.get('me');
      const camX = me ? this.lerpX(me, now) : 0, camY = me ? this.lerpY(me, now) : 0;
      // tile (dx, dy) da sala -> pixel na tela (camera no personagem, no meio da tela)
      this.camX = camX;
      this.camY = camY;
      const sx = (dx) => (dx - camX) * ts + W / 2 - ts / 2;
      const sy = (dy) => (dy - camY) * ts + H / 2 - ts / 2;
      const r0 = this.room;
      // abaixo do chao (andar > 7): escuro de caverna
      const dark = r0 && r0.from && r0.from[2] + (this.floor || 0) > 7;
      const r = this.room;
      const atlasOk = r && ready(this.atlas);
      const cell = (it, wx, wy, x, y, elev) => {
        const a = it.a;
        // item animado (fogo, fonte, agua): a fase pelo relogio, todos em sincronia (as 4 pecas da fonte andam juntas)
        const ph = a[9] > 1 ? Math.floor(now / Math.max(50, a[10] || 200)) % a[9] : 0;
        const k = a[1] * COLS + a[0] + ph * a[2] * a[3] + (((wy % a[3]) + a[3]) % a[3]) * a[2] + (((wx % a[2]) + a[2]) % a[2]);
        g.drawImage(this.atlas, (k % COLS) * 64, Math.floor(k / COLS) * 64, 64, 64, x - ts - ((a[5] + elev) * ts) / 32, y - ts - ((a[6] + elev) * ts) / 32, ts * 2, ts * 2);
      };
      const fl = this.floor || 0;
      const halfW = W / ts / 2 + 3, halfH = H / ts / 2 + 3;
      const yMin = Math.floor(camY - halfH), yMax = Math.ceil(camY + halfH);
      // linha y do andar z, deslocada k andares para cima (no Tibia o andar de cima aparece 1 tile acima e a esquerda)
      const rowTiles = (z, y) => (r && r.grid ? r.grid.get(z + ':' + y) || [] : []);
      const visible = (t, k) => Math.abs(t.x - k - camX) <= halfW;
      const drawTile = (t, k, pred) => {
        const x = sx(t.x - k), y = sy(t.y - k);
        let elev = 0;
        for (const it of t.items) {
          if (!pred(it.a[4])) continue;
          cell(it, r.from[0] + t.x, r.from[1] + t.y, x + ts, y + ts, it.a[4] === 2 || it.a[4] === 3 ? elev : 0);
          if (it.a[4] === 2 || it.a[4] === 3) elev += it.a[7] || 0;
        }
      };
      const ents = [...this.ents.values()].map((e) => ({ e, x: this.lerpX(e, now), y: this.lerpY(e, now) }));
      if (atlasOk) {
        // 1) chao e bordas do andar do personagem
        for (let y = yMin; y <= yMax; y++) for (const t of rowTiles(fl, y)) if (visible(t, 0)) drawTile(t, 0, (o) => o <= 1);
        // 2) linha por linha: paredes/itens e as criaturas daquela linha
        for (let y = yMin; y <= yMax; y++) {
          for (const t of rowTiles(fl, y)) if (visible(t, 0)) drawTile(t, 0, (o) => o === 2 || o === 3);
          for (const o of ents) if (Math.round(o.y) === y) {
            if (dark && !o.e.me) this.glow(sx(o.x), sy(o.y));
            this.drawCreature(o.e, sx(o.x), sy(o.y), now);
          }
        }
        // 3) o que fica por cima das criaturas
        for (let y = yMin; y <= yMax; y++) for (const t of rowTiles(fl, y)) if (visible(t, 0)) drawTile(t, 0, (o) => o === 4);
        // 4) andares de cima (segundo andar, telhados): so na superficie e se a camera nao esta debaixo de um teto
        const absZ = (r.from ? r.from[2] : 7) + fl;
        const cx = Math.round(camX), cy = Math.round(camY);
        for (let k = 1; absZ - k >= 0 && absZ <= 7; k++) {
          const z = fl - k;
          if (!r.zs.has(z)) break;
          if (r.cover.has(z + ':' + cx + ':' + cy) || r.cover.has(z + ':' + (cx + k) + ':' + (cy + k))) break;
          for (let y = yMin + k; y <= yMax + k; y++) for (const t of rowTiles(z, y)) if (visible(t, k)) drawTile(t, k, () => true);
        }
      } else {
        // sala lisa (ou carregando)
        for (let dy = -9; dy <= 9; dy++) for (let dx = -12; dx <= 12; dx++) {
          g.fillStyle = (dx + dy) & 1 ? '#2e3d25' : '#34452a';
          g.fillRect(sx(dx), sy(dy), ts, ts);
        }
        for (const o of ents.sort((p1, p2) => p1.y - p2.y)) this.drawCreature(o.e, sx(o.x), sy(o.y), now);
      }
      // chama mistica: brilho azul pulsando
      if (atlasOk && r.flame) {
        const k = 0.5 + 0.5 * Math.sin(now / 260);
        const fx = sx(r.flame[0]) + ts / 2, fy = sy(r.flame[1]) + ts / 2;
        const grd = g.createRadialGradient(fx, fy, 0, fx, fy, ts * (1.2 + 0.2 * k));
        grd.addColorStop(0, `rgba(120,200,255,${0.35 + 0.2 * k})`);
        grd.addColorStop(1, 'rgba(120,200,255,0)');
        g.fillStyle = grd;
        g.fillRect(fx - ts * 2, fy - ts * 2, ts * 4, ts * 4);
      }
      // destino do clique na cidade
      if (this.target && now - this.target.at < 900) {
        const k = 1 - (now - this.target.at) / 900;
        g.strokeStyle = `rgba(255,220,120,${k})`;
        g.lineWidth = 2;
        g.strokeRect(sx(this.target.x) + 3, sy(this.target.y) + 3, ts - 6, ts - 6);
      }
      // escuro de caverna, com luz em volta do personagem e dos monstros
      if (dark) this.drawDark(ents, sx, sy, now);
      // 4) nomes e barras de vida, efeitos e numeros
      for (const o of ents) this.drawName(o.e, sx(o.x), sy(o.y));
      this.drawEffects(sx, sy, now);
    }

    // brilho vermelho embaixo do monstro (no escuro)
    glow(x, y) {
      const g = this.ctx, ts = this.ts;
      const cx = x + ts / 2, cy = y + ts * 0.7;
      const grd = g.createRadialGradient(cx, cy, 0, cx, cy, ts * 1.1);
      grd.addColorStop(0, 'rgba(255,60,30,0.45)');
      grd.addColorStop(1, 'rgba(255,60,30,0)');
      g.fillStyle = grd;
      g.fillRect(cx - ts * 1.2, cy - ts * 1.2, ts * 2.4, ts * 2.4);
    }

    drawDark(ents, sx, sy, now) {
      const W = this.W, H = this.H, ts = this.ts;
      if (!this.dark || this.dark.width !== W || this.dark.height !== H) {
        this.dark = document.createElement('canvas');
        this.dark.width = W;
        this.dark.height = H;
      }
      const d = this.dark.getContext('2d');
      d.globalCompositeOperation = 'source-over';
      d.clearRect(0, 0, W, H);
      d.fillStyle = 'rgba(0,0,0,0.86)';
      d.fillRect(0, 0, W, H);
      d.globalCompositeOperation = 'destination-out';
      const hole = (cx, cy, rad, a) => {
        const grd = d.createRadialGradient(cx, cy, 0, cx, cy, rad);
        grd.addColorStop(0, `rgba(0,0,0,${a})`);
        grd.addColorStop(0.55, `rgba(0,0,0,${a * 0.75})`);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        d.fillStyle = grd;
        d.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
      };
      for (const o of ents) {
        const cx = sx(o.x) + ts / 2, cy = sy(o.y) + ts / 2;
        if (o.e.me) hole(cx, cy, ts * 5.2, 1);
        else hole(cx, cy, ts * 1.6, 0.55);
      }
      this.ctx.drawImage(this.dark, 0, 0, W, H);
    }

    drawCreature(e, x, y, now) {
      if (e.hidden) return;
      const g = this.ctx, ts = this.ts;
      if (e.target) {
        g.strokeStyle = '#ff2020';
        g.lineWidth = Math.max(1, ts / 16);
        g.strokeRect(x + 1, y + 1, ts - 2, ts - 2);
      }
      const sh = creatureSheet(e.look);
      if (!sh) {
        g.fillStyle = e.me ? '#d8a64a' : '#a33';
        g.beginPath();
        g.arc(x + ts / 2, y + ts / 2, ts * 0.35, 0, Math.PI * 2);
        g.fill();
        return;
      }
      const walking = now - e.walkT < Math.max(500, (e.dur || 0) + 60) && sh.cols > 1;
      const col = walking ? 1 + (Math.floor(now / 110) % (sh.cols - 1)) : 0;
      const row = [0, 1, 2, 3].includes(e.dir) ? e.dir : 2;
      g.drawImage(sh.img, col * 64, row * 64, 64, 64, x - ts, y - ts, ts * 2, ts * 2);
    }

    drawName(e, x, y) {
      if (e.noName) return;
      const g = this.ctx, ts = this.ts;
      const pct = e.max ? Math.max(0, Math.min(1, e.hp / e.max)) : 1;
      const color = pct > 0.6 ? '#20c020' : pct > 0.3 ? '#e0c020' : pct > 0.1 ? '#e05020' : '#c01010';
      // tamanho do Tibia: nome em Verdana 11 negrito e barra de 27x4, iguais em qualquer zoom
      const top = y - ts * 0.55;
      const bw = 27;
      g.fillStyle = '#000';
      g.fillRect(Math.round(x + ts / 2 - bw / 2 - 1), Math.round(top - 1), bw + 2, 6);
      g.fillStyle = color;
      g.fillRect(Math.round(x + ts / 2 - bw / 2), Math.round(top), Math.round(bw * pct), 4);
      g.font = 'bold 11px Verdana, sans-serif';
      g.textAlign = 'center';
      g.lineWidth = 2.5;
      g.strokeStyle = '#000';
      g.strokeText(e.name || '', x + ts / 2, top - 3);
      g.fillStyle = color;
      g.fillText(e.name || '', x + ts / 2, top - 3);
      if (e.say && performance.now() - e.say.at < 5000) this.drawSay(e.say.text, x + ts / 2, top - 17);
    }

    // texto amarelo (como o "says" do Tibia), quebrado em linhas curtas, acima do nome
    drawSay(text, cx, bottom) {
      const g = this.ctx, ts = this.ts;
      const lines = [];
      let cur = '';
      for (const w of text.split(/\s+/)) {
        if ((cur + ' ' + w).trim().length > 26 && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
      }
      if (cur) lines.push(cur);
      const fs = 11;
      g.font = `bold ${fs}px Verdana, sans-serif`;
      g.textAlign = 'center';
      g.lineWidth = 2.5;
      g.strokeStyle = '#000';
      g.fillStyle = '#f2e93a';
      lines.slice(0, 4).forEach((ln, i, arr) => {
        const y = bottom - (arr.length - 1 - i) * (fs + 2);
        g.strokeText(ln, cx, y);
        g.fillText(ln, cx, y);
      });
    }

    drawEffects(sx, sy, now) {
      const g = this.ctx, ts = this.ts;
      const pos = (id) => {
        const e = this.ents.get(id);
        return e ? [sx(this.lerpX(e, now)) + ts / 2, sy(this.lerpY(e, now)) + ts / 2] : null;
      };
      const tile = (p) => [sx(p[0]) + ts / 2, sy(p[1]) + ts / 2];
      // projeteis
      this.shots = this.shots.filter((s) => now < s.at + 260);
      for (const s of this.shots) {
        if (now < s.at) continue;
        const a = s.a ? tile(s.a) : pos(s.from), b = s.b ? tile(s.b) : pos(s.to);
        if (!a || !b) continue;
        const k = (now - s.at) / 260;
        const x = a[0] + (b[0] - a[0]) * k, y = a[1] + (b[1] - a[1]) * k;
        g.fillStyle = s.color;
        g.shadowColor = s.color;
        g.shadowBlur = ts / 3;
        g.beginPath();
        g.arc(x, y, ts * 0.14, 0, Math.PI * 2);
        g.fill();
        g.shadowBlur = 0;
      }
      // flashes (area / impacto)
      this.flashes = this.flashes.filter((f) => now < f.at + 420);
      for (const f of this.flashes) {
        if (now < f.at) continue;
        const p = f.ent ? pos(f.ent) : tile([f.x, f.y]);
        if (!p) continue;
        const k = (now - f.at) / 420;
        g.globalAlpha = 0.55 * (1 - k);
        g.fillStyle = f.color;
        g.beginPath();
        g.arc(p[0], p[1], ts * (0.3 + f.radius * k), 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
      }
      // numeros subindo
      this.floats = this.floats.filter((f) => now < f.at + 1100);
      g.textAlign = 'center';
      for (const f of this.floats) {
        if (now < f.at) continue;
        const p = pos(f.ent);
        if (!p) continue;
        const k = (now - f.at) / 1100;
        g.globalAlpha = 1 - k * 0.7;
        g.font = `bold ${Math.round(ts * (f.big ? 0.42 : 0.38))}px Verdana, sans-serif`;
        g.lineWidth = 3;
        g.strokeStyle = '#000';
        const y = p[1] - ts * 0.8 - k * ts * 1.2;
        g.strokeText(f.text, p[0], y);
        g.fillStyle = f.color;
        g.fillText(f.text, p[0], y);
        g.globalAlpha = 1;
      }
    }
  }

  // retratos (catalogo de cacadas, personagem): <canvas data-look='{"t":..,"h":..}'> recebe a criatura
  // parada, de frente, recortada no que tem desenho e centralizada
  function portraitReady(look) {
    const meta = creatureIndex && creatureIndex[look.t];
    if (!meta) return null;
    const base = loadImg(`criaturas/${look.t}.png`);
    if (!ready(base)) return null;
    if (meta.color && !tinted.has(`${look.t}:${look.h}:${look.b}:${look.l}:${look.f}`)) {
      creatureSheet(look);
      return tinted.get(`${look.t}:${look.h}:${look.b}:${look.l}:${look.f}`) || null;
    }
    return creatureSheet(look);
  }
  async function paintPortraits(root) {
    if (!creatureIndex) creatureIndex = (await loadJson('criaturas/index.json')) || {};
    const list = [...root.querySelectorAll('canvas[data-look]')];
    let tries = 0;
    const tick = () => {
      let pending = 0;
      for (const c of list) {
        if (c._done || !c.isConnected) continue;
        let look;
        try { look = JSON.parse(c.dataset.look); } catch { c._done = true; continue; }
        const sh = look && look.t ? portraitReady(look) : null;
        if (!sh) { pending++; continue; }
        const tmp = document.createElement('canvas');
        tmp.width = 64; tmp.height = 64;
        const tg = tmp.getContext('2d');
        tg.drawImage(sh.img, 0, 2 * 64, 64, 64, 0, 0, 64, 64); // linha 2 = de frente (sul), coluna 0 = parado
        const d = tg.getImageData(0, 0, 64, 64).data;
        let x0 = 64, y0 = 64, x1 = -1, y1 = -1;
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (d[(y * 64 + x) * 4 + 3] > 10) {
          if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
        }
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.clearRect(0, 0, c.width, c.height);
        if (x1 >= 0) {
          const w = x1 - x0 + 1, h = y1 - y0 + 1;
          const k = Math.min((c.width - 4) / w, (c.height - 4) / h, 2);
          g.drawImage(tmp, x0, y0, w, h, (c.width - w * k) / 2, (c.height - h * k) / 2, w * k, h * k);
        }
        c._done = true;
      }
      if (pending && tries++ < 240) requestAnimationFrame(tick);
    };
    tick();
  }

  let S_NAME = () => '';
  window.GameView = {
    create(wrap, nameFn) {
      if (nameFn) S_NAME = nameFn;
      return new GameView(wrap);
    },
    paintPortraits,
  };
})();
