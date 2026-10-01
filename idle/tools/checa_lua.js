'use strict';
// Confere arquivos Lua sem precisar do luac (nao ha Lua nesta maquina): analisador de Lua 5.1 (+ goto e
// labels do LuaJIT) que acha erro de sintaxe e lista as variaveis globais usadas (nome digitado errado
// aparece como global desconhecida).
// Uso: node tools/checa_lua.js canary/scripts/idle/*.lua [--globals]
const fs = require('fs');

const KW = new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' '));

function lex(src) {
  const toks = [];
  let i = 0, line = 1;
  const n = src.length;
  const err = (m) => { throw new Error(`linha ${line}: ${m}`); };
  const longBracket = () => {
    // em src[i] == '[' ; devolve o nivel ou -1
    let j = i + 1, lvl = 0;
    while (src[j] === '=') { lvl++; j++; }
    return src[j] === '[' ? lvl : -1;
  };
  const readLong = (lvl) => {
    const close = ']' + '='.repeat(lvl) + ']';
    const start = i;
    i += lvl + 2;
    const end = src.indexOf(close, i);
    if (end < 0) err('string/comentario longo sem fim');
    const body = src.slice(i, end);
    line += (src.slice(start, end + close.length).match(/\n/g) || []).length;
    i = end + close.length;
    return body;
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {
      i += 2;
      if (src[i] === '[') {
        const lvl = longBracket();
        if (lvl >= 0) { readLong(lvl); continue; }
      }
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '[') {
      const lvl = longBracket();
      if (lvl >= 0) { const l0 = line; const body = readLong(lvl); toks.push({ t: 'str', v: body, long: true, line: l0 }); continue; }
    }
    if (c === '"' || c === "'") {
      const q = c, l0 = line;
      i++;
      let s = '';
      while (true) {
        if (i >= n) err('string sem fim');
        const d = src[i];
        if (d === q) { i++; break; }
        if (d === '\n') err('quebra de linha dentro de string');
        if (d === '\\') {
          const e = src[i + 1];
          if (e === '\n') line++;
          if (!/[abfnrtv\\"'\n0-9xz]/.test(e)) err('escape invalido \\' + e);
          i += 2;
          continue;
        }
        s += d;
        i++;
      }
      toks.push({ t: 'str', v: s, line: l0 });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      const m = /^(0[xX][0-9a-fA-F]+(\.[0-9a-fA-F]*)?([pP][+-]?\d+)?|\d*\.?\d+([eE][+-]?\d+)?\.?\d*([eE][+-]?\d+)?)(ULL|LL|i)?/.exec(src.slice(i));
      if (!m) err('numero invalido');
      i += m[0].length;
      toks.push({ t: 'num', v: m[0], line });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      i += m[0].length;
      toks.push({ t: KW.has(m[0]) ? m[0] : 'name', v: m[0], line });
      continue;
    }
    const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
    if (three === '...') { toks.push({ t: '...', line }); i += 3; continue; }
    if (['..', '==', '~=', '<=', '>=', '::'].includes(two)) { toks.push({ t: two, line }); i += 2; continue; }
    if ('+-*/%^#<>=(){}[];:,.'.includes(c)) { toks.push({ t: c, line }); i++; continue; }
    err('caractere inesperado ' + JSON.stringify(c));
  }
  toks.push({ t: 'eof', line });
  return toks;
}

function parse(src) {
  const toks = lex(src);
  let p = 0;
  const globals = new Map(); // nome -> { reads, writes, lines }
  let scope = null;
  const pushScope = () => (scope = { vars: new Set(), up: scope });
  const popScope = () => (scope = scope.up);
  const declare = (name) => scope.vars.add(name);
  const resolve = (name) => { for (let s = scope; s; s = s.up) if (s.vars.has(name)) return true; return false; };
  const useName = (name, line, write) => {
    if (resolve(name)) return;
    const g = globals.get(name) || { reads: 0, writes: 0, lines: [] };
    if (write) g.writes++; else g.reads++;
    if (g.lines.length < 5) g.lines.push(line);
    globals.set(name, g);
  };

  const peek = (k = 0) => toks[p + k];
  const check = (t) => peek().t === t;
  const accept = (t) => (check(t) ? toks[p++] : null);
  const expect = (t, what) => {
    if (!check(t)) throw new Error(`linha ${peek().line}: esperava '${t}'${what ? ' (' + what + ')' : ''}, veio '${peek().v || peek().t}'`);
    return toks[p++];
  };

  const blockEnd = () => ['else', 'elseif', 'end', 'until', 'eof'].includes(peek().t);

  function block() {
    pushScope();
    while (!blockEnd()) {
      if (check('return')) {
        p++;
        if (!blockEnd() && !check(';')) explist();
        accept(';');
        if (!blockEnd()) throw new Error(`linha ${peek().line}: codigo depois de return`);
        break;
      }
      if (check('break')) { p++; accept(';'); continue; }
      statement();
      accept(';');
    }
    popScope();
  }

  function funcbody(isMethod, line) {
    expect('(');
    pushScope();
    if (isMethod) declare('self');
    if (!check(')')) {
      do {
        if (accept('...')) break;
        declare(expect('name', 'parametro').v);
      } while (accept(','));
    }
    expect(')');
    block();
    expect('end', 'fim da funcao aberta na linha ' + line);
    popScope();
  }

  function statement() {
    const tk = peek();
    switch (tk.t) {
      case 'if': {
        p++; exp(); expect('then');
        block();
        while (accept('elseif')) { exp(); expect('then'); block(); }
        if (accept('else')) block();
        expect('end', 'fim do if da linha ' + tk.line);
        return;
      }
      case 'while': p++; exp(); expect('do'); block(); expect('end', 'fim do while da linha ' + tk.line); return;
      case 'do': p++; block(); expect('end', 'fim do do da linha ' + tk.line); return;
      case 'for': {
        p++;
        const n1 = expect('name').v;
        if (accept('=')) {
          exp(); expect(','); exp();
          if (accept(',')) exp();
          expect('do');
          pushScope(); declare(n1); block(); popScope();
        } else {
          const names = [n1];
          while (accept(',')) names.push(expect('name').v);
          expect('in');
          explist();
          expect('do');
          pushScope(); names.forEach(declare); block(); popScope();
        }
        expect('end', 'fim do for da linha ' + tk.line);
        return;
      }
      case 'repeat': {
        p++;
        pushScope();
        // o until enxerga os locais do bloco
        while (!blockEnd()) { if (check('return') || check('break')) { block(); break; } statement(); accept(';'); }
        expect('until');
        exp();
        popScope();
        return;
      }
      case 'function': {
        p++;
        const first = expect('name');
        let isMethod = false;
        let dotted = false;
        while (check('.') || check(':')) {
          const sep = toks[p++].t;
          expect('name');
          dotted = true;
          if (sep === ':') { isMethod = true; break; }
        }
        useName(first.v, first.line, !dotted);
        funcbody(isMethod, tk.line);
        return;
      }
      case 'local': {
        p++;
        if (accept('function')) {
          const nm = expect('name').v;
          declare(nm);
          funcbody(false, tk.line);
          return;
        }
        const names = [expect('name').v];
        while (accept(',')) names.push(expect('name').v);
        if (accept('=')) explist();
        names.forEach(declare);
        return;
      }
      case '::': p++; expect('name'); expect('::'); return;
      case 'goto': p++; expect('name'); return;
      default: {
        // chamada ou atribuicao
        const first = suffixedexp(true);
        if (check('=') || check(',')) {
          if (first.kind === 'call') throw new Error(`linha ${tk.line}: nao da para atribuir a uma chamada`);
          const targets = [first];
          while (accept(',')) targets.push(suffixedexp(true));
          expect('=');
          explist();
          for (const t of targets) {
            if (t.kind === 'call') throw new Error(`linha ${tk.line}: nao da para atribuir a uma chamada`);
            if (t.kind === 'name') useName(t.name, t.line, true);
          }
          return;
        }
        if (first.kind !== 'call') throw new Error(`linha ${tk.line}: expressao solta (nao e chamada nem atribuicao)`);
        return;
      }
    }
  }

  // devolve { kind: 'name'|'index'|'call'|'paren' }. deferName: nome simples na esquerda de "=" e escrita
  function suffixedexp(deferName) {
    let kind;
    let nameTok = null;
    const tk = peek();
    if (accept('(')) { exp(); expect(')'); kind = 'paren'; }
    else if (check('name')) { nameTok = toks[p++]; kind = 'name'; }
    else throw new Error(`linha ${tk.line}: esperava nome ou '(', veio '${tk.v || tk.t}'`);
    let suffixed = false;
    while (true) {
      if (check('.')) { p++; expect('name'); kind = 'index'; }
      else if (check('[')) { p++; exp(); expect(']'); kind = 'index'; }
      else if (check(':')) { p++; expect('name'); args(); kind = 'call'; }
      else if (check('(') || check('{') || check('str')) {
        // em Lua, '(' em outra linha depois de uma expressao e ambiguo; o LuaJIT aceita
        args(); kind = 'call';
      } else break;
      suffixed = true;
    }
    if (nameTok && (suffixed || !deferName)) useName(nameTok.v, nameTok.line, false);
    if (nameTok && !suffixed && deferName) {
      // so sabemos se e escrita depois de ver o '='; se nao for, e leitura
      if (!(check('=') || check(','))) useName(nameTok.v, nameTok.line, false);
      return { kind: 'name', name: nameTok.v, line: nameTok.line };
    }
    return { kind };
  }

  function args() {
    if (accept('str')) return;
    if (check('{')) return table();
    expect('(');
    if (!check(')')) explist();
    expect(')');
  }

  function table() {
    expect('{');
    while (!check('}')) {
      if (check('[')) { p++; exp(); expect(']'); expect('='); exp(); }
      else if (check('name') && peek(1).t === '=') { p += 2; exp(); }
      else exp();
      if (!accept(',') && !accept(';')) break;
    }
    expect('}', 'fim da tabela');
  }

  function explist() { exp(); while (accept(',')) exp(); }

  const BIN = new Set(['+', '-', '*', '/', '%', '^', '..', '==', '~=', '<', '<=', '>', '>=', 'and', 'or']);
  function exp() {
    if (check('not') || check('-') || check('#')) { p++; exp1(); }
    else simple();
    while (BIN.has(peek().t)) {
      p++;
      exp1();
    }
  }
  function exp1() {
    if (check('not') || check('-') || check('#')) { p++; return exp1(); }
    simple();
  }
  function simple() {
    const tk = peek();
    if (['num', 'str', 'nil', 'true', 'false', '...'].includes(tk.t)) { p++; return; }
    if (check('{')) return table();
    if (check('function')) { p++; return funcbody(false, tk.line); }
    suffixedexp(false);
  }

  pushScope();
  block();
  expect('eof', 'fim do arquivo');
  return { globals };
}

if (require.main === module) {
  for (const file of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
    const src = fs.readFileSync(file, 'utf8');
    try {
      const { globals } = parse(src);
      console.log(`${file}: sintaxe ok`);
      if (process.argv.includes('--globals')) {
        for (const [k, g] of [...globals].sort()) console.log(`  ${k}${g.writes ? ' (escreve ' + g.writes + ')' : ''} linhas ${g.lines.join(',')}`);
      }
    } catch (e) {
      console.log(`${file}: ERRO ${e.message}`);
      process.exitCode = 1;
    }
  }
}
module.exports = { parse, lex };
