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
 * Estado (a cada 1 s): idle.me {x, y, dir, look}, idle.monsters[{id, x, y, dir, look, hp, max, target}], idle.fx[]
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
      this.canvas.remove();
    }

    resize() {
      const w = this.wrap.clientWidth || 360;
      this.vw = w < 560 ? 11 : 15; // no celular a camera segue o personagem numa janela menor
      this.vh = w < 560 ? 9 : 11;
      this.ts = Math.floor(w / this.vw);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = this.ts * this.vw * dpr;
      this.canvas.height = this.ts * this.vh * dpr;
      this.canvas.style.width = this.ts * this.vw + 'px';
      this.canvas.style.height = this.ts * this.vh + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.imageSmoothingEnabled = false;
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
      this.room = r;
    }

    update(idle) {
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

    lerpX(e, now) { const k = Math.min(1, (now - e.t0) / 400); return e.px + (e.x - e.px) * k; }
    lerpY(e, now) { const k = Math.min(1, (now - e.t0) / 400); return e.py + (e.y - e.py) * k; }

    // ------------------------------------------------------------------ desenho
    draw() {
      const g = this.ctx, ts = this.ts, now = performance.now();
      const W = this.vw * ts, H = this.vh * ts;
      g.fillStyle = '#07080b';
      g.fillRect(0, 0, W, H);
      const me = this.ents.get('me');
      const camX = me ? this.lerpX(me, now) : 0, camY = me ? this.lerpY(me, now) : 0;
      // tile (dx, dy) da sala -> pixel na tela (camera no personagem)
      const sx = (dx) => (dx - camX + (this.vw - 1) / 2) * ts;
      const sy = (dy) => (dy - camY + (this.vh - 1) / 2) * ts;
      const r = this.room;
      const atlasOk = r && ready(this.atlas);
      const cell = (it, wx, wy, x, y, elev) => {
        const a = it.a;
        const k = a[1] * COLS + a[0] + (((wy % a[3]) + a[3]) % a[3]) * a[2] + (((wx % a[2]) + a[2]) % a[2]);
        g.drawImage(this.atlas, (k % COLS) * 64, Math.floor(k / COLS) * 64, 64, 64, x - ts - ((a[5] + elev) * ts) / 32, y - ts - ((a[6] + elev) * ts) / 32, ts * 2, ts * 2);
      };
      if (atlasOk) {
        // 1) chao e bordas
        for (const t of r.sorted) {
          if ((t.z || 0) !== (this.floor || 0)) continue;
          const x = sx(t.x), y = sy(t.y);
          if (x < -ts * 2 || y < -ts * 2 || x > W + ts || y > H + ts) continue;
          for (const it of t.items) if (it.a[4] <= 1) cell(it, r.from[0] + t.x, r.from[1] + t.y, x + ts, y + ts, 0);
        }
      } else {
        // sala lisa (ou carregando)
        g.fillStyle = '#2b3a22';
        for (let dy = -7; dy <= 7; dy++) for (let dx = -9; dx <= 9; dx++) {
          g.fillStyle = (dx + dy) & 1 ? '#2e3d25' : '#34452a';
          g.fillRect(sx(dx), sy(dy), ts, ts);
        }
      }
      // 2) linha por linha: paredes/itens do tile e as criaturas que estao nessa linha
      const ents = [...this.ents.values()].map((e) => ({ e, x: this.lerpX(e, now), y: this.lerpY(e, now) }));
      const rowsY = new Set(ents.map((o) => Math.round(o.y)));
      const rows = r && atlasOk ? [...new Set(r.sorted.filter((t) => (t.z || 0) === (this.floor || 0)).map((t) => t.y).concat([...rowsY]))].sort((a, b) => a - b) : [...rowsY].sort((a, b) => a - b);
      for (const row of rows) {
        if (atlasOk) {
          for (const t of r.sorted) {
          if ((t.z || 0) !== (this.floor || 0)) continue;
            if (t.y !== row) continue;
            const x = sx(t.x), y = sy(t.y);
            if (x < -ts * 2 || y < -ts * 2 || x > W + ts || y > H + ts) continue;
            let elev = 0;
            for (const it of t.items) {
              if (it.a[4] === 2 || it.a[4] === 3) {
                cell(it, r.from[0] + t.x, r.from[1] + t.y, x + ts, y + ts, elev);
                elev += it.a[7] || 0;
              }
            }
          }
        }
        for (const o of ents) if (Math.round(o.y) === row) this.drawCreature(o.e, sx(o.x), sy(o.y), now);
      }
      // 3) o que fica por cima das criaturas
      if (atlasOk) {
        for (const t of r.sorted) {
          if ((t.z || 0) !== (this.floor || 0)) continue;
          const x = sx(t.x), y = sy(t.y);
          if (x < -ts * 2 || y < -ts * 2 || x > W + ts || y > H + ts) continue;
          for (const it of t.items) if (it.a[4] === 4) cell(it, r.from[0] + t.x, r.from[1] + t.y, x + ts, y + ts, 0);
        }
      }
      // 4) nomes e barras de vida, efeitos e numeros
      for (const o of ents) this.drawName(o.e, sx(o.x), sy(o.y));
      this.drawEffects(sx, sy, now);
    }

    drawCreature(e, x, y, now) {
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
      const walking = now - e.walkT < 500 && sh.cols > 1;
      const col = walking ? 1 + (Math.floor(now / 110) % (sh.cols - 1)) : 0;
      const row = [0, 1, 2, 3].includes(e.dir) ? e.dir : 2;
      g.drawImage(sh.img, col * 64, row * 64, 64, 64, x - ts, y - ts, ts * 2, ts * 2);
    }

    drawName(e, x, y) {
      const g = this.ctx, ts = this.ts;
      const pct = e.max ? Math.max(0, Math.min(1, e.hp / e.max)) : 1;
      const color = pct > 0.6 ? '#20c020' : pct > 0.3 ? '#e0c020' : pct > 0.1 ? '#e05020' : '#c01010';
      const top = y - ts * 0.8;
      const bw = ts * 0.95;
      g.fillStyle = '#000';
      g.fillRect(x + ts / 2 - bw / 2 - 1, top - 1, bw + 2, 5);
      g.fillStyle = color;
      g.fillRect(x + ts / 2 - bw / 2, top, bw * pct, 3);
      g.font = `bold ${Math.max(9, Math.round(ts * 0.34))}px Verdana, sans-serif`;
      g.textAlign = 'center';
      g.lineWidth = 3;
      g.strokeStyle = '#000';
      g.strokeText(e.name || '', x + ts / 2, top - 3);
      g.fillStyle = color;
      g.fillText(e.name || '', x + ts / 2, top - 3);
    }

    drawEffects(sx, sy, now) {
      const g = this.ctx, ts = this.ts;
      const pos = (id) => {
        const e = this.ents.get(id);
        return e ? [sx(this.lerpX(e, now)) + ts / 2, sy(this.lerpY(e, now)) + ts / 2] : null;
      };
      // projeteis
      this.shots = this.shots.filter((s) => now < s.at + 260);
      for (const s of this.shots) {
        if (now < s.at) continue;
        const a = pos(s.from), b = pos(s.to);
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
        const p = pos(f.ent);
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

  let S_NAME = () => '';
  window.GameView = {
    create(wrap, nameFn) {
      if (nameFn) S_NAME = nameFn;
      return new GameView(wrap);
    },
  };
})();
