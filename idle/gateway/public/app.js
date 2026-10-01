'use strict';
/*
 * Destruitor — pagina do jogo idle.
 * Fala so com a ponte (/jogar/api): HTTP para conta/personagens/catalogo e um
 * WebSocket por personagem para o estado ao vivo e os comandos.
 * ?demo=1 abre com dados simulados (sem servidor), para conferir a tela.
 */
(() => {
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const BASE = location.pathname.replace(/[^/]*$/, '');
  const DEMO = new URLSearchParams(location.search).has('demo');

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
  };

  const S = {
    token: store.get('dt_token'),
    chars: [],
    char: store.get('dt_char'),
    catalog: null,
    live: null,
    settings: null,
    dirty: false,
    editing: -1,
    tab: store.get('dt_tab') || 'cacada',
    ws: null,
    wsTries: 0,
    view: 'auth',
    authMode: 'entrar',
    newChar: { vocation: 'knight', sex: 'male' },
    chat: { tab: 'global', lists: { global: [], local: [], comercio: [], sistema: [] }, unread: {} },
  };

  // --------------------------------------------------------------------------
  // utilidades
  // --------------------------------------------------------------------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('pt-BR');
  const kfmt = (n) => {
    n = Number(n) || 0;
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace('.', ',') + 'kk';
    if (a >= 1e4) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace('.', ',') + 'k';
    return fmt(n);
  };
  const dur = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}min` : `${m}min ${String(x).padStart(2, '0')}s`;
  };
  const hm = (min) => `${Math.floor(min / 60)}:${String(Math.floor(min % 60)).padStart(2, '0')}h`;
  const expFor = (lv) => Math.floor((50 * (lv - 1) ** 3 - 150 * (lv - 1) ** 2 + 400 * (lv - 1)) / 3);
  const pct = (a, b) => Math.max(0, Math.min(100, b > 0 ? (a * 100) / b : 0));

  let toastTimer = null;
  function toast(text, kind = 'info') {
    $toast.textContent = text;
    $toast.className = 'toast show ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($toast.className = 'toast'), 3500);
  }

  async function api(path, body) {
    if (DEMO) return demoApi(path, body);
    const res = await fetch(BASE + 'api/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(S.token ? { 'x-token': S.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({ erro: 'Resposta inválida do servidor.' }));
    if (res.status === 401 && data.acesso) location.reload(); // a liberacao venceu: volta a tela do codigo
    if (res.status === 401 && path !== 'entrar') logout(false);
    if (!res.ok) throw new Error(data.erro || 'Erro ' + res.status);
    return data;
  }

  // --------------------------------------------------------------------------
  // rotulos
  // --------------------------------------------------------------------------
  const SUBJ = { self: 'Você', target: 'Alvo', area: 'Área' };
  const ATTR = { hp: 'HP', mana: 'Mana', shield: 'Magic shield', targets: 'Alvos' };
  const SUBJ_ATTRS = { self: ['hp', 'mana', 'shield'], target: ['hp'], area: ['targets'] };
  const OPS = { lt: '<', le: '≤', eq: '=', ge: '≥', gt: '>' };
  const PULL = { cauteloso: 'Cauteloso', ousado: 'Ousado', agressivo: 'Agressivo' };
  const TARGET = { perto: 'Mais próximo', fraco: 'Menor vida', forte: 'Maior vida', fracopct: 'Menor % de vida', fortepct: 'Maior % de vida' };
  const STANCE = { defesa: 'Defesa total', equilibrado: 'Equilibrado', ataque: 'Ataque total' };
  const KIND = { heal: 'Cura', attack: 'Ataque', area: 'Área', potion: 'Poção', shield: 'Escudo', haste: 'Velocidade' };
  const REASON = {
    'parada pelo jogador': 'Você parou a caçada.',
    morte: 'Seu personagem morreu.',
    stamina: 'A stamina acabou.',
    '12 horas': 'Passaram 12 horas sem ninguém olhando o jogo.',
    'saiu do jogo': 'O personagem saiu do jogo.',
    'servidor reiniciado': 'O servidor foi reiniciado.',
    'sem stamina': 'Sem stamina para caçar.',
    'sem sala livre': 'Todas as salas estão ocupadas. Tente de novo.',
    erro: 'A caçada parou por um erro no servidor.',
  };
  const VOCS = [
    { id: 'knight', name: 'Knight', desc: 'Muita vida, luta corpo a corpo' },
    { id: 'paladin', name: 'Paladin', desc: 'Ataca de longe, vida e mana' },
    { id: 'sorcerer', name: 'Sorcerer', desc: 'Magias de energia e fogo' },
    { id: 'druid', name: 'Druid', desc: 'Magias de gelo e terra, cura' },
  ];

  const letterOf = () => S.live?.player?.letter || 'K';
  const actionsFor = (letter) => (S.catalog?.actions || []).filter((a) => a.voc.includes(letter));
  const actionByName = (n) => (S.catalog?.actions || []).find((a) => a.name === n);

  function allowedSubjects(a) {
    if (!a) return ['self'];
    if (a.kind === 'attack' || a.kind === 'area') return ['self', 'target', 'area'];
    if (a.kind === 'shield' || a.kind === 'haste') return ['self', 'area'];
    return ['self'];
  }

  function suggestedConds(a) {
    if (a.kind === 'potion') return [a.name.includes('Mana') && !a.name.includes('Spirit') ? { subj: 'self', attr: 'mana', op: 'le', val: 50, pct: true } : { subj: 'self', attr: 'hp', op: 'le', val: 75, pct: true }];
    if (a.kind === 'heal') return [{ subj: 'self', attr: 'hp', op: 'le', val: 75, pct: true }];
    if (a.kind === 'shield') return [{ subj: 'self', attr: 'hp', op: 'le', val: 25, pct: true }];
    if (a.kind === 'area') return [{ subj: 'area', attr: 'targets', op: 'ge', val: 2, pct: false }];
    return [];
  }

  // mesma prioridade do "Ordenar automaticamente" do Huntera
  function priority(slot) {
    const a = actionByName(slot.action);
    if (!a) return 9;
    if (a.kind === 'shield') return 0;
    if (a.kind === 'heal') return 1;
    if (a.kind === 'potion') return a.name.includes('Mana') && !a.name.includes('Spirit') ? 3 : 2;
    if (a.kind === 'haste') return 4;
    if (a.kind === 'area') return 5;
    return 6;
  }

  const condText = (c) => `${SUBJ[c.subj]} ${ATTR[c.attr]} ${OPS[c.op]} ${c.val}${c.pct ? '%' : ''}`;

  // --------------------------------------------------------------------------
  // telas
  // --------------------------------------------------------------------------
  // fundo das telas de entrada e de personagens: fornalha com labaredas e um foco de fogo atras do logo (fogo.js)
  function ensureBg() {
    if (S.view === 'game' || DEMO && new URLSearchParams(location.search).has('cacando')) {
      if (window.Fogo) window.Fogo.stop();
      document.getElementById('bgWorld')?.remove();
      return;
    }
    if (document.getElementById('bgWorld') || !window.Fogo) return;
    const d = document.createElement('div');
    d.id = 'bgWorld';
    d.className = 'bg-world';
    d.innerHTML = '<canvas class="fogo"></canvas>';
    document.body.prepend(d);
    window.Fogo.start(d.firstChild);
  }

  function render() {
    ensureBg();
    if (S.view !== 'game') {
      if (S.gv) { S.gv.destroy(); S.gv = null; }
      if (S.replay) stopReplay();
      $app.className = 'app';
    }
    if (S.view === 'auth') {
      renderAuth();
      window.Fogo?.focus(document.querySelector('.brand .logo'));
      return setupGoogle();
    }
    if (S.view === 'chars') {
      renderChars();
      return window.Fogo?.focus(document.querySelector('.brand .logo'));
    }
    return renderGame();
  }

  function renderAuth() {
    const m = S.authMode;
    $app.innerHTML = `
      <div class="brand"><img class="logo" src="logo.webp" alt="Destruitor Idle"><p>Caçadas automáticas no navegador — no PC e no celular</p></div>
      <div class="narrow">
        <div class="tabs">
          <button data-auth="entrar" class="${m === 'entrar' ? 'on' : ''}">Entrar</button>
          <button data-auth="criar" class="${m === 'criar' ? 'on' : ''}">Criar conta</button>
        </div>
        <form class="card" id="authForm" autocomplete="on">
          <label class="field" for="email">E-mail</label>
          <input id="email" name="email" type="email" required autocomplete="email">
          <label class="field" for="senha">Senha${m === 'criar' ? ' (mínimo 8 caracteres)' : ''}</label>
          <input id="senha" name="password" type="password" required minlength="${m === 'criar' ? 8 : 1}" autocomplete="${m === 'criar' ? 'new-password' : 'current-password'}">
          ${m === 'criar' ? charFields() : ''}
          <button class="btn primary block" type="submit">${m === 'criar' ? 'Criar conta e personagem' : 'Entrar'}</button>
          <div class="gauth" id="gAuth" hidden>
            <div class="or">ou</div>
            <button type="button" class="gbtn" data-act="google"><svg class="glogo" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg><span>Continuar com o Google</span></button>
          </div>
        </form>
      </div>`;
  }

  // "Entrar com Google": so aparece quando o servidor tem o ID do cliente configurado
  async function setupGoogle() {
    if (DEMO) return;
    try {
      if (S.googleId === undefined) S.googleId = (await api('config')).googleClientId || '';
      if (!S.googleId) return;
      if (!window.google?.accounts?.id) {
        await new Promise((ok, fail) => {
          const sc = document.createElement('script');
          sc.src = 'https://accounts.google.com/gsi/client';
          sc.onload = ok;
          sc.onerror = fail;
          document.head.appendChild(sc);
        });
      }
      if (!document.getElementById('gAuth')) return;
      if (!S.gTok) {
        S.gTok = google.accounts.oauth2.initTokenClient({
          client_id: S.googleId,
          scope: 'openid email profile',
          callback: (r) => (r && r.access_token ? onGoogle({ access_token: r.access_token }) : toast('O Google não confirmou o login.', 'erro')),
          error_callback: (e) => { if (e && e.type !== 'popup_closed') toast('Não deu para abrir o login do Google.', 'erro'); },
        });
      }
      document.getElementById('gAuth').hidden = false;
    } catch {
      // sem Google (bloqueado ou fora do ar): fica so o e-mail
    }
  }
  async function onGoogle(resp) {
    try {
      const r = await api('google', resp);
      S.token = r.token;
      store.set('dt_token', r.token);
      S.chars = r.personagens;
      if (r.nome && !S.chars.length) S.suggestName = r.nome;
      S.view = 'chars';
      render();
      if (r.novo) toast('Conta criada com o Google. Agora crie seu personagem.', 'ok');
    } catch (e) {
      toast(e.message, 'erro');
    }
  }

  function charFields() {
    const n = S.newChar;
    return `
      <label class="field" for="nome">Nome do personagem</label>
      <input id="nome" name="name" type="text" maxlength="20" required placeholder="Ex.: Julio Amancio" value="${esc((S.suggestName || '').replace(/[^A-Za-z ]/g, ''))}">
      <label class="field">Vocação</label>
      <div class="pick">${VOCS.map((v) => `<button type="button" data-voc="${v.id}" class="${n.vocation === v.id ? 'on' : ''}"><b>${v.name}</b><small>${v.desc}</small></button>`).join('')}</div>
      <label class="field">Sexo</label>
      <div class="seg"><button type="button" data-sex="male" class="${n.sex === 'male' ? 'on' : ''}">Masculino</button><button type="button" data-sex="female" class="${n.sex === 'female' ? 'on' : ''}">Feminino</button></div>`;
  }

  function renderChars() {
    $app.innerHTML = `
      <div class="brand"><img class="logo" src="logo.webp" alt="Destruitor Idle"><p>Escolha seu personagem</p></div>
      <div class="narrow">
        <div class="card">
          ${S.chars.length ? S.chars.map((c) => `
            <div class="hunt">
              <div><div class="name">${esc(c.name)}</div><div class="meta">Level ${c.level} · ${esc(c.vocation)}</div></div>
              <button class="btn primary" data-play="${esc(c.name)}">Jogar</button>
            </div>`).join('') : '<p class="muted">Nenhum personagem ainda.</p>'}
        </div>
        ${S.chars.length < 5 ? `
        <form class="card" id="charForm">
          <h2>Novo personagem</h2>
          ${charFields()}
          <button class="btn block" type="submit">Criar personagem</button>
        </form>` : ''}
        <button class="btn block" data-act="logout">Sair da conta</button>
      </div>`;
  }

  // ---- barra de regras ----
  function tabBarra() {
    if (!S.settings || !S.catalog) return '<div class="card muted">Carregando…</div>';
    const s = S.settings;
    const letter = letterOf();
    const level = liveNumbers().level || 1;
    const avail = actionsFor(letter);
    const seg = (key, map) => `<div class="seg">${Object.entries(map).map(([k, v]) => `<button data-set="${key}" data-val="${k}" class="${String(s[key]) === String(k) ? 'on' : ''}">${v}</button>`).join('')}</div>`;
    return `
      <div class="card">
        <h2>Como caçar</h2>
        <label class="field">Tamanho do pull</label>${seg('pull', PULL)}
        <label class="field">Postura</label>${seg('stance', STANCE)}
        <div class="grid2">
          <div><label class="field">Alvo</label><select data-set-select="target">${Object.entries(TARGET).map(([k, v]) => `<option value="${k}" ${s.target === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div><label class="field">Distância dos inimigos</label>${seg('distance', { 1: '1 · perseguir', 2: '2', 3: '3', 4: '4' })}</div>
        </div>
      </div>
      <div class="card">
        <div class="spread"><h2 style="margin:0">Barra de regras <span class="muted small">${s.bar.length}/20</span></h2></div>
        <p class="muted small">De cima para baixo: no mesmo tipo de espera (cura, ataque, suporte, poção), vence o slot mais acima. Todas as condições precisam bater; sem condições, dispara sempre.</p>
        <div class="slots">${s.bar.map((slot, idx) => slotHtml(slot, idx, level)).join('')}</div>
        ${s.bar.length < 20 ? `
        <div class="row" style="margin-top:12px">
          <select id="addAction" class="inline" style="flex:1;min-width:0">
            <option value="">+ Adicionar ação…</option>
            ${['heal', 'potion', 'shield', 'haste', 'area', 'attack'].map((k) => {
              const list = avail.filter((a) => a.kind === k);
              return list.length ? `<optgroup label="${KIND[k]}">${list.map((a) => `<option value="${esc(a.name)}">${esc(a.name)} · lv ${a.lvl}${a.mana ? ' · ' + a.mana + ' mana' : ''}${a.kind === 'potion' ? ' · ' + (a.cost ? a.cost + ' gp' : 'grátis') : ''}</option>`).join('')}</optgroup>` : '';
            }).join('')}
          </select>
          <button class="btn small" data-act="add">Adicionar</button>
        </div>` : ''}
        <div class="row" style="margin-top:12px">
          <button class="btn small" data-act="sort">Ordenar automaticamente</button>
          <button class="btn small" data-act="reset">Restaurar sugestão</button>
        </div>
        <button class="btn primary block" data-act="save" ${S.dirty ? '' : 'disabled'}>${S.dirty ? 'Salvar e usar' : 'Salvo'}</button>
      </div>`;
  }

  function slotHtml(slot, idx, level) {
    const a = actionByName(slot.action);
    const lvlWarn = a && a.lvl > level;
    const editing = S.editing === idx;
    const subjects = allowedSubjects(a);
    return `
      <div class="slot ${slot.enabled ? '' : 'off'}">
        <div class="head">
          <span class="num">${idx + 1}</span>${POTION_ICON[slot.action] ? icon(POTION_ICON[slot.action]) : ''}
          <div class="title"><b>${esc(slot.action)}${lvlWarn ? `<span class="warnlvl" title="Precisa do level ${a.lvl}">!</span>` : ''}</b>
            <small>${a ? `${KIND[a.kind]}${a.words ? ' · ' + esc(a.words) : ''}${a.mana ? ' · ' + a.mana + ' mana' : ''}${a.kind === 'potion' ? ' · ' + (a.cost ? a.cost + ' gp' : 'grátis') : ''}` : ''}</small></div>
          <label class="switch" title="Ligar/desligar"><input type="checkbox" data-toggle="${idx}" ${slot.enabled ? 'checked' : ''}><span></span></label>
        </div>
        ${editing ? `
          ${slot.conds.map((c, ci) => `
            <div class="cond">
              <select data-cond="${idx}.${ci}.subj">${subjects.map((k) => `<option value="${k}" ${c.subj === k ? 'selected' : ''}>${SUBJ[k]}</option>`).join('')}</select>
              <select data-cond="${idx}.${ci}.attr">${(SUBJ_ATTRS[c.subj] || []).map((k) => `<option value="${k}" ${c.attr === k ? 'selected' : ''}>${ATTR[k]}</option>`).join('')}</select>
              <select data-cond="${idx}.${ci}.op">${Object.entries(OPS).map(([k, v]) => `<option value="${k}" ${c.op === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
              <input type="number" min="0" data-cond="${idx}.${ci}.val" value="${c.val}">
              ${c.attr === 'hp' || c.attr === 'mana' ? `<label class="small"><input type="checkbox" data-cond="${idx}.${ci}.pct" ${c.pct ? 'checked' : ''}> %</label>` : '<span></span>'}
              <button class="iconbtn" data-delcond="${idx}.${ci}" title="Tirar condição">✕</button>
            </div>`).join('')}
          <div class="row" style="margin-top:8px">
            ${slot.conds.length < 8 ? `<button class="btn small" data-addcond="${idx}">+ Condição</button>` : ''}
            <button class="btn small" data-edit="-1">Pronto</button>
          </div>` : `
          <div class="chips">${slot.conds.length ? slot.conds.map((c) => `<span class="chip">${condText(c)}</span>`).join('') : '<span class="chip">sempre</span>'}</div>`}
        <div class="row" style="margin-top:8px">
          ${editing ? '' : `<button class="btn small" data-edit="${idx}">Condições</button>`}
          <button class="iconbtn" data-move="${idx}.-1" title="Subir" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button class="iconbtn" data-move="${idx}.1" title="Descer" ${idx === S.settings.bar.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="iconbtn" data-del="${idx}" title="Tirar da barra">🗑</button>
        </div>
      </div>`;
  }


  // ---- loja ----
  const SHOP_KINDS = {
    arma: 'Armas', varinha: 'Varinhas', escudo: 'Escudos', capacete: 'Capacetes', armadura: 'Armaduras',
    calcas: 'Calças', botas: 'Botas', municao: 'Munição',
  };
  const KINDS_BY_VOC = {
    K: ['arma', 'escudo', 'capacete', 'armadura', 'calcas', 'botas'],
    P: ['arma', 'municao', 'escudo', 'capacete', 'armadura', 'calcas', 'botas'],
    S: ['varinha', 'escudo', 'capacete', 'armadura', 'calcas', 'botas'],
    D: ['varinha', 'escudo', 'capacete', 'armadura', 'calcas', 'botas'],
  };

  function itemStat(it) {
    if (it.kind === 'varinha') return `Dano ${it.minDmg}–${it.maxDmg}`;
    if (it.kind === 'arma' && it.ammo) return `Arco/besta (${it.ammo === 'bolt' ? 'bolts' : 'flechas'}) · alcance ${it.range || '-'}`;
    if (it.kind === 'arma') return `Ataque ${it.attack}${it.defense ? ' · Defesa ' + it.defense : ''}${it.extradef ? ' +' + it.extradef : ''}${it.two ? ' · duas mãos' : ''}`;
    if (it.kind === 'municao') return `Ataque ${it.attack} · ${it.ammo === 'bolt' ? 'bolt' : 'flecha'}`;
    if (it.kind === 'escudo') return `Defesa ${it.defense}`;
    return `Armadura ${it.armor}`;
  }
  const mainStat = (it) => (it.kind === 'varinha' ? (it.minDmg + it.maxDmg) / 2 : it.kind === 'arma' || it.kind === 'municao' ? it.attack || 0 : it.kind === 'escudo' ? it.defense || 0 : it.armor || 0);

  // o que o personagem usa hoje em cada categoria
  function currentFor(kind, slots) {
    const hands = [slots.mao1, slots.mao2].filter(Boolean);
    if (kind === 'arma' || kind === 'varinha') return hands.find((x) => (x.attack || 0) > 0 || /wand|rod|bow|crossbow|spear|star|knife/i.test(x.name)) || null;
    if (kind === 'escudo') return hands.find((x) => (x.defense || 0) > 0 && !(x.attack > 0)) || null;
    return slots[kind] || null;
  }

  const icon = (id, cls = 'icon') => (id ? `<img class="${cls}" src="itens/${id}.png" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span class="${cls}"></span>`);
  const VOC_NAME = { K: 'Knight', P: 'Paladin', S: 'Sorcerer', D: 'Druid' };

  function tabLoja() {
    if (!S.catalog) return '<div class="card muted">Carregando…</div>';
    const letter = letterOf();
    const gear = S.live?.gear;
    const slots = gear?.slots || {};
    const bank = liveNumbers().bank || 0;
    const voc = S.shopVoc || letter;
    const kinds = voc === 'all' ? Object.keys(SHOP_KINDS) : KINDS_BY_VOC[voc] || KINDS_BY_VOC.K;
    if (!kinds.includes(S.shopKind)) S.shopKind = kinds[0];
    const gearRows = [
      ['Arma', currentFor(letter === 'S' || letter === 'D' ? 'varinha' : 'arma', slots)],
      ['Escudo', currentFor('escudo', slots)],
      ['Capacete', slots.capacete], ['Armadura', slots.armadura], ['Calças', slots.calcas], ['Botas', slots.botas],
    ];
    if (letter === 'P') gearRows.push(['Munição', slots.municao]);
    const gearStat = (x) => (!x ? '' : x.attack ? `ataque ${x.attack}` : x.armor ? `armadura ${x.armor}` : x.defense ? `defesa ${x.defense}` : '');
    const opt = (v, t, cur) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${t}</option>`;
    return `
      <div class="card">
        <div class="spread"><h2 style="margin:0">Seu equipamento</h2><span class="muted small">Gold ${fmt(bank)}</span></div>
        ${gear ? `<div class="gear">${gearRows.map(([n, x]) => `<div class="gearslot">${icon(x && x.id)}<div><span class="muted small">${n}</span><div>${x ? esc(x.name) + (x.count > 1 ? ' ×' + x.count : '') : '<span class="muted">—</span>'}</div><span class="muted small">${gearStat(x)}</span></div></div>`).join('')}</div>`
          : '<p class="muted">Carregando o equipamento do personagem…</p>'}
        <p class="muted small">Comprar equipa na hora. O item que sai é vendido de volta pelo preço do NPC.${letter === 'P' ? ' Flechas e bolts são repostos sozinhos durante a caçada, pagos em gold.' : ''}</p>
      </div>
      <div class="card">
        <div class="seg" style="flex-wrap:wrap">${kinds.map((k) => `<button data-shopkind="${k}" class="${k === S.shopKind ? 'on' : ''}">${SHOP_KINDS[k]}</button>`).join('')}</div>
        <div class="filters">
          <input id="shopSearch" type="text" placeholder="Buscar item" value="${esc(S.shopSearch || '')}" autocomplete="off">
          <select id="shopVoc">${opt(letter, VOC_NAME[letter] + ' (minha)', voc)}${['K', 'P', 'S', 'D'].filter((v) => v !== letter).map((v) => opt(v, VOC_NAME[v], voc)).join('')}${opt('all', 'Todas', voc)}</select>
          <select id="shopLevel">${opt('meu', 'Até o meu level', S.shopLevel || 'mais50')}${opt('mais50', 'Até +50 levels', S.shopLevel || 'mais50')}${opt('todos', 'Todos os levels', S.shopLevel || 'mais50')}</select>
          <select id="shopSort">${opt('level', 'Por level', S.shopSort || 'level')}${opt('preco', 'Por preço', S.shopSort || 'level')}${opt('forca', 'Por força', S.shopSort || 'level')}</select>
        </div>
        <div class="hunts" id="shopList">${shopListHtml()}</div>
      </div>`;
  }

  function shopListHtml() {
    const letter = letterOf();
    const level = liveNumbers().level || 1;
    const slots = S.live?.gear?.slots || {};
    const bank = liveNumbers().bank || 0;
    const voc = S.shopVoc || letter;
    const kind = S.shopKind;
    const shopById = Object.fromEntries((S.catalog.shop || []).map((x) => [x.id, x]));
    const cur = currentFor(kind, slots);
    const curShop = cur && shopById[cur.id];
    const curStat = curShop ? mainStat(curShop) : cur ? (kind === 'escudo' ? cur.defense : kind === 'arma' ? cur.attack : cur.armor) || 0 : 0;
    const maxLevel = S.shopLevel === 'meu' ? level : S.shopLevel === 'todos' ? 99999 : level + 50;
    const q = (S.shopSearch || '').trim().toLowerCase();
    const sorters = {
      level: (a, b) => a.level - b.level || mainStat(a) - mainStat(b),
      preco: (a, b) => a.price - b.price || a.level - b.level,
      forca: (a, b) => mainStat(b) - mainStat(a) || a.level - b.level,
    };
    const list = (S.catalog.shop || [])
      .filter((x) => x.kind === kind && (voc === 'all' || x.voc.includes(voc)) && x.level <= maxLevel && (!q || x.name.toLowerCase().includes(q)))
      .sort(sorters[S.shopSort || 'level']);
    if (!list.length) return '<p class="muted">Nenhum item com esses filtros.</p>';
    return list.map((it) => {
      const lowLevel = it.level > level;
      const otherVoc = !it.voc.includes(letter);
      const unit = it.kind === 'municao' || it.stack;
      const cost = it.price * (unit ? 100 : 1);
      const poor = cost > bank;
      const same = cur && cur.id === it.id;
      const diff = Math.round(mainStat(it) - curStat);
      const better = !same && !otherVoc && diff > 0;
      const vocs = it.voc.length === 4 ? 'todas' : it.voc.split('').map((v) => VOC_NAME[v]).join(', ');
      return `<div class="hunt shopitem ${better && !lowLevel ? 'rec' : ''}">
        ${icon(it.id, 'icon big')}
        <div><div class="name">${esc(it.name)} ${same ? '<span class="badge live">em uso</span>' : better ? `<span class="badge warn">+${diff}</span>` : ''}</div>
        <div class="meta">${itemStat(it)}</div>
        <div class="meta">Level <b style="color:${lowLevel ? 'var(--bad)' : 'inherit'}">${it.level}</b> · <b style="color:${poor ? 'var(--bad)' : 'inherit'}">${fmt(cost)} gp</b>${unit ? ` (100 × ${fmt(it.price)})` : ''}${voc === 'all' || otherVoc ? ` · <span style="color:${otherVoc ? 'var(--bad)' : 'inherit'}">${vocs}</span>` : ''}</div></div>
        <button class="btn ${better && !lowLevel && !poor ? 'primary' : ''}" data-buy="${it.id}" ${lowLevel || poor || same || otherVoc ? 'disabled' : ''}>Comprar</button>
      </div>`;
    }).join('');
  }

  const POTION_ICON = {"Lesser Health Potion": 266, "Health Potion": 266, "Strong Health Potion": 236, "Great Health Potion": 239, "Ultimate Health Potion": 7643, "Mana Potion": 268, "Strong Mana Potion": 237, "Great Mana Potion": 238, "Great Spirit Potion": 7642, "Ultimate Mana Potion": 23373};

  // ---- analisador ----
  function tabAnalisador() {
    const i = S.live?.idle;
    if (!i || (!i.hunting && !i.elapsed)) return '<div class="card muted">Comece uma caçada para ver os números.</div>';
    const n = liveNumbers();
    const need = expFor(n.level + 1) - n.exp;
    const eta = i.hunting && i.xpHour > 0 ? dur((need / i.xpHour) * 3600) : '—';
    const kills = Object.entries(i.kills || {}).sort((a, b) => b[1] - a[1]);
    return `
      <div class="card">
        <h2>${i.hunting ? 'Sessão atual' : 'Última sessão'} ${i.huntName ? '· ' + esc(i.huntName) : ''}</h2>
        <div class="kpis">
          <div class="kpi"><span>Tempo</span><b>${dur(i.elapsed)}</b></div>
          <div class="kpi"><span>XP total</span><b>${kfmt(i.xp)}</b></div>
          <div class="kpi"><span>XP/h</span><b>${kfmt(i.xpHour || 0)}</b></div>
          <div class="kpi"><span>Próximo level</span><b>${eta}</b></div>
          <div class="kpi"><span>Loot</span><b>${kfmt(i.loot)}</b></div>
          <div class="kpi"><span>Gastos</span><b>${kfmt(i.supplies)}</b></div>
          <div class="kpi"><span>Lucro</span><b class="${(i.profit || 0) >= 0 ? 'pos' : 'neg'}">${kfmt(i.profit)}</b></div>
          <div class="kpi"><span>Lucro/h</span><b class="${(i.profitHour || 0) >= 0 ? 'pos' : 'neg'}">${kfmt(i.profitHour || 0)}</b></div>
        </div>
      </div>
      <div class="card">
        <h2>Abates <span class="muted small">${fmt(i.killCount)}</span></h2>
        ${kills.length ? `<table class="simple">${kills.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${fmt(v)}</td></tr>`).join('')}</table>` : '<p class="muted">Nenhum ainda.</p>'}
      </div>`;
  }

  // ---- personagem ----
  // ---- janela do personagem (como no Huntera): Personagem, Outfit e Mortes ----
  const PARTS = [['h', 'Cabeça'], ['b', 'Corpo'], ['l', 'Pernas'], ['f', 'Pés']];
  const SKILL_ROWS = [['fist', 'Fist Fighting', 3392], ['club', 'Club Fighting', 3270], ['sword', 'Sword Fighting', 3264], ['axe', 'Axe Fighting', 3274], ['distance', 'Distance Fighting', 3350], ['shielding', 'Shielding', 3409]];
  function lookCats() {
    if (!S.lookCat && !S.lookCatLoading) {
      S.lookCatLoading = true;
      Promise.all([fetch('criaturas/outfits.json').then((r) => r.json()), fetch('criaturas/mounts.json').then((r) => r.json())])
        .then(([outfits, mounts]) => { S.lookCat = { outfits, mounts }; if (S.modal?.k === 'personagem') renderModal(); })
        .catch(() => (S.lookCatLoading = false));
    }
    return S.lookCat;
  }
  const fmtGp = (n) => fmt(n) + ' gp';
  // mesmos precos do servidor (idle.lua I.LOOK_PRICE): so para mostrar; quem cobra e o servidor
  function lookPrice(kind, it, addon) {
    if (kind === 'outfit') return it.free ? 0 : it.from === 'quest' ? 100000 : 250000;
    if (kind === 'addon') return (it.free ? [20000, 40000] : [50000, 100000])[addon - 1];
    return { Donkey: 25000, 'War Horse': 60000 }[it.name] || (it.from === 'quest' ? 100000 : it.from === 'arena' ? 150000 : 250000);
  }
  function lookEd() {
    const m = S.modal;
    if (!m.ed) {
      const ch = S.live?.char;
      const l = ch?.look || S.live?.player?.look || { t: 128 };
      const mount = ch && l.m ? ((lookCats()?.mounts || []).find((x) => x.t === l.m) || {}).id || 0 : 0;
      m.ed = { t: l.t, h: l.h || 0, b: l.b || 0, l: l.l || 0, f: l.f || 0, a: l.a || 0, mount, part: 'h', sub: 'outfits', only: false, dir: 2 };
    }
    return m.ed;
  }
  function edLook(ed) {
    const mt = ed.mount && (lookCats()?.mounts || []).find((x) => x.id === ed.mount);
    return { t: ed.t, h: ed.h, b: ed.b, l: ed.l, f: ed.f, a: ed.a, m: mt ? mt.t : 0 };
  }

  function tabPersonagem() {
    const tab = S.modal.tab || 'ficha';
    const tabs = [['ficha', 'Personagem'], ['outfit', 'Outfit'], ['mortes', 'Mortes']];
    return `<div class="ptabs">${tabs.map(([k, n]) => `<button data-ptab="${k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>
      ${tab === 'outfit' ? outfitTab() : tab === 'mortes' ? mortesTab() : fichaTab()}`;
  }

  function fichaTab() {
    const p = S.live?.player;
    if (!p) return '<div class="card muted">Carregando…</div>';
    const n = liveNumbers();
    const ch = S.live?.char || {};
    const lvA = expFor(n.level || 1), lvB = expFor((n.level || 1) + 1);
    const xpPct = pct((n.exp || 0) - lvA, lvB - lvA);
    const sk = ch.skills || {};
    const bar = (v, max, cls) => `<div class="fbar ${cls}"><i style="width:${pct(v, max)}%"></i></div>`;
    const prog = (pc) => `<div class="sprog">${Array.from({ length: 10 }, (_, i) => `<i class="${i < Math.floor((pc || 0) / 10) ? 'on' : ''}"></i>`).join('')}</div>`;
    const row = ([k, name, ic]) => {
      const v = sk[k] || [p.skills?.[k] ?? 10, 0];
      return `<tr><td>${icon(ic, 'ti-xs')} ${name}</td><td>${v[0]}</td><td>${prog(v[1])}</td><td>${v[1] || 0}%</td></tr>`;
    };
    const ml = ch.magic || [p.magic, 0];
    return `<div class="ficha">
      <div class="f-top card">
        <canvas class="f-pic" width="128" height="128" data-look="${lookAttr(ch.look || p.look)}"></canvas>
        <div class="f-main">
          <h2>${esc(p.name)}</h2>
          <div class="f-sub">Level ${n.level} — ${esc(p.vocation)}</div>
          <div class="f-row"><span>Pontos de vida</span>${bar(n.hp, n.maxHp, 'hp')}<b>${fmt(n.hp)} / ${fmt(n.maxHp)}</b></div>
          <div class="f-row"><span>Mana</span>${bar(n.mana, n.maxMana, 'mana')}<b>${fmt(n.mana)} / ${fmt(n.maxMana)}</b></div>
          <div class="f-row"><span>Experiência</span>${bar(xpPct, 100, 'xp')}<b>${xpPct.toFixed(0)}%</b></div>
        </div>
        <div class="f-side">
          <div class="kv"><span>Velocidade</span><b>${ch.speed ?? '—'}</b></div>
          <div class="kv"><span>Capacidade</span><b>${ch.cap != null ? fmt(ch.freeCap) + ' / ' + fmt(ch.cap) + ' oz' : '—'}</b></div>
          <div class="kv"><span>Magic Level</span><b>${ml[0]}</b></div>
          <div class="kv"><span>Regeneração</span><b>Só em caçadas</b></div>
          <div class="kv"><span>Stamina</span><b>${hm(n.stamina || 0)}</b></div>
        </div>
      </div>
      <div class="f-cols">
        <div class="card"><h3>Skills de combate</h3>
          <table class="skills"><tr><th>Skill</th><th>Level</th><th>Progresso</th><th></th></tr>
          ${SKILL_ROWS.map(row).join('')}
          <tr><td>${icon(3059, 'ti-xs')} Magic Level</td><td>${ml[0]}</td><td>${prog(ml[1])}</td><td>${ml[1] || 0}%</td></tr></table>
        </div>
        <div class="card"><h3>Progressão</h3>
          <div class="kv"><span>Próximo level</span><b>faltam ${fmt(Math.max(0, lvB - (n.exp || 0)))} de experiência</b></div>
          ${bar(xpPct, 100, 'xp')}
          <div class="kv" style="margin-top:10px"><span>Gold no banco</span><b>${fmt(n.bank)}</b></div>
          <div class="kv"><span>Conta</span><b>${ch.premium || S.live?.premium ? 'Premium' : 'Free'}</b></div>
        </div>
      </div>
      <div class="row">
        <button class="btn" data-act="chars">Trocar de personagem</button>
        <button class="btn" data-act="logout">Sair da conta</button>
      </div>
    </div>`;
  }

  function outfitTab() {
    const cat = lookCats();
    const ch = S.live?.char;
    if (!cat || !ch) {
      if (!ch && !S.charAsked) { S.charAsked = true; sendWs({ t: 'char' }); }
      return '<div class="card muted">Carregando as roupas…</div>';
    }
    const ed = lookEd();
    const owned = ch.owned || {};
    const myMounts = new Set(ch.mounts || []);
    const premium = !!(ch.premium || S.live?.premium);
    const outfits = cat.outfits.filter((o) => o.sex === ch.sex);
    const cur = outfits.find((o) => o.t === ed.t) || outfits[0];
    const has = owned[ed.t] != null;
    const hasAddon = (k) => has && (owned[ed.t] & k);
    const look = edLook(ed);
    const card = (o) => {
      const own = owned[o.t] != null;
      const tag = own ? '' : o.premium && o.free ? 'Premium' : o.free ? '' : fmtGp(lookPrice('outfit', o));
      return `<button class="ocard ${o.t === ed.t ? 'on' : ''} ${own ? '' : 'lock'}" data-ocard="${o.t}">
        <canvas width="72" height="72" data-look="${lookAttr({ t: o.t, h: ed.h, b: ed.b, l: ed.l, f: ed.f })}"></canvas>
        <b>${esc(o.name)}</b>${tag ? `<em>${tag}</em>` : ''}</button>`;
    };
    const mcard = (mt) => {
      const own = mt.id === 0 || myMounts.has(mt.id);
      return `<button class="ocard ${ed.mount === mt.id ? 'on' : ''} ${own ? '' : 'lock'}" data-omount="${mt.id}">
        ${mt.id ? `<canvas width="72" height="72" data-look="${lookAttr({ t: mt.t })}"></canvas>` : '<span class="apé">A pé</span>'}
        <b>${esc(mt.name)}</b>${own || !mt.id ? '' : `<em>${fmtGp(lookPrice('mount', mt))}</em>`}</button>`;
    };
    const list = ed.sub === 'mounts'
      ? [{ id: 0, name: 'A pé' }, ...cat.mounts.filter((mt) => !ed.only || myMounts.has(mt.id))].map(mcard).join('')
      : outfits.filter((o) => !ed.only || owned[o.t] != null).map(card).join('');
    // o que falta comprar para vestir o que esta escolhido
    const buys = [];
    if (cur && !has) {
      if (cur.free && cur.premium && !premium) buys.push(`<span class="muted small">${esc(cur.name)} é só para conta Premium.</span>`);
      else if (!cur.free) buys.push(`<button class="btn small" data-obuy="outfit,${cur.t},0">Comprar ${esc(cur.name)} · ${fmtGp(lookPrice('outfit', cur))}</button>`);
    }
    for (const k of [1, 2]) if (cur && (ed.a & k) && !hasAddon(k)) buys.push(`<button class="btn small" data-obuy="addon,${cur.t},${k}">Comprar addon ${k} · ${fmtGp(lookPrice('addon', cur, k))}</button>`);
    const mt = ed.mount && cat.mounts.find((x) => x.id === ed.mount);
    if (mt && !myMounts.has(mt.id)) buys.push(`<button class="btn small" data-obuy="mount,${mt.id},0">Comprar ${esc(mt.name)} · ${fmtGp(lookPrice('mount', mt))}</button>`);
    const canSave = has && !buys.length;
    const palette = Array.from({ length: 133 }, (_, i) => {
      const c = window.GameView ? window.GameView.outfitColor(i) : [0, 0, 0];
      return `<button class="pal ${ed[ed.part] === i ? 'on' : ''}" data-ocolor="${i}" style="background:rgb(${c.join(',')})" title="${i}"></button>`;
    }).join('');
    return `<div class="outfit">
      <div class="o-left">
        <label class="ochk ${has && cur ? '' : 'off'}"><input type="checkbox" data-oaddon="1" ${ed.a & 1 ? 'checked' : ''}> Addon 1${hasAddon(1) ? '' : ' <em>' + (cur ? fmtGp(lookPrice('addon', cur, 1)) : '') + '</em>'}</label>
        <label class="ochk ${has && cur ? '' : 'off'}"><input type="checkbox" data-oaddon="2" ${ed.a & 2 ? 'checked' : ''}> Addon 2${hasAddon(2) ? '' : ' <em>' + (cur ? fmtGp(lookPrice('addon', cur, 2)) : '') + '</em>'}</label>
        <label class="ochk"><input type="checkbox" data-omounted="1" ${ed.mount ? 'checked' : ''}> Montaria</label>
        <div class="o-prev"><canvas id="oPrev" width="192" height="192"></canvas><button class="o-rot" data-orot="1" title="Girar">⟳</button></div>
        <div class="o-parts">${PARTS.map(([k, n]) => `<button data-opart="${k}" class="${ed.part === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        <div class="o-pal">${palette}</div>
      </div>
      <div class="o-right">
        <div class="o-sub"><button data-osub="outfits" class="${ed.sub !== 'mounts' ? 'on' : ''}">Outfits</button><button data-osub="mounts" class="${ed.sub === 'mounts' ? 'on' : ''}">Montarias</button></div>
        <label class="ochk"><input type="checkbox" data-oonly="1" ${ed.only ? 'checked' : ''}> Mostrar só os adquiridos</label>
        ${ed.sub === 'mounts' ? '<p class="muted small">Montar dá +10 de velocidade. Todas as montarias dão o mesmo bônus — qual delas você monta é só aparência.</p>' : ''}
        <div class="o-grid">${list}</div>
      </div>
      <div class="o-foot">${buys.join('')}<span class="grow"></span><button class="btn primary" data-osave="1" ${canSave ? '' : 'disabled'}>Salvar</button></div>
    </div>`;
  }

  function mortesTab() {
    if (!S.deaths && !S.deathsAsked) { S.deathsAsked = true; sendWs({ t: 'mortes' }); }
    const list = S.deaths || [];
    const ago = (t) => { const d = Date.now() / 1000 - t; return d < 3600 ? Math.max(1, Math.round(d / 60)) + ' min atrás' : d < 86400 ? Math.round(d / 3600) + 'h atrás' : Math.round(d / 86400) + ' dias atrás'; };
    return `<div class="mortes">
      <div class="spread"><p class="muted small">Suas últimas 20 mortes, da mais nova para a mais velha. O último minuto fica guardado só para a mais recente.</p>
        ${S.rec && S.rec.length > 3 ? '<button class="btn small" data-act="replay">Ver o último minuto</button>' : ''}</div>
      ${list.length ? `<table class="simple"><tr><th>Quando</th><th>Morto por</th><th>Level</th></tr>
        ${list.map((d) => `<tr><td>${ago(d.at)}</td><td>${esc(d.by)}${d.player ? ' <em class="pk">(jogador)</em>' : ''}</td><td>${d.level}</td></tr>`).join('')}</table>`
        : '<p class="muted">Nenhuma morte ainda. Continue assim!</p>'}
    </div>`;
  }

  // --------------------------------------------------------------------------
  // tela do jogo (como no Huntera): o mapa ocupa a tela toda; barra de cima,
  // barra de baixo (vida, mana, barra de acoes, alvo, postura, distancia),
  // janelas flutuantes que se fecham/minimizam/arrastam e janelas grandes (modais)
  // --------------------------------------------------------------------------
  const MOBILE = () => window.innerWidth < 760;
  const WINS = {
    inv: { title: 'Inventário', x: -300, y: 64, w: 280 },
    anal: { title: 'Analisador de caçada', x: -592, y: 64, w: 280 },
    loot: { title: 'Loot da sessão', x: 12, y: 64, w: 260 },
    log: { title: 'Registro', x: -312, y: -420, w: 300 },
    chat: { title: 'Chat', x: 12, y: -420, w: 380 },
  };
  function loadWins() {
    let saved = {};
    try { saved = JSON.parse(store.get('dt_wins') || '{}'); } catch { saved = {}; }
    const out = {};
    for (const [k, d] of Object.entries(WINS)) out[k] = { open: k !== 'log' || !MOBILE(), min: false, x: d.x, y: d.y, ...(saved[k] || {}) };
    if (MOBILE()) for (const k of Object.keys(out)) out[k].open = false; // no celular abre uma de cada vez
    return out;
  }
  const saveWins = () => store.set('dt_wins', JSON.stringify(S.wins));

  function liveNumbers() {
    const p = S.live?.player || {};
    const i = S.live?.idle;
    const on = i && i.hunting;
    return {
      name: p.name || S.char,
      vocation: p.vocation || '',
      level: on ? i.level : p.level,
      exp: on ? i.exp : p.exp,
      hp: on ? i.hp : p.hp,
      maxHp: on ? i.maxHp : p.maxHp,
      mana: on ? i.mana : p.mana,
      maxMana: on ? i.maxMana : p.maxMana,
      stamina: on ? i.stamina : p.stamina,
      bank: on ? i.bank : p.bank,
    };
  }

  // icones = itens do proprio Tibia (royal helmet, fire sword, spellbook, crystal coin, backpack...)
  const ICONS = [
    ['personagem', 3392, 'Personagem'],
    ['cacar', 3280, 'Caçar'],
    ['barra', 3059, 'Ações'],
    ['loja', 3043, 'Loja'],
    ['w:inv', 2854, 'Inventário'],
    ['w:loot', 2871, 'Loot da sessão'],
    ['w:anal', 2906, 'Analisador'],
    ['w:log', 2821, 'Registro'],
    ['w:chat', 2814, 'Chat'],
  ];

  function renderGame() {
    if (!S.wins) S.wins = loadWins();
    $app.className = 'app game-on';
    $app.innerHTML = `
      <div class="g">
        <div id="gvWrap" class="g-world"></div>
        <header class="g-top">
          <img class="g-logo" src="logo.webp" alt="Destruitor Idle">
          <div class="g-who" id="gWho"></div>
          <div class="g-pill" title="Gold no banco">${icon(3031, 'ti-s')}<b id="gGold">—</b></div>
          <button class="g-shop" data-modal="loja">Loja</button>
          <div class="g-pill g-online" title="Jogando agora"><i></i><b id="gOnline">—</b><span class="hide-m">jogando</span></div>
          <nav class="g-icons">${ICONS.map(([k, ic, t]) => `<button data-${k.startsWith('w:') ? 'win' : 'modal'}="${k.replace('w:', '')}" title="${t}" aria-label="${t}">${icon(ic, 'ti')}</button>`).join('')}
            <button data-act="chars" title="Trocar de personagem" aria-label="Trocar de personagem">${icon(2972, 'ti')}</button></nav>
        </header>
        <div id="gBanner" class="g-banner" hidden></div>
        <div id="gMsg" class="g-msg" hidden></div>
        <div id="gWins"></div>
        <footer class="g-bottom">
          <div class="g-ctx" id="gCtx"></div>
          <div class="g-dock">
            <div class="g-vitals" id="gVitals"></div>
            <div class="g-actions" id="gActions"></div>
            <div class="g-ctrl" id="gCtrl"></div>
          </div>
        </footer>
        <div id="gModal"></div>
      </div>`;
    S.gv = window.GameView ? window.GameView.create(document.getElementById('gvWrap'), () => S.char) : null;
    S.phase = null;
    renderWins();
    refresh(true);
    renderModal();
  }

  // partes que mudam a cada estado (so troca o que mudou)
  // compara com o ultimo HTML escrito (o innerHTML que o navegador devolve nunca e igual ao texto,
  // e trocar a cada 0,4 s recriava as imagens e elas piscavam)
  const setHtml = (id, html) => {
    const el = document.getElementById(id);
    if (el && el._html !== html) {
      el._html = html;
      el.innerHTML = html;
    }
  };

  function refresh(force) {
    if (S.view !== 'game') return;
    const n = liveNumbers();
    const i = S.live?.idle;
    const hunting = !!(i && i.hunting);
    const lvA = expFor(n.level || 1), lvB = expFor((n.level || 1) + 1);
    const xpPct = pct((n.exp || 0) - lvA, lvB - lvA);
    setHtml('gWho', S.live ? `<b>${esc(n.name)}</b><small>${esc(n.vocation)} · Lv ${n.level}</small>` : `<b>${esc(S.char)}</b><small>conectando…</small>`);
    setHtml('gGold', S.live ? fmt(n.bank) : '—');
    setHtml('gOnline', S.live?.players != null ? fmt(S.live.players) : '—');
    setHtml('gVitals', S.live ? `
      <div class="v hp"><i style="width:${pct(n.hp, n.maxHp)}%"></i><span>${fmt(n.hp)} / ${fmt(n.maxHp)}</span></div>
      <div class="v mana"><i style="width:${pct(n.mana, n.maxMana)}%"></i><span>${fmt(n.mana)} / ${fmt(n.maxMana)}</span></div>
      <div class="v-row"><span class="lv">Lv ${n.level}</span><div class="v xp" title="${xpPct.toFixed(1).replace('.', ',')}% para o level ${n.level + 1}"><i style="width:${xpPct}%"></i></div><span class="small">${xpPct.toFixed(1).replace('.', ',')}%</span><span class="stam" title="Stamina">${icon(17722, 'ti-xs')}${hm(n.stamina || 0)}</span></div>` : '');
    setHtml('gActions', actionBarHtml());
    setHtml('gCtrl', ctrlHtml());
    setHtml('gCtx', ctxHtml(hunting));
    for (const k of Object.keys(WINS)) if (k !== 'chat' && S.wins[k]?.open && !S.wins[k].min) setHtml('wb-' + k, winBody(k));
    if (S.modal && (S.modal.k === 'detalhes' || (S.modal.k === 'loja' && S.gearDirty) || S.bagDirty || S.charDirty || (S.modal.k === 'despachar' && dispatchLeft() > 0))) {
      S.gearDirty = false;
      S.bagDirty = false;
      S.charDirty = false;
      renderModal();
    }
  }

  // ---- barra de baixo ----
  function actionBarHtml() {
    const bar = S.settings?.bar || [];
    let out = '';
    for (let k = 0; k < 20; k++) {
      const slot = bar[k];
      if (!slot) { out += `<button class="as empty" data-slot="${k}" title="Configurar ação">+</button>`; continue; }
      const a = actionByName(slot.action);
      const label = actionImg(slot.action, 'as-ic') || `<span class="as-t k-${a ? a.kind : 'x'}">${esc(shortName(slot.action))}</span>`;
      const cost = a && a.kind === 'potion' ? (a.cost ? a.cost + ' gp' : 'Grátis') : '';
      const tip = `${slot.action}${cost ? ' · ' + cost : ''}\n${slot.conds.length ? slot.conds.map(condText).join(' e ') : 'sempre'}${slot.enabled ? '' : '\n(desligada)'}`;
      const wontFire = a && a.lvl > (liveNumbers().level || 1);
      out += `<button class="as ${slot.enabled ? '' : 'off'}" data-slot="${k}" title="${esc(tip)}${wontFire ? '\nAinda não dispara: precisa do level ' + a.lvl : ''}">${label}${cost === 'Grátis' ? '<em>Grátis</em>' : ''}${wontFire ? '<b class="as-warn">!</b>' : ''}</button>`;
    }
    return out;
  }
  const shortName = (n) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  const SPELL_ICON = {
    'Magic Shield': 3051, 'Light Healing': 3052, 'Wound Cleansing': 3052, 'Intense Healing': 3152, 'Ultimate Healing': 3160,
    'Divine Healing': 3098, Salvation: 3160, Haste: 3079, 'Strong Haste': 3079,
    'Energy Strike': 3198, 'Flame Strike': 3189, 'Ice Strike': 3158, 'Terra Strike': 3175, 'Death Strike': 3155, 'Physical Strike': 3200,
    Lightning: 3149, 'Strong Flame Strike': 3191, 'Strong Terra Strike': 3175, 'Strong Energy Strike': 3149, 'Strong Ice Strike': 3161,
    'Ultimate Flame Strike': 3192, 'Ultimate Terra Strike': 3175, 'Ultimate Energy Strike': 3202, 'Ultimate Ice Strike': 3161,
    'Fire Wave': 3191, 'Ice Wave': 3161, 'Energy Beam': 3164, 'Great Energy Beam': 3149, 'Energy Wave': 3202, 'Terra Wave': 3175,
    'Strong Ice Wave': 3161, 'Rage of the Skies': 3202, 'Wrath of Nature': 3175, "Hell's Core": 3192, 'Eternal Winter': 3161,
    'Ethereal Spear': 7367, 'Strong Ethereal Spear': 7378, 'Divine Missile': 3182, 'Divine Caldera': 3182,
    'Brutal Strike': 3278, 'Whirlwind Throw': 7368, Groundshaker: 3279, Berserk: 3342, 'Fierce Berserk': 3319,
  };
  const actionIcon = (name) => POTION_ICON[name] || SPELL_ICON[name] || 0;
  // icone oficial da magia (magias/index.json, gerado por tools/magias.py); sem ele, o item/runa
  const normName = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const spellIcon = (name) => (S.spellIcons && S.spellIcons[normName(name)]) || null;
  const actionImg = (name, cls) => {
    const f = spellIcon(name);
    if (f && !POTION_ICON[name]) return `<img class="${cls} sp" src="magias/${f}" alt="">`;
    return actionIcon(name) ? icon(actionIcon(name), cls + ' it') : '';
  };

  function ctrlHtml() {
    const s = S.settings;
    if (!s) return '';
    return `
      <label class="c-row"><span>Alvo</span><select data-quick="target">${Object.entries(TARGET).map(([k, v]) => `<option value="${k}" ${s.target === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <div class="c-row"><span>Postura</span><div class="c-st">${Object.entries({ ataque: 3281, equilibrado: 3409, defesa: 3422 }).map(([k, ic]) => `<button data-quick-set="stance" data-val="${k}" class="${s.stance === k ? 'on' : ''}" title="${STANCE[k]}">${icon(ic, 'ti-xs')}</button>`).join('')}</div>
        <div class="c-dist" title="Distância dos inimigos"><button data-dist="-1">−</button><b>${s.distance}</b><button data-dist="1">+</button></div></div>`;
  }

  function ctxHtml(hunting) {
    if (S.replay) return '';
    if (hunting || S.phase === 'leaving') {
      const left = S.phase === 'leaving' ? Math.max(0, Math.ceil((S.leaveAt - Date.now()) / 1000)) : 0;
      const ready = dispatchLeft();
      return `<button class="cb" data-modal="detalhes">Detalhes da caçada</button>
        <button class="cb" data-modal="despachar">${ready > 0 ? 'Pronto em ' + mmss(ready) : 'Despachar loot'}</button>
        <button class="cb danger ${S.phase === 'leaving' ? 'on' : ''}" data-act="leave">${S.phase === 'leaving' ? `Saindo em ${left}s… (cancelar)` : '↩ Sair da caçada'}</button>`;
    }
    if (S.phase === 'walking' || S.phase === 'entering') return '';
    return `<button class="cb gold" data-modal="cacar">${icon(3280, 'ti-xs')} Caçar</button>
      <button class="cb" data-modal="venda">Venda rápida${bagItems().length ? ` <em class="cbn">${bagItems().length}</em>` : ''}</button>
      <button class="cb" data-modal="barra">Ações</button>
      <button class="cb" data-modal="loja">Equipamentos</button>
      <button class="cb" data-modal="personagem">Personagem</button>`;
  }

  // ---- janelas flutuantes ----
  function renderWins() {
    const $w = document.getElementById('gWins');
    if (!$w) return;
    $w.innerHTML = Object.entries(WINS).filter(([k]) => S.wins[k].open).map(([k, d]) => {
      const st = S.wins[k];
      const pos = MOBILE() ? '' : `left:${st.x < 0 ? `calc(100% + ${st.x}px)` : st.x + 'px'};top:${st.y < 0 ? `calc(100% + ${st.y}px)` : st.y + 'px'};width:${d.w}px`;
      return `<section class="win ${st.min ? 'min' : ''}" data-win-id="${k}" style="${pos}">
        <header class="win-h" data-drag="${k}"><b>${d.title}</b><span>
          <button data-wmin="${k}" title="${st.min ? 'Abrir' : 'Minimizar'}">${st.min ? '▢' : '–'}</button>
          <button data-wclose="${k}" title="Fechar">✕</button></span></header>
        <div class="win-b" id="wb-${k}" data-wbody="${k}" style="${MOBILE() ? '' : st.h ? `height:${st.h}px` : k === 'chat' ? 'height:170px' : k === 'log' || k === 'loot' ? 'height:200px' : ''}">${st.min ? '' : winBody(k)}</div>
      </section>`;
    }).join('');
    // a janela pode ser esticada para baixo (canto de baixo); o tamanho fica salvo
    if (window.ResizeObserver && !MOBILE()) {
      if (S.winRO) S.winRO.disconnect();
      S.winRO = new ResizeObserver((list) => {
        for (const e of list) {
          const k = e.target.dataset.wbody;
          const h = Math.round(e.target.getBoundingClientRect().height);
          if (k && S.wins[k] && !S.wins[k].min && h > 40 && Math.abs((S.wins[k].h || 0) - h) > 4 && e.target.style.height) {
            S.wins[k].h = h;
            clearTimeout(S.winSave);
            S.winSave = setTimeout(saveWins, 400);
          }
        }
      });
      $w.querySelectorAll('[data-wbody]').forEach((el) => S.winRO.observe(el));
    }
    S.chat.jump = true;
    renderChatList();
  }

  function winBody(k) {
    const i = S.live?.idle;
    const n = liveNumbers();
    if (k === 'inv') {
      const sl = S.live?.gear?.slots || {};
      const cell = (x, label) => `<div class="eq" title="${x ? esc(x.name) : label}">${x ? icon(x.id, 'eq-ic') : `<span class="eq-l">${label}</span>`}${x && x.count > 1 ? `<em>${x.count}</em>` : ''}</div>`;
      return `<div class="eqgrid">
          ${cell(null, 'amuleto')}${cell(sl.capacete, 'elmo')}${cell(null, 'mochila')}
          ${cell(sl.mao1, 'arma')}${cell(sl.armadura, 'armadura')}${cell(sl.mao2, 'escudo')}
          ${cell(null, 'anel')}${cell(sl.calcas, 'calças')}${cell(sl.municao, 'munição')}
          <span></span>${cell(sl.botas, 'botas')}<span></span>
        </div>
        <div class="spread small"><span class="muted">Gold</span><b>${fmt(n.bank)}</b></div>
        ${bagHtml()}
        <button class="btn small block" data-modal="loja">Trocar equipamento</button>`;
    }
    if (k === 'loot') {
      const list = (i && i.lastLoot) || [];
      return list.length ? `<div class="lootlist">${list.map((l) => `<div>${esc(l)}</div>`).join('')}</div><div class="spread small"><span class="muted">Loot da sessão</span><b>${fmt(i.loot)} gp</b></div>` : '<p class="muted small">Nada aqui ainda — vá caçar!</p>';
    }
    if (k === 'anal') {
      const has = !!(i && (i.hunting || i.elapsed));
      const premium = !!S.live?.premium;
      const need = expFor(n.level + 1) - n.exp;
      const eta = has && i.hunting && i.xpHour > 0 ? dur((need / i.xpHour) * 3600) : '—';
      const kv = (a, b, cls = '') => `<div class="kv"><span>${a}</span><b class="${cls}">${b}</b></div>`;
      const pv = (fn, cls = '') => (premium && has ? [fn(), cls] : ['—', 'lock']);
      const rows = [
        ['XP total', () => kfmt(i.xp)], ['XP/h', () => kfmt(i.xpHour || 0)], ['Loot', () => kfmt(i.loot)], ['Gastos', () => kfmt(i.supplies)],
        ['Lucro', () => kfmt(i.profit), has && (i.profit || 0) >= 0 ? 'pos' : 'neg'], ['Lucro/h', () => kfmt(i.profitHour || 0), has && (i.profitHour || 0) >= 0 ? 'pos' : 'neg'],
        ['Abates', () => fmt(i.killCount)],
      ];
      return `<div class="kvs">${kv('Sessão atual', has ? dur(i.elapsed) : '—')}${kv('Próximo level', eta)}${rows.map(([a, fn, cls]) => { const [v, c] = pv(fn, cls || ''); return kv(a, v, c); }).join('')}</div>
        ${premium ? '' : `<p class="muted small center" style="margin-top:8px">Acompanhe XP, lucro e o desempenho da caçada.</p><button class="btn small block prem" data-act="premium">Assinar Premium</button>`}`;
    }
    if (k === 'chat') return chatBody();
    if (k === 'log') {
      const list = ((i && i.log) || []).slice().reverse();
      return list.length ? `<div class="loglist">${list.map((l) => `<div>${esc(l)}</div>`).join('')}</div>` : '<p class="muted small">Sem registros ainda.</p>';
    }
    return '';
  }

  // ---- chat: Global e Comercio (todo o servidor), Local (quem esta perto) e Sistema (mensagens do jogo) ----
  const CH_TABS = [['global', 'Global'], ['local', 'Local'], ['comercio', 'Comércio'], ['sistema', 'Sistema']];
  const CH_EMPTY = { global: 'Ninguém falou no Global ainda.', local: 'Fale com quem está perto de você na cidade.', comercio: 'Compre e venda itens aqui.', sistema: 'Mensagens do jogo aparecem aqui.' };
  function chatAdd(m) {
    const list = S.chat.lists[m.ch];
    if (!list) return;
    list.push(m);
    if (list.length > 120) list.shift();
    if (m.ch !== S.chat.tab) S.chat.unread[m.ch] = (S.chat.unread[m.ch] || 0) + 1;
    renderChatList();
  }
  function chatLine(m) {
    const t = new Date(m.at || Date.now());
    const hhmm = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
    if (m.ch === 'sistema') return `<div class="cm sys"><time>${hhmm}</time> ${esc(m.text)}</div>`;
    return `<div class="cm ch-${m.ch}"><time>${hhmm}</time> <b>${esc(m.name)}</b>${m.lv ? ` <i>[${m.lv}]</i>` : ''}: <span>${esc(m.text)}</span></div>`;
  }
  function chatBody() {
    return `<div class="chat">
        <div class="chat-tabs" id="chTabs"></div>
        <div class="chat-list" id="chList"></div>
        <form class="chat-in" id="chForm" autocomplete="off"><input id="chInput" maxlength="160" enterkeyhint="send"><button class="btn small" type="submit">Enviar</button></form>
      </div>`;
  }
  function renderChatList() {
    const $l = document.getElementById('chList'), $t = document.getElementById('chTabs');
    if (!$l || !$t) return;
    S.chat.unread[S.chat.tab] = 0;
    $t.innerHTML = CH_TABS.map(([k, n]) => `<button type="button" class="${k === S.chat.tab ? 'on' : ''}" data-chtab="${k}">${n}${S.chat.unread[k] ? `<em>${S.chat.unread[k] > 99 ? '99+' : S.chat.unread[k]}</em>` : ''}</button>`).join('');
    const atEnd = $l.scrollHeight - $l.scrollTop - $l.clientHeight < 40;
    const list = S.chat.lists[S.chat.tab];
    $l.innerHTML = list.length ? list.map(chatLine).join('') : `<p class="muted small">${CH_EMPTY[S.chat.tab]}</p>`;
    if (atEnd || S.chat.jump) $l.scrollTop = $l.scrollHeight;
    S.chat.jump = false;
    const $i = document.getElementById('chInput');
    if ($i) $i.placeholder = S.chat.tab === 'sistema' ? 'Escreva para falar no Local…' : `Falar no ${CH_TABS.find((c) => c[0] === S.chat.tab)[1]}… (Enter)`;
  }
  $app.addEventListener('submit', (ev) => {
    if (ev.target.id !== 'chForm') return;
    ev.preventDefault();
    const $i = document.getElementById('chInput');
    const text = $i.value.trim();
    if (!text) return;
    sendWs({ t: 'chat', ch: S.chat.tab === 'sistema' ? 'local' : S.chat.tab, text });
    $i.value = '';
  });
  // janela do personagem: abas, roupa, cores, addons, montaria, comprar, salvar
  $app.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-ptab],[data-osub],[data-ocard],[data-omount],[data-opart],[data-ocolor],[data-orot],[data-osave],[data-obuy]');
    if (!el || S.modal?.k !== 'personagem') return;
    const d = el.dataset;
    if (d.ptab) {
      S.modal.tab = d.ptab;
      if (d.ptab === 'mortes') { S.deaths = null; S.deathsAsked = false; }
      if (d.ptab === 'outfit') sendWs({ t: 'char' });
      return renderModal();
    }
    const ed = lookEd();
    if (d.osub) ed.sub = d.osub;
    else if (d.ocard) { ed.t = Number(d.ocard); ed.a = 0; }
    else if (d.omount != null) ed.mount = Number(d.omount);
    else if (d.opart) ed.part = d.opart;
    else if (d.ocolor != null) ed[ed.part] = Number(d.ocolor);
    else if (d.orot) ed.dir = (ed.dir + 1) % 4;
    else if (d.osave) { sendWs({ t: 'outfit', look: { t: ed.t, h: ed.h, b: ed.b, l: ed.l, f: ed.f, a: ed.a, mount: ed.mount } }); return; }
    else if (d.obuy) { const [kind, id, addon] = d.obuy.split(','); sendWs({ t: 'buylook', kind, id: Number(id), addon: Number(addon) }); return; }
    renderModal();
  });
  $app.addEventListener('change', (ev) => {
    const el = ev.target;
    if (S.modal?.k !== 'personagem' || !el.matches('[data-oaddon],[data-omounted],[data-oonly]')) return;
    const ed = lookEd();
    if (el.dataset.oaddon) ed.a = el.checked ? ed.a | Number(el.dataset.oaddon) : ed.a & ~Number(el.dataset.oaddon);
    else if (el.dataset.omounted) {
      if (!el.checked) ed.mount = 0;
      else { const mine = S.live?.char?.mounts || []; ed.mount = mine[0] || 0; if (!ed.mount) { ed.sub = 'mounts'; toast('Escolha uma montaria na lista.', 'info'); } }
    } else if (el.dataset.oonly) ed.only = el.checked;
    renderModal();
  });

  $app.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-chtab]');
    if (!b) return;
    S.chat.tab = b.dataset.chtab;
    S.chat.jump = true;
    renderChatList();
  });
  // Enter abre o chat para escrever (como no Tibia); Esc volta para o mapa
  document.addEventListener('keydown', (ev) => {
    const $i = document.getElementById('chInput');
    if (!$i || S.modal) return;
    if (ev.key === 'Enter' && document.activeElement !== $i && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) {
      ev.preventDefault();
      $i.focus();
    } else if (ev.key === 'Escape' && document.activeElement === $i) $i.blur();
  });

  // arrastar janelas (PC)
  let drag = null;
  $app.addEventListener('pointerdown', (ev) => {
    const h = ev.target.closest('[data-drag]');
    if (!h || ev.target.closest('button') || MOBILE()) return;
    const box = h.parentElement.getBoundingClientRect();
    drag = { k: h.dataset.drag, el: h.parentElement, dx: ev.clientX - box.left, dy: ev.clientY - box.top };
    h.setPointerCapture(ev.pointerId);
  });
  $app.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const x = Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - drag.dx));
    const y = Math.max(48, Math.min(window.innerHeight - 40, ev.clientY - drag.dy));
    drag.el.style.left = x + 'px';
    drag.el.style.top = y + 'px';
    S.wins[drag.k].x = x;
    S.wins[drag.k].y = y;
  });
  $app.addEventListener('pointerup', () => {
    if (drag) saveWins();
    drag = null;
  });

  // ---- janelas grandes (modais) ----
  function renderTab() {
    renderModal();
  }

  function renderModal() {
    const $m = document.getElementById('gModal');
    if (!$m) return;
    const m = S.modal;
    if (!m) { $m.innerHTML = ''; return; }
    const titles = { acao: 'Configurar ação', venda: 'Venda rápida', despachar: 'Despachar loot', cacar: 'Caçadas', hunt: 'Caçada', barra: 'Barra de ações', loja: 'Equipamentos', personagem: S.char, detalhes: 'Detalhes da caçada', morte: '' };
    let body = '';
    if (m.k === 'cacar') body = modalCacar();
    else if (m.k === 'hunt') body = modalHunt(m.id);
    else if (m.k === 'barra') body = tabBarra();
    else if (m.k === 'loja') body = tabLoja();
    else if (m.k === 'personagem') body = tabPersonagem();
    else if (m.k === 'detalhes') body = modalDetalhes();
    else if (m.k === 'morte') body = modalMorte();
    else if (m.k === 'venda' || m.k === 'despachar') body = modalVenda(m.k);
    else if (m.k === 'acao') body = modalAcao();
    $m.innerHTML = `<div class="modal-bg" data-close="1"></div>
      <div class="modal ${m.k === 'morte' ? 'death' : ''} ${m.k === 'personagem' ? 'pers' : ''}" role="dialog" aria-label="${esc(titles[m.k] || '')}">
        ${m.k === 'morte' ? '' : `<header class="modal-h"><b>${esc(titles[m.k] || '')}</b><button data-close="1" title="Fechar">✕</button></header>`}
        <div class="modal-b">${body}</div>
      </div>`;
    if (window.GameView) window.GameView.paintPortraits($m);
    const $pv = document.getElementById('oPrev');
    if ($pv && window.GameView && m.ed) window.GameView.paintLook($pv, edLook(m.ed), m.ed.dir, 0);
  }

  function openModal(k, extra) {
    S.modal = { k, ...(extra || {}) };
    if (k === 'barra') S.editing = extra && extra.slot != null ? extra.slot : -1;
    renderModal();
  }

  function closeModal() {
    if (S.modal?.k === 'barra' && S.dirty) {
      S.dirty = false;
      S.settings = S.savedSettings ? JSON.parse(S.savedSettings) : S.settings; // descarta o que nao foi salvo
    }
    S.modal = null;
    renderModal();
    refresh();
  }

  // catalogo de cacadas (como no Huntera): abas, favoritos, busca e cartoes com o retrato do monstro
  const lookAttr = (look) => (look && look.t ? esc(JSON.stringify(look)) : '');
  const portrait = (look, size = 56, cls = 'hc-pic') => `<canvas class="${cls}" width="${size}" height="${size}" data-look="${lookAttr(look)}"></canvas>`;
  const HUNT_TABS = { cacadas: 'Caçadas', treino: 'Treino', quests: 'Quests', arena: 'Arena', bosses: 'Bosses' };
  const SOON = {
    treino: ['Treino', 'Escolha uma skill e treine no pátio da cidade: num dummy enquanto estiver no jogo, ou com uma arma de exercício. Premium continua treinando com o jogo fechado.'],
    quests: ['Quests', 'The Annihilator, In Service of Yalahar e The Wrath of the Emperor — em grupo, com salas e recompensas.'],
    arena: ['Arena', 'Seis fossos de dificuldade crescente, do level 30 ao 200, cada um terminando num chefe.'],
    bosses: ['Bosses', 'Bosses diários, roteiros com vários bosses em sequência e invasões que descem sobre o mundo.'],
  };

  function modalCacar() {
    if (!S.catalog || !S.live) return '<p class="muted">Carregando…</p>';
    const tab = S.huntTab || 'cacadas';
    const tabs = `<div class="htabs">${Object.entries(HUNT_TABS).map(([k, v]) => `<button data-htab="${k}" class="${tab === k ? 'on' : ''}">${v}</button>`).join('')}</div>`;
    if (tab !== 'cacadas') {
      const [t, d] = SOON[tab];
      return `${tabs}<div class="soon"><b>${t}</b><p>${d}</p><span class="badge warn">Em breve</span></div>`;
    }
    const level = liveNumbers().level || 1;
    const f = S.huntFilter || 'todas';
    const favs = new Set(S.settings?.favs || []);
    const sub = [['todas', `Todas`], ['favoritos', `★ Favoritos${favs.size ? ' (' + favs.size + ')' : ''}`], ['nivel', 'Para o seu level'], ['livre', 'Caçada livre']];
    return `${tabs}
      <div class="hsub">${sub.map(([k, v]) => `<button data-filter="${k}" class="${f === k ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div class="hsearch">
        <input id="huntSearch" type="text" placeholder="${f === 'livre' ? 'Buscar monstro (ex.: dragon)' : 'Buscar caçadas'}" value="${esc(S.huntSearch || '')}" autocomplete="off">
        ${f === 'livre' ? `<select id="huntClass"><option value="">Todas as classes</option>${[...new Set((S.catalog.solo || []).map((m) => m.class))].sort().map((c) => `<option value="${esc(c)}" ${S.huntClass === c ? 'selected' : ''}>${esc(CLASSES[c] || c)}</option>`).join('')}</select>` : ''}
        <span class="muted small" id="huntCount"></span>
      </div>
      <div class="huntgrid" id="huntList">${huntListHtml(level)}</div>`;
  }

  const CLASSES = {
    Amphibic: 'Anfíbio', Aquatic: 'Aquático', Bird: 'Ave', Construct: 'Construto', Demon: 'Demônio', Dragon: 'Dragão',
    Elemental: 'Elemental', 'Extra Dimensional': 'Extradimensional', Fey: 'Fada', Giant: 'Gigante', Human: 'Humano',
    Humanoid: 'Humanoide', Lycanthrope: 'Licantropo', Magical: 'Mágico', Mammal: 'Mamífero', Plant: 'Planta',
    Reptile: 'Réptil', Slime: 'Gosma', Undead: 'Morto-vivo', Vermin: 'Verme',
  };

  function huntItems(level) {
    const letter = letterOf();
    const need = (h) => (h.lvl && h.lvl[letter]) || h.min;
    const byNeed = (x, y) => need(x) - need(y) || (x.xpKill || 0) - (y.xpKill || 0);
    const q = (S.huntSearch || '').trim().toLowerCase();
    const match = (h) => !q || h.name.toLowerCase().includes(q) || (h.monsters || []).some((m) => m.toLowerCase().includes(q));
    const f = S.huntFilter || 'todas';
    if (f === 'livre') {
      let solo = (S.catalog.solo || []).filter((m) => (!S.huntClass || m.class === S.huntClass) && (!q || m.name.toLowerCase().includes(q))).sort(byNeed);
      if (!q && !S.huntClass) {
        const safe = solo.filter((m) => need(m) <= level).slice(-15);
        solo = safe.concat(solo.filter((m) => need(m) > level).slice(0, 5));
      }
      return { need, items: solo.slice(0, 80).map((m) => ({ id: 'm:' + m.name, name: m.name, lvl: m.lvl, min: m.min, max: need(m) * 2 + 20, xpKill: m.xpKill, lootKill: m.lootKill, monsters: [CLASSES[m.class] || m.class], looks: [m.look] })) };
    }
    let all = S.catalog.hunts.slice().sort(byNeed).filter(match);
    if (f === 'favoritos') {
      const favs = new Set(S.settings?.favs || []);
      all = all.filter((h) => favs.has(h.id));
    } else if (f === 'nivel') {
      const safe = all.filter((h) => need(h) <= level).slice(-6).reverse();
      all = safe.concat(all.filter((h) => need(h) > level && need(h) <= level * 1.3 + 10).slice(0, 3));
    }
    return { need, items: all };
  }

  function huntListHtml(level) {
    const { need, items } = huntItems(level);
    const favs = new Set(S.settings?.favs || []);
    const recs = S.live?.records || {};
    setTimeout(() => {
      const c = document.getElementById('huntCount');
      if (c) c.textContent = `${items.length} ${items.length === 1 ? 'caçada disponível' : 'caçadas disponíveis'}`;
      const l = document.getElementById('huntList');
      if (l && window.GameView) window.GameView.paintPortraits(l);
    });
    if (!items.length) return `<p class="muted">${S.huntFilter === 'favoritos' ? 'Nenhuma favorita ainda: clique na estrela de uma caçada.' : 'Nenhuma caçada encontrada.'}</p>`;
    return items.map((h) => {
      const lv = need(h);
      const danger = lv > level;
      const rec = recs[h.id];
      const fav = favs.has(h.id);
      return `<button class="hcard2 ${danger ? 'danger' : ''}" data-huntcard="${esc(h.id)}">
        <span class="hc-top">${portrait((h.looks || [])[0])}
          <span class="hc-txt"><b>${esc(h.name)}</b><small>${h.monsters.slice(0, 3).map(esc).join(', ')}${h.monsters.length > 3 ? '…' : ''}</small></span>
          <span class="hc-star ${fav ? 'on' : ''}" data-fav="${esc(h.id)}" title="${fav ? 'Tirar dos favoritos' : 'Favoritar'}">${fav ? '★' : '☆'}</span></span>
        <span class="hc-foot">${rec ? `<span><b>Solo</b> ${kfmt(rec.xph)} XP/h · ${kfmt(rec.gph)} gp/h</span>` : '<i>Sem recorde ainda</i>'}<span class="hc-lv ${danger ? 'danger' : ''}">Lv ${lv}</span></span>
      </button>`;
    }).join('');
  }

  function findHunt(id) {
    if (!S.catalog) return null;
    const h = S.catalog.hunts.find((x) => x.id === id);
    if (h) return h;
    const m = (S.catalog.solo || []).find((x) => 'm:' + x.name === id);
    return m ? { id, name: 'Caçada livre: ' + m.name, monsters: [m.name], looks: [m.look], lvl: m.lvl, min: m.min, xpKill: m.xpKill, lootKill: m.lootKill } : null;
  }

  // cartao da cacada: pull, monstros e iniciar
  function modalHunt(id) {
    const h = findHunt(id);
    if (!h) return '<p class="muted">Caçada não encontrada.</p>';
    const pull = S.modal.pull || S.settings?.pull || 'ousado';
    const lv = (h.lvl && h.lvl[letterOf()]) || h.min;
    const PULL_TXT = { cauteloso: 'Menos monstros acordados; para para lutar com 2.', ousado: 'Boa parte da área acordada; junta até 4.', agressivo: 'A área inteira acordada; junta até 6 antes de lutar.' };
    return `
      <h2 style="margin:0 0 4px">${esc(h.name)}</h2>
      <p class="muted small" style="margin:0 0 12px">Level indicado ${lv}${h.xpKill ? ` · ${fmt(h.xpKill)} XP e ${fmt(h.lootKill)} gp por monstro` : ''}</p>
      <div class="hunt-cols">
        <div>
          <label class="field">Tamanho do pull</label>
          <div class="seg">${Object.entries(PULL).map(([k, v]) => `<button data-pull="${k}" class="${pull === k ? 'on' : ''}">${v}</button>`).join('')}</div>
          <p class="small muted">${PULL_TXT[pull]}</p>
          <label class="field">Monstros desta caçada</label>
          <div class="mlist">${h.monsters.map((m, i) => `<span class="mchip">${portrait((h.looks || [])[i], 40, 'mc-pic')}<span>${esc(m)}</span></span>`).join('')}</div>
        </div>
      </div>
      <div class="row" style="justify-content:space-between;margin-top:14px">
        <button class="btn" data-modal="cacar">‹ Voltar ao catálogo</button>
        <button class="btn primary" data-go="${esc(h.id)}">Iniciar caçada</button>
      </div>`;
  }

  function modalDetalhes() {
    const i = S.live?.idle;
    if (!i || !i.hunting) return '<p class="muted">Nenhuma caçada agora.</p>';
    const h = findHunt(i.hunt);
    const kills = Object.entries(i.kills || {}).sort((a, b) => b[1] - a[1]);
    return `
      <h2 style="margin:0 0 4px">${esc(i.huntName || '')}</h2>
      <p class="muted small">Pull ${PULL[i.settings?.pull] || ''} · Alvo ${TARGET[i.settings?.target] || ''} · ${dur(i.elapsed)}</p>
      ${h ? `<label class="field">Monstros</label><div class="mlist">${h.monsters.map((m) => `<span class="chip">${esc(m)}</span>`).join('')}</div>` : ''}
      <label class="field">Abates (${fmt(i.killCount)})</label>
      ${kills.length ? `<table class="simple">${kills.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${fmt(v)}</td></tr>`).join('')}</table>` : '<p class="muted small">Nenhum ainda.</p>'}
      ${i.noGold ? '<p class="small" style="color:var(--bad)">Sem gold para as poções pagas: só as grátis estão sendo usadas.</p>' : ''}`;
  }

  // ---- Configurar acao (como no Huntera): magias da vocacao com icone, runas, itens e as condicoes ----
  const KIND_DESC = {
    heal: 'Magia de cura — recupera a sua vida.',
    attack: 'Magia de ataque — atinge o alvo de longe.',
    area: 'Magia de área — atinge todos os monstros na área.',
    shield: 'Magia de suporte — a mana absorve o dano enquanto ela durar.',
    haste: 'Magia de suporte — aumenta a sua velocidade.',
    potion: 'Poção — o personagem bebe sozinho quando a regra deixa.',
  };
  const AREA_DESC = { wave: 'em onda na frente do personagem', beam: 'em raio reto', circle: 'em círculo em volta do personagem' };
  const RUNES = [
    ['Ultimate Healing Rune', 3160, 24, 160], ['Intense Healing Rune', 3152, 15, 90], ['Heavy Magic Missile Rune', 3198, 25, 15],
    ['Fireball Rune', 3189, 27, 30], ['Holy Missile Rune', 3182, 27, 14], ['Icicle Rune', 3158, 28, 30], ['Stone Shower Rune', 3175, 28, 40],
    ['Thunderstorm Rune', 3202, 28, 45], ['Avalanche Rune', 3161, 30, 55], ['Great Fireball Rune', 3191, 30, 60], ['Explosion Rune', 3200, 31, 25],
    ['Sudden Death Rune', 3155, 45, 150],
  ];

  function openAcao(k) {
    const bar = S.settings?.bar || [];
    const slot = bar[k];
    const a = slot && actionByName(slot.action);
    S.modal = {
      k: 'acao', slot: slot ? k : bar.length, tab: a && a.kind === 'potion' ? 'itens' : 'magias',
      pick: slot ? slot.action : null, conds: slot ? JSON.parse(JSON.stringify(slot.conds)) : [], enabled: slot ? slot.enabled : true, existing: !!slot,
    };
    renderModal();
  }

  function modalAcao() {
    const m = S.modal;
    const letter = letterOf();
    const level = liveNumbers().level || 1;
    const all = actionsFor(letter);
    const list = m.tab === 'itens' ? all.filter((a) => a.kind === 'potion') : m.tab === 'magias' ? all.filter((a) => a.kind !== 'potion') : [];
    const choice = (a) => {
      const locked = a.lvl > level;
      return `<button class="acho ${m.pick === a.name ? 'on' : ''} ${locked ? 'locked' : ''}" data-acpick="${esc(a.name)}" title="${esc(a.name)}${locked ? ' — level ' + a.lvl : ''}">
        ${actionImg(a.name, 'acho-ic') || `<span class="acho-t">${esc(shortName(a.name))}</span>`}${locked ? `<em>${a.lvl}</em>` : a.kind === 'potion' ? `<em class="gp">${a.cost ? a.cost : 'Grátis'}</em>` : ''}
        <span>${esc(a.name)}</span></button>`;
    };
    const tabs = `<div class="ac-tabs">${[['magias', 'Magias'], ['runas', 'Runas'], ['itens', 'Itens']].map(([k, v]) => `<button data-actab="${k}" class="${m.tab === k ? 'on' : ''}">${v}</button>`).join('')}</div>`;
    let left;
    if (m.tab === 'runas') {
      left = `<div class="ac-grid">${RUNES.map(([n, id, lv, gp]) => `<button class="acho locked" disabled title="${esc(n)}">${icon(id, 'acho-ic')}<em class="gp">${gp}</em><span>${esc(n)}</span></button>`).join('')}</div>
        <p class="muted small">Runas (cobradas em gold por uso, como as poções) chegam em breve.</p>`;
    } else left = `<div class="ac-grid">${list.map(choice).join('') || '<p class="muted small">Nada aqui para a sua vocação.</p>'}</div>`;
    const a = actionByName(m.pick);
    let det = '<p class="muted small">Escolha uma magia ou item ao lado.</p>';
    if (a) {
      const locked = a.lvl > level;
      const desc = (KIND_DESC[a.kind] || '') + (a.kind === 'area' && AREA_DESC[a.area] ? ` (${AREA_DESC[a.area]})` : '');
      det = `<div class="ac-head">${actionImg(a.name, 'ac-big') || ''}<div><b>${esc(a.name)}</b>${a.words ? `<small>${esc(a.words)}</small>` : ''}</div></div>
        <p class="small">${esc(desc)}</p>
        <p class="small muted">${a.kind === 'potion' ? (a.cost ? `Custa ${fmt(a.cost)} gold por uso.` : 'Grátis — não custa gold.') : `${a.mana} de mana · ${(a.cd / 1000).toFixed(a.cd % 1000 ? 1 : 0)}s de cooldown`}</p>
        <p class="small">Requer: level ${a.lvl}+</p>
        ${locked ? '<p class="small warnline">Você ainda não pode usar esta magia — ela entra sozinha quando você chegar no level.</p>' : ''}`;
    }
    const subjects = allowedSubjects(a);
    const conds = m.conds.map((c, ci) => `<div class="ac-cond">
        <select data-accond="${ci}.subj">${subjects.map((k) => `<option value="${k}" ${c.subj === k ? 'selected' : ''}>${SUBJ[k]}</option>`).join('')}</select>
        <select data-accond="${ci}.attr">${(SUBJ_ATTRS[c.subj] || []).map((k) => `<option value="${k}" ${c.attr === k ? 'selected' : ''}>${ATTR[k]}</option>`).join('')}</select>
        <select data-accond="${ci}.op">${Object.entries(OPS_TXT).map(([k, v]) => `<option value="${k}" ${c.op === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <span class="ac-step"><button data-acstep="${ci}.-1">−</button><input type="number" min="0" data-accond="${ci}.val" value="${c.val}"><button data-acstep="${ci}.1">+</button></span>
        ${c.attr === 'hp' || c.attr === 'mana' ? `<label class="small"><input type="checkbox" data-accond="${ci}.pct" ${c.pct ? 'checked' : ''}> %</label>` : '<span></span>'}
        <button class="iconbtn" data-acdel="${ci}" title="Tirar condição">✕</button></div>`).join('');
    return `${tabs}
      <div class="ac-main"><div class="ac-left">${left}</div><div class="ac-det">${det}</div></div>
      <div class="ac-conds">
        <div class="spread"><b>Condições</b><button class="btn small" data-acadd="1" ${a ? '' : 'disabled'}>+ Adicionar condição</button></div>
        ${conds || ''}
        <p class="muted small">Todas as condições precisam bater. Sem condições, dispara sempre. A ordem dos slots decide quem dispara primeiro.</p>
      </div>
      <div class="ac-foot">
        ${m.existing ? '<button class="btn small" data-acremove="1">Tirar da barra</button>' : '<span></span>'}
        <span class="row"><label class="row small"><input type="checkbox" data-acenabled="1" ${m.enabled ? 'checked' : ''}> Ativada</label>
        <button class="btn primary" data-acsave="1" ${a ? '' : 'disabled'}>Salvar</button></span>
      </div>`;
  }
  const OPS_TXT = { lt: 'menor que', le: 'menor ou igual a', eq: 'igual a', ge: 'maior ou igual a', gt: 'maior que' };

  function saveAcao() {
    const m = S.modal;
    if (!m.pick || !S.settings) return;
    const slot = { action: m.pick, enabled: m.enabled !== false, conds: m.conds };
    if (m.slot < S.settings.bar.length) S.settings.bar[m.slot] = slot;
    else if (S.settings.bar.length < 20) S.settings.bar.push(slot);
    sendWs({ t: 'settings', settings: S.settings });
    S.savedSettings = JSON.stringify(S.settings);
    S.modal = null;
    renderModal();
    refresh();
  }

  // ---- mochila, Venda rapida e Despachar loot (como no Huntera) ----
  const bagItems = () => S.live?.bag?.items || [];
  const keepSet = () => new Set(S.settings?.keep || []);
  const serverNow = () => Date.now() / 1000 + (S.clockOffset || 0);
  const dispatchLeft = () => Math.max(0, Math.ceil((S.live?.bag?.dispatchAt || 0) - serverNow()));
  const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

  function bagHtml() {
    const bag = S.live?.bag;
    const items = bagItems();
    const keep = keepSet();
    const value = items.filter((it) => !keep.has(it.id)).reduce((a, it) => a + it.price * it.count, 0);
    const cap = bag ? `<div class="v capb" title="Peso do loot na mochila / capacidade livre"><i style="width:${pct(bag.weight, bag.cap)}%"></i><span>${fmt(bag.weight / 100)} / ${fmt(bag.cap / 100)} oz</span></div>` : '';
    return `<div class="bagh"><span>Mochila</span><span class="small muted">${items.length ? fmt(value) + ' gp para vender' : ''}</span></div>
      <div class="baggrid">${items.length ? items.map((it) => `<div class="bi ${keep.has(it.id) ? 'keep' : ''}" title="${esc(it.name)} — ${it.count} × ${fmt(it.price)} gp${keep.has(it.id) ? ' (não vender)' : ''}">${icon(it.id, 'bi-ic')}${it.count > 1 ? `<em>${it.count}</em>` : ''}</div>`).join('') : '<span class="muted small bag-empty">Vazia — o loot das caçadas vem para cá.</span>'}</div>${cap}`;
  }

  function modalVenda(mode) {
    const items = bagItems();
    const keep = keepSet();
    const sell = items.filter((it) => !keep.has(it.id));
    const total = sell.reduce((a, it) => a + it.price * it.count, 0);
    const n = sell.reduce((a, it) => a + it.count, 0);
    const premium = !!S.live?.premium;
    const left = dispatchLeft();
    const intro = mode === 'venda'
      ? 'Tudo o que a loja da cidade compra da sua mochila. Clique em um item para marcar ou desmarcar — só os marcados são vendidos, e as marcas ficam salvas para a próxima.'
      : `Um mensageiro leva o loot marcado até a loja da cidade e vende por lá — você continua na caçada e o gold chega na hora. Uma vez a cada ${premium ? '30 minutos (Premium)' : 'hora (30 minutos com Premium)'}.`;
    const rows = items.map((it) => `<button class="vrow ${keep.has(it.id) ? '' : 'on'}" data-keep="${it.id}">
        ${icon(it.id, 'vr-ic')}<span class="vn"><b>${esc(it.name)}</b><small>${it.count} × ${fmt(it.price)} gp</small></span>
        <span class="vt">${fmt(it.price * it.count)} gp</span><span class="vc">${keep.has(it.id) ? '' : '✓'}</span></button>`).join('');
    const action = mode === 'venda'
      ? `<button class="btn primary" data-act="sell" ${n ? '' : 'disabled'}>Vender por ${fmt(total)} gp</button>`
      : left > 0 ? `<button class="btn" disabled>Pronto em ${mmss(left)}</button>`
        : `<button class="btn primary" data-act="dispatch" ${n ? '' : 'disabled'}>Despachar por ${fmt(total)} gp</button>`;
    return `<p class="muted small" style="margin-top:0">${intro}</p>
      ${items.length ? `<div class="vlist">${rows}</div>` : '<p class="muted">A mochila está vazia. O loot das caçadas vem para cá.</p>'}
      <div class="vfoot">
        <span><b>${n}</b> ${n === 1 ? 'item' : 'itens'} · <b>${fmt(total)} gp</b></span>
        <span class="row"><button class="btn small" data-keepall="0">Marcar tudo</button><button class="btn small" data-keepall="1">Desmarcar tudo</button></span>
      </div>
      <label class="row small" style="margin:10px 0"><input type="checkbox" data-autosell ${S.settings?.autosell !== false ? 'checked' : ''}> Vender sozinho o que estiver marcado quando a mochila encher</label>
      <div class="row" style="justify-content:flex-end">${action}</div>`;
  }

  function saveKeep(keep) {
    S.settings.keep = [...keep];
    sendWs({ t: 'settings', settings: S.settings });
    S.savedSettings = JSON.stringify(S.settings);
    renderModal();
    refresh();
  }

  // ---- morte: ultimos segundos e o replay do ultimo minuto ----
  function modalMorte() {
    const i = S.deathInfo || {};
    const lines = (i.log || []).slice(-14).reverse();
    return `
      <div class="death-h"><span>✝</span> Você morreu.</div>
      <p class="center">Morto por <b>${esc(i.killer || '?')}</b>${i.huntName ? ` em ${esc(i.huntName)}` : ''}.</p>
      <p class="center muted small">Você volta no templo da cidade.</p>
      <label class="field">Os últimos segundos</label>
      <div class="loglist death-log">${lines.map((l) => `<div>${esc(l)}</div>`).join('') || '<span class="muted">—</span>'}</div>
      <div class="row" style="justify-content:center;margin-top:12px">
        ${S.rec && S.rec.length > 3 ? '<button class="btn" data-act="replay">▸ Ver o último minuto</button>' : ''}
        <button class="btn primary" data-act="revive">Reviver</button>
      </div>`;
  }

  function startReplay() {
    const rec = (S.rec || []).slice();
    if (rec.length < 3 || !S.gv) return;
    S.modal = null;
    renderModal();
    S.replay = { rec, k: 0, t0: performance.now() - rec[0].t };
    banner(`<span>O último minuto antes de você morrer</span><div class="rp"><i id="rpBar"></i></div><button class="btn small" data-act="replay">Assistir de novo</button><button class="btn small" data-act="deathback">Voltar para a tela de morte</button>`);
    const base = rec[0].t;
    const t0 = performance.now();
    const tick = () => {
      if (!S.replay || S.replay.rec !== rec) return;
      const el = performance.now() - t0;
      while (S.replay.k < rec.length && rec[S.replay.k].t - base <= el) S.gv.update(rec[S.replay.k++].idle);
      const bar = document.getElementById('rpBar');
      if (bar) bar.style.width = pct(Math.min(el, rec[rec.length - 1].t - base), rec[rec.length - 1].t - base) + '%';
      if (S.replay.k < rec.length) S.replay.timer = setTimeout(tick, 60);
    };
    tick();
  }

  function stopReplay() {
    if (S.replay?.timer) clearTimeout(S.replay.timer);
    S.replay = null;
    banner(null);
  }

  // ---- faixa do topo (indo ate o portal, replay) e mensagens do centro ----
  function banner(html) {
    const b = document.getElementById('gBanner');
    if (!b) return;
    b.hidden = !html;
    b.innerHTML = html || '';
  }
  let msgTimer = null;
  function centerMsg(text) {
    const b = document.getElementById('gMsg');
    if (!b) return;
    b.textContent = text;
    b.hidden = false;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => (b.hidden = true), 4000);
  }

  // ---- cidade, ida para a chama mistica e saida da cacada ----
  function showTown(at) {
    if (!S.gv) return;
    const n = liveNumbers();
    S.gv.setTown(S.live?.player?.look || S.live?.idle?.me?.look, n.name, n.hp, n.maxHp, at);
  }

  function goHunt(id) {
    const h = findHunt(id);
    if (!h) return;
    const pull = S.modal?.pull || S.settings?.pull;
    if (S.settings && pull && pull !== S.settings.pull) {
      S.settings.pull = pull;
      sendWs({ t: 'settings', settings: S.settings });
      S.savedSettings = JSON.stringify(S.settings);
    }
    S.modal = null;
    renderModal();
    const enter = () => {
      S.phase = 'entering';
      banner('<span>Entrando na chama mística…</span>');
      sendWs({ t: 'start', hunt: id });
      S.enterTimeout = setTimeout(() => {
        if (S.phase === 'entering') { S.phase = null; banner(null); refresh(); }
      }, 20000);
    };
    S.phase = 'walking';
    banner(`<span>Indo até o portal da caçada…</span><button class="btn small" data-act="cancelwalk">Cancelar</button>`);
    refresh();
    const town = S.live?.town;
    if (town && S.gv && S.gv.room && S.gv.room.flame) {
      const steps = S.gv.path([town.me.x, town.me.y], S.gv.room.flame);
      if (steps && steps.length) {
        let done = false;
        const go = () => {
          if (done) return;
          done = true;
          S.walkServer = null;
          enter();
        };
        S.walkServer = { enter: go };
        sendWs({ t: 'walkto', x: S.gv.room.flame[0], y: S.gv.room.flame[1] });
        clearTimeout(S.walkTimer);
        S.walkTimer = setTimeout(go, steps.length * 450 + 4000); // nao chegou (bloqueado): entra assim mesmo
        return;
      }
      return enter();
    }
    const ms = S.gv ? S.gv.walkToFlame(enter) : 0;
    if (!ms) return enter();
    // com a aba em segundo plano o desenho para: garante a entrada no tempo da caminhada
    clearTimeout(S.walkTimer);
    S.walkTimer = setTimeout(() => {
      if (S.phase === 'walking' && S.gv) S.gv.finishWalk();
    }, ms + 1500);
  }

  // ---- andar livre em Thais ----
  const canWalk = () => S.view === 'game' && S.live?.town && !S.live?.idle?.hunting && !S.modal && !S.replay && (S.phase == null || S.walkServer);
  $app.addEventListener('click', (ev) => {
    if (!ev.target.closest('#gvWrap') || !canWalk() || !S.gv || S.walkServer) return;
    const r = ev.target.closest('#gvWrap').getBoundingClientRect();
    const t = S.gv.tileAt(ev.clientX - r.left, ev.clientY - r.top);
    const me = S.live.town.me;
    if (!t || !S.gv.room) return;
    if (me.x === t[0] && me.y === t[1]) return;
    // o servidor acha o caminho a partir da posicao de verdade (a daqui chega com atraso)
    S.gv.markTarget(t[0], t[1]);
    sendWs({ t: 'walkto', x: t[0], y: t[1] });
  });
  const KEY_STEP = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0], W: [0, -1], S: [0, 1], A: [-1, 0], D: [1, 0] };
  let lastStep = 0;
  document.addEventListener('keydown', (ev) => {
    const k = KEY_STEP[ev.key];
    if (!k || !canWalk() || S.walkServer || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
    ev.preventDefault();
    // segurar a seta anda no ritmo do personagem (como no Tibia), sem acumular passos
    if (Date.now() - lastStep < Math.max(150, (S.live?.town?.me?.ms || 300) - 40)) return;
    lastStep = Date.now();
    if (S.gv) S.gv.predictStep(k[0], k[1], S.live?.town?.me?.ms);
    sendWs({ t: 'step', dx: k[0], dy: k[1] });
  });

  // saida: 5 s (como no Huntera); clicar de novo cancela
  function leaveTick() {
    if (S.phase !== 'leaving') return;
    if (Date.now() >= S.leaveAt) {
      S.phase = 'stopping';
      sendWs({ t: 'stop' });
    } else setTimeout(leaveTick, 250);
    refresh();
  }

  // --------------------------------------------------------------------------
  // conexao ao vivo
  // --------------------------------------------------------------------------
  function connect() {
    if (DEMO) return demoConnect();
    if (S.ws) S.ws.close();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${BASE}api/ws?token=${encodeURIComponent(S.token)}&char=${encodeURIComponent(S.char)}`);
    S.ws = ws;
    ws.onopen = () => (S.wsTries = 0);
    ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
    ws.onclose = () => {
      if (S.ws !== ws || S.view !== 'game') return;
      S.wsTries++;
      setTimeout(() => S.view === 'game' && S.ws === ws && connect(), Math.min(15000, 1000 * S.wsTries));
    };
  }

  function onMessage(m) {
    if (m.t === 'state') {
      const prev = S.live;
      const was = !!prev?.idle?.hunting;
      S.live = m;
      const now = !!m.idle?.hunting;
      const gmsg = m.gear?.msg;
      if (gmsg && gmsg.at && gmsg.at !== S.lastGearMsg) {
        if (S.lastGearMsg !== undefined) toast(gmsg.text, gmsg.ok ? 'ok' : 'erro');
        S.lastGearMsg = gmsg.at;
      } else if (S.lastGearMsg === undefined) S.lastGearMsg = gmsg?.at || 0;
      if (m.now) S.clockOffset = m.now - Date.now() / 1000;
      const bmsg = m.bag?.msg;
      if (bmsg && bmsg.at && bmsg.at !== S.lastBagMsg) {
        if (S.lastBagMsg !== undefined) toast(bmsg.text, bmsg.ok ? 'ok' : 'erro');
        S.lastBagMsg = bmsg.at;
      } else if (S.lastBagMsg === undefined) S.lastBagMsg = bmsg?.at || 0;
      if ((m.bag?.updated || 0) !== S.bagUpdated) {
        S.bagUpdated = m.bag?.updated || 0;
        if (S.modal && (S.modal.k === 'venda' || S.modal.k === 'despachar')) S.bagDirty = true;
      }
      const cmsg = m.char?.msg;
      if (cmsg && cmsg.at && cmsg.at !== S.lastCharMsg) {
        if (S.lastCharMsg !== undefined) toast(cmsg.text, cmsg.ok ? 'ok' : 'erro');
        S.lastCharMsg = cmsg.at;
      } else if (S.lastCharMsg === undefined) S.lastCharMsg = cmsg?.at || 0;
      if ((m.char?.updated || 0) !== S.charUpdated) {
        S.charUpdated = m.char?.updated || 0;
        if (S.modal?.k === 'personagem') S.charDirty = true;
      }
      if ((m.gear?.updated || 0) !== S.gearUpdated) {
        S.gearUpdated = m.gear?.updated || 0;
        S.gearDirty = true;
      }
      // level e skills: mensagem no meio do topo (como no Huntera)
      const lvNow = now ? m.idle.level : m.player?.level;
      const lvWas = prev ? (prev.idle?.hunting ? prev.idle.level : prev.player?.level) : null;
      if (lvWas && lvNow > lvWas) {
        const learned = actionsFor(m.player?.letter || letterOf()).filter((a) => a.kind !== 'potion' && a.lvl > lvWas && a.lvl <= lvNow).map((a) => a.name);
        centerMsg(`Você avançou do level ${lvWas} para o level ${lvNow}.` + (learned.length ? ` Você aprendeu ${learned.join(', ')}!` : ''));
      }
      if (now) {
        // grava o ultimo minuto (para o replay da morte)
        S.rec = S.rec || [];
        S.rec.push({ t: performance.now(), idle: m.idle });
        while (S.rec.length && performance.now() - S.rec[0].t > 60000) S.rec.shift();
        if (S.phase !== 'leaving' && S.phase !== 'stopping') S.phase = 'hunting';
        clearTimeout(S.enterTimeout);
        banner(S.replay ? document.getElementById('gBanner').innerHTML : null);
        if (!S.replay && S.gv) S.gv.update(m.idle);
      } else if (was || !prev || S.phase === 'hunting' || S.phase === 'stopping') {
        // voltou (ou abriu a pagina) na cidade
        const died = was && m.idle?.reason === 'morte';
        S.phase = null;
        banner(null);
        if (!m.town) showTown(was && !died ? 'flame' : 'temple');
        if (died) {
          S.deathInfo = m.idle;
          openModal('morte');
        } else if (was && m.idle?.reason) toast(REASON[m.idle.reason] || m.idle.reason, 'info');
      }
      // Thais de verdade: o personagem anda livre e ve os outros jogadores
      if (!now && m.town && S.gv && !S.replay) {
        S.gv.updateTown(m.town, liveNumbers().name);
        for (const f of m.town.fx || []) if (f.k === 'say') chatAdd({ ch: 'local', name: f.name, lv: f.lv, text: f.text, at: Date.now() });
        // indo para a chama a pe: chegou -> entra na cacada
        if (S.phase === 'walking' && S.walkServer && S.gv.room && S.gv.room.flame) {
          const f = S.gv.room.flame;
          if (Math.abs(m.town.me.x - f[0]) + Math.abs(m.town.me.y - f[1]) <= 0) S.walkServer.enter();
        }
      }
      refresh();
    } else if (m.t === 'settings') {
      if (!S.dirty) {
        S.settings = m.settings;
        S.savedSettings = JSON.stringify(m.settings);
        if (S.modal?.k === 'barra') renderModal();
        refresh();
      }
    } else if (m.t === 'msg') {
      if (!/^Entrando em|^Saindo da caçada/.test(m.text)) toast(m.text, m.kind);
      chatAdd({ ch: 'sistema', text: m.text, at: Date.now() });
    } else if (m.t === 'mortes') {
      S.deaths = m.list || [];
      if (S.modal?.k === 'personagem') renderModal();
    } else if (m.t === 'chatlog') {
      S.chat.lists.global = (m.global || []).map((x) => ({ ...x, ch: 'global' }));
      S.chat.lists.comercio = (m.comercio || []).map((x) => ({ ...x, ch: 'comercio' }));
      S.chat.jump = true;
      renderChatList();
    } else if (m.t === 'chat') {
      const c = m.m || {};
      chatAdd(c);
      if (c.ch === 'local' && S.gv) S.gv.say(c.name === liveNumbers().name ? 'me' : 'p' + c.pid, c.text);
    }
  }

  function sendWs(obj) {
    if (DEMO) return demoSend(obj);
    if (!S.ws || S.ws.readyState !== 1) return toast('Sem conexão com o servidor. Tentando de novo…', 'erro');
    S.ws.send(JSON.stringify(obj));
  }

  // --------------------------------------------------------------------------
  // acoes
  // --------------------------------------------------------------------------
  async function loadCatalog() {
    if (!S.catalog) S.catalog = await api('catalogo');
    if (!S.spells) {
      try {
        S.spells = await (await fetch('magias/index.json')).json();
        S.spellIcons = Object.fromEntries(S.spells.filter((x) => x.icon).map((x) => [normName(x.name), x.icon]));
      } catch {
        S.spells = [];
      }
    }
  }

  async function enterGame(name) {
    S.char = name;
    store.set('dt_char', name);
    S.view = 'game';
    S.live = null;
    S.live0 = false;
    S.settings = null;
    S.dirty = false;
    S.editing = -1;
    S.modal = null;
    S.phase = null;
    S.rec = [];
    render();
    try {
      await loadCatalog();
    } catch (e) {
      toast(e.message, 'erro');
    }
    connect();
  }

  function logout(callApi = true) {
    if (callApi && S.token && !DEMO) api('sair', {}).catch(() => {});
    S.token = null;
    store.set('dt_token', null);
    store.set('dt_char', null);
    if (S.ws) S.ws.close();
    S.ws = null;
    S.view = 'auth';
    render();
  }

  function markDirty() {
    S.dirty = true;
    renderTab();
  }

  $app.addEventListener('click', async (ev) => {
    const star = ev.target.closest('[data-fav]');
    if (star && S.settings) {
      ev.stopPropagation();
      const favs = new Set(S.settings.favs || []);
      const id = star.dataset.fav;
      if (favs.has(id)) favs.delete(id);
      else favs.add(id);
      S.settings.favs = [...favs];
      sendWs({ t: 'settings', settings: S.settings });
      S.savedSettings = JSON.stringify(S.settings);
      return renderModal();
    }
    const t = ev.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.auth) {
      S.authMode = d.auth;
      return render();
    }
    if (d.voc) {
      S.newChar.vocation = d.voc;
      t.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === t));
      return;
    }
    if (d.sex) {
      S.newChar.sex = d.sex;
      t.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === t));
      return;
    }
    if (d.play) return enterGame(d.play);
    if (d.modal) return openModal(d.modal);
    if (d.close) return closeModal();
    if (d.win) {
      const w = S.wins[d.win];
      w.open = !w.open;
      w.min = false;
      if (MOBILE() && w.open) for (const k of Object.keys(S.wins)) if (k !== d.win) S.wins[k].open = false;
      saveWins();
      return renderWins();
    }
    if (d.wmin) {
      S.wins[d.wmin].min = !S.wins[d.wmin].min;
      saveWins();
      return renderWins();
    }
    if (d.wclose) {
      S.wins[d.wclose].open = false;
      saveWins();
      return renderWins();
    }
    if (d.huntcard) return openModal('hunt', { id: d.huntcard, pull: S.settings?.pull });
    if (d.pull) {
      S.modal.pull = d.pull;
      return renderModal();
    }
    if (d.go) return goHunt(d.go);
    if (d.keep) {
      const keep = keepSet();
      const id = Number(d.keep);
      if (keep.has(id)) keep.delete(id);
      else keep.add(id);
      return saveKeep(keep);
    }
    if (d.keepall !== undefined) return saveKeep(d.keepall === '1' ? new Set([...keepSet(), ...bagItems().map((it) => it.id)]) : new Set());
    if (d.slot !== undefined) return openAcao(Number(d.slot));
    if (d.actab) {
      S.modal.tab = d.actab;
      return renderModal();
    }
    if (d.acpick) {
      const a = actionByName(d.acpick);
      if (!a) return;
      if (S.modal.pick !== a.name) S.modal.conds = suggestedConds(a);
      S.modal.pick = a.name;
      return renderModal();
    }
    if (d.acadd !== undefined) {
      const a = actionByName(S.modal.pick);
      const subj = a && a.kind === 'area' ? 'area' : 'self';
      S.modal.conds.push(subj === 'area' ? { subj, attr: 'targets', op: 'ge', val: 2, pct: false } : { subj, attr: 'hp', op: 'le', val: 75, pct: true });
      return renderModal();
    }
    if (d.acdel !== undefined) {
      S.modal.conds.splice(Number(d.acdel), 1);
      return renderModal();
    }
    if (d.acstep) {
      const [ci, dir] = d.acstep.split('.').map(Number);
      const c = S.modal.conds[ci];
      c.val = Math.max(0, (Number(c.val) || 0) + dir * (c.pct ? 5 : 1));
      if (c.pct) c.val = Math.min(100, c.val);
      return renderModal();
    }
    if (d.acsave !== undefined) return saveAcao();
    if (d.acremove !== undefined) {
      S.settings.bar.splice(S.modal.slot, 1);
      sendWs({ t: 'settings', settings: S.settings });
      S.savedSettings = JSON.stringify(S.settings);
      S.modal = null;
      renderModal();
      return refresh();
    }
    if (d.quickSet) {
      S.settings[d.quickSet] = d.val;
      sendWs({ t: 'settings', settings: S.settings });
      S.savedSettings = JSON.stringify(S.settings);
      return refresh();
    }
    if (d.dist) {
      S.settings.distance = Math.max(1, Math.min(4, (S.settings.distance || 1) + Number(d.dist)));
      sendWs({ t: 'settings', settings: S.settings });
      S.savedSettings = JSON.stringify(S.settings);
      return refresh();
    }
    if (d.htab) {
      S.huntTab = d.htab;
      return renderModal();
    }
    if (d.filter) {
      S.huntFilter = d.filter;
      return renderTab();
    }
    if (d.shopkind) {
      S.shopKind = d.shopkind;
      return renderTab();
    }
    if (d.buy) return sendWs({ t: 'buy', id: Number(d.buy) });
    if (d.set) {
      S.settings[d.set] = d.set === 'distance' ? Number(d.val) : d.val;
      return markDirty();
    }
    if (d.edit !== undefined) {
      S.editing = Number(d.edit);
      return renderTab();
    }
    if (d.addcond !== undefined) {
      const slot = S.settings.bar[Number(d.addcond)];
      const a = actionByName(slot.action);
      const subj = allowedSubjects(a).includes('area') && a.kind === 'area' ? 'area' : 'self';
      slot.conds.push(subj === 'area' ? { subj, attr: 'targets', op: 'ge', val: 2, pct: false } : { subj, attr: 'hp', op: 'le', val: 75, pct: true });
      return markDirty();
    }
    if (d.delcond) {
      const [si, ci] = d.delcond.split('.').map(Number);
      S.settings.bar[si].conds.splice(ci, 1);
      return markDirty();
    }
    if (d.move) {
      const [si, dir] = d.move.split('.').map(Number);
      const bar = S.settings.bar;
      const j = si + dir;
      if (j < 0 || j >= bar.length) return;
      [bar[si], bar[j]] = [bar[j], bar[si]];
      if (S.editing === si) S.editing = j;
      return markDirty();
    }
    if (d.del !== undefined) {
      S.settings.bar.splice(Number(d.del), 1);
      S.editing = -1;
      return markDirty();
    }
    const act = d.act;
    if (act === 'google') {
      if (S.gTok) S.gTok.requestAccessToken();
      return;
    }
    if (act === 'leave') {
      if (S.phase === 'leaving') S.phase = 'hunting';
      else {
        S.phase = 'leaving';
        S.leaveAt = Date.now() + 5000;
        leaveTick();
      }
      return refresh();
    }
    if (act === 'cancelwalk') {
      clearTimeout(S.walkTimer);
      if (S.walkServer) {
        S.walkServer = null;
        sendWs({ t: 'stopwalk' });
      }
      if (S.gv) S.gv.stopWalk();
      S.phase = null;
      banner(null);
      return refresh();
    }
    if (act === 'replay') return startReplay();
    if (act === 'sell' || act === 'dispatch') {
      sendWs({ t: act });
      S.modal = null;
      renderModal();
      return refresh();
    }
    if (act === 'premium') return toast('A conta Premium chega em breve na Loja.');
    if (act === 'deathback') {
      stopReplay();
      return openModal('morte');
    }
    if (act === 'revive') {
      stopReplay();
      S.modal = null;
      renderModal();
      showTown('temple');
      return refresh();
    }
    if (act === 'logout') return logout();
    if (act === 'chars') {
      if (S.ws) S.ws.close();
      S.ws = null;
      S.view = 'chars';
      try {
        S.chars = (await api('personagens')).personagens;
      } catch (e) {
        toast(e.message, 'erro');
      }
      return render();
    }
    if (act === 'add') {
      const sel = document.getElementById('addAction');
      const a = actionByName(sel.value);
      if (!a) return toast('Escolha uma ação na lista.');
      S.settings.bar.push({ action: a.name, enabled: true, conds: suggestedConds(a) });
      return markDirty();
    }
    if (act === 'sort') {
      S.settings.bar = S.settings.bar.map((s, i) => [s, i]).sort((x, y) => priority(x[0]) - priority(y[0]) || x[1] - y[1]).map((x) => x[0]);
      S.editing = -1;
      return markDirty();
    }
    if (act === 'reset') {
      const def = S.catalog.defaultBars?.[letterOf()];
      if (def) {
        S.settings.bar = JSON.parse(JSON.stringify(def));
        S.editing = -1;
        markDirty();
      }
      return;
    }
    if (act === 'save') {
      sendWs({ t: 'settings', settings: S.settings });
      S.savedSettings = JSON.stringify(S.settings);
      S.dirty = false;
      S.editing = -1;
      return renderTab();
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && S.modal && S.modal.k !== 'morte') closeModal();
  });

  $app.addEventListener('input', (ev) => {
    if (ev.target.id === 'shopSearch') {
      S.shopSearch = ev.target.value;
      const $l = document.getElementById('shopList');
      if ($l) $l.innerHTML = shopListHtml();
      return;
    }
    if (ev.target.id !== 'huntSearch') return;
    S.huntSearch = ev.target.value;
    const $l = document.getElementById('huntList');
    if ($l) $l.innerHTML = huntListHtml(liveNumbers().level || 1);
  });

  $app.addEventListener('change', (ev) => {
    const t = ev.target;
    const d = t.dataset;
    if (t.id === 'shopVoc' || t.id === 'shopLevel' || t.id === 'shopSort') {
      S[{ shopVoc: 'shopVoc', shopLevel: 'shopLevel', shopSort: 'shopSort' }[t.id]] = t.value;
      return renderTab();
    }
    if (t.id === 'huntClass') {
      S.huntClass = t.value;
      const $l = document.getElementById('huntList');
      if ($l) $l.innerHTML = huntListHtml(liveNumbers().level || 1);
      return;
    }
    if (d.autosell !== undefined) {
      S.settings.autosell = t.checked;
      sendWs({ t: 'settings', settings: S.settings });
      S.savedSettings = JSON.stringify(S.settings);
      return;
    }
    if (d.accond) {
      const [ci, key] = d.accond.split('.');
      const c = S.modal.conds[Number(ci)];
      if (key === 'pct') c.pct = t.checked;
      else if (key === 'val') c.val = Math.max(0, Math.floor(Number(t.value) || 0));
      else c[key] = t.value;
      if (key === 'subj') {
        c.attr = SUBJ_ATTRS[c.subj][0];
        c.pct = c.attr === 'hp' || c.attr === 'mana';
        c.op = c.subj === 'area' ? 'ge' : 'le';
      }
      if (key === 'attr' && !(c.attr === 'hp' || c.attr === 'mana')) c.pct = false;
      return renderModal();
    }
    if (d.acenabled !== undefined) {
      S.modal.enabled = t.checked;
      return;
    }
    if (d.quick) {
      S.settings[d.quick] = t.value;
      sendWs({ t: 'settings', settings: S.settings });
      S.savedSettings = JSON.stringify(S.settings);
      return refresh();
    }
    if (d.toggle !== undefined) {
      S.settings.bar[Number(d.toggle)].enabled = t.checked;
      return markDirty();
    }
    if (d.setSelect) {
      S.settings[d.setSelect] = t.value;
      return markDirty();
    }
    if (d.cond) {
      const [si, ci, key] = d.cond.split('.');
      const c = S.settings.bar[Number(si)].conds[Number(ci)];
      if (key === 'pct') c.pct = t.checked;
      else if (key === 'val') c.val = Math.max(0, Math.floor(Number(t.value) || 0));
      else c[key] = t.value;
      if (key === 'subj') {
        c.attr = SUBJ_ATTRS[c.subj][0];
        c.pct = c.attr === 'hp' || c.attr === 'mana';
        c.op = c.subj === 'area' ? 'ge' : 'le';
      }
      if (key === 'attr' && !(c.attr === 'hp' || c.attr === 'mana')) c.pct = false;
      return markDirty();
    }
  });

  $app.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(f));
      if (f.id === 'authForm') {
        const body = S.authMode === 'criar' ? { ...data, ...S.newChar } : data;
        const r = await api(S.authMode === 'criar' ? 'cadastrar' : 'entrar', body);
        S.token = r.token;
        store.set('dt_token', r.token);
        S.chars = r.personagens;
        if (S.authMode === 'criar' && S.chars.length) return enterGame(S.chars[0].name);
        S.view = 'chars';
        return render();
      }
      if (f.id === 'charForm') {
        const r = await api('personagens', { ...data, ...S.newChar });
        S.chars = r.personagens;
        toast('Personagem criado.', 'ok');
        return render();
      }
    } catch (e) {
      toast(e.message, 'erro');
    } finally {
      btn.disabled = false;
    }
  });

  // --------------------------------------------------------------------------
  // modo demonstracao (?demo=1): sem servidor, so para ver a tela
  // --------------------------------------------------------------------------
  // ?demo=1 comeca na cidade; &cacando=1 ja comeca cacando; &morte=1 morre 12 s depois de entrar
  const demoQ = new URLSearchParams(location.search);
  const demo = { t0: Date.now() / 1000, hunting: demoQ.has('cacando'), settings: null };
  function demoCatalog() {
    const a = (name, kind, voc, lvl, mana, cost, words = '') => ({ name, kind, voc, lvl, mana, cost, words, cd: 2000, group: 'attack', area: '' });
    const bar = [
      ['Magic Shield', 'self.hp.le.25.p'], ['Ultimate Healing', 'self.hp.le.55.p'], ['Intense Healing', 'self.hp.le.70.p'],
      ['Health Potion', 'self.hp.le.40.p'], ['Mana Potion', 'self.mana.le.30.p'], ['Rage of the Skies', 'area.targets.ge.4'],
      ['Energy Wave', 'area.targets.ge.3'], ['Great Energy Beam', 'area.targets.ge.2'], ['Strong Energy Strike', ''], ['Energy Strike', ''],
    ].map(([action, c]) => ({ action, enabled: true, conds: c ? [{ subj: c.split('.')[0], attr: c.split('.')[1], op: c.split('.')[2], val: Number(c.split('.')[3]), pct: c.endsWith('.p') }] : [] }));
    return {
      hunts: [
        { id: 'trolls', name: 'Colinas dos Trolls', min: 8, max: 28, lvl: { K: 8, P: 8, S: 8, D: 8 }, xpKill: 20, lootKill: 9, monsters: ['Troll'] },
        { id: 'ciclopes', name: 'Colinas dos Ciclopes', min: 8, max: 28, lvl: { K: 11, P: 8, S: 8, D: 8 }, xpKill: 150, lootKill: 32, monsters: ['Cyclops', 'Cyclops Drone', 'Cyclops Smith'] },
        { id: 'olhos', name: 'Caverna dos Olhos', min: 26, max: 78, lvl: { K: 37, P: 38, S: 26, D: 26 }, xpKill: 478, lootKill: 132, monsters: ['Bonelord', 'Elder Bonelord', 'Braindeath'] },
        { id: 'dragoes', name: 'Covil dos Dragões', min: 37, max: 104, lvl: { K: 52, P: 54, S: 37, D: 37 }, xpKill: 700, lootKill: 187, monsters: ['Dragon'] },
        { id: 'lordes', name: 'Pico dos Dragões Lordes', min: 62, max: 180, lvl: { K: 89, P: 93, S: 62, D: 62 }, xpKill: 2100, lootKill: 309, monsters: ['Dragon Lord'] },
      ],
      actions: [
        a('Light Healing', 'heal', 'SDP', 8, 20, 0, 'exura'), a('Intense Healing', 'heal', 'SDP', 20, 70, 0, 'exura gran'), a('Ultimate Healing', 'heal', 'SD', 30, 160, 0, 'exura vita'),
        a('Health Potion', 'potion', 'SDPK', 1, 0, 50), a('Mana Potion', 'potion', 'SDPK', 1, 0, 56), a('Lesser Health Potion', 'potion', 'SDPK', 1, 0, 0),
        a('Magic Shield', 'shield', 'SD', 14, 50, 0, 'utamo vita'), a('Energy Strike', 'attack', 'SD', 12, 20, 0, 'exori vis'), a('Strong Energy Strike', 'attack', 'S', 80, 60, 0, 'exori gran vis'),
        a('Energy Wave', 'area', 'S', 38, 170, 0, 'exevo vis hur'), a('Great Energy Beam', 'area', 'S', 29, 110, 0, 'exevo gran vis lux'), a('Rage of the Skies', 'area', 'S', 55, 600, 0, 'exevo gran mas vis'),
      ],
      solo: [
        { name: 'Dragon', class: 'Dragon', min: 34, lvl: { K: 50, P: 52, S: 34, D: 34 }, xpKill: 700, lootKill: 187 },
        { name: 'Dragon Hatchling', class: 'Dragon', min: 14, lvl: { K: 20, P: 20, S: 14, D: 14 }, xpKill: 185, lootKill: 40 },
        { name: 'Frost Dragon', class: 'Dragon', min: 70, lvl: { K: 110, P: 115, S: 70, D: 70 }, xpKill: 2100, lootKill: 420 },
        { name: 'Ghoul', class: 'Undead', min: 10, lvl: { K: 11, P: 9, S: 10, D: 10 }, xpKill: 85, lootKill: 21 },
        { name: 'Vampire', class: 'Undead', min: 40, lvl: { K: 60, P: 62, S: 40, D: 40 }, xpKill: 305, lootKill: 90 },
        { name: 'Cyclops', class: 'Giant', min: 8, lvl: { K: 10, P: 8, S: 8, D: 8 }, xpKill: 150, lootKill: 32 },
      ],
      shop: [
        { id: 3074, name: 'wand of vortex', kind: 'varinha', wtype: 'wand', voc: 'S', level: 6, price: 516, minDmg: 8, maxDmg: 18 },
        { id: 3075, name: 'wand of dragonbreath', kind: 'varinha', wtype: 'wand', voc: 'S', level: 13, price: 1314, minDmg: 13, maxDmg: 25 },
        { id: 3072, name: 'wand of decay', kind: 'varinha', wtype: 'wand', voc: 'S', level: 19, price: 5000, minDmg: 25, maxDmg: 37 },
        { id: 3073, name: 'wand of cosmic energy', kind: 'varinha', wtype: 'wand', voc: 'S', level: 26, price: 10000, minDmg: 37, maxDmg: 43 },
        { id: 3071, name: 'wand of inferno', kind: 'varinha', wtype: 'wand', voc: 'S', level: 33, price: 15000, minDmg: 56, maxDmg: 74 },
        { id: 8092, name: 'wand of starstorm', kind: 'varinha', wtype: 'wand', voc: 'S', level: 37, price: 18000, minDmg: 56, maxDmg: 74 },
        { id: 3359, name: 'brass armor', kind: 'armadura', wtype: 'armor', voc: 'SDPK', level: 9, price: 786, armor: 8 },
        { id: 3357, name: 'plate armor', kind: 'armadura', wtype: 'armor', voc: 'SDPK', level: 27, price: 4674, armor: 10 },
        { id: 8041, name: 'blue robe', kind: 'armadura', wtype: 'armor', voc: 'SD', level: 36, price: 8076, armor: 11 },
        { id: 3388, name: 'demon armor', kind: 'armadura', wtype: 'armor', voc: 'SDPK', level: 81, price: 39666, armor: 16 },
      ],
      pulls: ['cauteloso', 'ousado', 'agressivo'],
      maxUnwatchedHours: 12,
      defaultBars: { S: bar },
    };
  }
  function demoApi(path, body) {
    if (path === 'catalogo') return Promise.resolve(demoCatalog());
    if (path === 'personagens') return Promise.resolve({ personagens: [{ name: 'Julio Demo', level: 45, vocation: 'Master Sorcerer' }] });
    return Promise.resolve({ token: 'demo', personagens: [{ name: 'Julio Demo', level: 45, vocation: 'Master Sorcerer' }] });
  }
  function demoState() {
    const el = Date.now() / 1000 - demo.t0 + 1800;
    const wob = (k) => Math.abs(Math.sin(el / k));
    if (demo.hunting && demo.dieAt && Date.now() > demo.dieAt) {
      demo.hunting = false;
      demo.died = true;
      demo.dieAt = 0;
    }
    const idle = demo.hunting ? {
      hunting: true, hunt: 'ciclopes', huntName: 'Colinas dos Ciclopes', elapsed: el, level: 45, exp: expFor(45) + Math.floor(el * 30),
      hp: Math.floor(245 * (0.55 + 0.45 * wob(7))), maxHp: 245, mana: Math.floor(1195 * (0.4 + 0.6 * wob(11))), maxMana: 1195, stamina: 2400, bank: 48210 + Math.floor(el * 3),
      xp: Math.floor(el * 30), xpHour: 108000, loot: Math.floor(el * 5), supplies: Math.floor(el * 1.4), profit: Math.floor(el * 3.6), profitHour: 12960,
      kills: { Cyclops: 41, 'Cyclops Drone': 17, 'Cyclops Smith': 9 }, killCount: 67,
      room: 'dragoes',
      me: { x: 0, y: 0, dir: Math.floor(el / 3) % 4, look: { t: 128, h: 78, b: 69, l: 58, f: 76 } },
      monsters: [
        { id: 11, name: 'Dragon', hp: Math.floor(1000 * wob(5)), max: 1000, dist: 1, target: true, x: 1, y: Math.round(Math.sin(el / 2)), dir: 3, look: { t: 34 } },
        { id: 12, name: 'Dragon', hp: 1000, max: 1000, dist: 2, target: false, x: -2 + (Math.floor(el / 2) % 2), y: 1, dir: 1, look: { t: 34 } },
        { id: 13, name: 'Dragon', hp: Math.floor(1000 * (0.3 + 0.7 * wob(9))), max: 1000, dist: 3, target: false, x: 0, y: -2, dir: 2, look: { t: 34 } },
      ],
      fx: [
        { k: 'cast', n: 'Energy Strike', kind: 'attack', e: 'energy', to: 11 },
        { k: 'dmg', id: 11, v: 60 + Math.floor(Math.random() * 90) },
        { k: 'hurt', v: 20 + Math.floor(Math.random() * 60) },
        ...(Math.random() < 0.3 ? [{ k: 'xp', v: 700 }] : []),
        ...(Math.random() < 0.25 ? [{ k: 'cast', n: 'Great Energy Beam', kind: 'area', e: 'energy' }] : []),
      ],
      log: ['18:40:01 Cacada iniciada: Colinas dos Ciclopes', '18:40:07 Cyclops tirou 42 de vida', '18:40:09 Voce matou Cyclops', '18:40:12 Cyclops Smith tirou 67 de vida'],
      lastLoot: ['Cyclops: 64 gp (battle shield)', 'Cyclops Smith: 112 gp (cyclops toe)', 'Cyclops: 21 gp'],
      settings: { pull: 'ousado', target: 'perto', distance: 3, stance: 'equilibrado' },
    } : demo.died ? { hunting: false, reason: 'morte', killer: 'Dragon', huntName: 'Covil dos Dragões', elapsed: 40, xp: 2100, killCount: 3, loot: 420, supplies: 300, kills: { Dragon: 3 },
      log: ['18:41:02 Dragon tirou 120 de vida', '18:41:03 Voce curou 160', '18:41:04 Dragon tirou 210 de vida', '18:41:05 Dragon tirou 190 de vida', '18:41:06 Voce morreu para Dragon'] }
      : { hunting: false, reason: 'parada pelo jogador', elapsed: 1800, xp: 54000, profit: 6480, killCount: 67, loot: 9000, supplies: 2520, kills: { Cyclops: 41 } };
    const gear = { updated: demo.gearAt || 1, msg: demo.gearMsg, slots: demo.slots || { mao1: { id: 3075, name: 'wand of dragonbreath', count: 1 }, armadura: { id: 3359, name: 'brass armor', armor: 8, count: 1 }, capacete: { id: 7992, name: 'mage hat', armor: 2, count: 1 }, calcas: { id: 3362, name: 'studded legs', armor: 2, count: 1 }, botas: { id: 3552, name: 'leather boots', armor: 1, count: 1 } } };
    if (!demo.bag) demo.bag = { 3582: 6, 3577: 9, 5877: 2, 5920: 3, 3351: 1, 3349: 1, 3409: 2, 3416: 1, 3607: 12 };
    const DEMO_ITEMS = { 3582: ['ham', 2, 300], 3577: ['meat', 2, 1300], 5877: ['green dragon leather', 100, 400], 5920: ['green dragon scale', 100, 400], 3351: ['steel helmet', 293, 4600], 3349: ['crossbow', 120, 4000], 3409: ['steel shield', 80, 6900], 3416: ['dragon shield', 4000, 6000], 3607: ['cheese', 2, 400] };
    const bag = {
      updated: demo.bagAt || 1, msg: demo.bagMsg, dispatchAt: demo.dispatchAt || 0, cooldown: 3600, cap: 85000,
      items: Object.entries(demo.bag).map(([id, count]) => ({ id: Number(id), count, name: DEMO_ITEMS[id][0], price: DEMO_ITEMS[id][1], weight: DEMO_ITEMS[id][2] })),
    };
    bag.weight = bag.items.reduce((a, it) => a + it.weight * it.count, 0);
    return { t: 'state', online: demo.hunting, town: demoTown(), players: 1284, premium: demoQ.has('premium'), now: Math.floor(Date.now() / 1000), bag, gear, player: { name: 'Julio Demo', vocation: 'Master Sorcerer', letter: 'S', level: 45, exp: expFor(45) + 1000, hp: 245, maxHp: 245, mana: 1195, maxMana: 1195, bank: 48210, stamina: 2400, magic: 38, skills: { fist: 10, club: 10, sword: 10, axe: 10, distance: 12, shielding: 20 }, look: { t: 128, h: 78, b: 69, l: 58, f: 76 } }, idle };
  }
  // a cidade da demonstracao: o personagem anda (clique/teclado) e o povo de Thais vive em volta
  function demoTownStart() {
    if (demo.town || !window.Povo) return;
    demo.town = { x: 4, y: 11, dir: 2, queue: [], next: 0 };
    fetch('salas/cidade.json').then((r) => r.json()).then((c) => {
      demo.povo = window.Povo.create(c);
      demo.povo.setHunts(demoCatalog().hunts.map((h) => ({ name: h.name, min: h.min })));
      demo.povo.onChat = (m) => onMessage({ t: 'chat', m: { ...m, at: Date.now() } });
      const t = c.points && c.points.temple;
      if (t) { demo.town.x = t[0]; demo.town.y = t[1]; }
      demo.fxAt = Date.now();
    }).catch(() => {});
    setInterval(() => {
      const now = Date.now(), T = demo.town;
      if (!demo.povo) return;
      demo.povo.tick(now);
      if (T.queue.length && now >= T.next) {
        const [dx, dy] = T.queue.shift();
        const nx = T.x + Math.sign(dx), ny = T.y + Math.sign(dy);
        if (!demo.povo.walk.has(nx + ',' + ny)) { T.queue = []; return; }
        T.x = nx; T.y = ny;
        T.dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
        const ms = demoStepMs(45) * (dx && dy ? 3 : 1);
        T.next = now + ms;
        T.trail = [...(T.trail || []), [T.x, T.y, 0, ms, now]].filter((t) => now - t[4] < 2000).slice(-12);
      }
    }, 100);
  }
  // o mesmo calculo do Canary: velocidade do level numa curva (log) e o chao (150 = comum)
  function demoStepMs(level) {
    const calc = Math.max(1, Math.floor(857.36 * Math.log(220 + level - 1 + 261.29) - 4795.01 + 0.5));
    return Math.ceil(Math.floor((1000 * 150) / calc) / 50) * 50;
  }
  function demoTown() {
    const T = demo.town;
    if (demo.hunting || !T || !demo.povo) return null;
    const now = Date.now();
    const fx = demo.povo.events(demo.fxAt, T.x, T.y, 14, 11, now);
    demo.fxAt = now;
    const trail = (T.trail || []).map((t) => t.slice(0, 4));
    return { me: { x: T.x, y: T.y, z: 0, dir: T.dir, look: { t: 128, h: 78, b: 69, l: 58, f: 76 }, trail, ms: demoStepMs(45) }, hp: 245, maxHp: 245, players: demo.povo.near(T.x, T.y), fx };
  }
  function demoConnect() {
    demoTownStart();
    if (!demo.settings) demo.settings = { hunt: 'ciclopes', pull: 'ousado', target: 'perto', distance: 3, stance: 'equilibrado', bar: JSON.parse(JSON.stringify(demoCatalog().defaultBars.S)) };
    onMessage({ t: 'settings', settings: JSON.parse(JSON.stringify(demo.settings)) });
    onMessage(demoState());
    clearInterval(demo.timer);
    demo.timer = setInterval(() => onMessage(demoState()), 400);
  }
  function demoSend(o) {
    if (o.t === 'stop') {
      demo.hunting = false;
      onMessage({ t: 'msg', text: 'Saindo da caçada…' });
      if (demo.town && demo.povo) { demo.town.x = demo.povo.flame[0]; demo.town.y = demo.povo.flame[1]; demo.town.queue = []; }
    }
    if (o.t === 'step' && demo.town) demo.town.queue = [[o.dx, o.dy]];
    if (o.t === 'walkto' && demo.town && demo.povo) {
      // como o servidor: caminho a partir de onde o personagem esta agora
      const T = demo.town;
      let px = T.x, py = T.y;
      const path = demo.povo.path([T.x, T.y], [o.x, o.y]) || [];
      T.queue = path.map(([x, y]) => { const d = [x - px, y - py]; px = x; py = y; return d; });
    }
    if (o.t === 'stopwalk' && demo.town) demo.town.queue = [];
    if (o.t === 'chat') {
      onMessage({ t: 'chat', m: { ch: o.ch, name: 'Julio Demo', lv: 45, voc: 'MS', text: o.text, at: Date.now(), pid: 0 } });
    }
    if (o.t === 'start') {
      demo.hunting = true;
      demo.died = false;
      demo.t0 = Date.now() / 1000;
      if (demoQ.has('morte')) demo.dieAt = Date.now() + 12000;
      onMessage({ t: 'msg', text: 'Entrando na caçada…' });
    }
    if (o.t === 'buy') {
      const it = demoCatalog().shop.find((x) => x.id === o.id);
      demo.slots = demo.slots || demoState().gear.slots;
      if (it.kind === 'varinha') demo.slots.mao1 = { id: it.id, name: it.name, count: 1 };
      else demo.slots[it.kind] = { id: it.id, name: it.name, armor: it.armor, count: 1 };
      demo.gearAt = Date.now();
      demo.gearMsg = { ok: true, text: 'Comprou ' + it.name + ' por ' + it.price + ' gp.', at: Date.now() };
    }
    if (o.t === 'sell' || o.t === 'dispatch') {
      const keep = new Set(demo.settings?.keep || []);
      let total = 0, n = 0;
      const DEMO_PRICE = { 3582: 2, 3577: 2, 5877: 100, 5920: 100, 3351: 293, 3349: 120, 3409: 80, 3416: 4000, 3607: 2 };
      for (const [id, count] of Object.entries(demo.bag || {})) if (!keep.has(Number(id))) { total += DEMO_PRICE[id] * count; n += count; delete demo.bag[id]; }
      if (o.t === 'dispatch') demo.dispatchAt = Math.floor(Date.now() / 1000) + 3600;
      demo.bagAt = Date.now();
      demo.bagMsg = { ok: !!n, at: Date.now(), text: n ? `${o.t === 'sell' ? 'Venda rápida' : 'Despachou'} ${n} itens por ${total} gold.` : 'Nada marcado para vender.' };
    }
    if (o.t === 'settings') { demo.settings = JSON.parse(JSON.stringify(o.settings)); onMessage({ t: 'msg', text: 'Configuração salva.', kind: 'ok' }); }
  }

  // --------------------------------------------------------------------------
  // inicio
  // --------------------------------------------------------------------------
  (async () => {
    if (DEMO) {
      S.token = 'demo';
      return enterGame('Julio Demo');
    }
    if (S.token) {
      try {
        S.chars = (await api('personagens')).personagens;
        if (S.char && S.chars.some((c) => c.name === S.char)) return enterGame(S.char);
        S.view = 'chars';
      } catch {
        S.view = 'auth';
      }
    }
    render();
  })();
})();
