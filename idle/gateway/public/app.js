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
  function render() {
    if (S.view === 'auth') return renderAuth();
    if (S.view === 'chars') return renderChars();
    return renderGame();
  }

  function renderAuth() {
    const m = S.authMode;
    $app.innerHTML = `
      <div class="brand"><h1>DESTRUITOR</h1><p>Caçadas automáticas no navegador — no PC e no celular</p></div>
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
        </form>
      </div>`;
  }

  function charFields() {
    const n = S.newChar;
    return `
      <label class="field" for="nome">Nome do personagem</label>
      <input id="nome" name="name" type="text" maxlength="20" required placeholder="Ex.: Julio Amancio">
      <label class="field">Vocação</label>
      <div class="pick">${VOCS.map((v) => `<button type="button" data-voc="${v.id}" class="${n.vocation === v.id ? 'on' : ''}"><b>${v.name}</b><small>${v.desc}</small></button>`).join('')}</div>
      <label class="field">Sexo</label>
      <div class="seg"><button type="button" data-sex="male" class="${n.sex === 'male' ? 'on' : ''}">Masculino</button><button type="button" data-sex="female" class="${n.sex === 'female' ? 'on' : ''}">Feminino</button></div>`;
  }

  function renderChars() {
    $app.innerHTML = `
      <div class="brand"><h1>DESTRUITOR</h1><p>Escolha seu personagem</p></div>
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

  function renderGame() {
    const tab = S.tab;
    const tabs = [
      ['cacada', '⚔', 'Caçada'],
      ['barra', '☰', 'Barra'],
      ['analisador', '📈', 'Analisador'],
      ['personagem', '👤', 'Personagem'],
    ];
    $app.innerHTML = `
      <div class="hud" id="hud"></div>
      <nav class="nav">${tabs.map(([id, ic, t]) => `<button data-tab="${id}" class="${tab === id ? 'on' : ''}"><span class="ic">${ic}</span>${t}</button>`).join('')}</nav>
      <div id="tabBody"></div>`;
    renderHud();
    renderTab();
  }

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

  function renderHud() {
    const $h = document.getElementById('hud');
    if (!$h) return;
    if (!S.live) {
      $h.innerHTML = `<div class="who"><b>${esc(S.char)}</b><span class="badge off">conectando…</span></div>`;
      return;
    }
    const n = liveNumbers();
    const i = S.live.idle;
    const lvA = expFor(n.level), lvB = expFor(n.level + 1);
    const status = i && i.hunting ? `<span class="badge live">caçando</span>` : `<span class="badge off">na cidade</span>`;
    $h.innerHTML = `
      <div class="who"><div><b>${esc(n.name)}</b> <span class="muted small">${esc(n.vocation)} · Lv ${n.level}</span></div>${status}</div>
      <div class="bars">
        <div class="bar hp"><i style="width:${pct(n.hp, n.maxHp)}%"></i><span>${fmt(n.hp)} / ${fmt(n.maxHp)}</span></div>
        <div class="bar mana"><i style="width:${pct(n.mana, n.maxMana)}%"></i><span>${fmt(n.mana)} / ${fmt(n.maxMana)}</span></div>
        <div class="bar xp"><i style="width:${pct(n.exp - lvA, lvB - lvA)}%"></i><span>${pct(n.exp - lvA, lvB - lvA).toFixed(1).replace('.', ',')}% para o level ${n.level + 1}</span></div>
      </div>
      <div class="stats"><span>Gold <b>${fmt(n.bank)}</b></span><span>Stamina <b>${hm(n.stamina || 0)}</b></span>${i && i.hunting ? `<span>XP/h <b>${kfmt(i.xpHour)}</b></span><span>Lucro/h <b class="${i.profitHour >= 0 ? 'pos' : 'neg'}">${kfmt(i.profitHour)}</b></span>` : ''}</div>`;
  }

  function renderTab() {
    const $b = document.getElementById('tabBody');
    if (!$b) return;
    if (S.tab === 'cacada') $b.innerHTML = tabCacada();
    else if (S.tab === 'barra') $b.innerHTML = tabBarra();
    else if (S.tab === 'analisador') $b.innerHTML = tabAnalisador();
    else $b.innerHTML = tabPersonagem();
  }

  // ---- caçada ----
  function tabCacada() {
    if (!S.live || !S.catalog) return '<div class="card muted">Carregando…</div>';
    const i = S.live.idle;
    const level = liveNumbers().level;
    if (i && i.hunting) {
      const mobs = (i.monsters || []).slice().sort((a, b) => (b.target ? 1 : 0) - (a.target ? 1 : 0));
      return `
        <div class="game-grid">
          <div>
            <div class="card">
              <div class="spread"><h2 style="margin:0">${esc(i.huntName)}</h2><span class="muted small">${dur(i.elapsed)}</span></div>
              <div class="row small muted" style="margin:6px 0 12px">Pull <b>${PULL[i.settings?.pull] || ''}</b> · Alvo <b>${TARGET[i.settings?.target] || ''}</b></div>
              <div class="mobs">
                ${mobs.length ? mobs.map((m) => `
                  <div class="mob ${m.target ? 'target' : ''}">
                    <div class="n">${m.target ? '⚔ ' : ''}${esc(m.name)} <small>· ${m.dist} sqm</small></div>
                    <div class="bar mob"><i style="width:${pct(m.hp, m.max)}%"></i></div>
                  </div>`).join('') : '<div class="muted small">Próximo pull chegando…</div>'}
              </div>
              ${i.noGold ? '<p class="small" style="color:var(--bad)">Sem gold para as poções pagas: só as grátis estão sendo usadas.</p>' : ''}
              <button class="btn danger block" data-act="stop">Parar caçada</button>
            </div>
          </div>
          <div>
            <div class="card"><h2>Combate</h2><div class="log">${(i.log || []).slice().reverse().map((l) => `<div>${esc(l)}</div>`).join('') || '<span class="muted">—</span>'}</div></div>
            <div class="card"><h2>Loot</h2><div class="log">${(i.lastLoot || []).map((l) => `<div>${esc(l)}</div>`).join('') || '<span class="muted">Nada ainda.</span>'}</div></div>
          </div>
        </div>`;
    }
    const hunts = S.catalog.hunts.slice().sort((a, b) => a.min - b.min);
    const last = i && !i.hunting && i.reason ? `
      <div class="card">
        <h2>Última caçada</h2>
        <p style="margin:0 0 8px">${esc(REASON[i.reason] || i.reason)}</p>
        ${i.elapsed ? `<div class="kpis">
          <div class="kpi"><span>Tempo</span><b>${dur(i.elapsed)}</b></div>
          <div class="kpi"><span>XP</span><b>${kfmt(i.xp)}</b></div>
          <div class="kpi"><span>Lucro</span><b class="${(i.profit || 0) >= 0 ? 'pos' : 'neg'}">${kfmt(i.profit)}</b></div>
          <div class="kpi"><span>Abates</span><b>${fmt(i.killCount)}</b></div>
        </div>` : ''}
      </div>` : '';
    return `
      ${last}
      <div class="card">
        <h2>Escolha uma caçada</h2>
        <p class="muted small" style="margin-top:-4px">Seu personagem luta sozinho, seguindo a sua barra de regras. Você pode fechar a página: ele continua caçando por até ${S.catalog.maxUnwatchedHours || 12} horas.</p>
        <div class="hunts">
          ${hunts.map((h) => {
            const rec = level >= h.min && level <= h.max;
            return `<div class="hunt ${rec ? 'rec' : ''}">
              <div><div class="name">${esc(h.name)} ${rec ? '<span class="badge warn">recomendada</span>' : ''}</div>
              <div class="meta">Level ${h.min}–${h.max >= 999 ? '+' : h.max} · ${h.monsters.map(esc).join(', ')}</div></div>
              <button class="btn ${rec ? 'primary' : ''}" data-hunt="${h.id}">Caçar</button>
            </div>`;
          }).join('')}
        </div>
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
          <span class="num">${idx + 1}</span>
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
  function tabPersonagem() {
    const p = S.live?.player;
    if (!p) return '<div class="card muted">Carregando…</div>';
    const n = liveNumbers();
    const sk = p.skills || {};
    return `
      <div class="card">
        <h2>${esc(p.name)}</h2>
        <table class="simple">
          <tr><td>Vocação</td><td>${esc(p.vocation)}</td></tr>
          <tr><td>Level</td><td>${n.level}</td></tr>
          <tr><td>Experiência</td><td>${fmt(n.exp)}</td></tr>
          <tr><td>Magic level</td><td>${p.magic}</td></tr>
          <tr><td>Punho</td><td>${sk.fist}</td></tr>
          <tr><td>Clava</td><td>${sk.club}</td></tr>
          <tr><td>Espada</td><td>${sk.sword}</td></tr>
          <tr><td>Machado</td><td>${sk.axe}</td></tr>
          <tr><td>Distância</td><td>${sk.distance}</td></tr>
          <tr><td>Escudo</td><td>${sk.shielding}</td></tr>
          <tr><td>Gold no banco</td><td>${fmt(n.bank)}</td></tr>
          <tr><td>Stamina</td><td>${hm(n.stamina || 0)}</td></tr>
        </table>
        <p class="muted small">Skills e magic level atualizam quando o personagem sai do jogo (fim da caçada).</p>
      </div>
      <div class="row">
        <button class="btn" data-act="chars">Trocar de personagem</button>
        <button class="btn" data-act="logout">Sair da conta</button>
      </div>`;
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
      const was = S.live?.idle?.hunting;
      S.live = m;
      renderHud();
      if (S.tab !== 'barra' || !S.settings) renderTab();
      if (was && !m.idle?.hunting && m.idle?.reason) toast(REASON[m.idle.reason] || m.idle.reason, m.idle.reason === 'morte' ? 'erro' : 'info');
    } else if (m.t === 'settings') {
      if (!S.dirty) {
        S.settings = m.settings;
        if (S.tab === 'barra') renderTab();
      }
    } else if (m.t === 'msg') {
      toast(m.text, m.kind);
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
  }

  async function enterGame(name) {
    S.char = name;
    store.set('dt_char', name);
    S.view = 'game';
    S.live = null;
    S.settings = null;
    S.dirty = false;
    S.editing = -1;
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
    if (d.tab) {
      S.tab = d.tab;
      store.set('dt_tab', d.tab);
      document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === d.tab));
      return renderTab();
    }
    if (d.hunt) return sendWs({ t: 'start', hunt: d.hunt });
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
    if (act === 'stop') return sendWs({ t: 'stop' });
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
      S.dirty = false;
      S.editing = -1;
      return renderTab();
    }
  });

  $app.addEventListener('change', (ev) => {
    const t = ev.target;
    const d = t.dataset;
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
  const demo = { t0: Date.now() / 1000, hunting: true, settings: null };
  function demoCatalog() {
    const a = (name, kind, voc, lvl, mana, cost, words = '') => ({ name, kind, voc, lvl, mana, cost, words, cd: 2000, group: 'attack', area: '' });
    const bar = [
      ['Magic Shield', 'self.hp.le.25.p'], ['Ultimate Healing', 'self.hp.le.55.p'], ['Intense Healing', 'self.hp.le.70.p'],
      ['Health Potion', 'self.hp.le.40.p'], ['Mana Potion', 'self.mana.le.30.p'], ['Rage of the Skies', 'area.targets.ge.4'],
      ['Energy Wave', 'area.targets.ge.3'], ['Great Energy Beam', 'area.targets.ge.2'], ['Strong Energy Strike', ''], ['Energy Strike', ''],
    ].map(([action, c]) => ({ action, enabled: true, conds: c ? [{ subj: c.split('.')[0], attr: c.split('.')[1], op: c.split('.')[2], val: Number(c.split('.')[3]), pct: c.endsWith('.p') }] : [] }));
    return {
      hunts: [
        { id: 'esgoto', name: 'Esgoto de Thais', min: 8, max: 20, monsters: ['Cave Rat', 'Bat', 'Snake', 'Spider'] },
        { id: 'trolls', name: 'Colinas dos Trolls', min: 10, max: 30, monsters: ['Troll', 'Island Troll', 'Frost Troll', 'Goblin'] },
        { id: 'ciclopes', name: 'Colinas dos Ciclopes', min: 40, max: 80, monsters: ['Cyclops', 'Cyclops Drone', 'Cyclops Smith'] },
        { id: 'dragoes', name: 'Covil dos Dragoes', min: 60, max: 110, monsters: ['Dragon'] },
      ],
      actions: [
        a('Light Healing', 'heal', 'SDP', 8, 20, 0, 'exura'), a('Intense Healing', 'heal', 'SDP', 20, 70, 0, 'exura gran'), a('Ultimate Healing', 'heal', 'SD', 30, 160, 0, 'exura vita'),
        a('Health Potion', 'potion', 'SDPK', 1, 0, 50), a('Mana Potion', 'potion', 'SDPK', 1, 0, 56), a('Lesser Health Potion', 'potion', 'SDPK', 1, 0, 0),
        a('Magic Shield', 'shield', 'SD', 14, 50, 0, 'utamo vita'), a('Energy Strike', 'attack', 'SD', 12, 20, 0, 'exori vis'), a('Strong Energy Strike', 'attack', 'S', 80, 60, 0, 'exori gran vis'),
        a('Energy Wave', 'area', 'S', 38, 170, 0, 'exevo vis hur'), a('Great Energy Beam', 'area', 'S', 29, 110, 0, 'exevo gran vis lux'), a('Rage of the Skies', 'area', 'S', 55, 600, 0, 'exevo gran mas vis'),
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
    const idle = demo.hunting ? {
      hunting: true, hunt: 'ciclopes', huntName: 'Colinas dos Ciclopes', elapsed: el, level: 45, exp: expFor(45) + Math.floor(el * 30),
      hp: Math.floor(245 * (0.55 + 0.45 * wob(7))), maxHp: 245, mana: Math.floor(1195 * (0.4 + 0.6 * wob(11))), maxMana: 1195, stamina: 2400, bank: 48210 + Math.floor(el * 3),
      xp: Math.floor(el * 30), xpHour: 108000, loot: Math.floor(el * 5), supplies: Math.floor(el * 1.4), profit: Math.floor(el * 3.6), profitHour: 12960,
      kills: { Cyclops: 41, 'Cyclops Drone': 17, 'Cyclops Smith': 9 }, killCount: 67,
      monsters: [
        { name: 'Cyclops', hp: Math.floor(260 * wob(5)), max: 260, dist: 1, target: true },
        { name: 'Cyclops Drone', hp: 325, max: 325, dist: 2, target: false },
        { name: 'Cyclops Smith', hp: Math.floor(435 * (0.3 + 0.7 * wob(9))), max: 435, dist: 3, target: false },
      ],
      log: ['18:40:01 Cacada iniciada: Colinas dos Ciclopes', '18:40:07 Cyclops tirou 42 de vida', '18:40:09 Voce matou Cyclops', '18:40:12 Cyclops Smith tirou 67 de vida'],
      lastLoot: ['Cyclops: 64 gp (battle shield)', 'Cyclops Smith: 112 gp (cyclops toe)', 'Cyclops: 21 gp'],
      settings: { pull: 'ousado', target: 'perto', distance: 3, stance: 'equilibrado' },
    } : { hunting: false, reason: 'parada pelo jogador', elapsed: 1800, xp: 54000, profit: 6480, killCount: 67, loot: 9000, supplies: 2520, kills: { Cyclops: 41 } };
    return { t: 'state', online: demo.hunting, player: { name: 'Julio Demo', vocation: 'Master Sorcerer', letter: 'S', level: 45, exp: expFor(45) + 1000, hp: 245, maxHp: 245, mana: 1195, maxMana: 1195, bank: 48210, stamina: 2400, magic: 38, skills: { fist: 10, club: 10, sword: 10, axe: 10, distance: 12, shielding: 20 } }, idle };
  }
  function demoConnect() {
    if (!demo.settings) demo.settings = { hunt: 'ciclopes', pull: 'ousado', target: 'perto', distance: 3, stance: 'equilibrado', bar: JSON.parse(JSON.stringify(demoCatalog().defaultBars.S)) };
    onMessage({ t: 'settings', settings: JSON.parse(JSON.stringify(demo.settings)) });
    onMessage(demoState());
    clearInterval(demo.timer);
    demo.timer = setInterval(() => onMessage(demoState()), 1000);
  }
  function demoSend(o) {
    if (o.t === 'stop') { demo.hunting = false; onMessage({ t: 'msg', text: 'Saindo da caçada…' }); }
    if (o.t === 'start') { demo.hunting = true; demo.t0 = Date.now() / 1000; onMessage({ t: 'msg', text: 'Entrando na caçada…' }); }
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
