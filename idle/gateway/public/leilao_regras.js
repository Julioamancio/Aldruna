/*
 * Destruitor Idle — regras do LEILAO usadas pela ponte (gateway/leilao.js) e pela pagina (leilao.js).
 * Quem decide de verdade e o servidor (canary/scripts/idle/idle_leilao.lua): estas sao as mesmas contas,
 * para mostrar a taxa antes e recusar cedo o que o servidor recusaria. A configuracao vem do servidor
 * (idle_catalog 'leilao'); CFG abaixo e so o padrao enquanto ela nao chega — manter igual ao L.CFG do Lua.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LeilaoRegras = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CFG = {
    taxaPct: 2, taxaMin: 20, taxaMax: 500000, // taxa de anuncio: cobrada na hora, nao volta
    comissaoPct: 3, // a casa fica com isto da venda
    dias: [1, 3, 7], diasPadrao: 7,
    maxAtivos: 10, maxAtivosPremium: 25,
    maxQtd: 10000, precoMax: 100000000, totalMax: 2000000000,
    pisoNpc: true, avisoPct: 30, soNaCidade: true,
  };

  const TIPOS = {
    arma: 'Armas', escudo: 'Escudos', capacete: 'Capacetes', armadura: 'Armaduras', calcas: 'Calças', botas: 'Botas',
    amuleto: 'Amuletos', anel: 'Anéis', municao: 'Munição', recipiente: 'Recipientes', runa: 'Runas', outros: 'Outros',
  };

  const ORDENS = { barato: 'Menor preço', caro: 'Maior preço', termina: 'Termina antes', novos: 'Mais recentes', nome: 'Por nome' };

  const fmt = (n) => Math.floor(Number(n) || 0).toLocaleString('pt-BR');

  // inteiro positivo de verdade (aceita "1200" da pagina; recusa 1.5, -3, "1e3", "")
  function inteiro(v) {
    if (typeof v === 'number') return Number.isSafeInteger(v) ? v : NaN;
    if (typeof v === 'string' && /^\s*\d{1,15}\s*$/.test(v)) return Number(v);
    return NaN;
  }

  const cfgDe = (cfg) => ({ ...CFG, ...(cfg || {}) });

  function taxa(cfg, total) {
    const c = cfgDe(cfg);
    return Math.min(c.taxaMax, Math.max(c.taxaMin, Math.floor((total * c.taxaPct) / 100)));
  }

  function comissao(cfg, total) {
    return Math.floor((total * cfgDe(cfg).comissaoPct) / 100);
  }

  // o que o vendedor paga e recebe
  function conta(cfg, qtd, preco) {
    const total = qtd * preco;
    const t = taxa(cfg, total);
    const c = comissao(cfg, total);
    return { total, taxa: t, comissao: c, recebe: total - c, liquido: total - c - t };
  }

  const limiteAtivos = (cfg, premium) => (premium ? cfgDe(cfg).maxAtivosPremium : cfgDe(cfg).maxAtivos);

  // a: { npc, tem, qtd, preco, dias, ativos, premium, cacando, banco }  ->  texto do erro ou null
  // (mesma ordem e mesmos textos do L.anunciar do Lua)
  function validarAnuncio(cfg, a) {
    const c = cfgDe(cfg);
    if (c.soNaCidade && a.cacando) return 'A casa de leilões só negocia na cidade — saia da caçada para anunciar.';
    if (!(a.npc > 0)) return 'Esse item não pode ser vendido no leilão.';
    const qtd = inteiro(a.qtd);
    const preco = inteiro(a.preco);
    if (!(qtd >= 1)) return 'Quantidade inválida.';
    if (qtd > c.maxQtd) return `No máximo ${fmt(c.maxQtd)} unidades por oferta.`;
    if (a.tem != null && a.tem < qtd) return 'Você não tem essa quantidade na mochila.';
    if (!(preco >= 1)) return 'Ponha um preço por unidade.';
    if (preco > c.precoMax) return `O preço máximo é ${fmt(c.precoMax)} de gold cada.`;
    if (c.pisoNpc && preco < a.npc) return `O preço mínimo é o valor no NPC: ${fmt(a.npc)} de gold cada — abaixo disso a Venda rápida paga mais.`;
    if (qtd * preco > c.totalMax) return `O total da oferta passa de ${fmt(c.totalMax)} de gold.`;
    if (!c.dias.includes(inteiro(a.dias))) return `Escolha a duração: ${c.dias.join(', ').replace(/, (\d+)$/, ' ou $1')} dias.`;
    const lim = limiteAtivos(c, a.premium);
    if (a.ativos != null && a.ativos >= lim) return `Você já tem ${lim} ofertas ativas — cancele uma ou espere vender.`;
    const t = taxa(c, qtd * preco);
    if (a.banco != null && a.banco < t) return `A taxa de ${fmt(t)} de gold para anunciar é mais do que você tem no banco.`;
    return null;
  }

  // c: { oferta: { count, price, expires, seller_id, status }, eu, qtd, banco, agora, cacando }
  function validarCompra(cfg, x) {
    const c = cfgDe(cfg);
    const o = x.oferta;
    if (c.soNaCidade && x.cacando) return 'A casa de leilões só negocia na cidade — saia da caçada para comprar.';
    if (!o || (o.status && o.status !== 'ativo' && o.status !== 'reservado')) return 'Essa oferta não existe mais.';
    if (o.status === 'reservado') return 'Essa oferta está sendo comprada agora.';
    if (o.expires <= x.agora) return 'Essa oferta expirou.';
    if (o.seller_id === x.eu) return 'Você não pode comprar a sua própria oferta.';
    const qtd = inteiro(x.qtd);
    if (!(qtd >= 1)) return 'Quantidade inválida.';
    if (qtd > o.count) return 'A oferta não tem mais essa quantidade.';
    if (x.banco != null && x.banco < qtd * o.price) return `Você precisa de ${fmt(qtd * o.price)} de gold no banco para isso.`;
    return null;
  }

  // ultimos negocios de um item ([{ count, price }], do mais novo para o mais velho) ->
  // media por unidade (ponderada pela quantidade), mediana do preco por unidade (um negocio fora da
  // curva nao mexe nela), menor e maior
  function precoMedio(vendas) {
    const v = (vendas || []).filter((x) => x && x.count > 0 && x.price > 0);
    if (!v.length) return { n: 0, media: 0, mediana: 0, min: 0, max: 0 };
    let qtd = 0, soma = 0;
    for (const x of v) {
      qtd += Number(x.count);
      soma += Number(x.count) * Number(x.price);
    }
    const p = v.map((x) => Number(x.price)).sort((a, b) => a - b);
    const m = p.length >> 1;
    const mediana = p.length % 2 ? p[m] : Math.round((p[m - 1] + p[m]) / 2);
    return { n: v.length, media: Math.round(soma / qtd), mediana, min: p[0], max: p[p.length - 1] };
  }

  // preco longe da referencia (preco medio): { pct, texto } ou null
  function avisoPreco(cfg, preco, ref) {
    if (!(ref > 0) || !(preco > 0)) return null;
    const pct = Math.round(((preco - ref) / ref) * 100);
    if (Math.abs(pct) < cfgDe(cfg).avisoPct) return null;
    return { pct, texto: pct > 0 ? `${pct}% acima do preço médio — pode demorar a vender.` : `${-pct}% abaixo do preço médio — você pode estar deixando gold na mesa.` };
  }

  // numero "redondo" para sugerir preco: 2 algarismos significativos (1234 -> 1200, 98765 -> 99000)
  function arredondar(n) {
    n = Math.max(1, Math.round(Number(n) || 0));
    if (n < 100) return n;
    const d = 10 ** (String(n).length - 2);
    return Math.round(n / d) * d;
  }

  // preco justo para um anuncio automatico (jogadores simulados): a mediana dos ultimos negocios; sem
  // negocios, o valor no NPC com uma margem. Nunca abaixo do NPC.
  function precoJusto(npc, stats, margem = 1.25) {
    const base = stats && stats.n >= 3 ? stats.mediana : npc * margem;
    return Math.max(npc, arredondar(base));
  }

  // "3031:5,3035:2" -> Map(id -> quantidade)  (coluna items do idle_bag)
  function lerMochila(txt) {
    const m = new Map();
    for (const part of String(txt || '').split(',')) {
      const [id, n] = part.split(':').map(Number);
      if (Number.isInteger(id) && id > 0 && Number.isInteger(n) && n > 0) m.set(id, (m.get(id) || 0) + n);
    }
    return m;
  }

  // segundos -> "6d 4h", "3h 20min", "12min", "agora"
  function tempoRestante(s) {
    s = Math.max(0, Math.floor(s || 0));
    if (s < 60) return 'menos de 1min';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${String(m).padStart(2, '0')}min`;
    return `${m}min`;
  }

  return { CFG, TIPOS, ORDENS, fmt, inteiro, cfgDe, taxa, comissao, conta, limiteAtivos, validarAnuncio, validarCompra, precoMedio, avisoPreco, arredondar, precoJusto, lerMochila, tempoRestante };
});
