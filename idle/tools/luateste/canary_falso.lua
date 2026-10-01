-- Canary falso para testar idle_acessorios.lua: itens com transformequipto/deequip, mochila (container),
-- slots do jogador com requisito de level e de tipo de slot, monstros, banco e GlobalEvent.

CONST_SLOT_HEAD = 1
CONST_SLOT_NECKLACE = 2
CONST_SLOT_BACKPACK = 3
CONST_SLOT_RING = 9
SLOTP_NECKLACE = 4
SLOTP_BACKPACK = 8
SLOTP_RING = 32
CONDITION_MANASHIELD = 77

ITEMS = {
	[2854] = { name = "backpack", container = 20, slot = SLOTP_BACKPACK },
	[2853] = { name = "bag", container = 8 },
	[3003] = { name = "rope" },
	[3053] = { name = "time ring", slot = SLOTP_RING, equip = 3090 },
	[3090] = { name = "time ring", slot = SLOTP_RING, deequip = 3053, decay = 600 },
	[3048] = { name = "might ring", slot = SLOTP_RING, charges = 20 },
	[3081] = { name = "stone skin amulet", slot = SLOTP_NECKLACE, charges = 5 },
	[3572] = { name = "scarf", slot = SLOTP_NECKLACE },
	[3055] = { name = "platinum amulet", slot = SLOTP_NECKLACE },
	[23533] = { name = "ring of red plasma", slot = SLOTP_RING, equip = 23534, level = 100 },
	[23534] = { name = "ring of red plasma", slot = SLOTP_RING, deequip = 23533, decay = 1800, level = 100 },
}

function ItemType(id)
	local d = ITEMS[id] or {}
	return {
		getTransformDeEquipId = function(self) return d.deequip or 0 end,
		getTransformEquipId = function(self) return d.equip or 0 end,
		getCharges = function(self) return d.charges or 0 end,
		getDecayTime = function(self) return d.decay or 0 end,
		getSlotPosition = function(self) return d.slot or 0 end,
		getName = function(self) return d.name or "" end,
	}
end

local SLOT_OF = { [CONST_SLOT_NECKLACE] = SLOTP_NECKLACE, [CONST_SLOT_RING] = SLOTP_RING, [CONST_SLOT_BACKPACK] = SLOTP_BACKPACK }
CALLS = { addItem = 0, moveTo = 0, moveToSlot = 0, remove = 0 }

local function detach(it)
	local p = it.parent
	if not p then return end
	if p.kind == "slot" then
		p.player.slots[p.slot] = nil
		-- de-equip do Canary: o anel volta a ser o "de guardar" e para de contar o tempo
		local d = ITEMS[it.id]
		if d and d.deequip then it.id = d.deequip end
	else
		for i, x in ipairs(p.box.items) do
			if x == it then table.remove(p.box.items, i) break end
		end
	end
	it.parent = nil
end

local function putInSlot(player, it, slot)
	if player.slots[slot] then return false end
	local d = ITEMS[it.id] or {}
	if (d.slot or 0) ~= SLOT_OF[slot] then return false end
	if (d.level or 0) > player.level then return false end
	detach(it)
	if d.equip then it.id = d.equip end
	player.slots[slot] = it
	it.parent = { kind = "slot", player = player, slot = slot }
	return true
end

local nextUid = 0
function newItem(id, charges)
	nextUid = nextUid + 1
	local it = { uid = nextUid, id = id, charges = charges or (ITEMS[id] and ITEMS[id].charges) }
	it.getId = function(self) return self.id end
	it.getName = function(self) return ITEMS[self.id].name end
	it.getCount = function(self) return 1 end
	it.isContainer = function(self) return ITEMS[self.id].container ~= nil end
	if ITEMS[id].container then
		it.items = {}
		it.getEmptySlots = function(self, rec)
			local n = ITEMS[self.id].container - #self.items
			if rec then
				for _, x in ipairs(self.items) do
					if x.items then n = n + x:getEmptySlots(true) end
				end
			end
			return n
		end
		it.getItems = function(self, rec)
			local out = {}
			for _, x in ipairs(self.items) do
				out[#out + 1] = x
				if rec and x.items then
					for _, y in ipairs(x:getItems(true)) do out[#out + 1] = y end
				end
			end
			return out
		end
		it.add = function(self, x)
			x.parent = { kind = "box", box = self }
			self.items[#self.items + 1] = x
			return x
		end
	end
	it.remove = function(self)
		CALLS.remove = CALLS.remove + 1
		detach(self)
		self.removed = true
		return true
	end
	it.moveTo = function(self, box)
		CALLS.moveTo = CALLS.moveTo + 1
		assert(box and box.items, "moveTo sem container")
		detach(self)
		box:add(self)
		return true
	end
	it.moveToSlot = function(self, player, slot)
		CALLS.moveToSlot = CALLS.moveToSlot + 1
		return putInSlot(player, self, slot)
	end
	return it
end

function Pos(x, y, z)
	return { x = x, y = y, z = z, getDistance = function(self, o) return math.max(math.abs(self.x - o.x), math.abs(self.y - o.y)) end }
end

PLAYERS, MONSTERS = {}, {}
function Player(name) return PLAYERS[name] end
function Monster(id) return MONSTERS[id] end

local nextPid = 1000
function newPlayer(name, level)
	nextPid = nextPid + 1
	local p = { pid = nextPid, name = name, level = level or 50, hp = 100, maxhp = 100, mana = 100, maxmana = 100, slots = {}, shield = false, pos = Pos(100, 100, 7) }
	p.getId = function(self) return self.pid end
	p.getName = function(self) return self.name end
	p.getHealth = function(self) return self.hp end
	p.getMaxHealth = function(self) return self.maxhp end
	p.getMana = function(self) return self.mana end
	p.getMaxMana = function(self) return self.maxmana end
	p.getPosition = function(self) return self.pos end
	p.getCondition = function(self, t) if t == CONDITION_MANASHIELD and self.shield then return {} end return nil end
	p.getSlotItem = function(self, s) return self.slots[s] end
	p.addItem = function(self, id, count, drop, sub, slot)
		CALLS.addItem = CALLS.addItem + 1
		LAST_ADD = { id = id, count = count, drop = drop, sub = sub, slot = slot }
		assert(drop == false, "addItem sem canDropOnMap=false")
		local it = newItem(id, sub)
		if not putInSlot(self, it, slot) then return nil end
		return it
	end
	PLAYERS[name] = p
	return p
end

function newMonster(id, name, x, y, z, target)
	local m = { mid = id, name = name, pos = Pos(x, y, z or 7), target = target, hp = 100, maxhp = 100 }
	m.getId = function(self) return self.mid end
	m.getName = function(self) return self.name end
	m.getPosition = function(self) return self.pos end
	m.getTarget = function(self) return self.target end
	m.getHealth = function(self) return self.hp end
	m.getMaxHealth = function(self) return self.maxhp end
	MONSTERS[id] = m
	return m
end

-- banco: so a coluna acc de idle_settings
DB_ACC, DBQ = {}, {}
db = {
	query = function(q) DBQ[#DBQ + 1] = q return true end,
	storeQuery = function(q)
		DBQ[#DBQ + 1] = q
		local guid = tonumber(q:match("= (%d+)$"))
		if not guid or DB_ACC[guid] == nil then return false end
		return { acc = DB_ACC[guid] }
	end,
}
Result = { getString = function(r, col) return r[col] end, free = function(r) end }

WARN = {}
logger = { warn = function(fmt, a, b) WARN[#WARN + 1] = tostring(a) .. ": " .. tostring(b) end, info = function() end, error = function() end }

EVENTS = {}
function GlobalEvent(name)
	local e = { name = name }
	e.interval = function(self, ms) self.ms = ms end
	e.register = function(self) EVENTS[self.name] = self end
	return e
end

Idle = { LOG_MAX = 25, hunters = {}, bags = {} }
GEAR = {}
Idle.alive = function(h) return h.mlist or {} end
Idle.writeGear = function(player)
	local data = { slots = {} }
	if Idle.accGear then pcall(Idle.accGear, player, data) end
	GEAR[#GEAR + 1] = data
end
