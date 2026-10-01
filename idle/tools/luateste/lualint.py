# Verificador de sintaxe Lua 5.1/LuaJIT (descida recursiva) + lista de globais lidas que nao sao conhecidas.
import re
import sys

KEYWORDS = {"and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in", "local",
            "nil", "not", "or", "repeat", "return", "then", "true", "until", "while"}
SYMBOLS = ["...", "..", "==", "~=", "<=", ">=", "::", "+", "-", "*", "/", "%", "^", "#", "<", ">", "=", "(", ")", "{", "}",
           "[", "]", ";", ":", ",", "."]
BINOPS = {"+", "-", "*", "/", "%", "^", "..", "==", "~=", "<", "<=", ">", ">=", "and", "or"}


class LuaError(Exception):
    pass


def tokenize(src):
    toks, i, line, n = [], 0, 1, len(src)
    while i < n:
        c = src[i]
        if c == "\n":
            line += 1
            i += 1
            continue
        if c in " \t\r":
            i += 1
            continue
        if src.startswith("--", i):
            m = re.match(r"--\[(=*)\[", src[i:])
            if m:
                close = "]" + m.group(1) + "]"
                j = src.find(close, i)
                if j < 0:
                    raise LuaError("comentario longo sem fim na linha %d" % line)
                line += src.count("\n", i, j)
                i = j + len(close)
            else:
                j = src.find("\n", i)
                i = n if j < 0 else j
            continue
        m = re.match(r"\[(=*)\[", src[i:])
        if m:
            close = "]" + m.group(1) + "]"
            j = src.find(close, i)
            if j < 0:
                raise LuaError("string longa sem fim na linha %d" % line)
            toks.append(("str", src[i:j + len(close)], line))
            line += src.count("\n", i, j)
            i = j + len(close)
            continue
        if c in "\"'":
            j = i + 1
            while j < n and src[j] != c:
                if src[j] == "\\":
                    j += 1
                elif src[j] == "\n":
                    raise LuaError("string sem fim na linha %d" % line)
                j += 1
            if j >= n:
                raise LuaError("string sem fim na linha %d" % line)
            toks.append(("str", src[i:j + 1], line))
            i = j + 1
            continue
        m = re.match(r"0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", src[i:])
        if m and m.group(0):
            toks.append(("num", m.group(0), line))
            i += len(m.group(0))
            continue
        m = re.match(r"[A-Za-z_][A-Za-z0-9_]*", src[i:])
        if m:
            w = m.group(0)
            toks.append(("kw" if w in KEYWORDS else "name", w, line))
            i += len(w)
            continue
        for s in SYMBOLS:
            if src.startswith(s, i):
                toks.append(("sym", s, line))
                i += len(s)
                break
        else:
            raise LuaError("caractere inesperado %r na linha %d" % (c, line))
    toks.append(("eof", "<eof>", line))
    return toks


class Parser:
    def __init__(self, toks):
        self.t = toks
        self.p = 0
        self.scopes = [set()]
        self.global_reads = {}
        self.global_writes = set()

    # ---- utilidades
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

    def expect(self, v, what=""):
        if not self.accept(v):
            tk = self.peek()
            raise LuaError("linha %d: esperava '%s'%s, veio '%s'" % (tk[2], v, (" " + what) if what else "", tk[1]))

    def name(self):
        tk = self.peek()
        if tk[0] != "name":
            raise LuaError("linha %d: esperava um nome, veio '%s'" % (tk[2], tk[1]))
        self.p += 1
        return tk[1]

    def declare(self, n):
        self.scopes[-1].add(n)

    def is_local(self, n):
        return any(n in s for s in self.scopes)

    def ref(self, n, line):
        if not self.is_local(n):
            self.global_reads.setdefault(n, line)

    # ---- blocos
    def chunk(self):
        self.block()
        if self.peek()[0] != "eof":
            tk = self.peek()
            raise LuaError("linha %d: sobrou '%s'" % (tk[2], tk[1]))

    def block_end(self):
        tk = self.peek()
        return tk[0] == "eof" or (tk[0] == "kw" and tk[1] in ("end", "else", "elseif", "until"))

    def block(self):
        while not self.block_end():
            if self.check("return"):
                self.p += 1
                if not self.block_end() and not self.check(";"):
                    self.explist()
                self.accept(";")
                if not self.block_end():
                    tk = self.peek()
                    raise LuaError("linha %d: codigo depois do return" % tk[2])
                return
            if self.check("break"):
                self.p += 1
                self.accept(";")
                continue
            self.statement()
            self.accept(";")

    def scoped_block(self, names=()):
        self.scopes.append(set(names))
        self.block()
        self.scopes.pop()

    def statement(self):
        tk = self.peek()
        if self.accept("do"):
            self.scoped_block()
            self.expect("end", "(do)")
        elif self.accept("while"):
            self.expr()
            self.expect("do")
            self.scoped_block()
            self.expect("end", "(while)")
        elif self.accept("repeat"):
            self.scopes.append(set())
            self.block()
            self.expect("until")
            self.expr()
            self.scopes.pop()
        elif self.accept("if"):
            self.expr()
            self.expect("then")
            self.scoped_block()
            while self.accept("elseif"):
                self.expr()
                self.expect("then")
                self.scoped_block()
            if self.accept("else"):
                self.scoped_block()
            self.expect("end", "(if da linha %d)" % tk[2])
        elif self.accept("for"):
            n1 = self.name()
            if self.accept("="):
                self.expr()
                self.expect(",")
                self.expr()
                if self.accept(","):
                    self.expr()
                self.expect("do")
                self.scoped_block([n1])
            else:
                names = [n1]
                while self.accept(","):
                    names.append(self.name())
                self.expect("in")
                self.explist()
                self.expect("do")
                self.scoped_block(names)
            self.expect("end", "(for da linha %d)" % tk[2])
        elif self.accept("function"):
            line = self.peek()[2]
            n = self.name()
            dotted = False
            method = False
            while self.check(".") or self.check(":"):
                if self.accept(":"):
                    self.name()
                    method = True
                    dotted = True
                    break
                self.p += 1
                self.name()
                dotted = True
            if dotted:
                self.ref(n, line)
            elif not self.is_local(n):
                self.global_writes.add(n)
            self.funcbody(method)
        elif self.accept("local"):
            if self.accept("function"):
                n = self.name()
                self.declare(n)
                self.funcbody(False)
            else:
                names = [self.name()]
                while self.accept(","):
                    names.append(self.name())
                if self.accept("="):
                    self.explist()
                for n in names:
                    self.declare(n)
        elif self.accept("goto"):
            self.name()
        elif self.accept("::"):
            self.name()
            self.expect("::")
        else:
            # atribuicao ou chamada
            first = self.peek()
            kind = self.suffixedexp(assign_target=True)
            if self.check("=") or self.check(","):
                targets = [(first, kind)]
                while self.accept(","):
                    f2 = self.peek()
                    targets.append((f2, self.suffixedexp(assign_target=True)))
                self.expect("=")
                self.explist()
                for f, k in targets:
                    if k == "call":
                        raise LuaError("linha %d: nao da para atribuir a uma chamada" % f[2])
                    if k == "name" and not self.is_local(f[1]):
                        self.global_writes.add(f[1])
                        # nao e leitura
                        if self.global_reads.get(f[1]) == f[2] and f[1] not in self._read_before:
                            self.global_reads.pop(f[1], None)
            elif kind != "call":
                raise LuaError("linha %d: expressao solta (nao e chamada nem atribuicao): '%s'" % (first[2], first[1]))

    _read_before = set()

    def funcbody(self, method):
        self.expect("(")
        params = ["self"] if method else []
        if not self.check(")"):
            while True:
                if self.accept("..."):
                    params.append("arg")
                    break
                params.append(self.name())
                if not self.accept(","):
                    break
        self.expect(")")
        self.scopes.append(set(params))
        self.block()
        self.scopes.pop()
        self.expect("end", "(function)")

    # ---- expressoes
    def explist(self):
        self.expr()
        while self.accept(","):
            self.expr()

    def expr(self):
        if self.check("not") or self.check("-") or self.check("#"):
            self.p += 1
            self.expr()
        else:
            self.simpleexp()
        while True:
            tk = self.peek()
            if tk[1] in BINOPS and tk[0] in ("kw", "sym"):
                self.p += 1
                if self.check("not") or self.check("-") or self.check("#"):
                    self.p += 1
                    self.expr()
                    continue
                self.simpleexp()
            else:
                break

    def simpleexp(self):
        tk = self.peek()
        if tk[0] in ("num", "str"):
            self.p += 1
        elif tk[0] == "kw" and tk[1] in ("nil", "true", "false"):
            self.p += 1
        elif self.accept("..."):
            pass
        elif self.accept("function"):
            self.funcbody(False)
        elif self.check("{"):
            self.table()
        else:
            self.suffixedexp()

    def table(self):
        self.expect("{")
        while not self.check("}"):
            if self.accept("["):
                self.expr()
                self.expect("]")
                self.expect("=")
                self.expr()
            elif self.peek()[0] == "name" and self.peek(1)[1] == "=" and self.peek(1)[0] == "sym":
                self.p += 2
                self.expr()
            else:
                self.expr()
            if not (self.accept(",") or self.accept(";")):
                break
        self.expect("}", "(tabela)")

    def suffixedexp(self, assign_target=False):
        tk = self.peek()
        kind = "name"
        if tk[0] == "name":
            self.p += 1
            if not self.is_local(tk[1]):
                if assign_target:
                    # pode ser escrita: so conta como leitura se nao for atribuicao direta
                    if tk[1] not in self.global_reads:
                        self.global_reads[tk[1]] = tk[2]
                    else:
                        self._read_before.add(tk[1])
                else:
                    self.ref(tk[1], tk[2])
                    self._read_before.add(tk[1])
        elif self.accept("("):
            self.expr()
            self.expect(")")
            kind = "paren"
        else:
            raise LuaError("linha %d: expressao inesperada '%s'" % (tk[2], tk[1]))
        while True:
            if self.accept("."):
                self.name()
                kind = "index"
                if assign_target and tk[0] == "name":
                    self._read_before.add(tk[1])
            elif self.accept("["):
                self.expr()
                self.expect("]")
                kind = "index"
                if assign_target and tk[0] == "name":
                    self._read_before.add(tk[1])
            elif self.accept(":"):
                self.name()
                self.args()
                kind = "call"
                if assign_target and tk[0] == "name":
                    self._read_before.add(tk[1])
            elif self.check("(") or self.check("{") or self.peek()[0] == "str":
                self.args()
                kind = "call"
                if assign_target and tk[0] == "name":
                    self._read_before.add(tk[1])
            else:
                return kind

    def args(self):
        if self.peek()[0] == "str":
            self.p += 1
        elif self.check("{"):
            self.table()
        else:
            self.expect("(")
            if not self.check(")"):
                self.explist()
            self.expect(")")


KNOWN = {"assert", "error", "ipairs", "pairs", "next", "pcall", "xpcall", "print", "select", "tonumber", "tostring", "type",
         "unpack", "rawget", "rawset", "setmetatable", "getmetatable", "require", "dofile", "loadstring", "load", "collectgarbage",
         "string", "table", "math", "os", "io", "bit", "debug", "coroutine", "_G", "arg", "self",
         "Idle", "Player", "Monster", "Creature", "ItemType", "Item", "Container", "Position", "Tile", "Game", "db", "Result",
         "logger", "GlobalEvent", "CreatureEvent", "EventCallback", "Spell", "Combat", "Condition", "Variant", "MonsterType",
         "addEvent", "stopEvent", "Town", "Vocation", "Outfit", "Party", "Guild", "Group", "Action", "MoveEvent", "TalkAction",
         "doTargetCombatHealth", "doTargetCombatMana", "configManager", "configKeys", "Storage", "kv"}
KNOWN_RE = re.compile(r"^(CONST_|SLOTP_|CONDITION|COMBAT_|DIRECTION_|SKILL_|WEAPON_|ITEM_|RETURNVALUE_|FLAG_|PlayerFlag|TILESTATE_|ZONE_|MESSAGE_|TALKTYPE_|RESPAWN|ORIGIN_|AMMO_|SPEECHBUBBLE_|LIGHT_|VOCATION|Idle[A-Z])")


def check(path, extra_known=()):
    src = open(path, encoding="utf-8").read()
    p = Parser(tokenize(src))
    p.chunk()
    unknown = {n: l for n, l in p.global_reads.items() if n not in KNOWN and n not in extra_known and not KNOWN_RE.match(n) and n not in p.global_writes}
    return p, unknown


if __name__ == "__main__":
    for f in sys.argv[1:]:
        try:
            p, unknown = check(f)
            print("OK  ", f, "| globais escritas:", sorted(p.global_writes) or "-", "| globais desconhecidas:", unknown or "-")
        except LuaError as e:
            print("ERRO", f, e)
