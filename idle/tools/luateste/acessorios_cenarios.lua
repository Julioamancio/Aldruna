-- Cenarios do AUTO de colar e anel (rodam o idle_acessorios.lua de verdade sobre o canary_falso.lua)
local I = Idle
local PASS = 0
local function ok(name) PASS = PASS + 1 print("ok   " .. name) end
local function eq(a, b, what) assert(a == b, (what or "") .. ": esperava " .. tostring(b) .. ", veio " .. tostring(a)) end

local P, H, BP
local function fresh(acc, level)
	PLAYERS, MONSTERS, GEAR, WARN = {}, {}, {}, {}
	I.hunters, I.bags = {}, {}
	P = newPlayer("Teste", level)
	BP = newItem(2854)
	P.slots[CONST_SLOT_BACKPACK] = BP
	BP.parent = { kind = "slot", player = P, slot = CONST_SLOT_BACKPACK }
	BP:add(newItem(3003))
	H = { guid = 7, name = "Teste", settings = {}, log = {}, mlist = {} }
	I.hunters[7] = H
	I.bags[7] = { items = {}, dispatchAt = 0 }
	DB_ACC[7] = acc
end
local function wear(slot, id)
	local it = newItem(id)
	P.slots[slot] = it
	it.parent = { kind = "slot", player = P, slot = slot }
	return it
end
local function slotId(slot) local it = P.slots[slot] return it and it.id or 0 end
local function packHas(id)
	local n = 0
	for _, x in ipairs(BP:getItems(true)) do if x.id == id then n = n + 1 end end
	return n
end
local function tick() EVENTS.IdleAcessorios.onThink(1000) end
local function lastLog() return H.log[#H.log] or "" end

-- 0. o modulo registrou o evento de 1 s
assert(EVENTS.IdleAcessorios and EVENTS.IdleAcessorios.ms == 1000, "GlobalEvent IdleAcessorios de 1000 ms")
ok("registra o GlobalEvent IdleAcessorios (1 s)")

-- 1. sem configuracao: nao mexe em nada (a echarpe do kit inicial continua)
fresh("")
wear(CONST_SLOT_NECKLACE, 3572)
tick()
tick()
eq(slotId(CONST_SLOT_NECKLACE), 3572, "colar")
eq(#GEAR, 0, "writeGear")
eq(H.settings.acc.any, false, "any")
local alters = 0
for _, q in ipairs(DBQ) do if q:find("ALTER TABLE") then alters = alters + 1 end end
eq(alters, 1, "ALTER da coluna acc so uma vez")
ok("sem configuracao: nao mexe no slot e le o banco uma vez so")

-- 2. so regras desligadas: a barra nao mexe no slot
fresh("colar|3081|0||\ncolar|3055|0||")
wear(CONST_SLOT_NECKLACE, 3572)
I.bags[7].items[3081] = 1
tick()
eq(slotId(CONST_SLOT_NECKLACE), 3572, "colar")
eq(H.settings.acc.count.colar, 0, "contagem")
fresh("colar|3572|1||\nanel|3053|0||")
wear(CONST_SLOT_RING, 3048)
BP:add(newItem(3572))
tick()
eq(slotId(CONST_SLOT_NECKLACE), 3572, "colar ligado entra")
eq(slotId(CONST_SLOT_RING), 3048, "anel so com regra desligada: nao mexe")
ok("regras desligadas: slot fica como esta")

-- 3. colar: stone skin com HP <= 40%, senao echarpe
fresh("colar|3081|1|self.hp.le.40.p|\ncolar|3572|1||")
wear(CONST_SLOT_NECKLACE, 3572)
I.bags[7].items[3081] = 1
tick()
eq(slotId(CONST_SLOT_NECKLACE), 3572, "vida cheia: echarpe")
eq(#GEAR, 0, "nada mudou")
P.hp = 30
tick()
eq(slotId(CONST_SLOT_NECKLACE), 3081, "vida baixa: stone skin")
eq(I.bags[7].items[3081], nil, "saiu da mochila do loot")
eq(LAST_ADD.sub, 5, "stone skin nova com 5 cargas")
eq(packHas(3572), 1, "echarpe foi para a mochila de verdade")
eq(H.bagDirty, true, "mochila do loot marcada para gravar")
assert(lastLog():find("Colar: colocou stone skin amulet"), lastLog())
eq(#GEAR, 1, "writeGear depois da troca")
eq(GEAR[1].acc.colar, 3081, "gear.acc.colar")
eq(#GEAR[1].acc.pack, 1, "gear.acc.pack")
eq(GEAR[1].acc.pack[1].id, 3572, "pack id")
local stone = P.slots[CONST_SLOT_NECKLACE]
stone.charges = 2 -- gastou 3 cargas
P.hp = 100
tick()
eq(slotId(CONST_SLOT_NECKLACE), 3572, "vida cheia de novo: echarpe")
eq(packHas(3081), 1, "stone skin guardada na mochila de verdade")
P.hp = 35
tick()
eq(P.slots[CONST_SLOT_NECKLACE], stone, "a mesma stone skin voltou (com as cargas que sobraram)")
eq(stone.charges, 2, "cargas preservadas")
eq(CALLS.addItem, 1, "so criou uma peca nova (a do loot)")
ok("colar por condicao de HP: troca, guarda e devolve a mesma peca com as cargas")

-- 4. anel: time ring com 2+ monstros atacando, senao might ring; o time ring no dedo e outro id (3090)
fresh("anel|3053|1|area.targets.ge.2|\nanel|3048|1||")
I.bags[7].items[3053] = 1
BP:add(newItem(3048))
H.mlist = { newMonster(1, "Dragon", 101, 100, 7, P), newMonster(2, "Dragon", 103, 100, 7, newPlayer("Outro")) }
tick()
eq(slotId(CONST_SLOT_RING), 3048, "1 atacando (o outro mira outra pessoa): might ring")
H.mlist[2].target = P
tick()
eq(slotId(CONST_SLOT_RING), 3090, "2 atacando: time ring (id no dedo)")
eq(packHas(3048), 1, "might ring guardado")
local before = #GEAR
tick()
eq(#GEAR, before, "time ring no dedo (3090) conta como o 3053: nao troca de novo")
H.mlist[2].target = nil
tick()
eq(slotId(CONST_SLOT_RING), 3048, "voltou o might ring")
eq(packHas(3053), 1, "time ring guardado como 3053 (de-equip)")
H.mlist[2].target = P
tick()
eq(slotId(CONST_SLOT_RING), 3090, "o mesmo time ring volta da mochila")
eq(I.bags[7].items[3053], nil, "o do loot ja tinha saido")
ok("anel por monstros atacando (Area), com transformequipto/deequip")

-- 5. por perto: so com Dragon a ate 7 sqm; sem nenhuma regra valendo, o slot esvazia
fresh("anel|3053|1||Dragon;Dragon Lord")
wear(CONST_SLOT_RING, 3048)
BP:add(newItem(3053))
H.mlist = { newMonster(1, "Rat", 101, 100, 7, P), newMonster(2, "Dragon Lord", 110, 100, 7, nil) }
tick()
eq(slotId(CONST_SLOT_RING), 0, "dragon lord longe: nenhuma regra vale, slot vazio")
eq(packHas(3048), 1, "might ring guardado")
assert(lastLog():find("tirou might ring"), lastLog())
local g0 = #GEAR
tick()
eq(#GEAR, g0, "slot vazio e nada valendo: nao regrava o gear")
H.mlist[2].pos = Pos(105, 103, 7)
tick()
eq(slotId(CONST_SLOT_RING), 3090, "dragon lord perto: time ring")
H.mlist[2].pos = Pos(105, 103, 6)
tick()
eq(slotId(CONST_SLOT_RING), 0, "outro andar nao conta")
ok("por perto: nome do monstro, distancia e andar")

-- 6. level: o Canary recusa; tenta de novo so depois de 60 s e passa para a proxima
fresh("anel|23533|1||\nanel|3048|1||", 50)
I.bags[7].items[23533] = 1
BP:add(newItem(3048))
tick()
eq(slotId(CONST_SLOT_RING), 0, "red plasma recusado: slot vazio neste segundo")
eq(I.bags[7].items[23533], 1, "a peca recusada continua no loot")
assert(lastLog():find("não deu para colocar ring of red plasma"), lastLog())
tick()
eq(slotId(CONST_SLOT_RING), 3048, "segundo seguinte: might ring")
local adds = CALLS.addItem
tick()
eq(CALLS.addItem, adds, "nao tenta de novo antes de 60 s")
eq(slotId(CONST_SLOT_RING), 3048, "might ring fica")
local t0 = os.time()
-- avanca o relogio 61 s
__avancar(61)
P.level = 120
tick()
eq(slotId(CONST_SLOT_RING), 23534, "depois de 60 s e com level: red plasma")
eq(packHas(3048), 1, "might ring guardado")
ok("requisito de level: pula a peca por 60 s e tenta de novo")

-- 7. mochila cheia: peca que gasta fica no slot; peca sem carga vai para o loot
fresh("colar|3572|1||")
for _ = 1, 19 do BP:add(newItem(3003)) end
eq(BP:getEmptySlots(false), 0, "mochila cheia")
wear(CONST_SLOT_NECKLACE, 3081)
I.bags[7].items[3572] = 1
tick()
eq(slotId(CONST_SLOT_NECKLACE), 3081, "stone skin (com carga) nao sai com a mochila cheia")
assert(lastLog():find("a mochila está cheia"), lastLog())
local nlog = #H.log
tick()
eq(#H.log, nlog, "o aviso nao repete a cada segundo")
fresh("colar|3572|1||")
for _ = 1, 19 do BP:add(newItem(3003)) end
wear(CONST_SLOT_NECKLACE, 3055)
I.bags[7].items[3572] = 1
tick()
eq(slotId(CONST_SLOT_NECKLACE), 3572, "echarpe entrou")
eq(I.bags[7].items[3055], 1, "platinum amulet (sem carga) foi para a mochila do loot")
ok("mochila cheia: so peca sem carga/tempo vai para o loot")

-- 8. mochila cheia mas com uma bolsa dentro com lugar: guarda na bolsa
fresh("colar|3572|1||")
local bag = newItem(2853)
BP:add(bag)
for _ = 1, 18 do BP:add(newItem(3003)) end
wear(CONST_SLOT_NECKLACE, 3081)
bag:add(newItem(3572)) -- 1 rope + 1 bolsa + 18 ropes = mochila cheia; a echarpe esta na bolsa
eq(BP:getEmptySlots(false), 0, "mochila cheia")
tick()
eq(slotId(CONST_SLOT_NECKLACE), 3572, "echarpe da bolsa")
local inBag = 0
for _, x in ipairs(bag.items) do if x.id == 3081 then inBag = inBag + 1 end end
eq(inBag, 1, "stone skin guardada dentro da bolsa")
ok("bolsa dentro da mochila: acha a peca e guarda na bolsa")

-- 9. alvo e mana/magic shield
fresh("anel|3048|1|target.hp.le.50.p&self.mana.ge.30.p&self.shield.eq.0|")
BP:add(newItem(3048))
tick()
eq(slotId(CONST_SLOT_RING), 0, "sem alvo: nao vale")
local m = newMonster(9, "Dragon", 101, 100, 7, P)
H.mlist = { m }
H.targetId = 9
m.hp = 40
tick()
eq(slotId(CONST_SLOT_RING), 3048, "alvo com 40%: vale")
P.shield = true
tick()
eq(slotId(CONST_SLOT_RING), 0, "com magic shield: nao vale")
P.shield = false
P.mana = 10
tick()
eq(slotId(CONST_SLOT_RING), 0, "mana 10%: nao vale")
P.mana = 100
m.hp = 0
tick()
eq(slotId(CONST_SLOT_RING), 0, "alvo morrendo (vida 0) nao conta como alvo")
ok("condicoes de Alvo, Mana e Magic shield")

-- 10. reload: a ponte manda reload -> h.settings novo -> le a configuracao de novo
fresh("colar|3572|1||")
wear(CONST_SLOT_NECKLACE, 3572)
BP:add(newItem(3055))
tick()
eq(slotId(CONST_SLOT_NECKLACE), 3572, "echarpe")
DB_ACC[7] = "colar|3055|1||\ncolar|3572|1||"
tick()
eq(slotId(CONST_SLOT_NECKLACE), 3572, "sem reload continua a configuracao antiga")
H.settings = {} -- o que o I.reload faz (h.settings = I.loadSettings(player))
tick()
eq(slotId(CONST_SLOT_NECKLACE), 3055, "depois do reload: platinum amulet primeiro")
ok("reload troca a configuracao no meio da cacada")

-- 11. erro dentro do AUTO nao para a cacada: so registra (no maximo 3 vezes)
fresh("colar|3572|1||")
wear(CONST_SLOT_NECKLACE, 3572)
H.settings.acc = { any = true, count = { colar = 1 }, colar = { { id = 3572, on = true } } } -- regra sem conds: erro
for _ = 1, 5 do tick() end
eq(#WARN, 3, "3 avisos no log do servidor")
assert(I.hunters[7] == H, "a cacada continua")
ok("erro no AUTO e isolado (pcall) e o aviso nao enche o log")

-- 12. accParse: lixo, limite de 20, nomes em minusculas
local cfg = I.accParse("colar|3081|1|self.hp.le.40.p&lixo.x.y.1|Dragon Lord;RAT\nxx|1|1||\nanel|abc|1||\nanel|3048|1||\n")
eq(#cfg.colar, 1, "colar")
eq(#cfg.colar[1].conds, 1, "condicao invalida descartada")
eq(cfg.colar[1].near["dragon lord"], true, "near em minusculas")
eq(cfg.colar[1].near["rat"], true, "near RAT")
eq(#cfg.anel, 1, "anel")
local many = {}
for i = 1, 25 do many[#many + 1] = "anel|" .. (3000 + i) .. "|1||" end
eq(#I.accParse(table.concat(many, "\n")).anel, 20, "no maximo 20")
ok("accParse")

-- 13. accGear sem mochila
fresh("")
P.slots[CONST_SLOT_BACKPACK] = nil
wear(CONST_SLOT_RING, 3053)
P.slots[CONST_SLOT_RING].id = 3090
local data = {}
I.accGear(P, data)
eq(#data.acc.pack, 0, "sem mochila")
eq(data.acc.anel, 3053, "anel no dedo como id de guardar")
eq(data.acc.colar, 0, "sem colar")
ok("accGear")

print(PASS .. " cenarios passaram")
