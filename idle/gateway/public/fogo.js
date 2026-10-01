/*
 * Fundo flamejante das telas de fora do jogo (codigo de acesso, entrar, personagens): uma fornalha escura,
 * labaredas subindo do chao, um foco de fogo pulsando atras do logo e brasas que sobem rodando.
 *
 *   Fogo.start(canvas, { focus: elementoDoLogo })   // focus: o fogo se concentra atras desse elemento
 *   Fogo.stop()
 */
(function () {
  'use strict';
  let raf = 0, cv = null, g = null, W = 0, H = 0, dpr = 1, focusEl = null;
  let flames = [], embers = [], t0 = 0, last = 0, onResize = null;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rnd = (a, b) => a + Math.random() * (b - a);

  // cor da labareda pela idade: branco-amarelo no nascer, laranja, vermelho e some no escuro
  function flameColor(k, a) {
    const r = 255, gg = Math.max(0, Math.round(230 - 200 * k)), b = Math.max(0, Math.round(120 - 220 * k));
    return `rgba(${r},${gg},${b},${a})`;
  }

  function focusPoint() {
    if (focusEl && focusEl.isConnected) {
      const r = focusEl.getBoundingClientRect();
      if (r.width) return [r.left + r.width / 2, r.top + r.height * 0.55, Math.max(r.width, r.height)];
    }
    return [W / 2, H * 0.32, Math.min(W, H) * 0.4];
  }

  function resize() {
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    W = window.innerWidth;
    H = window.innerHeight;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawnFlame(fx, fy, fr) {
    // dois lugares: a fornalha do chao (larga) e o foco atras do logo
    if (Math.random() < 0.62) {
      const x = W / 2 + (Math.random() + Math.random() + Math.random() - 1.5) * W * 0.45;
      flames.push({ x, y: H + 10, vx: rnd(-0.25, 0.25), vy: rnd(-2.4, -1.1), r: rnd(18, 46), life: 0, max: rnd(70, 140), wob: rnd(0, 6.28) });
    } else {
      const ang = rnd(0, Math.PI * 2), d = fr * rnd(0.05, 0.42);
      flames.push({ x: fx + Math.cos(ang) * d, y: fy + Math.sin(ang) * d * 0.5 + fr * 0.2, vx: rnd(-0.3, 0.3), vy: rnd(-1.6, -0.7), r: rnd(14, 34), life: 0, max: rnd(45, 90), wob: rnd(0, 6.28), focus: true });
    }
  }

  function spawnEmber() {
    embers.push({ x: rnd(0, W), y: H + rnd(0, 40), vx: rnd(-0.4, 0.4), vy: rnd(-1.6, -0.6), r: rnd(0.8, 2.6), life: 0, max: rnd(240, 520), ph: rnd(0, 6.28), sw: rnd(0.6, 1.8) });
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (document.hidden) return;
    const dt = Math.min(3, (now - (last || now)) / 16.7);
    last = now;
    const t = (now - t0) / 1000;
    const [fx, fy, fr] = focusPoint();

    // fundo: fornalha escura com o brilho vermelho embaixo
    g.globalCompositeOperation = 'source-over';
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a0810');
    bg.addColorStop(0.55, '#120a0c');
    bg.addColorStop(1, '#2a0c06');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    // foco flamejante atras do logo: calor que pulsa (duas ondas fora de compasso parecem fogo vivo)
    const pulse = 0.75 + 0.15 * Math.sin(t * 2.1) + 0.1 * Math.sin(t * 5.3 + 1.7);
    let rg = g.createRadialGradient(fx, fy, 0, fx, fy, fr * 1.6 * pulse);
    rg.addColorStop(0, 'rgba(255,170,60,0.55)');
    rg.addColorStop(0.25, 'rgba(230,80,20,0.32)');
    rg.addColorStop(0.6, 'rgba(120,20,8,0.14)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, W, H);
    // brilho do chao
    rg = g.createRadialGradient(W / 2, H * 1.08, 0, W / 2, H * 1.08, Math.max(W, H) * 0.75);
    rg.addColorStop(0, `rgba(255,110,30,${0.42 + 0.08 * Math.sin(t * 1.3)})`);
    rg.addColorStop(0.4, 'rgba(150,30,10,0.22)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, W, H);

    if (!reduce) {
      // labaredas: muitas bolhas de luz somadas (lighter) parecem chama
      for (let i = 0; i < 9 * dt; i++) if (flames.length < 520) spawnFlame(fx, fy, fr);
      g.globalCompositeOperation = 'lighter';
      for (let i = flames.length - 1; i >= 0; i--) {
        const p = flames[i];
        p.life += dt;
        const k = p.life / p.max;
        if (k >= 1) { flames.splice(i, 1); continue; }
        p.wob += 0.08 * dt;
        p.x += (p.vx + Math.sin(p.wob) * 0.35) * dt;
        p.y += p.vy * dt;
        p.vy *= 1 - 0.004 * dt;
        const r = p.r * (1 - k * 0.75);
        const a = (k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85) * (p.focus ? 0.16 : 0.13);
        const fg = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        fg.addColorStop(0, flameColor(k, a));
        fg.addColorStop(1, flameColor(Math.min(1, k + 0.3), 0));
        g.fillStyle = fg;
        g.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      }
      // brasas: pontinhos que sobem rodando e piscam
      if (embers.length < 90 && Math.random() < 0.5 * dt) spawnEmber();
      for (let i = embers.length - 1; i >= 0; i--) {
        const e = embers[i];
        e.life += dt;
        if (e.life > e.max || e.y < -20) { embers.splice(i, 1); continue; }
        e.ph += 0.05 * dt;
        e.x += (e.vx + Math.sin(e.ph) * e.sw * 0.5) * dt;
        e.y += e.vy * dt;
        const fl = 0.55 + 0.45 * Math.sin(e.ph * 3.1);
        const a = Math.min(1, e.life / 30) * (1 - e.life / e.max) * fl;
        g.fillStyle = `rgba(255,${Math.round(150 + 70 * fl)},80,${a})`;
        g.beginPath();
        g.arc(e.x, e.y, e.r, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = `rgba(255,120,40,${a * 0.25})`;
        g.beginPath();
        g.arc(e.x, e.y, e.r * 4, 0, Math.PI * 2);
        g.fill();
      }
    }
    // escurece as bordas (o olho vai para o centro)
    g.globalCompositeOperation = 'source-over';
    const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.8);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.6)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
  }

  window.Fogo = {
    start(canvas, opts = {}) {
      this.stop();
      cv = canvas;
      g = cv.getContext('2d');
      focusEl = opts.focus || null;
      flames = [];
      embers = [];
      for (let i = 0; i < 40; i++) {
        spawnEmber();
        const e = embers[embers.length - 1];
        e.y = rnd(0, H || window.innerHeight);
        e.life = rnd(0, e.max * 0.6);
      }
      resize();
      onResize = () => resize();
      window.addEventListener('resize', onResize);
      t0 = performance.now();
      last = 0;
      raf = requestAnimationFrame(frame);
    },
    focus(el) {
      focusEl = el;
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (onResize) window.removeEventListener('resize', onResize);
      onResize = null;
    },
  };
})();
