'use strict';
/*
 * Destruitor Idle — botoes AUTO de colar e anel na janela Inventario (como no Huntera).
 *
 * A barra e a ordem: a cada segundo de luta, da esquerda para a direita, a primeira peca ligada cujas
 * condicoes valem e que o personagem carrega vai para o slot (o servidor faz a troca: idle_acessorios.lua).
 * Aqui: o botao AUTO (acima do colar e abaixo do anel) e a janela "Seus colares" / "Seus anéis".
 *
 * Fala com a pagina por window.IdleApp (exposto no fim do app.js) e com a ponte pela mensagem
 * {t:'acessorios', cfg:{colar:[{id, on, conds, near}], anel:[...]}} (gateway/acessorios.js).
 * O catalogo das pecas (nomes, bonus, duracao) vem de itens/acessorios.json (tools/acessorios.py).
 */
(() => {
  const SLOT = {
    colar: { title: 'Seus colares', gear: 'amuleto', one: 'colar', many: 'colares', ligado: 'ligado', ligados: 'ligados' },
    anel: { title: 'Seus anéis', gear: 'anel', one: 'anel', many: 'anéis', ligado: 'ligado', ligados: 'ligados' },
  };
  const SUBJ = { self: 'Você', target: 'Alvo', area: 'Área' };
  const ATTR = { hp: 'HP', mana: 'Mana', shield: 'Magic shield', targets: 'Alvos' };
  const SUBJ_ATTRS = { self: ['hp', 'mana', 'shield'], target: ['hp'], area: ['targets'] };
  const OPS_TXT = { lt: 'menor que', le: 'menor ou igual a', eq: 'igual a', ge: 'maior ou igual a', gt: 'maior que' };
  const VOC = { K: 'Knight', P: 'Paladin', S: 'Sorcerer', D: 'Druid' };
  const MAX_RULES = 20, MAX_CONDS = 8, MAX_NEAR = 5;
  const INTRO = 'A barra é a ordem: a cada segundo de luta, da esquerda para a direita, a primeira peça cujas condições valem e que você carrega é a que fica no slot; se nenhuma vale, o slot fica vazio. Área conta os monstros que estão te atacando.';

  const A = { cfg: null, char: null, cat: null, catErr: false, catLoading: null, m: null };
  const app = () => window.IdleApp || {};
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (id, cls) => (app().icon ? app().icon(id, cls) : '');
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const emptyCfg = () => ({ colar: [], anel: [] });
  // "might ring" -> "Might Ring"; "amulet of loss" -> "Amulet of Loss"
  const nice = (n) => String(n || '').replace(/(^|[\s(])([a-z])/g, (m, s, c) => s + c.toUpperCase()).replace(/ (Of|The|And) /g, (w) => w.toLowerCase());

  // ---------------------------------------------------------------- dados
  function loadCatalog() {
    if (A.cat || A.catLoading) return A.catLoading;
    A.catLoading = fetch('itens/acessorios.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((d) => {
        const list = d.itens || [];
        A.cat = { list, byId: new Map(list.map((e) => [e.id, e])), byEquip: new Map(list.filter((e) => e.equip).map((e) => [e.equip, e])) };
        if (A.m) render();
      })
      .catch(() => {
        A.catErr = true;
        if (A.m) render();
      })
      .finally(() => (A.catLoading = null));
    return A.catLoading;
  }

  const myCfg = () => (A.cfg && A.char === app().S?.char ? A.cfg : emptyCfg());

  // o que o personagem carrega: mochila do loot + mochila de verdade (gear.acc.pack, do servidor)
  function carried() {
    const S = app().S || {};
    const m = new Map();
    const add = (id, n) => m.set(id, (m.get(id) || 0) + n);
    for (const it of S.live?.bag?.items || []) add(it.id, it.count);
    for (const p of S.live?.gear?.acc?.pack || []) add(p.id, p.n);
    return m;
  }
  // a peca que esta no slot agora (o servidor manda o id "de guardar"; sem isso, o id do slot)
  function wornId(slot) {
    const gear = app().S?.live?.gear;
    if (gear?.acc && gear.acc[slot] != null) return gear.acc[slot] || 0;
    const it = gear?.slots?.[SLOT[slot].gear];
    if (!it) return 0;
    const e = A.cat && (A.cat.byId.get(it.id) || A.cat.byEquip.get(it.id));
    return e ? e.id : it.id;
  }
  function blocked(e) {
    const level = app().liveNumbers ? app().liveNumbers().level || 1 : 1;
    const letter = app().letterOf ? app().letterOf() : '';
    // sem vocacao (rookie, ate o level 8) tambem nao veste peca de vocacao
    if (e.voc && (!letter || !e.voc.includes(letter))) return `Só para ${e.voc.split('').map((v) => VOC[v]).join(' e ')}`;
    if (e.level && level < e.level) return `Precisa do level ${e.level}`;
    return '';
  }
  function monsterNames() {
    if (A.monsters) return A.monsters;
    const c = app().S?.catalog;
    if (!c) return [];
    const set = new Set();
    for (const m of c.solo || []) set.add(m.name);
    for (const h of c.hunts || []) for (const n of h.monsters || []) set.add(n);
    A.monsters = [...set].sort((a, b) => a.localeCompare(b));
    return A.monsters;
  }

  // ---------------------------------------------------------------- botao AUTO (Inventario)
  function autoBtn(slot) {
    const on = (myCfg()[slot] || []).filter((r) => r.on).length;
    const d = SLOT[slot];
    const tip = on ? `${on} ${on === 1 ? d.one + ' ' + d.ligado : d.many + ' ' + d.ligados} — a barra cuida do slot` : `Colocar ${d.one === 'colar' ? 'o colar' : 'o anel'} sozinho: escolha as peças e quando usar`;
    return `<button type="button" class="acc-auto acc-${slot} ${on ? 'on' : ''}" data-acc-open="${slot}" title="${esc(tip)}">AUTO</button>`;
  }

  // ---------------------------------------------------------------- janela
  function open(slot) {
    if (!SLOT[slot]) return;
    const draft = clone(myCfg());
    const rules = draft[slot];
    const worn = wornId(slot);
    const first = rules.find((r) => r.on) || rules[0];
    A.m = { slot, draft, saved: JSON.stringify(draft), sel: first ? first.id : worn || 0, q: '', only: false };
    loadCatalog();
    render();
  }

  function close(save = true) {
    const m = A.m;
    if (!m) return;
    A.m = null;
    document.getElementById('accModal')?.remove();
    if (save && JSON.stringify(m.draft) !== m.saved) send(m.draft);
  }

  function send(cfg) {
    A.cfg = clone(cfg);
    A.char = app().S?.char;
    if (app().DEMO) return app().toast && app().toast('Colares e anéis salvos.', 'ok');
    if (app().sendWs) app().sendWs({ t: 'acessorios', cfg });
  }

  const rulesOf = () => A.m.draft[A.m.slot];
  const ruleOf = (id) => rulesOf().find((r) => r.id === id);
  function ensureRule(id) {
    let r = ruleOf(id);
    if (!r) {
      if (rulesOf().length >= MAX_RULES) {
        app().toast?.(`No máximo ${MAX_RULES} peças por barra.`, 'erro');
        return null;
      }
      r = { id, on: true, conds: [], near: [] };
      rulesOf().push(r);
    }
    return r;
  }

  function host() {
    let el = document.getElementById('accModal');
    if (el) return el;
    const parent = document.querySelector('.g') || document.body;
    el = document.createElement('div');
    el.id = 'accModal';
    parent.appendChild(el);
    return el;
  }

  function render() {
    const m = A.m;
    if (!m) return;
    const d = SLOT[m.slot];
    if (!m.sel && A.cat) {
      // nada escolhido ainda: a primeira peca que carrega (ou a primeira da lista)
      const have = carried();
      const e = A.cat.list.find((x) => x.slot === m.slot && have.get(x.id)) || A.cat.list.find((x) => x.slot === m.slot);
      if (e) m.sel = e.id;
    }
    host().innerHTML = `<div class="modal-bg" data-acc-close="1"></div>
      <div class="modal acc-modal" role="dialog" aria-label="${esc(d.title)}">
        <header class="modal-h"><b>${esc(d.title)}</b><button type="button" data-acc-close="1" title="Fechar">✕</button></header>
        <div class="modal-b">
          <p class="muted small acc-intro">${INTRO}</p>
          ${orderHtml()}
          ${A.cat ? `<div class="acc-main">
            <div class="acc-left">
              <div class="acc-search"><input type="search" id="accQ" placeholder="Buscar..." value="${esc(m.q)}" autocomplete="off">
                <label class="acc-only small" title="Mostrar só o que você carrega"><input type="checkbox" data-acc-only="1" ${m.only ? 'checked' : ''}> Mochila</label></div>
              <div class="acc-list" id="accList">${listHtml()}</div>
            </div>
            <div class="acc-det">${detHtml()}</div>
          </div>` : `<p class="muted">${A.catErr ? 'A lista de peças ainda não está disponível. Tente de novo mais tarde.' : 'Carregando…'}</p>`}
          <div class="acc-foot"><span class="muted small">Peças ligadas aqui ficam marcadas para não ir na Venda rápida.</span>
            <button type="button" class="btn primary" data-acc-done="1">Pronto</button></div>
        </div>
      </div>`;
  }

  function orderHtml() {
    const m = A.m;
    const on = rulesOf().filter((r) => r.on);
    const have = carried();
    const worn = wornId(m.slot);
    const body = on.length
      ? on.map((r, k) => {
        const e = A.cat?.byId.get(r.id);
        const n = (have.get(r.id) || 0) + (worn === r.id ? 1 : 0);
        const tip = `${k + 1}º — ${e ? nice(e.name) : 'Peça ' + r.id}${worn === r.id ? ' (no slot agora)' : n ? '' : ' (nenhuma na bolsa)'}\n${condsText(r)}`;
        return `${k ? '<span class="acc-sep">›</span>' : ''}<button type="button" class="acc-chip ${m.sel === r.id ? 'on' : ''} ${worn === r.id ? 'worn' : ''} ${n ? '' : 'none'}" data-acc-sel="${r.id}" title="${esc(tip)}"><i class="acc-n">${k + 1}</i>${icon(r.id, 'acc-ic')}</button>`;
      }).join('')
      : `<span class="acc-empty">Nada ligado — a barra não mexe no slot. Ligue uma peça na lista e a barra assume o slot.</span>`;
    return `<div class="acc-order"><div class="acc-h">ORDEM DE PRIORIDADE</div><div class="acc-bar">${body}</div></div>`;
  }

  function condsText(r) {
    const parts = (r.conds || []).map((c) => `${SUBJ[c.subj]} ${ATTR[c.attr]} ${{ lt: '<', le: '≤', eq: '=', ge: '≥', gt: '>' }[c.op]} ${c.val}${c.pct ? '%' : ''}`);
    if (r.near && r.near.length) parts.push('perto de ' + r.near.join(' ou '));
    return parts.length ? 'Usa quando: ' + parts.join(' e ') : 'Usa sempre';
  }

  function listHtml() {
    const m = A.m;
    if (!A.cat) return '';
    const q = m.q.trim().toLowerCase();
    const have = carried();
    const worn = wornId(m.slot);
    const onPos = new Map(rulesOf().filter((r) => r.on).map((r, k) => [r.id, k + 1]));
    const items = A.cat.list.filter((e) => e.slot === m.slot
      && (!q || e.name.toLowerCase().includes(q) || (e.bonus || []).some((b) => b.t.toLowerCase().includes(q)))
      && (!m.only || have.get(e.id) || worn === e.id));
    if (!items.length) return `<p class="muted small">${m.only ? `Você não carrega nenhum${m.slot === 'colar' ? ' colar' : ' anel'}${q ? ' com esse nome' : ''}. O loot das caçadas vem para a mochila.` : 'Nada encontrado.'}</p>`;
    return items.map((e) => {
      const n = have.get(e.id) || 0;
      const pos = onPos.get(e.id);
      const rule = ruleOf(e.id);
      const sub = (e.bonus || []).map((b) => b.t).join(' · ');
      return `<button type="button" class="acc-row ${m.sel === e.id ? 'on' : ''} ${blocked(e) ? 'locked' : ''}" data-acc-sel="${e.id}" title="${esc(nice(e.name))}${blocked(e) ? ' — ' + esc(blocked(e)) : ''}">
        ${icon(e.id, 'acc-ric')}<span class="acc-rn"><b>${esc(nice(e.name))}</b><small>${esc(sub)}</small></span>
        <span class="acc-rb">${worn === e.id ? '<em class="acc-slot">no slot</em>' : ''}${pos ? `<em class="acc-pos" title="${pos}º na ordem">${pos}º</em>` : rule ? '<em class="acc-off" title="Regra guardada, desligada">off</em>' : ''}${n ? `<em class="acc-cnt" title="Na bolsa">×${n}</em>` : ''}</span></button>`;
    }).join('');
  }

  function detHtml() {
    const m = A.m;
    const e = A.cat.byId.get(m.sel);
    if (!e || e.slot !== m.slot) return `<p class="muted small">Escolha ${m.slot === 'colar' ? 'um colar' : 'um anel'} na lista ao lado.</p>`;
    const rule = ruleOf(e.id);
    const n = carried().get(e.id) || 0;
    const worn = wornId(m.slot) === e.id;
    const block = blocked(e);
    const onList = rulesOf().filter((r) => r.on);
    const pos = rule && rule.on ? onList.indexOf(rule) + 1 : 0;
    const reqs = [e.level ? `Level ${e.level}+` : '', e.voc ? 'Só ' + e.voc.split('').map((v) => VOC[v]).join(' e ') : ''].filter(Boolean).join(' · ');
    const have = worn ? `<p class="acc-have">No slot agora${n ? ` · mais ${n} na bolsa` : ''}</p>` : n ? `<p class="acc-have">Na bolsa: ${n}</p>` : '<p class="acc-none">Nenhuma na bolsa</p>';
    const state = rule && rule.on ? `Ligada — ${pos}º na ordem` : rule ? 'Desligada — a regra fica guardada, só nunca é colocada.' : 'Desligada — ligue para a barra usar esta peça.';
    const conds = rule ? rule.conds : [];
    const near = rule ? rule.near : [];
    return `<div class="acc-head">${icon(e.id, 'acc-big')}<div><b>${esc(nice(e.name))}</b>${e.limite ? `<small>${esc(e.limite)}</small>` : ''}</div></div>
      <ul class="acc-bonus">${(e.bonus || []).map((b) => `<li class="${b.neg ? 'neg' : ''}">${esc(b.t)}</li>`).join('')}</ul>
      ${reqs ? `<p class="acc-req ${block ? 'bad' : ''}">${esc(reqs)}${block ? ' — ' + esc(block.toLowerCase()) : ''}</p>` : ''}
      ${have}
      <div class="acc-toggle"><label class="acc-switch" title="Ligar / desligar"><input type="checkbox" data-acc-on="1" ${rule && rule.on ? 'checked' : ''}><span></span></label><span>${esc(state)}</span></div>
      ${pos ? `<div class="acc-move small"><span>Posição na ordem</span><button type="button" class="iconbtn" data-acc-move="-1" ${pos === 1 ? 'disabled' : ''} title="Mais cedo na ordem">◀</button><b>${pos}º de ${onList.length}</b><button type="button" class="iconbtn" data-acc-move="1" ${pos === onList.length ? 'disabled' : ''} title="Mais tarde na ordem">▶</button></div>` : ''}
      <div class="acc-sec">USA QUANDO</div>
      ${conds.length ? conds.map(condRow).join('') : '<span class="chip">Sempre</span>'}
      <div><button type="button" class="btn small acc-add" data-acc-add="1" ${conds.length >= MAX_CONDS ? 'disabled' : ''}>+ Adicionar condição</button></div>
      <div class="acc-sec">POR PERTO</div>
      <div class="acc-near">${near.map((nm, i) => `<span class="chip">${esc(nm)} <button type="button" class="acc-x" data-acc-ndel="${i}" title="Tirar">✕</button></span>`).join('')}</div>
      ${near.length < MAX_NEAR ? `<input class="acc-nearin" list="accMonsters" data-acc-near="1" placeholder="+ Adicionar um monstro..." autocomplete="off">
        <datalist id="accMonsters">${monsterNames().map((nm) => `<option value="${esc(nm)}">`).join('')}</datalist>` : ''}
      <p class="muted small acc-hint">${near.length ? 'Só entra quando um destes monstros está a até 7 passos de você.' : 'Sem monstro aqui, vale para qualquer caçada.'}</p>
      ${rule ? '<div class="acc-delrow"><button type="button" class="btn small" data-acc-del="1">Apagar regra</button></div>' : ''}`;
  }

  function condRow(c, ci) {
    return `<div class="ac-cond">
      <select data-acc-cond="${ci}.subj">${Object.keys(SUBJ).map((k) => `<option value="${k}" ${c.subj === k ? 'selected' : ''}>${SUBJ[k]}</option>`).join('')}</select>
      <select data-acc-cond="${ci}.attr">${(SUBJ_ATTRS[c.subj] || []).map((k) => `<option value="${k}" ${c.attr === k ? 'selected' : ''}>${ATTR[k]}</option>`).join('')}</select>
      <select data-acc-cond="${ci}.op">${Object.entries(OPS_TXT).map(([k, v]) => `<option value="${k}" ${c.op === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <span class="ac-step"><button type="button" data-acc-step="${ci}.-1">−</button><input type="number" min="0" data-acc-cond="${ci}.val" value="${Number(c.val) || 0}"><button type="button" data-acc-step="${ci}.1">+</button></span>
      ${c.attr === 'hp' || c.attr === 'mana' ? `<label class="small"><input type="checkbox" data-acc-cond="${ci}.pct" ${c.pct ? 'checked' : ''}> %</label>` : '<span></span>'}
      <button type="button" class="iconbtn" data-acc-cdel="${ci}" title="Tirar condição">✕</button></div>`;
  }

  // ---------------------------------------------------------------- eventos
  document.addEventListener('click', (ev) => {
    const openBtn = ev.target.closest('[data-acc-open]');
    if (openBtn) return open(openBtn.dataset.accOpen);
    if (!A.m || !ev.target.closest('#accModal')) return;
    const el = ev.target.closest('[data-acc-close],[data-acc-done],[data-acc-sel],[data-acc-move],[data-acc-add],[data-acc-cdel],[data-acc-step],[data-acc-ndel],[data-acc-del]');
    if (!el) return;
    const d = el.dataset;
    const m = A.m;
    if (d.accClose || d.accDone) return close(true);
    if (d.accSel) {
      m.sel = Number(d.accSel);
      return render();
    }
    if (d.accMove) {
      const list = rulesOf();
      const r = ruleOf(m.sel);
      const i = list.indexOf(r);
      const dir = Number(d.accMove);
      let j = i + dir;
      while (j >= 0 && j < list.length && !list[j].on) j += dir;
      if (r && j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
      return render();
    }
    if (d.accAdd) {
      const r = ensureRule(m.sel);
      if (r && r.conds.length < MAX_CONDS) r.conds.push({ subj: 'self', attr: 'hp', op: 'le', val: 50, pct: true });
      return render();
    }
    if (d.accCdel) {
      const r = ruleOf(m.sel);
      if (r) r.conds.splice(Number(d.accCdel), 1);
      return render();
    }
    if (d.accStep) {
      const [ci, dir] = d.accStep.split('.').map(Number);
      const c = ruleOf(m.sel)?.conds[ci];
      if (!c) return;
      c.val = Math.max(0, (Number(c.val) || 0) + dir * (c.pct ? 5 : 1));
      if (c.pct) c.val = Math.min(100, c.val);
      return render();
    }
    if (d.accNdel) {
      const r = ruleOf(m.sel);
      if (r) r.near.splice(Number(d.accNdel), 1);
      return render();
    }
    if (d.accDel) {
      const list = rulesOf();
      const i = list.indexOf(ruleOf(m.sel));
      if (i >= 0) list.splice(i, 1);
      return render();
    }
  });

  document.addEventListener('change', (ev) => {
    if (!A.m || !ev.target.closest('#accModal')) return;
    const t = ev.target;
    const d = t.dataset;
    const m = A.m;
    if (d.accOnly) {
      m.only = t.checked;
      const l = document.getElementById('accList');
      if (l) l.innerHTML = listHtml();
      return;
    }
    if (d.accOn) {
      if (t.checked) {
        const r = ensureRule(m.sel);
        if (r) r.on = true;
      } else {
        const r = ruleOf(m.sel);
        if (r) r.on = false;
      }
      return render();
    }
    if (d.accCond) {
      const [ci, key] = d.accCond.split('.');
      const c = ruleOf(m.sel)?.conds[Number(ci)];
      if (!c) return;
      if (key === 'pct') c.pct = t.checked;
      else if (key === 'val') c.val = Math.max(0, Math.floor(Number(t.value) || 0));
      else c[key] = t.value;
      if (key === 'subj') {
        c.attr = SUBJ_ATTRS[c.subj][0];
        c.pct = c.attr === 'hp' || c.attr === 'mana';
        c.op = c.subj === 'area' ? 'ge' : 'le';
        c.val = c.subj === 'area' ? 2 : 50;
      }
      if (key === 'attr' && !(c.attr === 'hp' || c.attr === 'mana')) c.pct = false;
      if (c.pct) c.val = Math.min(100, c.val);
      return render();
    }
    if (d.accNear) {
      const raw = t.value.trim().toLowerCase();
      const name = monsterNames().find((n) => n.toLowerCase() === raw);
      if (!raw) return;
      if (!name) {
        app().toast?.('Escolha um monstro da lista.', 'erro');
        return;
      }
      const r = ensureRule(m.sel);
      if (r && !r.near.some((n) => n.toLowerCase() === raw) && r.near.length < MAX_NEAR) r.near.push(name);
      return render();
    }
  });

  document.addEventListener('input', (ev) => {
    if (!A.m || ev.target.id !== 'accQ') return;
    A.m.q = ev.target.value;
    const l = document.getElementById('accList');
    if (l) l.innerHTML = listHtml();
  });

  // com a janela aberta, o teclado e dela: Esc fecha; setas/WASD/Enter nao andam nem abrem o chat
  window.addEventListener('keydown', (ev) => {
    if (!A.m) return;
    if (!document.getElementById('accModal')) {
      A.m = null; // a tela do jogo foi refeita (trocou de personagem)
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close(true);
    }
    ev.stopPropagation();
  }, true);

  // mensagens da ponte
  function onMessage(msg) {
    A.cfg = msg.cfg && typeof msg.cfg === 'object' ? { colar: msg.cfg.colar || [], anel: msg.cfg.anel || [] } : emptyCfg();
    A.char = app().S?.char;
    if (A.m && JSON.stringify(A.m.draft) === A.m.saved) {
      A.m.draft = clone(A.cfg);
      A.m.saved = JSON.stringify(A.m.draft);
      render();
    }
  }

  loadCatalog();
  window.Acessorios = { autoBtn, open, onMessage };
})();
