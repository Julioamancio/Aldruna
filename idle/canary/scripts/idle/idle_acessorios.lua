--[[
Destruitor Idle — botoes AUTO de colar e anel (como no Huntera).

A barra e a ordem: a cada segundo de luta, da esquerda para a direita, a primeira peca LIGADA cujas
condicoes valem e que o personagem carrega vai para o slot; se nenhuma vale, o slot fica vazio.
Sem nenhuma peca ligada naquele slot, a barra nao mexe nele.

  * Configuracao: idle_settings.acc (gravada pela ponte, gateway/acessorios.js), uma linha por peca:
        colar|3081|1|self.hp.le.50.p&area.targets.ge.2|Dragon;Dragon Lord
    (slot | id | ligada | condicoes no formato da barra de acoes | monstros "por perto")
    Lida no comeco da cacada e de novo depois de cada "reload" (o reload troca h.settings).
  * "Carrega" = a mochila de verdade (container do slot CONST_SLOT_BACKPACK; a peca guarda as cargas
    e o tempo que sobraram) + a mochila do loot (Idle.bags: pecas novas que cairam dos monstros).
  * A peca que sai do slot vai para a mochila de verdade (o Canary faz o de-equip: o time ring volta a
    ser 3053 e para de contar o tempo, como no Tibia). Mochila de verdade cheia: so peca sem carga e
    sem tempo vai para a mochila do loot; uma com carga/tempo fica no slot (senao voltaria "nova").
  * Area = monstros que estao atacando o personagem. Por perto = um dos monstros escolhidos a ate
    ACC_NEAR sqm, no mesmo andar. Alvo = o alvo atual da cacada.
  * Roda num GlobalEvent proprio (1 s) e dentro de pcall: um erro aqui nunca derruba a cacada.
]]

Idle = Idle or {}
local I = Idle

local ACC_SLOTS = {
	{ key = "colar", slot = CONST_SLOT_NECKLACE, nome = "Colar" },
	{ key = "anel", slot = CONST_SLOT_RING, nome = "Anel" },
}
local ACC_MAX = 20 -- pecas por barra
local ACC_NEAR = 7 -- "por perto": ate 7 sqm, no mesmo andar
local ACC_RETRY = 60 -- peca que o Canary recusou (level, vocacao): tenta de novo depois de 60 s

local function accLog(h, text)
	local l = h.log
	if not l then
		return
	end
	l[#l + 1] = os.date("%H:%M:%S") .. " " .. text
	while #l > (I.LOG_MAX or 25) do
		table.remove(l, 1)
	end
end

-- id "de guardar": no slot o time ring 3053 vira 3090 (transformequipto); fora, volta a ser 3053
local function baseId(id)
	local de = ItemType(id):getTransformDeEquipId()
	if de and de ~= 0 then
		return de
	end
	return id
end

-- peca que gasta (cargas ou tempo): fora da mochila de verdade perderia o que sobrou
local function wears(id)
	local t = ItemType(id)
	if (t:getCharges() or 0) > 0 or (t:getDecayTime() or 0) > 0 then
		return true
	end
	local eq = t:getTransformEquipId()
	return eq ~= nil and eq ~= 0 and (ItemType(eq):getDecayTime() or 0) > 0
end

local function isAccessory(id)
	local sp = ItemType(id):getSlotPosition() or 0
	return bit.band(sp, SLOTP_NECKLACE) ~= 0 or bit.band(sp, SLOTP_RING) ~= 0
end

local function backpack(player)
	local bp = player:getSlotItem(CONST_SLOT_BACKPACK)
	if bp and bp:isContainer() then
		return bp
	end
	return nil
end

-- um container da mochila com lugar livre (a propria mochila ou uma bolsa dentro dela)
local function roomIn(bp)
	if bp:getEmptySlots(false) > 0 then
		return bp
	end
	for _, it in ipairs(bp:getItems(true)) do
		if it:isContainer() and it:getEmptySlots(false) > 0 then
			return it
		end
	end
	return nil
end

local function lootBag(guid)
	local b = I.bags and I.bags[guid]
	return b and b.items or nil
end

-- --------------------------------------------------------------------------
-- configuracao
-- --------------------------------------------------------------------------
function I.accParse(text)
	local cfg = { colar = {}, anel = {}, count = { colar = 0, anel = 0 }, any = false }
	for line in string.gmatch(text or "", "[^\n]+") do
		local slot, id, on, conds, near = line:match("^(%a+)|(%d+)|([01])|([^|]*)|(.*)$")
		if (slot == "colar" or slot == "anel") and #cfg[slot] < ACC_MAX then
			local r = { id = tonumber(id), on = on == "1", conds = I.parseConds(conds), near = nil }
			for name in string.gmatch(near or "", "[^;]+") do
				r.near = r.near or {}
				r.near[name:lower()] = true
			end
			cfg[slot][#cfg[slot] + 1] = r
			if r.on then
				cfg.count[slot] = cfg.count[slot] + 1
				cfg.any = true
			end
		end
	end
	return cfg
end

function I.accLoad(guid)
	if not I.accColumn then
		-- a ponte tambem cria a coluna; aqui e so para o servidor nao depender da ordem em que sobem
		I.accColumn = true
		db.query("ALTER TABLE `idle_settings` ADD COLUMN IF NOT EXISTS `acc` TEXT NULL")
	end
	local text = ""
	local r = db.storeQuery("SELECT `acc` FROM `idle_settings` WHERE `player_id` = " .. guid)
	if r then
		text = Result.getString(r, "acc") or ""
		Result.free(r)
	end
	return I.accParse(text)
end

-- --------------------------------------------------------------------------
-- condicoes (as mesmas da barra de acoes; Area = monstros atacando o personagem)
-- --------------------------------------------------------------------------
local function accCompare(a, op, b)
	if op == "lt" then
		return a < b
	elseif op == "le" then
		return a <= b
	elseif op == "eq" then
		return a == b
	elseif op == "ge" then
		return a >= b
	end
	return a > b
end

local function attackers(ctx)
	if ctx.attackers == nil then
		local n, pid = 0, ctx.player:getId()
		for _, m in ipairs(ctx.list) do
			local tg = m:getTarget()
			if tg and tg:getId() == pid then
				n = n + 1
			end
		end
		ctx.attackers = n
	end
	return ctx.attackers
end

local function condsOk(r, ctx)
	local player, target = ctx.player, ctx.target
	for _, c in ipairs(r.conds) do
		local v
		if c.subj == "self" then
			if c.attr == "hp" then
				v = c.pct and (player:getHealth() * 100 / math.max(1, player:getMaxHealth())) or player:getHealth()
			elseif c.attr == "mana" then
				v = c.pct and (player:getMana() * 100 / math.max(1, player:getMaxMana())) or player:getMana()
			elseif c.attr == "shield" then
				v = player:getCondition(CONDITION_MANASHIELD) and 1 or 0
			end
		elseif c.subj == "target" then
			if not target then
				return false
			end
			v = c.pct and (target:getHealth() * 100 / math.max(1, target:getMaxHealth())) or target:getHealth()
		elseif c.subj == "area" then
			v = attackers(ctx)
		end
		if v == nil or not accCompare(v, c.op, c.val) then
			return false
		end
	end
	return true
end

local function nearOk(r, ctx)
	if not r.near then
		return true
	end
	local pp = ctx.player:getPosition()
	for _, m in ipairs(ctx.list) do
		local mp = m:getPosition()
		if mp.z == pp.z and pp:getDistance(mp) <= ACC_NEAR and r.near[m:getName():lower()] then
			return true
		end
	end
	return false
end

-- --------------------------------------------------------------------------
-- o que o personagem carrega e a troca no slot
-- --------------------------------------------------------------------------
local function packCounts(ctx)
	if not ctx.pack then
		local counts = {}
		local bp = backpack(ctx.player)
		if bp then
			for _, it in ipairs(bp:getItems(true)) do
				local id = baseId(it:getId())
				counts[id] = (counts[id] or 0) + 1
			end
		end
		ctx.pack = counts
	end
	return ctx.pack
end

local function carried(ctx, id)
	local loot = lootBag(ctx.guid)
	return (packCounts(ctx)[id] or 0) + ((loot and loot[id]) or 0)
end

-- tira a peca do slot: mochila de verdade; cheia -> mochila do loot (so peca que nao gasta)
local function stash(ctx, item)
	local id, name = item:getId(), item:getName()
	local bp = backpack(ctx.player)
	local box = bp and roomIn(bp)
	if box and item:moveTo(box) then
		return true
	end
	if wears(id) then
		return false, "a mochila está cheia, não deu para guardar " .. name
	end
	local loot = lootBag(ctx.guid)
	if not loot then
		return false, "não deu para guardar " .. name
	end
	local base = baseId(id)
	if item:remove() then
		loot[base] = (loot[base] or 0) + 1
		ctx.h.bagDirty = true
		return true
	end
	return false, "não deu para guardar " .. name
end

-- poe a peca no slot: primeiro a da mochila de verdade (com as cargas/tempo que sobraram), depois uma do loot
local function wear(ctx, def, id)
	local player = ctx.player
	local bp = backpack(player)
	if bp then
		for _, it in ipairs(bp:getItems(true)) do
			if baseId(it:getId()) == id then
				return it:moveToSlot(player, def.slot) == true
			end
		end
	end
	local loot = lootBag(ctx.guid)
	if loot and (loot[id] or 0) > 0 then
		local charges = ItemType(id):getCharges() or 0
		local item = player:addItem(id, 1, false, charges > 0 and charges or 1, def.slot)
		if not item then
			return false
		end
		loot[id] = loot[id] - 1
		if loot[id] <= 0 then
			loot[id] = nil
		end
		ctx.h.bagDirty = true
		return true
	end
	return false
end

-- devolve true se mexeu no slot
local function accSlot(ctx, def, rules)
	local player, h = ctx.player, ctx.h
	local cur = player:getSlotItem(def.slot)
	local curBase = cur and baseId(cur:getId()) or 0
	local t = os.time()
	local want = nil
	for _, r in ipairs(rules) do
		if r.on and (r.retryAt or 0) <= t and (r.id == curBase or carried(ctx, r.id) > 0) and nearOk(r, ctx) and condsOk(r, ctx) then
			want = r
			break
		end
	end
	if (want and want.id == curBase) or (not want and not cur) then
		return false
	end
	if cur then
		local curName = cur:getName()
		local ok, why = stash(ctx, cur)
		if not ok then
			h.accWarn = h.accWarn or {}
			if (h.accWarn[def.key] or 0) + 60 <= t then
				h.accWarn[def.key] = t
				accLog(h, def.nome .. ": " .. tostring(why) .. ".")
			end
			return false
		end
		ctx.pack = nil
		if not want then
			accLog(h, def.nome .. ": tirou " .. curName .. " (nenhuma regra vale agora).")
		end
	end
	if want then
		local name = ItemType(want.id):getName()
		if wear(ctx, def, want.id) then
			accLog(h, def.nome .. ": colocou " .. name .. ".")
		else
			want.retryAt = t + ACC_RETRY
			accLog(h, def.nome .. ": não deu para colocar " .. name .. " (level ou vocação).")
		end
		ctx.pack = nil
	end
	return true
end

function I.accTick(h)
	local s = h.settings
	if not s then
		return
	end
	if s.acc == nil then
		s.acc = I.accLoad(h.guid)
	end
	if not s.acc.any then
		return
	end
	local player = Player(h.name)
	if not player then
		return
	end
	local target = h.targetId and Monster(h.targetId) or nil
	if target and target:getHealth() <= 0 then
		target = nil
	end
	local ctx = { h = h, guid = h.guid, player = player, target = target, list = (I.alive and I.alive(h)) or {} }
	local changed = false
	for _, def in ipairs(ACC_SLOTS) do
		if (s.acc.count[def.key] or 0) > 0 and accSlot(ctx, def, s.acc[def.key]) then
			changed = true
		end
	end
	if changed then
		I.writeGear(player)
	end
end

-- para a pagina (I.writeGear): quantas pecas ha na mochila de verdade e o que esta em cada slot
function I.accGear(player, data)
	local counts, pack = {}, {}
	local bp = backpack(player)
	if bp then
		for _, it in ipairs(bp:getItems(true)) do
			local id = baseId(it:getId())
			if isAccessory(id) then
				counts[id] = (counts[id] or 0) + 1
			end
		end
	end
	for id, n in pairs(counts) do
		pack[#pack + 1] = { id = id, n = n }
	end
	local function worn(slot)
		local it = player:getSlotItem(slot)
		return it and baseId(it:getId()) or 0
	end
	data.acc = { pack = pack, colar = worn(CONST_SLOT_NECKLACE), anel = worn(CONST_SLOT_RING) }
end

-- a cada segundo, para quem esta cacando (fora do tickHunter: um erro aqui so e registrado)
local accThink = GlobalEvent("IdleAcessorios")
function accThink.onThink(interval)
	for guid, h in pairs(I.hunters or {}) do
		local ok, err = pcall(I.accTick, h)
		if not ok then
			h.accErrors = (h.accErrors or 0) + 1
			if h.accErrors <= 3 then
				logger.warn("[Idle] acessorios de {}: {}", tostring(h.name or guid), tostring(err))
			end
		end
	end
	return true
end
accThink:interval(1000)
accThink:register()
