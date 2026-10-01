/*
 * Povo de Thais: aventureiros que dao vida a cidade. Treinam na sala de treino, vao cacar (somem na
 * chama mistica), voltam, passam no depot, ficam de papo no templo e no salao, e conversam no Global
 * e no Comercio (chamando para cacadas e bosses, vendendo itens).
 * O mesmo arquivo roda no gateway (Node: um povo so, igual para todos os jogadores) e na demonstracao.
 *
 *   const povo = Povo.create(cidade)           // cidade = salas/cidade.json (tiles, atlas, points)
 *   povo.setHunts([{ name, min }])             // cacadas do catalogo (para as conversas)
 *   povo.onChat = (m) => {}                    // { ch: 'global' | 'comercio', name, lv, voc, text }
 *   povo.tick(Date.now())                      // a cada ~200 ms
 *   povo.near(x, y, rx, ry)                    // quem esta visivel perto: [{ id, name, lv, voc, x, y, z, dir, look }]
 *   povo.events(desdeMs, x, y, rx, ry)         // efeitos e falas desde entao: [{ id, at, k: 'shot'|'hit'|'flame'|'say', ... }]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Povo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STEP8 = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];
  const DUMMIES = new Set([5787, 15710, 28558, 28559, 28560, 28561, 28562, 28563, 28564, 28565]);
  const LOCKERS = new Set([3497, 3498, 3499, 3500]);
  const MIN = 60000;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const irnd = (a, b) => Math.floor(rnd(a, b + 1));
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const chance = (p) => Math.random() < p;
  const key = (x, y) => x + ',' + y;

  // quem mora em Thais: nome, level, vocacao, sexo e o jeito de passar o dia
  // (treino: vive na sala de treino e sai para cacar; rua: depot, cacada, papo no templo)
  const GENTE = [
    ['Kael Dragonheart', 142, 'K', 'm', 'treino'], ['Lady Morgana', 98, 'S', 'f', 'treino'], ['Thorin Machado', 61, 'K', 'm', 'treino'],
    ['Luna Druida', 47, 'D', 'f', 'treino'], ['Ragnar o Ousado', 187, 'K', 'm', 'treino'], ['Elara Flecha', 73, 'P', 'f', 'treino'],
    ['Zeca do Exori', 35, 'K', 'm', 'treino'], ['Mago Tiberio', 121, 'S', 'm', 'treino'], ['Aurora Elfica', 88, 'D', 'f', 'treino'],
    ['Brutus Bloqueador', 212, 'K', 'm', 'treino'], ['Vitoria Sorc', 54, 'S', 'f', 'treino'], ['Hunter Mike', 39, 'P', 'm', 'treino'],
    ['Sombra Noturna', 156, 'P', 'm', 'treino'], ['Seraphina', 67, 'D', 'f', 'treino'], ['Pedrinho Knight', 22, 'K', 'm', 'treino'],
    ['Malakai', 301, 'S', 'm', 'rua'], ['Drako Fenix', 118, 'K', 'm', 'rua'], ['Valquiria', 95, 'P', 'f', 'rua'],
    ['Gandalfin', 76, 'D', 'm', 'rua'], ['Joao Blocker', 133, 'K', 'm', 'rua'], ['Nerak', 44, 'S', 'm', 'rua'],
    ['Iris Curandeira', 58, 'D', 'f', 'rua'], ['Dark Paladino', 109, 'P', 'm', 'rua'], ['Bruxo Supremo', 247, 'S', 'm', 'rua'],
    ['Rafa Tanker', 29, 'K', 'm', 'rua'], ['Mel Arqueira', 18, 'P', 'f', 'rua'],
  ];
  const OUTFITS = {
    K: { m: [131, 134, 335, 268, 143], f: [139, 142, 336, 269, 147] },
    P: { m: [129, 152, 288, 151, 366], f: [137, 156, 289, 155, 367] },
    S: { m: [130, 145, 133, 273], f: [138, 149, 141, 270] },
    D: { m: [144, 154, 324, 146], f: [148, 158, 325, 150] },
  };
  const PROMO = { K: 'EK', P: 'RP', S: 'MS', D: 'ED' };
  const SHOT = { P: ['#e8d8a0'], S: ['#9ad8ff', '#ff8a30'], D: ['#a8f0ff', '#70d860'] };

  // conversas do Global: [abertura, respostas possiveis]
  const TOPICOS = [
    ['alguem pra {hunt}? {voc} {lv} aqui', ['eu vou, {voc2} {lv2}', 'bora, me chama pt', 'to dentro, ja to no templo', 'espera 5 min que to no depot']],
    ['party pra {hunt}, falta um {vocNome}', ['eu! {voc2} {lv2}', 'se ninguem for eu vou', 'chama pv']],
    ['boss {boss} hoje as {hora}h, precisa de {n} pessoas, chama pv', ['eu colo', 'vai ter bless? quero ir', 'reserva uma vaga pra mim', 'fechou, to dentro']],
    ['{boss} ja nasceu? alguem viu?', ['nasceu ontem, deve demorar', 'nao vi ainda', 'mataram de manha']],
    ['qual a melhor hunt pra {vocNome} {lv}?', ['{hunt} e boa, faz uns {xp}k/h', 'vai de {hunt}, loot bom', 'eu ia de {hunt}']],
    ['morri pra {monster} kkk perdi meu loot', ['F', 'kkkkk acontece', 'esqueceu a bless ne']],
    ['bom dia galera', ['bom dia!', 'bom diaa', 'eae']],
    ['upei pro {lvUp}!!', ['gz!!', 'parabens mano', 'gzz']],
    ['procuro guild ativa, {voc} {lv}', ['chama pv que te mando convite', 'a nossa ta recrutando']],
    ['{hunt} ta lotada agora?', ['tem um time la', 'ta vazia, vai la', 'acabei de sair de la']],
    ['quem quer fazer {boss} amanha?', ['eu', 'conta comigo', 'que horas?']],
    ['alguem vende pot? to sem mana', ['na loja tem', 'ta barato no NPC']],
    ['finalmente dropou {item} na {hunt}!!', ['sortudo', 'gz pelo drop', 'vende?']],
    ['alguem fazendo {hunt} agora? quero entrar na pt', ['vem, falta 1', 'a gente ta saindo, foi mal']],
    ['quanto ta o {item}?', ['uns {price}', 'no Comercio vi por {price}']],
    ['time pra {boss} sabado, {voc} {lv} procura vaga', ['tem vaga, chama pv', 'ja fechamos, desculpa']],
  ];
  const COMERCIO = ['VENDO {item} {price}', 'COMPRO {item}, pago {price}', 'troco {item} por {item2}', 'VENDO {item} barato, chama pv', 'COMPRO {item} e {item2}, pago bem'];
  const BOSSES = ['Ferumbras', 'Orshabaal', 'Morgaroth', 'Ghazbaran', 'The Pale Count', 'Zushuka', 'Grand Master Oberon', 'Scarlett Etzel', 'Lady Tenebris', 'Zulazza'];
  const MONSTROS = ['Dragon Lord', 'Demon', 'Hydra', 'Behemoth', 'Giant Spider', 'Warlock', 'Hero', 'Nightmare', 'Grim Reaper', 'Juggernaut'];
  const ITENS = ['magic plate armor', 'golden armor', 'demon shield', 'boots of haste', 'dragon scale mail', 'giant sword', 'crown armor',
    'mastermind shield', 'royal helmet', 'fire axe', 'dragon shield', 'stone skin amulet', 'might ring', 'blue robe', 'wand of inferno', 'royal crossbow'];
  const PRECOS = ['15k', '30k', '45k', '80k', '120k', '200k', '350k', '1kk'];

  // falas perto (aparecem em amarelo em cima do personagem)
  const FALA = {
    sai: ['partiu {hunt}', 'fui cacar, flw', 'bora upar', 'vou dar uma volta na {hunt}'],
    volta: ['ufa, voltei vivo', 'loot bom hoje', 'quase morri kkk', 'que hunt boa'],
    depot: ['deixa eu guardar esse loot', 'alguem troca platinum?', 'hi', 'cade meu backpack...'],
    treino: ['treinando ML ate amanha', 'esse boneco aguenta hein', 'mais 1 skill e vou cacar', 'bora treinar'],
    papo: ['alguem de party?', 'trade?', 'alguem pra {hunt}?', 'bora cacar?', 'que dia bonito em Thais', 'alguem sabe onde fica o barco?'],
  };

  class Povo {
    constructor(cidade) {
      this.hunts = [{ name: 'Covil dos Dragões', min: 37 }, { name: 'Colinas dos Ciclopes', min: 8 }];
      this.evs = [];
      this.evSeq = 0;
      this.chatQ = [];
      this.onChat = null;
      this.occ = new Map();
      this.load(cidade);
      const now = Date.now();
      this.topicAt = now + rnd(3000, 9000);
      this.tradeAt = now + rnd(12000, 30000);
      this.bots = GENTE.map(([name, lv, L, sex, jeito], i) => ({
        id: 'b' + i, name, lv, L, jeito,
        look: { t: pick(OUTFITS[L][sex]), h: irnd(0, 132), b: irnd(0, 132), l: irnd(0, 132), f: irnd(0, 132) },
        x: 0, y: 0, dir: 2, vis: false, st: 'hunt', until: 0, path: [], next: 0,
        stepMs: Math.max(300, Math.min(470, 500 - lv)),
      }));
      this.start(now);
    }

    // onde se anda, onde se treina, onde fica o depot, a chama e os lugares de papo
    load(r) {
      const walk = new Set(), items = new Map();
      for (const t of r.tiles) {
        if ((t[2] || 0) !== 0) continue;
        const ids = t.slice(3);
        items.set(key(t[0], t[1]), ids);
        let ground = false, block = false;
        for (const id of ids) {
          const a = r.atlas && r.atlas[id];
          if (!a) continue;
          if (a[4] === 0) ground = true;
          if (a[8]) block = true;
        }
        if (ground && !block) walk.add(key(t[0], t[1]));
      }
      for (const [x, y] of r.nowalk || []) walk.delete(key(x, y));
      this.walk = walk;
      const P = r.points || {};
      const has = (x, y, set) => (items.get(key(x, y)) || []).some((id) => set.has(id));
      // a chama: o tile livre mais perto do ponto marcado (como a pagina faz)
      this.flame = this.nearest(P.flame || [0, 0]);
      // treino: em volta de cada boneco (do lado para quem luta; ate 3 passos para quem atira)
      const spots = new Map();
      for (const [k, ids] of items) {
        if (!ids.some((id) => DUMMIES.has(id))) continue;
        const [dx, dy] = k.split(',').map(Number);
        for (const [x, y, d] of this.around([dx, dy], 3)) {
          const old = spots.get(key(x, y));
          const melee = Math.max(Math.abs(x - dx), Math.abs(y - dy)) === 1;
          if (old && old.d <= d) continue;
          spots.set(key(x, y), { x, y, d, melee, dummy: [dx, dy], dir: faceTo(x, y, dx, dy), by: null });
        }
      }
      this.trainSpots = [...spots.values()];
      // depot: de frente para um armario, perto do ponto do depot
      this.depotSpots = [];
      for (const [x, y] of this.around(P.depot || [0, 0], 8, true)) {
        for (const [ox, oy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          if (has(x + ox, y + oy, LOCKERS)) { this.depotSpots.push({ x, y, dir: faceTo(x, y, x + ox, y + oy), by: null }); break; }
        }
      }
      // papo: em volta do templo e no salao do depot
      const hang = new Map();
      for (const c of [...this.around(P.temple || [0, 0], 5, true), ...this.around(P.salao || P.depot || [0, 0], 7, true)]) hang.set(key(c[0], c[1]), c);
      const busy = new Set([...this.trainSpots, ...this.depotSpots].map((s) => key(s.x, s.y)));
      this.hangSpots = [...hang.values()].filter(([x, y]) => !busy.has(key(x, y)) && !(x === this.flame[0] && y === this.flame[1]));
      this.temple = this.nearest(P.temple || [0, 0]);
    }

    // tiles livres a ate n passos de p (com o proprio p se for livre)
    around(p, n, self) {
      const out = [], seen = new Set([key(p[0], p[1])]);
      let front = [[p[0], p[1]]];
      if (self && this.walk.has(key(p[0], p[1]))) out.push([p[0], p[1], 0]);
      for (let d = 1; d <= n && front.length; d++) {
        const nx = [];
        for (const [x, y] of front) {
          for (const [ox, oy] of STEP8) {
            const k = key(x + ox, y + oy);
            if (seen.has(k) || !this.walk.has(k)) continue;
            seen.add(k);
            out.push([x + ox, y + oy, d]);
            nx.push([x + ox, y + oy]);
          }
        }
        front = nx;
      }
      return out;
    }

    nearest(p) {
      let best = null, bd = 1e9;
      for (const k of this.walk) {
        const [x, y] = k.split(',').map(Number);
        const d = Math.abs(x - p[0]) + Math.abs(y - p[1]);
        if (d < bd) { bd = d; best = [x, y]; }
      }
      return best || [p[0], p[1]];
    }

    // caminho curto por tiles livres (8 direcoes, sem cortar quina); avoid = tiles ocupados a evitar
    path(from, to, avoid) {
      const goal = key(to[0], to[1]);
      const prev = new Map([[key(from[0], from[1]), null]]);
      const queue = [from];
      for (let qi = 0; qi < queue.length && qi < 40000; qi++) {
        const [x, y] = queue[qi];
        if (key(x, y) === goal) break;
        for (const [dx, dy] of STEP8) {
          const nk = key(x + dx, y + dy);
          if (prev.has(nk) || !this.walk.has(nk) || (avoid && avoid.has(nk) && nk !== goal)) continue;
          if (dx && dy && (!this.walk.has(key(x + dx, y)) || !this.walk.has(key(x, y + dy)))) continue;
          prev.set(nk, key(x, y));
          queue.push([x + dx, y + dy]);
        }
      }
      if (!prev.has(goal)) return null;
      const out = [];
      for (let k = goal; k; k = prev.get(k)) out.unshift(k.split(',').map(Number));
      return out.slice(1);
    }

    setHunts(list) {
      const ok = (list || []).filter((h) => h && h.name && h.min > 0);
      if (ok.length) this.hunts = ok;
    }

    huntFor(lv) {
      const fit = this.hunts.filter((h) => h.min <= lv && h.min >= lv * 0.35);
      const any = this.hunts.filter((h) => h.min <= lv);
      return pick(fit.length ? fit : any.length ? any : this.hunts).name;
    }

    voc(b) {
      return b.lv >= 20 ? PROMO[b.L] : b.L;
    }

    // ------------------------------------------------------------------ comeco: a cidade ja cheia
    start(now) {
      const train = this.bots.filter((b) => b.jeito === 'treino');
      const rua = this.bots.filter((b) => b.jeito === 'rua');
      train.forEach((b, i) => {
        if (i < 11 && this.placeAt(b, this.freeTrain(b), now)) {
          b.st = 'train';
          b.until = now + rnd(0.5, 14) * MIN;
          b.atkAt = now + rnd(300, 2500);
        } else this.away(b, now, rnd(0.5, 4) * MIN);
      });
      rua.forEach((b, i) => {
        const kind = i % 4;
        if (kind === 0 && this.placeAt(b, this.freeDepot(), now)) { b.st = 'depot'; b.until = now + rnd(5, 50) * 1000; }
        else if (kind === 1 || kind === 2) {
          const s = this.freeHang();
          if (s && this.placeAt(b, { x: s[0], y: s[1], dir: irnd(0, 3) }, now)) { b.st = 'idle'; b.until = now + rnd(10, 110) * 1000; }
          else this.away(b, now, rnd(0.3, 3) * MIN);
        } else this.away(b, now, rnd(0.3, 3) * MIN);
      });
    }

    placeAt(b, spot, now) {
      if (!spot) return false;
      b.x = spot.x; b.y = spot.y; b.dir = spot.dir ?? 2;
      b.vis = true;
      if (spot.by !== undefined) { spot.by = b.id; b.spot = spot; }
      this.occ.set(key(b.x, b.y), b.id);
      b.next = now;
      return true;
    }

    away(b, now, ms) {
      b.vis = false;
      b.st = 'hunt';
      b.until = now + ms;
    }

    freeTrain(b) {
      const free = this.trainSpots.filter((s) => !s.by && !this.occ.has(key(s.x, s.y)));
      const want = free.filter((s) => (b.L === 'K' ? s.melee : !s.melee));
      return pick(want.length ? want : free.filter((s) => s.melee || b.L !== 'K')) || null;
    }

    freeDepot() {
      return pick(this.depotSpots.filter((s) => !s.by && !this.occ.has(key(s.x, s.y)))) || null;
    }

    freeHang() {
      for (let t = 0; t < 12; t++) {
        const s = pick(this.hangSpots);
        if (s && !this.occ.has(key(s[0], s[1]))) return s;
      }
      return null;
    }

    release(b) {
      if (b.spot) b.spot.by = null;
      b.spot = null;
    }

    // ------------------------------------------------------------------ o dia de cada um
    tick(now) {
      for (const b of this.bots) {
        if (b.st === 'walk') this.stepBot(b, now);
        else if (now >= b.until) this.next(b, now);
        else if (b.st === 'train' && now >= b.atkAt) this.attack(b, now);
      }
      this.chatTick(now);
    }

    next(b, now) {
      const was = b.st;
      this.release(b);
      if (was === 'hunt') return this.comeBack(b, now);
      const r = Math.random();
      if (was === 'train') return b.jeito === 'treino' ? (r < 0.75 ? this.goHunt(b, now) : this.goDepot(b, now)) : (r < 0.6 ? this.goHunt(b, now) : this.goHang(b, now));
      if (was === 'depot') {
        if (b.jeito === 'treino') return this.goTrain(b, now);
        return r < 0.45 ? this.goHunt(b, now) : r < 0.8 ? this.goHang(b, now) : this.goTrain(b, now);
      }
      // papo (ou nao achou lugar): quem vive de treino volta a treinar; o resto caca, vai ao depot ou muda de canto
      if (b.jeito === 'treino') return r < 0.85 ? this.goTrain(b, now) : this.goDepot(b, now);
      return r < 0.45 ? this.goHunt(b, now) : r < 0.75 ? this.goDepot(b, now) : this.goHang(b, now);
    }

    go(b, spot, now, arrive) {
      const steps = this.path([b.x, b.y], [spot.x, spot.y]);
      if (!steps) {
        if (spot.by === b.id) spot.by = null;
        b.st = 'idle';
        b.until = now + rnd(2000, 6000);
        return false;
      }
      b.st = 'walk';
      b.path = steps;
      b.arrive = arrive;
      b.waits = 0;
      b.next = now + rnd(300, 1200);
      return true;
    }

    goTrain(b, now) {
      const s = this.freeTrain(b);
      if (!s) return this.goHang(b, now);
      s.by = b.id;
      b.spot = s;
      this.go(b, s, now, (t) => {
        b.st = 'train';
        b.dir = s.dir;
        b.until = t + (b.jeito === 'treino' ? rnd(8, 15) : rnd(3, 6)) * MIN;
        b.atkAt = t + rnd(500, 2000);
        if (chance(0.15)) this.say(b, pick(FALA.treino), t);
      });
    }

    goDepot(b, now) {
      const s = this.freeDepot();
      if (!s) return this.goHang(b, now, true);
      s.by = b.id;
      b.spot = s;
      this.go(b, s, now, (t) => {
        b.st = 'depot';
        b.dir = s.dir;
        b.until = t + rnd(20, 60) * 1000;
        if (chance(0.25)) this.say(b, pick(FALA.depot), t);
      });
    }

    goHang(b, now) {
      const s = this.freeHang();
      if (!s) { b.st = 'idle'; b.until = now + rnd(3000, 8000); return; }
      this.go(b, { x: s[0], y: s[1] }, now, (t) => {
        b.st = 'idle';
        b.dir = irnd(0, 3);
        b.until = t + rnd(40, 120) * 1000;
        if (chance(0.3)) this.say(b, this.fill(pick(FALA.papo), b), t);
      });
    }

    goHunt(b, now) {
      b.hunt = this.huntFor(b.lv);
      if (chance(0.25)) this.say(b, this.fill(pick(FALA.sai), b, null, { hunt: b.hunt }), now);
      this.go(b, { x: this.flame[0], y: this.flame[1] }, now, (t) => {
        this.ev({ k: 'flame', x: b.x, y: b.y }, t);
        this.occ.delete(key(b.x, b.y));
        this.away(b, t, (b.jeito === 'treino' ? rnd(1.5, 3) : rnd(2, 4)) * MIN);
      });
    }

    comeBack(b, now) {
      // sai da chama (ou do lado dela, se tiver gente em cima)
      const spot = [[this.flame[0], this.flame[1], 0], ...this.around(this.flame, 2)].find(([x, y]) => !this.occ.has(key(x, y)));
      if (!spot) { b.until = now + 3000; return; }
      b.x = spot[0]; b.y = spot[1]; b.dir = 2;
      b.vis = true;
      this.occ.set(key(b.x, b.y), b.id);
      this.ev({ k: 'flame', x: b.x, y: b.y }, now);
      if (chance(0.35)) this.say(b, pick(FALA.volta), now + 800);
      b.st = 'idle';
      b.until = now + rnd(800, 2500);
      this.goDepot(b, now + 1200); // depois de cacar: depot
    }

    stepBot(b, now) {
      if (now < b.next) return;
      if (!b.path.length) {
        const fn = b.arrive;
        b.arrive = null;
        b.st = 'idle';
        b.until = now + 4000;
        if (fn) fn(now);
        return;
      }
      const [x, y] = b.path[0];
      const k = key(x, y);
      const other = this.occ.get(k);
      if (other && other !== b.id) {
        // alguem no caminho: espera um pouco e, se continuar, contorna; preso demais, desiste
        b.waits++;
        b.stuck = (b.stuck || 0) + 1;
        b.next = now + 350;
        if (b.stuck > 18) {
          this.release(b);
          b.path = [];
          b.arrive = null;
          b.st = 'idle';
          b.stuck = 0;
          b.until = now + rnd(1000, 4000);
          return;
        }
        if (b.waits > 4) {
          const goal = b.path[b.path.length - 1];
          const avoid = new Set([...this.occ.keys()].filter((q) => q !== key(goal[0], goal[1])));
          const alt = this.path([b.x, b.y], goal, avoid);
          if (alt && alt.length) b.path = alt;
          b.waits = 0;
          if (!alt && this.occ.get(key(goal[0], goal[1])) && this.occ.get(key(goal[0], goal[1])) !== b.id) {
            // o lugar foi tomado: desiste e escolhe outra coisa
            this.release(b);
            b.path = [];
            b.arrive = null;
            b.st = 'idle';
            b.until = now + 1500;
          }
        }
        return;
      }
      b.path.shift();
      const dx = x - b.x, dy = y - b.y;
      this.occ.delete(key(b.x, b.y));
      this.occ.set(k, b.id);
      b.x = x; b.y = y;
      b.dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
      b.next = now + b.stepMs * (dx && dy ? 1.4 : 1);
      b.waits = 0;
      b.stuck = 0;
    }

    attack(b, now) {
      const d = b.spot ? b.spot.dummy : null;
      b.atkAt = now + rnd(1400, 2600);
      if (!d) return;
      b.dir = b.spot.dir;
      if (b.L === 'K') this.ev({ k: 'hit', x: d[0], y: d[1], c: '#ffffff' }, now);
      else this.ev({ k: 'shot', fx: b.x, fy: b.y, x: d[0], y: d[1], c: pick(SHOT[b.L]) }, now);
    }

    // ------------------------------------------------------------------ efeitos e falas
    ev(e, at) {
      e.id = ++this.evSeq;
      e.at = at;
      this.evs.push(e);
      if (this.evs.length > 600) this.evs.splice(0, 200);
    }

    say(b, text, at) {
      this.ev({ k: 'say', bot: b.id, name: b.name, lv: b.lv, text, x: b.x, y: b.y }, at);
    }

    // o que aconteceu depois de 'desde' (ms) ate agora, perto de (x, y)
    events(desde, x, y, rx = 14, ry = 11, now = Date.now()) {
      const from = Math.max(desde || 0, now - 3000);
      return this.evs.filter((e) => e.at > from && e.at <= now && Math.abs(e.x - x) <= rx && Math.abs(e.y - y) <= ry);
    }

    near(x, y, rx = 14, ry = 11) {
      return this.bots.filter((b) => b.vis && Math.abs(b.x - x) <= rx && Math.abs(b.y - y) <= ry)
        .map((b) => ({ id: b.id, name: b.name, lv: b.lv, voc: this.voc(b), x: b.x, y: b.y, z: 0, dir: b.dir, look: b.look }));
    }

    count() {
      return this.bots.length;
    }

    // ------------------------------------------------------------------ chat
    fill(t, b, b2, extra = {}) {
      const ctx = {
        hunt: this.huntFor(b.lv), voc: this.voc(b), lv: b.lv, vocNome: pick(['EK', 'RP', 'MS', 'ED']), boss: pick(BOSSES),
        hora: irnd(18, 23), n: irnd(3, 8), monster: pick(MONSTROS), item: pick(ITENS), item2: pick(ITENS), price: pick(PRECOS),
        xp: irnd(Math.max(20, b.lv), b.lv * 5), lvUp: b.lv + 1, ...extra,
      };
      if (b2) { ctx.voc2 = this.voc(b2); ctx.lv2 = b2.lv; }
      return t.replace(/\{(\w+)\}/g, (_, k) => (ctx[k] === undefined ? '' : String(ctx[k])));
    }

    chatTick(now) {
      if (now >= this.topicAt) {
        this.topicAt = now + rnd(9000, 26000);
        const [open, replies] = pick(TOPICOS);
        const a = pick(this.bots);
        const ctx = { hunt: this.huntFor(a.lv), boss: pick(BOSSES), item: pick(ITENS), price: pick(PRECOS), monster: pick(MONSTROS) };
        this.chatQ.push({ at: now, ch: 'global', b: a, text: this.fill(open, a, null, ctx) });
        if (open.startsWith('upei')) a.lv += 1;
        let t = now;
        for (let i = 0; i < 2 && replies.length && chance(i === 0 ? 0.75 : 0.35); i++) {
          const r = pick(this.bots.filter((x) => x !== a));
          t += rnd(3000, 9000);
          this.chatQ.push({ at: t, ch: 'global', b: r, text: this.fill(pick(replies), a, r, ctx) });
        }
        this.chatQ.sort((p, q) => p.at - q.at);
      }
      if (now >= this.tradeAt) {
        this.tradeAt = now + rnd(25000, 60000);
        const a = pick(this.bots);
        this.chatQ.push({ at: now, ch: 'comercio', b: a, text: this.fill(pick(COMERCIO), a) });
        this.chatQ.sort((p, q) => p.at - q.at);
      }
      while (this.chatQ.length && this.chatQ[0].at <= now) {
        const m = this.chatQ.shift();
        if (this.onChat) this.onChat({ ch: m.ch, name: m.b.name, lv: m.b.lv, voc: this.voc(m.b), text: m.text });
      }
    }
  }

  function faceTo(x, y, tx, ty) {
    const dx = tx - x, dy = ty - y;
    return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
  }

  return { create: (cidade) => new Povo(cidade) };
});
