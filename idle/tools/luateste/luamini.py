# Interpretador minimo de Lua 5.1 (o suficiente para testar idle_acessorios.lua com o Canary falso).
# Erros de execucao (indexar nil, chamar nil, comparar tipos errados...) viram LuaError com a linha.
import math
import re
import time

from lualint import tokenize, LuaError as SyntaxErr

KEYW = {"and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in", "local",
        "nil", "not", "or", "repeat", "return", "then", "true", "until", "while"}


class LuaError(Exception):
    def __init__(self, msg, value=None):
        super().__init__(msg)
        self.value = value if value is not None else msg


class Table:
    __slots__ = ("h", "meta")

    def __init__(self, d=None):
        self.h = {}
        self.meta = None
        if d:
            for k, v in d.items():
                self.set(k, v)

    @staticmethod
    def key(k):
        if isinstance(k, float) and k.is_integer():
            return int(k)
        if isinstance(k, bool):
            return ("bool", k)
        return k

    def get(self, k):
        v = self.h.get(Table.key(k))
        if v is None and self.meta is not None:
            idx = self.meta.get("__index")
            if isinstance(idx, Table):
                return idx.get(k)
            if idx is not None:
                r = call(idx, [self, k])
                return r[0] if r else None
        return v

    def set(self, k, v):
        if k is None:
            raise LuaError("table index is nil")
        kk = Table.key(k)
        if v is None:
            self.h.pop(kk, None)
        else:
            self.h[kk] = v

    def length(self):
        n = 0
        while self.h.get(n + 1) is not None:
            n += 1
        return n

    def items(self):
        out = []
        for k, v in list(self.h.items()):
            if isinstance(k, tuple) and k[0] == "bool":
                k = k[1]
            out.append((k, v))
        return out


class Function:
    def __init__(self, params, vararg, body, scope, name="?"):
        self.params, self.vararg, self.body, self.scope, self.name = params, vararg, body, scope, name


class Scope:
    __slots__ = ("vars", "parent")

    def __init__(self, parent=None):
        self.vars = {}
        self.parent = parent

    def find(self, n):
        s = self
        while s is not None:
            if n in s.vars:
                return s
            s = s.parent
        return None


class ReturnEx(Exception):
    def __init__(self, vals):
        self.vals = vals


class BreakEx(Exception):
    pass


# ------------------------------------------------------------------ parser -> AST (tuplas)
class Parser:
    def __init__(self, toks):
        self.t, self.p = toks, 0

    def peek(self, k=0):
        return self.t[self.p + k]

    def check(self, v):
        tk = self.peek()
        return tk[1] == v and tk[0] in ("kw", "sym")

    def accept(self, v):
        if self.check(v):
            self.p += 1
            return True
        return False

    def expect(self, v):
        if not self.accept(v):
            tk = self.peek()
            raise SyntaxErr("linha %d: esperava '%s', veio '%s'" % (tk[2], v, tk[1]))

    def name(self):
        tk = self.peek()
        if tk[0] != "name":
            raise SyntaxErr("linha %d: esperava nome" % tk[2])
        self.p += 1
        return tk[1]

    def block_end(self):
        tk = self.peek()
        return tk[0] == "eof" or (tk[0] == "kw" and tk[1] in ("end", "else", "elseif", "until"))

    def block(self):
        stats = []
        while not self.block_end():
            line = self.peek()[2]
            if self.accept("return"):
                exprs = [] if (self.block_end() or self.check(";")) else self.explist()
                self.accept(";")
                stats.append(("return", line, exprs))
                break
            if self.accept("break"):
                stats.append(("break", line))
                self.accept(";")
                continue
            stats.append(self.statement())
            self.accept(";")
        return stats

    def statement(self):
        line = self.peek()[2]
        if self.accept("do"):
            b = self.block()
            self.expect("end")
            return ("do", line, b)
        if self.accept("while"):
            c = self.expr()
            self.expect("do")
            b = self.block()
            self.expect("end")
            return ("while", line, c, b)
        if self.accept("repeat"):
            b = self.block()
            self.expect("until")
            return ("repeat", line, b, self.expr())
        if self.accept("if"):
            arms = []
            c = self.expr()
            self.expect("then")
            arms.append((c, self.block()))
            els = None
            while self.accept("elseif"):
                c = self.expr()
                self.expect("then")
                arms.append((c, self.block()))
            if self.accept("else"):
                els = self.block()
            self.expect("end")
            return ("if", line, arms, els)
        if self.accept("for"):
            n1 = self.name()
            if self.accept("="):
                a = self.expr()
                self.expect(",")
                b = self.expr()
                st = self.expr() if self.accept(",") else None
                self.expect("do")
                body = self.block()
                self.expect("end")
                return ("fornum", line, n1, a, b, st, body)
            names = [n1]
            while self.accept(","):
                names.append(self.name())
            self.expect("in")
            ex = self.explist()
            self.expect("do")
            body = self.block()
            self.expect("end")
            return ("forin", line, names, ex, body)
        if self.accept("function"):
            n = self.name()
            target = ("name", line, n)
            method = False
            full = n
            while self.check(".") or self.check(":"):
                if self.accept(":"):
                    m = self.name()
                    target = ("index", line, target, ("str", line, m))
                    full += ":" + m
                    method = True
                    break
                self.p += 1
                m = self.name()
                target = ("index", line, target, ("str", line, m))
                full += "." + m
            f = self.funcbody(method, full)
            return ("assign", line, [target], [f])
        if self.accept("local"):
            if self.accept("function"):
                n = self.name()
                return ("localfunc", line, n, self.funcbody(False, n))
            names = [self.name()]
            while self.accept(","):
                names.append(self.name())
            ex = self.explist() if self.accept("=") else []
            return ("local", line, names, ex)
        e = self.suffixedexp()
        if self.check("=") or self.check(","):
            targets = [e]
            while self.accept(","):
                targets.append(self.suffixedexp())
            self.expect("=")
            return ("assign", line, targets, self.explist())
        if e[0] not in ("call", "method"):
            raise SyntaxErr("linha %d: expressao solta" % line)
        return ("callstat", line, e)

    def funcbody(self, method, name="?"):
        line = self.peek()[2]
        self.expect("(")
        params = ["self"] if method else []
        vararg = False
        if not self.check(")"):
            while True:
                if self.accept("..."):
                    vararg = True
                    break
                params.append(self.name())
                if not self.accept(","):
                    break
        self.expect(")")
        body = self.block()
        self.expect("end")
        return ("function", line, params, vararg, body, name)

    def explist(self):
        out = [self.expr()]
        while self.accept(","):
            out.append(self.expr())
        return out

    PRI = {"or": (1, 1), "and": (2, 2), "<": (3, 3), ">": (3, 3), "<=": (3, 3), ">=": (3, 3), "~=": (3, 3), "==": (3, 3),
           "..": (5, 4), "+": (6, 6), "-": (6, 6), "*": (7, 7), "/": (7, 7), "%": (7, 7), "^": (10, 9)}
    UNARY = 8

    def expr(self, limit=0):
        line = self.peek()[2]
        tk = self.peek()
        if tk[0] in ("kw", "sym") and tk[1] in ("not", "-", "#"):
            self.p += 1
            e = ("unop", line, tk[1], self.expr(self.UNARY))
        else:
            e = self.simpleexp()
        while True:
            tk = self.peek()
            op = tk[1] if tk[0] in ("kw", "sym") else None
            if op not in self.PRI or self.PRI[op][0] <= limit:
                break
            self.p += 1
            rhs = self.expr(self.PRI[op][1])
            e = ("binop", tk[2], op, e, rhs)
        return e

    def simpleexp(self):
        tk = self.peek()
        line = tk[2]
        if tk[0] == "num":
            self.p += 1
            v = int(tk[1], 16) if tk[1].lower().startswith("0x") else float(tk[1])
            if isinstance(v, float) and v.is_integer() and "." not in tk[1] and "e" not in tk[1].lower():
                v = int(v)
            return ("num", line, v)
        if tk[0] == "str":
            self.p += 1
            return ("str", line, unquote(tk[1]))
        if tk[0] == "kw" and tk[1] in ("nil", "true", "false"):
            self.p += 1
            return ("const", line, {"nil": None, "true": True, "false": False}[tk[1]])
        if self.accept("..."):
            return ("vararg", line)
        if self.accept("function"):
            return self.funcbody(False)
        if self.check("{"):
            return self.table()
        return self.suffixedexp()

    def table(self):
        line = self.peek()[2]
        self.expect("{")
        fields = []
        while not self.check("}"):
            if self.accept("["):
                k = self.expr()
                self.expect("]")
                self.expect("=")
                fields.append(("kv", k, self.expr()))
            elif self.peek()[0] == "name" and self.peek(1)[1] == "=" and self.peek(1)[0] == "sym":
                k = self.peek()[1]
                self.p += 2
                fields.append(("kv", ("str", line, k), self.expr()))
            else:
                fields.append(("pos", self.expr()))
            if not (self.accept(",") or self.accept(";")):
                break
        self.expect("}")
        return ("table", line, fields)

    def suffixedexp(self):
        tk = self.peek()
        line = tk[2]
        if tk[0] == "name":
            self.p += 1
            e = ("name", line, tk[1])
        elif self.accept("("):
            e = ("paren", line, self.expr())
            self.expect(")")
        else:
            raise SyntaxErr("linha %d: expressao inesperada '%s'" % (line, tk[1]))
        while True:
            line = self.peek()[2]
            if self.accept("."):
                e = ("index", line, e, ("str", line, self.name()))
            elif self.accept("["):
                k = self.expr()
                self.expect("]")
                e = ("index", line, e, k)
            elif self.accept(":"):
                n = self.name()
                e = ("method", line, e, n, self.args())
            elif self.check("(") or self.check("{") or self.peek()[0] == "str":
                e = ("call", line, e, self.args())
            else:
                return e

    def args(self):
        tk = self.peek()
        if tk[0] == "str":
            self.p += 1
            return [("str", tk[2], unquote(tk[1]))]
        if self.check("{"):
            return [self.table()]
        self.expect("(")
        a = [] if self.check(")") else self.explist()
        self.expect(")")
        return a


def unquote(s):
    if s.startswith("["):
        m = re.match(r"\[(=*)\[\n?", s)
        return s[m.end():-len(m.group(1)) - 2]
    body, out, i = s[1:-1], [], 0
    esc = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", '"': '"', "'": "'", "a": "\a", "b": "\b", "f": "\f", "v": "\v", "\n": "\n"}
    while i < len(body):
        c = body[i]
        if c == "\\":
            i += 1
            d = body[i]
            if d.isdigit():
                m = re.match(r"\d{1,3}", body[i:])
                out.append(chr(int(m.group(0))))
                i += len(m.group(0))
                continue
            out.append(esc.get(d, d))
        else:
            out.append(c)
        i += 1
    return "".join(out)


# ------------------------------------------------------------------ valores
def truthy(v):
    return v is not None and v is not False


def typeof(v):
    if v is None:
        return "nil"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, Table):
        return "table"
    if isinstance(v, Function) or callable(v):
        return "function"
    return "userdata"


def tostr(v):
    if v is None:
        return "nil"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and v.is_integer() and abs(v) < 1e15:
            return str(int(v))
        return ("%.14g" % v) if isinstance(v, float) else str(v)
    if isinstance(v, str):
        return v
    return "%s: 0x%x" % (typeof(v), id(v))


def call(f, args, line=0):
    if isinstance(f, Function):
        sc = Scope(f.scope)
        for i, p in enumerate(f.params):
            sc.vars[p] = args[i] if i < len(args) else None
        if f.vararg:
            sc.vars["..."] = list(args[len(f.params):])
        try:
            exec_block(f.body, sc)
        except ReturnEx as r:
            return r.vals
        return []
    if callable(f):
        try:
            r = f(*args)
        except TypeError as e:
            raise LuaError("linha %d: erro chamando funcao nativa: %s" % (line, e))
        if r is None:
            return []
        return list(r) if isinstance(r, (list, tuple)) else [r]
    raise LuaError("linha %d: attempt to call a %s value" % (line, typeof(f)))


STRING_LIB = Table()


def index(o, k, line=0):
    if isinstance(o, Table):
        return o.get(k)
    if isinstance(o, str):
        return STRING_LIB.get(k)
    raise LuaError("linha %d: attempt to index a %s value (campo '%s')" % (line, typeof(o), tostr(k)))


def arith(op, a, b, line):
    if isinstance(a, str):
        try:
            a = float(a)
        except ValueError:
            pass
    if isinstance(b, str):
        try:
            b = float(b)
        except ValueError:
            pass
    if not isinstance(a, (int, float)) or isinstance(a, bool) or not isinstance(b, (int, float)) or isinstance(b, bool):
        raise LuaError("linha %d: attempt to perform arithmetic on a %s value" % (line, typeof(a if not isinstance(a, (int, float)) or isinstance(a, bool) else b)))
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        return a / b if b != 0 else (math.inf if a > 0 else -math.inf if a < 0 else math.nan)
    if op == "%":
        return a - math.floor(a / b) * b
    if op == "^":
        return float(a) ** b


def compare(op, a, b, line):
    if op == "==":
        return a == b and typeof(a) == typeof(b) if not isinstance(a, (Table, Function)) else a is b
    if op == "~=":
        return not compare("==", a, b, line)
    num = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool)
    if not ((num(a) and num(b)) or (isinstance(a, str) and isinstance(b, str))):
        raise LuaError("linha %d: attempt to compare %s with %s" % (line, typeof(a), typeof(b)))
    return {"<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]


def eval_multi(exprs, sc):
    out = []
    for i, e in enumerate(exprs):
        if i == len(exprs) - 1 and e[0] in ("call", "method", "vararg"):
            out.extend(eval_call(e, sc) if e[0] != "vararg" else list(lookup(sc, "...") or []))
        else:
            out.append(ev(e, sc))
    return out


def lookup(sc, n):
    s = sc.find(n)
    if s is not None:
        return s.vars[n]
    return GLOBALS.get(n)


def eval_call(e, sc):
    line = e[1]
    if e[0] == "call":
        f = ev(e[2], sc)
        args = eval_multi(e[3], sc)
        if f is None:
            raise LuaError("linha %d: attempt to call a nil value (%s)" % (line, describe(e[2])))
        return call(f, args, line)
    o = ev(e[2], sc)
    f = index(o, e[3], line)
    if f is None:
        raise LuaError("linha %d: attempt to call method '%s' (a nil value)" % (line, e[3]))
    return call(f, [o] + eval_multi(e[4], sc), line)


def describe(e):
    if e[0] == "name":
        return "global/local '%s'" % e[2]
    if e[0] == "index" and e[3][0] == "str":
        return "campo '%s'" % e[3][2]
    return e[0]


def ev(e, sc):
    k = e[0]
    if k in ("num", "str", "const"):
        return e[2]
    if k == "name":
        return lookup(sc, e[2])
    if k == "index":
        return index(ev(e[2], sc), ev(e[3], sc), e[1])
    if k in ("call", "method"):
        r = eval_call(e, sc)
        return r[0] if r else None
    if k == "paren":
        return ev(e[2], sc)
    if k == "vararg":
        v = lookup(sc, "...") or []
        return v[0] if v else None
    if k == "function":
        return Function(e[2], e[3], e[4], sc, e[5])
    if k == "table":
        t = Table()
        n = 0
        fields = e[2]
        for i, f in enumerate(fields):
            if f[0] == "kv":
                t.set(ev(f[1], sc), ev(f[2], sc))
            else:
                if i == len(fields) - 1 and f[1][0] in ("call", "method", "vararg"):
                    vals = eval_call(f[1], sc) if f[1][0] != "vararg" else list(lookup(sc, "...") or [])
                    for v in vals:
                        n += 1
                        t.set(n, v)
                else:
                    n += 1
                    t.set(n, ev(f[1], sc))
        return t
    if k == "unop":
        v = ev(e[3], sc)
        if e[2] == "not":
            return not truthy(v)
        if e[2] == "-":
            return -arith("+", 0, v, e[1]) if not isinstance(v, (int, float)) else -v
        if isinstance(v, str):
            return len(v)
        if isinstance(v, Table):
            return v.length()
        raise LuaError("linha %d: attempt to get length of a %s value" % (e[1], typeof(v)))
    if k == "binop":
        op = e[2]
        if op == "and":
            a = ev(e[3], sc)
            return ev(e[4], sc) if truthy(a) else a
        if op == "or":
            a = ev(e[3], sc)
            return a if truthy(a) else ev(e[4], sc)
        a, b = ev(e[3], sc), ev(e[4], sc)
        if op == "..":
            for x in (a, b):
                if not isinstance(x, (str, int, float)) or isinstance(x, bool):
                    raise LuaError("linha %d: attempt to concatenate a %s value" % (e[1], typeof(x)))
            return tostr(a) + tostr(b)
        if op in ("==", "~=", "<", "<=", ">", ">="):
            return compare(op, a, b, e[1])
        return arith(op, a, b, e[1])
    raise LuaError("expressao desconhecida " + k)


def assign(target, val, sc):
    if target[0] == "name":
        s = sc.find(target[2])
        if s is not None:
            s.vars[target[2]] = val
        else:
            GLOBALS.set(target[2], val)
    elif target[0] == "index":
        o = ev(target[2], sc)
        if not isinstance(o, Table):
            raise LuaError("linha %d: attempt to index a %s value (atribuicao)" % (target[1], typeof(o)))
        o.set(ev(target[3], sc), val)
    else:
        raise LuaError("alvo de atribuicao invalido")


def exec_block(stats, sc):
    for s in stats:
        exec_stat(s, sc)


def exec_stat(s, sc):
    k = s[0]
    if k == "local":
        vals = eval_multi(s[3], sc)
        for i, n in enumerate(s[2]):
            sc.vars[n] = vals[i] if i < len(vals) else None
    elif k == "localfunc":
        sc.vars[s[2]] = None
        sc.vars[s[2]] = ev(s[3], sc)
    elif k == "assign":
        vals = eval_multi(s[3], sc)
        for i, t in enumerate(s[2]):
            assign(t, vals[i] if i < len(vals) else None, sc)
    elif k == "callstat":
        eval_call(s[2], sc)
    elif k == "do":
        exec_block(s[2], Scope(sc))
    elif k == "while":
        while truthy(ev(s[2], sc)):
            try:
                exec_block(s[3], Scope(sc))
            except BreakEx:
                break
    elif k == "repeat":
        while True:
            inner = Scope(sc)
            try:
                exec_block(s[2], inner)
            except BreakEx:
                break
            if truthy(ev(s[3], inner)):
                break
    elif k == "if":
        for c, b in s[2]:
            if truthy(ev(c, sc)):
                exec_block(b, Scope(sc))
                return
        if s[3] is not None:
            exec_block(s[3], Scope(sc))
    elif k == "fornum":
        a, b = ev(s[3], sc), ev(s[4], sc)
        st = ev(s[5], sc) if s[5] else 1
        i = a
        while (st > 0 and i <= b) or (st < 0 and i >= b):
            inner = Scope(sc)
            inner.vars[s[2]] = i
            try:
                exec_block(s[6], inner)
            except BreakEx:
                break
            i += st
    elif k == "forin":
        vals = eval_multi(s[3], sc)
        f, state, ctl = (vals + [None, None, None])[:3]
        while True:
            r = call(f, [state, ctl], s[1])
            r = (r + [None] * len(s[2]))
            if r[0] is None:
                break
            ctl = r[0]
            inner = Scope(sc)
            for i, n in enumerate(s[2]):
                inner.vars[n] = r[i]
            try:
                exec_block(s[4], inner)
            except BreakEx:
                break
    elif k == "return":
        raise ReturnEx(eval_multi(s[2], sc))
    elif k == "break":
        raise BreakEx()
    else:
        raise LuaError("comando desconhecido " + k)


# ------------------------------------------------------------------ padroes do Lua -> regex do Python
CLASSES = {"a": "A-Za-z", "d": "0-9", "l": "a-z", "u": "A-Z", "s": r"\s", "w": "A-Za-z0-9", "x": "0-9A-Fa-f",
           "p": r"!-/:-@\[-`{-~", "c": r"\x00-\x1f\x7f"}


def lua_pattern(p):
    out, i, n = [], 0, len(p)
    if p.startswith("^"):
        out.append(r"\A")
        i = 1
    while i < n:
        c = p[i]
        if c == "%":
            d = p[i + 1]
            if d in CLASSES:
                out.append("[" + CLASSES[d] + "]")
            elif d.upper() in CLASSES and d.isupper():
                out.append("[^" + CLASSES[d.lower()] + "]")
            else:
                out.append(re.escape(d))
            i += 2
        elif c == "[":
            j = i + 1
            s = "["
            if j < n and p[j] == "^":
                s += "^"
                j += 1
            first = True
            while j < n and (p[j] != "]" or first):
                first = False
                if p[j] == "%":
                    d = p[j + 1]
                    s += CLASSES.get(d, re.escape(d))
                    j += 2
                    continue
                ch = p[j]
                if j + 2 < n and p[j + 1] == "-" and p[j + 2] != "]":
                    s += re.escape(ch) + "-" + re.escape(p[j + 2])
                    j += 3
                    continue
                s += "\\]" if ch == "]" else ("\\\\" if ch == "\\" else ("\\-" if ch == "-" else ("\\^" if ch == "^" else ch)))
                j += 1
            out.append(s + "]")
            i = j + 1
        elif c == ".":
            out.append(r"[\s\S]")
            i += 1
        elif c == "$" and i == n - 1:
            out.append(r"\Z")
            i += 1
        elif c in "*+?":
            out.append(c)
            i += 1
        elif c == "-":
            out.append("*?")
            i += 1
        elif c in "()":
            out.append(c)
            i += 1
        else:
            out.append(re.escape(c))
            i += 1
    return re.compile("".join(out))


def s_match(s, p, init=1):
    m = lua_pattern(p).search(s, (init or 1) - 1)
    if not m:
        return [None]
    return list(m.groups()) if m.groups() else [m.group(0)]


def s_gmatch(s, p):
    it = lua_pattern(p).finditer(s)

    def nxt(*_):
        for m in it:
            return list(m.groups()) if m.groups() else [m.group(0)]
        return [None]
    return [nxt]


def s_format(fmt, *args):
    args = list(args)
    out = []

    def rep(m):
        spec = m.group(0)
        if spec == "%%":
            return "%"
        v = args.pop(0)
        if spec[-1] == "d":
            v = int(v)
        elif spec[-1] == "s":
            v = tostr(v)
        return spec % v
    return re.sub(r"%%|%[-0-9.]*[dsfgxq]", rep, fmt)


def s_find(s, p, init=1, plain=False):
    if plain:
        j = s.find(p, (init or 1) - 1)
        return [None] if j < 0 else [j + 1, j + len(p)]
    m = lua_pattern(p).search(s, (init or 1) - 1)
    if not m:
        return [None]
    return [m.start() + 1, m.end()] + list(m.groups())


def s_sub(s, i, j=-1):
    n = len(s)
    i = int(i)
    j = int(j if j is not None else -1)
    if i < 0:
        i = max(n + i + 1, 1)
    if j < 0:
        j = n + j + 1
    return s[max(i, 1) - 1:j]


for k, f in {"match": s_match, "gmatch": s_gmatch, "format": s_format, "find": s_find, "sub": s_sub,
             "lower": lambda s: s.lower(), "upper": lambda s: s.upper(), "len": lambda s: len(s),
             "rep": lambda s, n: s * int(n), "byte": lambda s, i=1: ord(s[int(i) - 1])}.items():
    STRING_LIB.set(k, f)


def _next(t, k=None):
    items = t.items()
    if k is None:
        return list(items[0]) if items else [None]
    for i, (kk, v) in enumerate(items):
        if kk == k and typeof(kk) == typeof(k):
            return list(items[i + 1]) if i + 1 < len(items) else [None]
    return [None]


def _ipairs(t):
    def it(tt, i):
        v = tt.get(int(i) + 1)
        return [None] if v is None else [int(i) + 1, v]
    if not isinstance(t, Table):
        raise LuaError("bad argument #1 to 'ipairs' (table expected, got %s)" % typeof(t))
    return [it, t, 0]


def _pairs(t):
    if not isinstance(t, Table):
        raise LuaError("bad argument #1 to 'pairs' (table expected, got %s)" % typeof(t))
    snap = t.items()
    pos = {"i": 0}

    def it(tt, k):
        if pos["i"] >= len(snap):
            return [None]
        kk, v = snap[pos["i"]]
        pos["i"] += 1
        return [kk, v]
    return [it, t, None]


def _pcall(f, *args):
    try:
        return [True] + call(f, list(args))
    except LuaError as e:
        return [False, e.value]
    except RecursionError:
        return [False, "stack overflow"]


def _error(msg=None, level=1):
    raise LuaError(tostr(msg), msg)


def _tonumber(v, base=None):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v
    try:
        x = float(v) if base is None else int(v, int(base))
        return int(x) if isinstance(x, float) and x.is_integer() else x
    except (TypeError, ValueError):
        return None


def _table_remove(t, pos=None):
    n = t.length()
    if n == 0:
        return [None]
    pos = n if pos is None else int(pos)
    v = t.get(pos)
    for i in range(pos, n):
        t.set(i, t.get(i + 1))
    t.set(n, None)
    return [v]


def _table_insert(t, a, b=None):
    n = t.length()
    if b is None:
        t.set(n + 1, a)
    else:
        for i in range(n, int(a) - 1, -1):
            t.set(i + 1, t.get(i))
        t.set(int(a), b)


def _setmetatable(t, m):
    t.meta = m
    return t


GLOBALS = Table()


def reset_globals():
    global GLOBALS
    GLOBALS = Table()
    G = GLOBALS
    G.set("_G", G)
    for k, v in {"print": lambda *a: print("[lua]", *[tostr(x) for x in a]), "type": typeof, "tostring": tostr, "tonumber": _tonumber,
                 "pairs": _pairs, "ipairs": _ipairs, "next": _next, "pcall": _pcall, "error": _error,
                 "setmetatable": _setmetatable, "getmetatable": lambda t: t.meta if isinstance(t, Table) else None,
                 "select": lambda n, *a: list(a) if n == "#" and False else (len(a) if n == "#" else list(a[int(n) - 1:])),
                 "assert": lambda v, msg=None, *r: [v, msg] + list(r) if truthy(v) else _error(msg or "assertion failed!")}.items():
        G.set(k, v)
    G.set("string", STRING_LIB)
    G.set("table", Table({"remove": _table_remove, "insert": _table_insert, "concat": lambda t, sep="", i=1, j=None: sep.join(tostr(t.get(x)) for x in range(int(i), int(j or t.length()) + 1)),
                          "sort": lambda t, f=None: _table_sort(t, f)}))
    G.set("math", Table({"max": lambda *a: max(a), "min": lambda *a: min(a), "floor": lambda x: int(math.floor(x)), "ceil": lambda x: int(math.ceil(x)),
                         "abs": abs, "huge": math.inf, "random": lambda a=None, b=None: a if b is None else a, "sqrt": math.sqrt}))
    G.set("os", Table({"time": lambda *a: int(NOW["t"]), "date": lambda f="%c", t=None: time.strftime(f, time.localtime(t or NOW["t"])),
                       "mtime": lambda: int(NOW["t"] * 1000)}))
    G.set("bit", Table({"band": lambda *a: _band(a), "bor": lambda *a: _bor(a)}))
    return G


def _band(a):
    r = -1
    for x in a:
        r &= int(x)
    return r


def _bor(a):
    r = 0
    for x in a:
        r |= int(x)
    return r


def _table_sort(t, f):
    n = t.length()
    vals = [t.get(i) for i in range(1, n + 1)]
    import functools
    if f is None:
        vals.sort()
    else:
        vals.sort(key=functools.cmp_to_key(lambda a, b: -1 if truthy(call(f, [a, b])[0]) else (1 if truthy(call(f, [b, a])[0]) else 0)))
    for i, v in enumerate(vals):
        t.set(i + 1, v)


NOW = {"t": 1_790_000_000}


def run(src, name="chunk"):
    try:
        ast = Parser(tokenize(src)).block()
    except SyntaxErr as e:
        raise LuaError("%s: erro de sintaxe: %s" % (name, e))
    try:
        exec_block(ast, Scope())
    except ReturnEx:
        pass
    except LuaError as e:
        raise LuaError("%s: %s" % (name, e), e.value)
