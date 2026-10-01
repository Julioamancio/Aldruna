'use strict';
/*
 * Destruitor Idle — janela do LEILAO (mercado entre jogadores), como a aba LEILAO da loja do Huntera.
 *   OFERTAS: busca, tipo, ordem, "so itens que eu tenho"; clicar abre o item (todas as ofertas dele, a mais
 *            barata primeiro, valor no NPC, preco medio e os ultimos negocios) e comprar (tudo ou parte).
 *   VENDER:  itens da mochila; quantidade, preco por unidade, duracao; mostra a taxa (agora, nao volta),
 *            a comissao da casa, quanto voce recebe, o preco medio e a menor oferta.
 *   MINHAS OFERTAS: cancelar (o item volta; a taxa nao). HISTORICO: vendas, compras, canceladas, expiradas.
 * Fala com a ponte por { t: 'leilao', op } (gateway/leilao.js). O app.js so repassa as mensagens e o estado
 * (window.IdleApp) e tem os botoes que abrem esta janela (data-lx="abrir"). ?demo=1: leilao de mentira.
 */
(() => {
  const RG = window.LeilaoRegras;
  if (!RG) return;
  const DEMO = new URLSearchParams(location.search).has('demo');
  const app = () => window.IdleApp || null;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = RG.fmt;
  const icon = (id, cls = 'lx-ic') => (app() && app().icon ? app().icon(id, cls) : '');
  const TABS = [['ofertas', 'Ofertas'], ['vender', 'Vender'], ['meus', 'Minhas ofertas'], ['historico', 'Histórico']];

  const L = {
    open: false,
    tab: 'ofertas',
    cfg: RG.CFG,
    tipos: RG.TIPOS,
    ordens: RG.ORDENS,
    f: { busca: '', tipo: '', ordem: 'barato', pagina: 0, meus: false },
    lista: null, // resposta de 'lista'
    det: null, // item aberto: { id, ...resposta de 'item' }
    meus: null,
    hist: null,
    precos: {}, // itemId -> { media, mediana, n, menor, aVenda }
    sel: 0, // item escolhido na aba Vender
    form: { qtd: '', preco: '', dias: 7 },
    compra: null, // { id, qtd } confirmando compra
    cancela: 0, // oferta pedindo confirmacao para cancelar
    espera: '', // pedido mandado, esperando o servidor
    comprando: 0, // item da compra em andamento (vai para o "nao vender")
    clock: 0,
    req: 0,
    bagSig: '',
  };

  const live = () => (app() && app().live()) || null;
  const cacando = () => !!(live() && live().idle && live().idle.hunting);
  const banco = () => {
    const l = live();
    if (!l) return 0;
    return l.idle && l.idle.hunting ? l.idle.bank : (l.player && l.player.bank) || 0;
  };
  const bag = () => (live() && live().bag && live().bag.items) || [];
  const serverNow = () => Date.now() / 1000 + L.clock;
  const readOnly = () => L.cfg.soNaCidade && cacando();
  const limite = () => (L.meus ? L.meus.limite : RG.limiteAtivos(L.cfg, !!(live() && live().premium)));

  function send(op, extra) {
    const m = { t: 'leilao', op, req: ++L.req, ...(extra || {}) };
    if (DEMO) return setTimeout(() => demo(m), 120);
    if (app()) app().send(m);
  }

  // ------------------------------------------------------------------------
  // janela
  // ------------------------------------------------------------------------
  function root() {
    let el = document.getElementById('lxModal');
    const host = document.querySelector('.g') || document.body;
    if (!el || el.parentElement !== host) {
      if (el) el.remove();
      el = document.createElement('div');
      el.id = 'lxModal';
      host.appendChild(el);
      el.addEventListener('click', onClick);
      el.addEventListener('input', onInput);
      el.addEventListener('change', onChange);
    }
    return el;
  }
  // so troca o que mudou (o estado chega a cada 0,25 s: recriar as imagens toda vez faz piscar)
  const put = (id, html) => {
    const el = document.getElementById(id);
    if (el && el._lx !== html) {
      el._lx = html;
      el.innerHTML = html;
    }
  };

  function open(tab) {
    L.open = true;
    if (tab) L.tab = tab;
    L.det = null;
    L.compra = null;
    L.cancela = 0;
    const el = root();
    el.innerHTML = `<div class="modal-bg" data-lx="fechar"></div>
      <div class="modal lx" role="dialog" aria-label="Leilão">
        <header class="modal-h"><b>Leilão <span class="lx-sub">· casa de leilões, de jogador para jogador</span></b><button data-lx="fechar" title="Fechar" aria-label="Fechar">✕</button></header>
        <div class="modal-b">
          <div id="lxTop"></div>
          <div class="ptabs lx-tabs" id="lxTabs"></div>
          <div id="lxBody"></div>
        </div>
      </div>`;
    send('abrir');
    send('meus');
    top();
    tabs();
    load();
    body();
  }

  function close() {
    L.open = false;
    const el = document.getElementById('lxModal');
    if (el) el.innerHTML = '';
  }

  function top() {
    put('lxTop', `<div class="lx-top">
        <span class="lx-gold" title="Gold no banco">${icon(3031, 'ti-s')}<b>${fmt(banco())}</b></span>
        <span class="muted small">Ofertas: <b>${L.meus ? L.meus.ativos : '…'}/${limite()}</b></span>
        <span class="muted small lx-rules">Taxa de anúncio ${L.cfg.taxaPct}% (mín. ${fmt(L.cfg.taxaMin)}), cobrada na hora · a casa fica com ${L.cfg.comissaoPct}% da venda</span>
      </div>
      ${readOnly() ? '<div class="lx-ro">Só leitura — a casa de leilões negocia na cidade. Volte para comprar, vender ou cancelar.</div>' : ''}`);
  }

  function tabs() {
    put('lxTabs', TABS.map(([k, v]) => `<button data-lx="tab" data-lx-v="${k}" class="${L.tab === k ? 'on' : ''}">${v}${k === 'meus' && L.meus && L.meus.ativos ? ` <em class="cbn">${L.meus.ativos}</em>` : ''}</button>`).join(''));
  }

  // pede os dados da aba atual
  function load() {
    if (L.tab === 'ofertas') {
      if (L.det) send('item', { item: L.det.id });
      else lista();
    } else if (L.tab === 'vender') {
      send('precos', { ids: bag().map((it) => it.id) });
      send('meus');
    } else if (L.tab === 'meus') send('meus');
    else if (L.tab === 'historico') send('historico');
  }

  function lista() {
    const f = L.f;
    send('lista', { busca: f.busca, tipo: f.tipo, ordem: f.ordem, pagina: f.pagina, ...(f.meus ? { ids: bag().map((it) => it.id) } : {}) });
  }

  function body() {
    if (!L.open) return;
    if (L.tab === 'ofertas') return L.det ? put('lxBody', detalheHtml()) : ofertasTab();
    if (L.tab === 'vender') return venderTab();
    if (L.tab === 'meus') return put('lxBody', meusHtml());
    if (L.tab === 'historico') return put('lxBody', historicoHtml());
  }

  // ------------------------------------------------------------------------
  // OFERTAS
  // ------------------------------------------------------------------------
  const opt = (v, t, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(t)}</option>`;

  function ofertasTab() {
    const f = L.f;
    if (!document.getElementById('lxList')) {
      put('lxBody', `<div class="lx-filters">
          <input id="lxBusca" type="search" placeholder="Buscar itens negociáveis" value="${esc(f.busca)}" autocomplete="off" maxlength="40">
          <select id="lxTipo" aria-label="Filtrar por tipo">${opt('', 'Todos os tipos', f.tipo)}${Object.entries(L.tipos).map(([k, v]) => opt(k, v, f.tipo)).join('')}</select>
          <select id="lxOrdem" aria-label="Ordenar">${Object.entries(L.ordens).map(([k, v]) => opt(k, v, f.ordem)).join('')}</select>
          <label class="lx-chk"><input type="checkbox" id="lxMeusItens" ${f.meus ? 'checked' : ''}> Itens que você tem</label>
        </div>
        <div id="lxList"></div>`);
    }
    put('lxList', listaHtml());
  }

  function vsMedia(o) {
    if (!(o.media > 0)) return '';
    const pct = Math.round(((o.preco - o.media) / o.media) * 100);
    if (Math.abs(pct) < 10) return '<span class="lx-tag">no preço médio</span>';
    return `<span class="lx-tag ${pct < 0 ? 'bom' : 'caro'}" title="Preço médio: ${fmt(o.media)} gp">${pct > 0 ? '+' : '−'}${Math.abs(pct)}% da média</span>`;
  }
  const lvTag = (lv) => (lv > 0 ? `<span class="lx-lv" title="Usar isto exige level ${lv}.">Lv ${lv}</span>` : '');

  function listaHtml() {
    const r = L.lista;
    if (!r) return '<p class="muted">Abrindo a casa de leilões…</p>';
    if (!r.ofertas.length) {
      if (L.f.meus) return '<p class="muted center lx-empty">Ninguém está vendendo nada do que você tem.</p>';
      return L.f.busca || L.f.tipo ? '<p class="muted center lx-empty">Ninguém está vendendo nada que corresponda.</p>'
        : '<p class="muted center lx-empty"><b>Nada à venda no momento.</b><br>Quando alguém anunciar algo, aparece aqui.</p>';
    }
    const now = serverNow();
    const rows = r.ofertas.map((o) => `<button class="lx-row ${o.minha ? 'mine' : ''}" data-lx="item" data-lx-v="${o.item}">
        ${icon(o.item, 'lx-ic')}
        <span class="lx-n"><b>${esc(o.nome)} ${lvTag(o.lv)}</b><small>${o.minha ? 'Sua oferta' : 'de ' + esc(o.vendedor)} · termina em ${RG.tempoRestante(o.termina - now)}</small></span>
        <span class="lx-q">${fmt(o.qtd)}×</span>
        <span class="lx-p"><b>${fmt(o.preco)} gp</b>${o.qtd > 1 ? `<small>cada · ${fmt(o.qtd * o.preco)} no total</small>` : ''}${o.npc ? `<small>NPC ${fmt(o.npc)}</small>` : ''}</span>
        <span class="lx-m">${vsMedia(o)}</span>
      </button>`).join('');
    const pages = Math.max(1, Math.ceil(r.total / r.por));
    return `<div class="lx-count muted small">${fmt(r.total)} ${r.total === 1 ? 'oferta' : 'ofertas'} · as mais baratas são atendidas primeiro</div>
      <div class="lx-rows">${rows}</div>
      ${pages > 1 ? `<div class="lx-pages"><button class="btn small" data-lx="pagina" data-lx-v="${r.pagina - 1}" ${r.pagina <= 0 ? 'disabled' : ''}>‹ Anterior</button>
        <span class="muted small">Página ${r.pagina + 1} de ${pages}</span>
        <button class="btn small" data-lx="pagina" data-lx-v="${r.pagina + 1}" ${r.pagina + 1 >= pages ? 'disabled' : ''}>Próxima ›</button></div>` : ''}`;
  }

  function detalheHtml() {
    const d = L.det;
    const back = '<button class="btn small" data-lx="voltar">‹ Voltar para a lista</button>';
    if (!d || !d.item) return `${back}<p class="muted">Abrindo o item…</p>`;
    const it = d.item;
    const s = d.stats || { n: 0 };
    const now = serverNow();
    const menor = d.ofertas.length ? d.ofertas[0].preco : 0;
    const kpi = (k, v, small) => `<div class="kpi"><span>${k}</span><b>${v}</b>${small ? `<small class="muted">${small}</small>` : ''}</div>`;
    const ro = readOnly();
    const offers = d.ofertas.map((o) => {
      const c = L.compra && L.compra.id === o.id ? L.compra : null;
      let action;
      if (o.minha) action = '<span class="muted small">sua oferta</span>';
      else if (c) {
        const qtd = Math.max(1, Math.min(o.qtd, RG.inteiro(c.qtd) || 1));
        const total = qtd * o.preco;
        const erro = RG.validarCompra(L.cfg, { oferta: { count: o.qtd, price: o.preco, expires: o.termina, seller_id: -1, status: 'ativo' }, eu: 0, qtd, banco: banco(), agora: now, cacando: cacando() });
        action = `<div class="lx-confirm">
            ${o.qtd > 1 ? `<span class="lx-step"><button data-lx="cqtd" data-lx-v="-1">−</button><input id="lxCQtd" type="number" min="1" max="${o.qtd}" value="${qtd}" inputmode="numeric"><button data-lx="cqtd" data-lx-v="1">+</button><button data-lx="cqtd" data-lx-v="max" class="lx-max">máx</button></span>` : ''}
            <span class="small">Comprar <b>${fmt(qtd)}× ${esc(it.nome)}</b> de ${esc(o.vendedor)} por <b>${fmt(total)} gp</b>?${erro ? '' : ` Sobram ${fmt(banco() - total)} gp no banco. Vai para a mochila marcado para não entrar na Venda rápida.`}</span>
            ${erro ? `<span class="lx-err small">${esc(erro)}</span>` : ''}
            <span class="row"><button class="btn small" data-lx="cnao">Voltar</button><button class="btn small primary" data-lx="csim" data-lx-v="${o.id}" ${erro || L.espera ? 'disabled' : ''}>${L.espera === 'comprar' ? 'Comprando…' : 'Sim, comprar'}</button></span>
          </div>`;
      } else action = `<button class="btn small primary" data-lx="comprar" data-lx-v="${o.id}" ${ro ? 'disabled title="Só na cidade"' : ''}>Comprar</button>`;
      return `<div class="lx-offer ${c ? 'on' : ''}">
          <span><b>${fmt(o.preco)} gp</b> <small class="muted">cada</small></span>
          <span>${fmt(o.qtd)}×</span>
          <span class="small">${o.minha ? 'você' : esc(o.vendedor)}</span>
          <span class="small muted">termina em ${RG.tempoRestante(o.termina - now)}</span>
          <span class="lx-act">${action}</span>
        </div>`;
    }).join('');
    const vendas = (d.vendas || []).map((v) => `<div class="lx-sale"><span class="muted">${quando(v.quando)}</span><span>${fmt(v.qtd)}×</span><b>${fmt(v.preco)} gp</b></div>`).join('');
    return `${back}
      <div class="lx-head">${icon(it.id, 'lx-ic big')}<div><b class="lx-title">${esc(it.nome)} ${lvTag(it.lv)}</b>
        <div class="muted small">${esc(L.tipos[it.tipo] || '')}${it.peso ? ` · ${(it.peso / 100).toFixed(2).replace('.', ',')} oz` : ''}</div></div></div>
      <div class="kpis lx-kpis">
        ${kpi('Valor no NPC', it.npc ? fmt(it.npc) + ' gp' : '—', 'o que a Venda rápida paga')}
        ${kpi('Preço médio', s.n ? fmt(s.media) + ' gp' : '—', s.n ? `${s.n} ${s.n === 1 ? 'negócio' : 'negócios'} (30 dias)` : 'sem negócios ainda')}
        ${kpi('Menor oferta', menor ? fmt(menor) + ' gp' : '—', d.ofertas.length ? `${d.ofertas.length} ${d.ofertas.length === 1 ? 'oferta' : 'ofertas'}` : '')}
        ${kpi('Seu gold', fmt(banco()) + ' gp')}
      </div>
      <h3 class="lx-h3">Ofertas de venda <small class="muted">— as mais baratas são atendidas primeiro</small></h3>
      ${d.ofertas.length ? `<div class="lx-offers">${offers}</div>` : '<p class="muted">Ninguém está vendendo este item agora.</p>'}
      <h3 class="lx-h3">Últimos negócios</h3>
      ${vendas ? `<div class="lx-sales">${vendas}</div>` : '<p class="muted small">Nada foi liquidado ainda.</p>'}`;
  }

  function quando(t) {
    const d = new Date(t * 1000);
    const ago = serverNow() - t;
    if (ago < 3600) return Math.max(1, Math.round(ago / 60)) + ' min atrás';
    if (ago < 86400) return Math.round(ago / 3600) + 'h atrás';
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // ------------------------------------------------------------------------
  // VENDER
  // ------------------------------------------------------------------------
  function venderTab() {
    if (!document.getElementById('lxVBag')) {
      put('lxBody', `<div class="lx-sell"><div><div class="lx-h3">Sua mochila</div><div id="lxVBag" class="lx-vbag"></div></div><div id="lxVForm" class="lx-vform"></div></div>`);
      vForm();
    }
    vBag();
    vResumo();
  }

  function vBag() {
    const items = bag();
    if (!items.length) return put('lxVBag', '<p class="muted small">Nada para vender ainda — ache um loot primeiro.</p>');
    put('lxVBag', items.map((it) => {
      const p = L.precos[it.id];
      return `<button class="lx-brow ${L.sel === it.id ? 'on' : ''}" data-lx="sel" data-lx-v="${it.id}">
          ${icon(it.id, 'lx-ic')}<span class="lx-n"><b>${esc(it.name)}</b><small>Você tem ${fmt(it.count)} · NPC ${fmt(it.price)}${p && p.n ? ` · médio ${fmt(p.media)}` : ''}</small></span>
        </button>`;
    }).join(''));
  }

  const selItem = () => bag().find((it) => it.id === L.sel) || null;

  function vForm() {
    const it = selItem();
    if (!it) return put('lxVForm', '<p class="muted lx-pick">Escolha um item da mochila para anunciar.</p>');
    const p = L.precos[it.id] || {};
    const f = L.form;
    const ro = readOnly();
    put('lxVForm', `<div class="lx-head">${icon(it.id, 'lx-ic big')}<div><b class="lx-title">Vender ${esc(it.name)}</b><div class="muted small">Você tem ${fmt(it.count)}</div></div></div>
      <div class="kpis lx-kpis">
        <div class="kpi"><span>Valor no NPC</span><b>${fmt(it.price)} gp</b></div>
        <div class="kpi"><span>Preço médio</span><b>${p.n ? fmt(p.media) + ' gp' : '—'}</b><small class="muted">${p.n ? `${p.n} ${p.n === 1 ? 'negócio' : 'negócios'}` : 'sem negócios'}</small></div>
        <div class="kpi"><span>Menor oferta</span><b>${p.menor ? fmt(p.menor) + ' gp' : '—'}</b><small class="muted">${p.aVenda ? fmt(p.aVenda) + ' à venda' : 'ninguém vendendo'}</small></div>
      </div>
      <label class="field" for="lxQtd">Quantidade <span class="muted small">(até ${fmt(Math.min(it.count, L.cfg.maxQtd))})</span></label>
      <div class="lx-in"><input id="lxQtd" type="number" min="1" max="${Math.min(it.count, L.cfg.maxQtd)}" value="${esc(f.qtd)}" inputmode="numeric" ${ro ? 'disabled' : ''}><button class="btn small" data-lx="qmax" ${ro ? 'disabled' : ''}>Tudo</button></div>
      <label class="field" for="lxPreco">Preço por unidade <span class="muted small">(gold cada)</span></label>
      <div class="lx-in"><input id="lxPreco" type="number" min="${L.cfg.pisoNpc ? it.price : 1}" value="${esc(f.preco)}" inputmode="numeric" ${ro ? 'disabled' : ''}>
        <span class="lx-quick">${[['npc', 'NPC', it.price], ['media', 'Médio', p.n ? p.media : 0], ['menor', 'Menor −1', p.menor ? Math.max(it.price, p.menor - 1) : 0]].filter((x) => x[2] > 0)
          .map(([k, t, v]) => `<button class="btn small" data-lx="psug" data-lx-v="${v}" title="${fmt(v)} gp" ${ro ? 'disabled' : ''}>${t}</button>`).join('')}</span></div>
      <label class="field">Duração</label>
      <div class="seg">${L.cfg.dias.map((d) => `<button data-lx="dias" data-lx-v="${d}" class="${Number(f.dias) === d ? 'on' : ''}" ${ro ? 'disabled' : ''}>${d} ${d === 1 ? 'dia' : 'dias'}</button>`).join('')}</div>
      <div id="lxResumo"></div>`);
  }

  function vResumo() {
    const it = selItem();
    if (!it || !document.getElementById('lxResumo')) return;
    const f = L.form;
    const qtd = RG.inteiro(f.qtd);
    const preco = RG.inteiro(f.preco);
    const p = L.precos[it.id] || {};
    const filled = qtd > 0 && preco > 0;
    const erro = filled ? RG.validarAnuncio(L.cfg, { npc: it.price, tem: it.count, qtd, preco, dias: f.dias, ativos: L.meus ? L.meus.ativos : null, premium: !!(live() && live().premium), cacando: cacando(), banco: banco() }) : null;
    const c = filled ? RG.conta(L.cfg, qtd, preco) : null;
    const aviso = filled ? RG.avisoPreco(L.cfg, preco, p.n ? p.media : 0) : null;
    const cheaper = filled && p.menor && p.menor < preco ? `Uma oferta de venda já pede só ${fmt(p.menor)} de gold cada — quem compra leva a mais barata primeiro.` : '';
    put('lxResumo', `<div class="lx-sum">
        ${c ? `<div class="kv"><span>Total</span><b>${fmt(c.total)} gp</b></div>
          <div class="kv"><span>Taxa de anúncio (agora, não volta)</span><b class="neg">−${fmt(c.taxa)} gp</b></div>
          <div class="kv"><span>A casa fica com ${L.cfg.comissaoPct}% da venda</span><b class="neg">−${fmt(c.comissao)} gp</b></div>
          <div class="kv"><span>No fim você ganha</span><b class="${c.liquido >= qtd * it.price ? 'pos' : 'neg'}">${fmt(c.liquido)} gp</b></div>`
          : '<p class="muted small">A taxa e os totais aparecem quando a quantidade e o preço estiverem preenchidos.</p>'}
      </div>
      ${c ? `<p class="small">Você recebe <b>${fmt(c.recebe)}</b> de gold quando vender · <b>${fmt(c.taxa)}</b> de gold de taxa agora. Na Venda rápida seriam ${fmt(qtd * it.price)} gp.</p>` : ''}
      ${aviso ? `<p class="small lx-warn">${esc(aviso.texto)}</p>` : ''}
      ${cheaper ? `<p class="small lx-warn">${esc(cheaper)}</p>` : ''}
      ${erro ? `<p class="small lx-err">${esc(erro)}</p>` : ''}
      <div class="row" style="justify-content:flex-end"><span class="muted small">Ofertas: ${L.meus ? L.meus.ativos : '…'}/${limite()}</span>
        <button class="btn primary" data-lx="anunciar" ${!filled || erro || L.espera ? 'disabled' : ''}>${L.espera === 'anunciar' ? 'Anunciando…' : 'Criar oferta'}</button></div>`);
  }

  // ------------------------------------------------------------------------
  // MINHAS OFERTAS e HISTORICO
  // ------------------------------------------------------------------------
  function meusHtml() {
    const r = L.meus;
    if (!r) return '<p class="muted">Abrindo suas ofertas…</p>';
    const now = serverNow();
    const pend = r.pendente && r.pendente.n ? `<div class="lx-pend">A receber: ${r.pendente.gold ? `<b>${fmt(r.pendente.gold)} gp</b>` : ''}${r.pendente.gold && r.pendente.itens ? ' e ' : ''}${r.pendente.itens ? `<b>${fmt(r.pendente.itens)} ${r.pendente.itens === 1 ? 'item' : 'itens'}</b>` : ''} — chega quando você estiver na cidade.</div>` : '';
    const head = `<div class="spread"><span class="muted small">${r.ativos} de ${r.limite} ofertas ativas${r.premium ? '' : ` (Premium: ${L.cfg.maxAtivosPremium})`}.</span>
      <button class="btn small" data-lx="tab" data-lx-v="vender">+ Vender algo</button></div>${pend}`;
    if (!r.ofertas.length) return `${head}<p class="muted center lx-empty">Você não tem nenhuma oferta ativa.</p>`;
    const ro = readOnly();
    return `${head}<div class="lx-rows">${r.ofertas.map((o) => {
      const conf = L.cancela === o.id;
      return `<div class="lx-row static ${conf ? 'on' : ''}">
          ${icon(o.item, 'lx-ic')}
          <span class="lx-n"><b>${esc(o.nome)}</b><small>${o.status === 'reservado' ? 'sendo comprada agora' : 'termina em ' + RG.tempoRestante(o.termina - now)} · taxa paga ${fmt(o.taxa)} gp</small></span>
          <span class="lx-q">${fmt(o.qtd)}×</span>
          <span class="lx-p"><b>${fmt(o.preco)} gp</b><small>${o.qtd > 1 ? fmt(o.qtd * o.preco) + ' no total' : ''}</small></span>
          <span class="lx-m">${conf
            ? `<span class="small">Cancelar? A taxa não volta.</span> <button class="btn small" data-lx="xnao">Não</button> <button class="btn small danger" data-lx="xsim" data-lx-v="${o.id}" ${L.espera ? 'disabled' : ''}>${L.espera === 'cancelar' ? 'Cancelando…' : 'Sim, cancelar'}</button>`
            : `<button class="btn small" data-lx="cancelar" data-lx-v="${o.id}" ${ro || o.status !== 'ativo' ? 'disabled' : ''}>Cancelar</button>`}</span>
        </div>`;
    }).join('')}</div>`;
  }

  const TIPO_H = { venda: ['Vendeu', 'pos'], compra: ['Comprou', 'neg'], cancelado: ['Cancelada', ''], expirado: ['Expirou', ''] };
  function historicoHtml() {
    const r = L.hist;
    if (!r) return '<p class="muted">Abrindo o histórico…</p>';
    if (!r.linhas.length) return '<p class="muted center lx-empty">Nada foi liquidado ainda.</p>';
    return `<div class="lx-rows">${r.linhas.map((h) => {
      const [t, cls] = TIPO_H[h.tipo] || [h.tipo, ''];
      const detail = h.tipo === 'venda' ? `para ${esc(h.quem)} · a casa ficou com ${fmt(h.taxa)} gp`
        : h.tipo === 'compra' ? `de ${esc(h.quem)}` : h.tipo === 'expirado' ? 'os itens voltaram para a mochila' : 'os itens voltaram para a mochila';
      return `<div class="lx-row static">
          ${icon(h.item, 'lx-ic')}
          <span class="lx-n"><b><span class="lx-h ${h.tipo}">${t}</span> ${fmt(h.qtd)}× ${esc(h.nome)}</b><small>${quando(h.quando)} · ${detail}</small></span>
          <span class="lx-p"><b>${fmt(h.preco)} gp</b><small>cada</small></span>
          <span class="lx-m">${h.liquido ? `<b class="${cls}">${h.liquido > 0 ? '+' : '−'}${fmt(Math.abs(h.liquido))} gp</b>` : ''}</span>
        </div>`;
    }).join('')}</div>`;
  }

  // ------------------------------------------------------------------------
  // eventos
  // ------------------------------------------------------------------------
  let buscaTimer = null;
  function onInput(ev) {
    const t = ev.target;
    if (t.id === 'lxBusca') {
      L.f.busca = t.value;
      L.f.pagina = 0;
      clearTimeout(buscaTimer);
      buscaTimer = setTimeout(lista, 250);
    } else if (t.id === 'lxQtd' || t.id === 'lxPreco') {
      L.form[t.id === 'lxQtd' ? 'qtd' : 'preco'] = t.value;
      vResumo();
    } else if (t.id === 'lxCQtd' && L.compra) {
      L.compra.qtd = t.value;
    }
  }

  function onChange(ev) {
    const t = ev.target;
    if (t.id === 'lxTipo' || t.id === 'lxOrdem') {
      L.f[t.id === 'lxTipo' ? 'tipo' : 'ordem'] = t.value;
      L.f.pagina = 0;
      lista();
    } else if (t.id === 'lxMeusItens') {
      L.f.meus = t.checked;
      L.f.pagina = 0;
      lista();
    } else if (t.id === 'lxCQtd' && L.compra) {
      L.compra.qtd = t.value;
      body();
    }
  }

  function onClick(ev) {
    const b = ev.target.closest('[data-lx]');
    if (!b || b.disabled) return;
    const a = b.dataset.lx;
    const v = b.dataset.lxV;
    if (a === 'fechar') return close();
    if (a === 'tab') {
      L.tab = v;
      L.det = null;
      L.compra = null;
      L.cancela = 0;
      put('lxBody', '');
      tabs();
      load();
      return body();
    }
    if (a === 'pagina') {
      L.f.pagina = Math.max(0, Number(v) || 0);
      return lista();
    }
    if (a === 'item') {
      L.det = { id: Number(v) };
      L.compra = null;
      put('lxBody', detalheHtml());
      return send('item', { item: Number(v) });
    }
    if (a === 'voltar') {
      L.det = null;
      L.compra = null;
      put('lxBody', '');
      body();
      return lista();
    }
    if (a === 'comprar') {
      L.compra = { id: Number(v), qtd: 1 };
      return body();
    }
    if (a === 'cqtd' && L.compra && L.det) {
      const o = L.det.ofertas.find((x) => x.id === L.compra.id);
      if (!o) return;
      const cur = RG.inteiro(L.compra.qtd) || 1;
      L.compra.qtd = v === 'max' ? o.qtd : Math.max(1, Math.min(o.qtd, cur + Number(v)));
      return body();
    }
    if (a === 'cnao') {
      L.compra = null;
      return body();
    }
    if (a === 'csim' && L.compra) {
      const o = L.det && L.det.ofertas.find((x) => x.id === Number(v));
      if (!o) return;
      L.espera = 'comprar';
      L.comprando = o.item;
      send('comprar', { id: o.id, qtd: Math.max(1, Math.min(o.qtd, RG.inteiro(L.compra.qtd) || 1)) });
      return body();
    }
    if (a === 'sel') {
      L.sel = Number(v);
      const it = selItem();
      const p = (it && L.precos[it.id]) || {};
      L.form = { qtd: it ? String(it.count) : '', preco: it ? String(Math.max(it.price, p.n ? RG.arredondar(p.media) : RG.arredondar(it.price * 1.2))) : '', dias: L.cfg.diasPadrao };
      vBag();
      vForm();
      return vResumo();
    }
    if (a === 'qmax') {
      const it = selItem();
      if (!it) return;
      L.form.qtd = String(Math.min(it.count, L.cfg.maxQtd));
      const el = document.getElementById('lxQtd');
      if (el) el.value = L.form.qtd;
      return vResumo();
    }
    if (a === 'psug') {
      L.form.preco = String(v);
      const el = document.getElementById('lxPreco');
      if (el) el.value = L.form.preco;
      return vResumo();
    }
    if (a === 'dias') {
      L.form.dias = Number(v);
      b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      return vResumo();
    }
    if (a === 'anunciar') {
      const it = selItem();
      if (!it) return;
      L.espera = 'anunciar';
      send('anunciar', { item: it.id, qtd: RG.inteiro(L.form.qtd), preco: RG.inteiro(L.form.preco), dias: Number(L.form.dias) });
      return vResumo();
    }
    if (a === 'cancelar') {
      L.cancela = Number(v);
      return body();
    }
    if (a === 'xnao') {
      L.cancela = 0;
      return body();
    }
    if (a === 'xsim') {
      L.espera = 'cancelar';
      send('cancelar', { id: Number(v) });
      return body();
    }
  }

  // abrir pelos botoes do app.js (barra de baixo e barra de cima)
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-lx="abrir"]');
    if (b) open();
  });
  // com a janela aberta, o teclado e dela (setas e WASD nao andam com o personagem; Enter nao abre o chat)
  window.addEventListener('keydown', (ev) => {
    if (!L.open) return;
    if (ev.key === 'Escape') {
      if (L.compra || L.cancela) {
        L.compra = null;
        L.cancela = 0;
        body();
      } else close();
    } else if (ev.key === 'Enter' && ev.target && ev.target.id === 'lxCQtd' && L.compra) {
      const btn = document.querySelector('[data-lx="csim"]');
      if (btn && !btn.disabled) btn.click();
    }
    ev.stopImmediatePropagation();
  }, true);

  // ------------------------------------------------------------------------
  // mensagens da ponte e o estado do jogo (chamados pelo app.js)
  // ------------------------------------------------------------------------
  function onMessage(m) {
    if (m.op === 'cfg') {
      L.cfg = RG.cfgDe(m.cfg);
      L.tipos = m.tipos || RG.TIPOS;
      L.ordens = m.ordens || RG.ORDENS;
      if (L.open) {
        top();
        if (L.tab === 'vender') {
          vForm();
          vResumo();
        }
      }
    } else if (m.op === 'lista') {
      L.lista = m;
      if (L.open && L.tab === 'ofertas' && !L.det) put('lxList', listaHtml());
    } else if (m.op === 'item') {
      if (L.det && m.item && L.det.id === m.item.id) {
        L.det = { id: m.item.id, ...m };
        if (L.compra && !L.det.ofertas.some((o) => o.id === L.compra.id)) L.compra = null;
        if (L.open && L.tab === 'ofertas') body();
      }
    } else if (m.op === 'meus') {
      L.meus = m;
      if (!L.open) return;
      top();
      tabs();
      if (L.tab === 'meus') body();
      else if (L.tab === 'vender') vResumo();
    } else if (m.op === 'historico') {
      L.hist = m;
      if (L.open && L.tab === 'historico') body();
    } else if (m.op === 'precos') {
      Object.assign(L.precos, m.precos || {});
      if (L.open && L.tab === 'vender') {
        vBag();
        if (!document.activeElement || !/lxQtd|lxPreco/.test(document.activeElement.id)) vForm();
        vResumo();
      }
    } else if (m.op === 'recusado' || m.op === 'erro') {
      L.espera = '';
      if (L.open) body();
    } else if (m.op === 'aviso') {
      // resultado de um pedido (ou uma venda/expiracao): atualiza o que estiver aberto
      if (m.ok && L.espera === 'anunciar') {
        L.sel = 0;
        L.form = { qtd: '', preco: '', dias: L.cfg.diasPadrao };
        if (L.open && L.tab === 'vender') vForm();
      }
      // o que foi comprado fica marcado para nao ir na Venda rapida (nem no vender sozinho)
      // (depois do aviso da compra sumir: salvar a marca mostra "Configuracao salva." por cima dele)
      if (m.ok && L.comprando && /^Comprou/.test(m.texto || '') && app() && app().naoVender) {
        const id = L.comprando;
        setTimeout(() => app() && app().naoVender(id), 3700);
      }
      if (L.espera === 'comprar') L.comprando = 0;
      if (m.ok) {
        L.compra = null;
        L.cancela = 0;
      }
      L.espera = '';
      if (!L.open) return;
      send('meus');
      if (L.tab !== 'meus') load();
      body();
    }
  }

  function onState(m) {
    if (m.now) L.clock = m.now - Date.now() / 1000;
    if (!L.open) return;
    top();
    const sig = bag().map((it) => it.id + ':' + it.count).join(',');
    if (sig !== L.bagSig) {
      const first = !L.bagSig;
      L.bagSig = sig;
      if (L.tab === 'vender') {
        if (L.sel && !selItem()) L.sel = 0;
        vBag();
        if (!first) send('precos', { ids: bag().map((it) => it.id) });
        if (!document.activeElement || !/lxQtd|lxPreco/.test(document.activeElement.id)) vForm();
        vResumo();
      }
    }
  }

  window.Leilao = { open, close, onMessage, onState };

  // ------------------------------------------------------------------------
  // ?demo=1: leilao de mentira (sem servidor), so para ver a tela
  // ------------------------------------------------------------------------
  const D = { seq: 100, ofertas: null, hist: [], meus: 0 };
  const DEMO_ITENS = {
    3582: ['ham', 2, 'outros'], 3577: ['meat', 2, 'outros'], 5877: ['green dragon leather', 100, 'outros'], 5920: ['green dragon scale', 100, 'outros'],
    3351: ['steel helmet', 293, 'capacete'], 3349: ['crossbow', 120, 'arma'], 3409: ['steel shield', 80, 'escudo'], 3416: ['dragon shield', 4000, 'escudo'],
    3607: ['cheese', 2, 'outros'], 3392: ['royal helmet', 30000, 'capacete'], 3280: ['fire sword', 4000, 'arma'], 3381: ['crown armor', 12000, 'armadura'],
  };
  function demoInit() {
    if (D.ofertas) return;
    const t = Math.floor(Date.now() / 1000);
    const nomes = ['Lady Mirena', 'Kael Ventos', 'Tormund', 'Bruxa do Norte', 'Velho Jack'];
    D.ofertas = [];
    let k = 0;
    for (const [id, [nome, npc, tipo]] of Object.entries(DEMO_ITENS)) {
      for (let j = 0; j < 1 + (k % 3); j++) {
        const preco = RG.arredondar(npc * (1.1 + ((k * 7 + j * 3) % 10) / 10));
        D.ofertas.push({ id: ++D.seq, item: Number(id), nome, tipo, qtd: 1 + ((k + j) % 4) * (npc < 200 ? 25 : 1), preco, vendedor: nomes[(k + j) % nomes.length], seller: 2, termina: t + 3600 * (3 + ((k * 11 + j) % 160)), criada: t - 3600 * ((k + j) % 30), status: 'ativo' });
      }
      for (let j = 0; j < 4; j++) D.hist.push({ item: Number(id), nome, qtd: 1 + (j % 3), preco: RG.arredondar(npc * (1.2 + j / 10)), quando: t - 3600 * (j * 9 + k), tipo: 'venda', comprador: 'Alguém', vendedor: nomes[j % nomes.length] });
      k++;
    }
  }
  function demoStats(id) {
    return RG.precoMedio(D.hist.filter((h) => h.item === id && h.tipo === 'venda').slice(0, 20).map((h) => ({ count: h.qtd, price: h.preco })));
  }
  function demoOferta(o) {
    const s = demoStats(o.item);
    return { ...o, npc: DEMO_ITENS[o.item] ? DEMO_ITENS[o.item][1] : 0, lv: o.item === 3392 ? 50 : 0, minha: o.seller === 1, media: s.media, negocios: s.n };
  }
  function demoReply(m, r) {
    onMessage({ t: 'leilao', req: m.req, ...r });
  }
  function demo(m) {
    demoInit();
    const t = Math.floor(Date.now() / 1000);
    const ativas = D.ofertas.filter((o) => o.status === 'ativo' && o.termina > t);
    const toast = (text, ok) => app() && app().toast(text, ok ? 'ok' : 'erro');
    if (m.op === 'abrir') return demoReply(m, { op: 'cfg', cfg: RG.CFG, tipos: RG.TIPOS, ordens: RG.ORDENS });
    if (m.op === 'lista') {
      const busca = String(m.busca || '').toLowerCase();
      let l = ativas.filter((o) => (!busca || o.nome.includes(busca)) && (!m.tipo || o.tipo === m.tipo) && (!m.ids || m.ids.includes(o.item)));
      const ord = { barato: (a, b) => a.preco - b.preco, caro: (a, b) => b.preco - a.preco, termina: (a, b) => a.termina - b.termina, novos: (a, b) => b.criada - a.criada, nome: (a, b) => a.nome.localeCompare(b.nome) || a.preco - b.preco };
      l = l.sort(ord[m.ordem] || ord.barato);
      const por = 12;
      return demoReply(m, { op: 'lista', total: l.length, pagina: m.pagina || 0, por, ofertas: l.slice((m.pagina || 0) * por, (m.pagina || 0) * por + por).map(demoOferta) });
    }
    if (m.op === 'item') {
      const id = Number(m.item);
      const [nome, npc, tipo] = DEMO_ITENS[id] || ['item', 0, 'outros'];
      return demoReply(m, { op: 'item', item: { id, nome, npc, tipo, lv: id === 3392 ? 50 : 0, peso: 3500 }, stats: demoStats(id), ofertas: ativas.filter((o) => o.item === id).sort((a, b) => a.preco - b.preco).map(demoOferta), vendas: D.hist.filter((h) => h.item === id && h.tipo === 'venda').slice(0, 20).map((h) => ({ qtd: h.qtd, preco: h.preco, quando: h.quando })) });
    }
    if (m.op === 'meus') {
      const mine = D.ofertas.filter((o) => o.seller === 1 && o.status === 'ativo');
      return demoReply(m, { op: 'meus', ofertas: mine.map((o) => ({ ...demoOferta(o), taxa: RG.taxa(RG.CFG, o.qtd * o.preco) })), ativos: mine.length, limite: RG.CFG.maxAtivos, premium: false, pendente: { n: 1, gold: 1940, itens: 0 } });
    }
    if (m.op === 'historico') {
      return demoReply(m, { op: 'historico', linhas: D.hist.filter((h) => h.mine).concat([{ tipo: 'venda', item: 3409, nome: 'steel shield', qtd: 2, preco: 1000, total: 2000, taxa: 60, quem: 'Kael Ventos', quando: t - 7200, liquido: 1940 }, { tipo: 'compra', item: 3351, nome: 'steel helmet', qtd: 1, preco: 400, total: 400, taxa: 12, quem: 'Tormund', quando: t - 90000, liquido: -400 }, { tipo: 'expirado', item: 3577, nome: 'meat', qtd: 50, preco: 4, total: 200, taxa: 0, quem: '', quando: t - 200000, liquido: 0 }]).sort((a, b) => b.quando - a.quando) });
    }
    if (m.op === 'precos') {
      const out = {};
      for (const id of m.ids || []) {
        const s = demoStats(id);
        const a = ativas.filter((o) => o.item === id);
        out[id] = { ...s, menor: a.length ? Math.min(...a.map((o) => o.preco)) : 0, aVenda: a.reduce((x, o) => x + o.qtd, 0) };
      }
      return demoReply(m, { op: 'precos', precos: out });
    }
    if (m.op === 'anunciar') {
      const it = bag().find((x) => x.id === m.item);
      const erro = RG.validarAnuncio(RG.CFG, { npc: it ? it.price : 0, tem: it ? it.count : 0, qtd: m.qtd, preco: m.preco, dias: m.dias, ativos: D.ofertas.filter((o) => o.seller === 1 && o.status === 'ativo').length, premium: false, cacando: cacando(), banco: banco() });
      if (erro) {
        toast(erro, false);
        return demoReply(m, { op: 'recusado', texto: erro });
      }
      D.ofertas.push({ id: ++D.seq, item: it.id, nome: it.name, tipo: (DEMO_ITENS[it.id] || [])[2] || 'outros', qtd: m.qtd, preco: m.preco, vendedor: 'Julio Demo', seller: 1, termina: t + m.dias * 86400, criada: t, status: 'ativo' });
      const texto = `Sua oferta de ${m.qtd}× ${it.name} está no leilão por ${fmt(m.preco)} de gold cada (taxa de ${fmt(RG.taxa(RG.CFG, m.qtd * m.preco))} de gold).`;
      toast(texto, true);
      return demoReply(m, { op: 'aviso', ok: true, texto });
    }
    if (m.op === 'comprar') {
      const o = D.ofertas.find((x) => x.id === m.id);
      const erro = RG.validarCompra(RG.CFG, { oferta: o && { ...o, seller_id: o.seller, expires: o.termina, count: o.qtd, price: o.preco }, eu: 1, qtd: m.qtd, banco: banco(), agora: t, cacando: cacando() });
      if (erro) {
        toast(erro, false);
        return demoReply(m, { op: 'recusado', texto: erro });
      }
      o.qtd -= m.qtd;
      if (o.qtd <= 0) o.status = 'vendido';
      D.hist.unshift({ item: o.item, nome: o.nome, qtd: m.qtd, preco: o.preco, quando: t, tipo: 'venda' });
      const texto = `Comprou ${m.qtd}× ${o.nome} por ${fmt(m.qtd * o.preco)} de gold — está na sua mochila.`;
      toast(texto, true);
      return demoReply(m, { op: 'aviso', ok: true, texto });
    }
    if (m.op === 'cancelar') {
      const o = D.ofertas.find((x) => x.id === m.id && x.seller === 1);
      if (o) o.status = 'cancelado';
      const texto = o ? `Oferta cancelada — ${o.qtd}× ${o.nome} voltaram para a mochila (a taxa não volta).` : 'Essa oferta não existe mais.';
      toast(texto, !!o);
      return demoReply(m, { op: 'aviso', ok: !!o, texto });
    }
  }
})();
