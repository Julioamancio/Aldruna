--[[
Destruitor Idle — combate automatico no servidor, no estilo do Huntera.

Como funciona
  * Cada personagem que caca ganha uma SALA propria (tiles criados aqui, longe do mapa),
    onde os monstros nascem em "pulls". O personagem nao precisa de cliente: um jogador
    sem conexao continua no mundo enquanto esta em combate (regra do proprio Tibia).
  * A cada segundo o servidor escolhe o alvo e percorre a BARRA DE REGRAS do jogador
    (slots em ordem, cada um com condicoes); o slot mais a esquerda vence dentro do
    mesmo grupo de cooldown (cura, ataque, suporte, item).
  * Pocoes custam gold do banco a cada uso; o loot e vendido na hora pelo preco de NPC.
  * A pagina web conversa com isto so pelo banco:
      idle_commands  (pagina -> servidor)  start/stop/reload
      idle_settings  (pagina grava)        cacada, pull, alvo, distancia, barra
      idle_state     (servidor grava)      estado ao vivo em JSON, a cada 2 s
      idle_catalog   (servidor grava)      cacadas e acoes disponiveis, no boot
]]

Idle = Idle or {}
local I = Idle

I.MAX_UNWATCHED = 12 * 60 * 60 -- caca ate 12 h sem ninguem olhando a pagina
I.ROOM_RADIUS = 4
I.ROOM_BASE = { x = 40000, y = 40000, z = 7 }
I.ROOM_STEP = 48 -- areas de ate 31x23 com folga entre elas
I.ROOM_COLS = 40
I.STATE_EVERY = 400 -- estado para a pagina (a caminhada fica suave)
I.LOG_MAX = 25
I.LOGIN_GRACE = 90 -- segundos para um personagem sem cliente receber o comando de cacar

I.hunters = I.hunters or {} -- [guid] = estado da cacada
I.owner = I.owner or {} -- [monsterId] = guid do cacador
I.rooms = I.rooms or {} -- [indice] = guid ocupante (ou nil)
I.roomReady = I.roomReady or {} -- [indice] = true quando os tiles ja existem
I.loginAt = I.loginAt or {} -- [guid] = os.time() do login

local function now()
	return os.mtime and os.mtime() or os.time() * 1000
end

-- --------------------------------------------------------------------------
-- Cacadas (monstros do datapack data-canary)
-- --------------------------------------------------------------------------
I.HUNTS = {
	{ id = "esgoto", name = "Esgoto de Thais", min = 8, max = 20, monsters = { "Cave Rat", "Bat", "Snake", "Spider" } },
	{ id = "floresta", name = "Floresta Sombria", min = 8, max = 25, monsters = { "Wolf", "Winter Wolf", "Poison Spider", "Wasp" } },
	{ id = "trolls", name = "Colinas dos Trolls", min = 10, max = 30, monsters = { "Troll", "Island Troll", "Frost Troll", "Goblin" } },
	{ id = "sapos", name = "Lagoa dos Sapos", min = 15, max = 35, monsters = { "Azure Frog", "Coral Frog", "Crimson Frog", "Orchid Frog", "Green Frog", "Bog Frog", "Toad" } },
	{ id = "cripta", name = "Cripta Esquecida", min = 20, max = 45, monsters = { "Skeleton", "Ghoul", "Slime", "Mummy" } },
	{ id = "amazonas", name = "Acampamento Amazona", min = 25, max = 50, monsters = { "Amazon", "Valkyrie", "Hunter" } },
	{ id = "rio", name = "Margem do Rio", min = 30, max = 55, monsters = { "Crocodile", "Tortoise", "Salamander", "Filth Toad" } },
	{ id = "bandidos", name = "Esconderijo dos Bandidos", min = 35, max = 65, monsters = { "Bandit", "Assassin", "Sandcrawler" } },
	{ id = "ciclopes", name = "Colinas dos Ciclopes", min = 40, max = 80, monsters = { "Cyclops", "Cyclops Drone", "Cyclops Smith" } },
	{ id = "dragoes", name = "Covil dos Dragoes", min = 60, max = 110, monsters = { "Dragon" } },
	{ id = "gelo", name = "Caverna Congelada", min = 70, max = 120, monsters = { "Ice Dragon", "Frost Troll", "Winter Wolf" } },
	{ id = "lordes", name = "Ninho dos Dragoes Lordes", min = 100, max = 160, monsters = { "Dragon Lord", "Dragon", "Wyrm" } },
	{ id = "hidras", name = "Lago das Hidras", min = 100, max = 170, monsters = { "Hydra", "Black Knight" } },
	{ id = "behemoth", name = "Minas dos Behemoths", min = 120, max = 200, monsters = { "Behemoth", "Frazzlemaw", "Guzzlemaw" } },
	{ id = "inferno", name = "Portoes do Inferno", min = 150, max = 260, monsters = { "Hellspawn", "Hellhound", "Fury", "Destroyer", "Defiler" } },
	{ id = "demonios", name = "Fortaleza Demoniaca", min = 200, max = 999, monsters = { "Demon", "Juggernaut", "Hellhound", "Destroyer" } },
}
-- as cacadas calibradas (idle_hunts.lua, gerado por tools/calibra.py) substituem a lista acima no boot
function I.setHunts(list, validate)
	local valid = {}
	for _, h in ipairs(list) do
		local monsters = {}
		for _, name in ipairs(h.monsters) do
			if not validate or MonsterType(name) then
				monsters[#monsters + 1] = name
			else
				logger.warn("[Idle] cacada {}: monstro desconhecido {}", h.id, name)
			end
		end
		if #monsters > 0 then
			h.monsters = monsters
			valid[#valid + 1] = h
		end
	end
	I.HUNTS = valid
	I.huntById = {}
	for _, h in ipairs(I.HUNTS) do
		I.huntById[h.id] = h
	end
end
I.setHunts(I.HUNTS, false)

-- cacada livre: "m:<nome do monstro>" caca so aquele monstro do bestiario
I.SOLO = I.SOLO or {}
function I.setSolo(list)
	I.SOLO = {}
	I.SOLO_LIST = {}
	for _, m in ipairs(list) do
		if MonsterType(m.name) then
			I.SOLO[m.name:lower()] = m
			I.SOLO_LIST[#I.SOLO_LIST + 1] = m
		end
	end
end

function I.getHunt(id)
	if not id then
		return nil
	end
	if id:sub(1, 2) == "m:" then
		local m = I.SOLO[id:sub(3):lower()]
		if not m then
			return nil
		end
		return { id = "m:" .. m.name, name = "Cacada livre: " .. m.name, min = m.min, lvl = m.lvl, monsters = { m.name } }
	end
	return I.huntById[id]
end

I.PULLS = { cauteloso = { 1, 2 }, ousado = { 2, 4 }, agressivo = { 4, 6 } }
-- como no Huntera ("um pull maior acorda estes tambem"): quanto dos spawns da area acorda em cada tamanho
I.PULL_WAKE = { cauteloso = 0.45, ousado = 0.75, agressivo = 1.0 }

-- --------------------------------------------------------------------------
-- Acoes da barra (numeros oficiais das magias do Canary v3.6.1)
-- voc: S sorcerer, D druid, P paladin, K knight
-- area: "circle" acerta todos no raio; "wave"/"beam" acertam os mais proximos no alcance
-- --------------------------------------------------------------------------
local function ml(a, b)
	return function(c)
		return c.level / 5 + c.ml * a + (b or 0)
	end
end
local function heal(a, b)
	return function(c)
		return c.level * 0.2 + c.ml * a + (b or 0)
	end
end

I.ACTIONS = {}
local function add(def)
	def.key = def.name
	I.ACTIONS[def.name] = def
end

-- curas
add({ name = "Light Healing", words = "exura", kind = "heal", voc = "SDP", lvl = 8, mana = 20, cd = 1000, group = "heal", min = heal(1.4, 8), max = heal(1.795, 11) })
add({ name = "Intense Healing", words = "exura gran", kind = "heal", voc = "SDP", lvl = 20, mana = 70, cd = 1000, group = "heal", min = heal(3.184, 20), max = heal(5.59, 35) })
add({ name = "Ultimate Healing", words = "exura vita", kind = "heal", voc = "SD", lvl = 30, mana = 160, cd = 1000, group = "heal", min = ml(6.8, 42), max = ml(12.9, 90) })
add({ name = "Divine Healing", words = "exura san", kind = "heal", voc = "P", lvl = 35, mana = 160, cd = 1000, group = "heal", min = heal(7.22, 44), max = heal(12.79, 79) })
add({ name = "Salvation", words = "exura gran san", kind = "heal", voc = "P", lvl = 60, mana = 210, cd = 1000, group = "heal", min = heal(12, 75), max = heal(20, 125) })
add({ name = "Wound Cleansing", words = "exura ico", kind = "heal", voc = "K", lvl = 8, mana = 40, cd = 1000, group = "heal", min = heal(4, 25), max = heal(7.95, 51) })

-- ataque de alvo unico (magos)
local strike = { min = ml(1.403, 8), max = ml(2.203, 13) }
local strong = { min = ml(2.8, 16), max = ml(4.4, 28) }
local ultimate = { min = ml(4.5, 35), max = ml(7.3, 55) }
add({ name = "Energy Strike", words = "exori vis", kind = "attack", voc = "SD", lvl = 12, mana = 20, cd = 2000, group = "attack", elem = COMBAT_ENERGYDAMAGE, fx = CONST_ME_ENERGYAREA, min = strike.min, max = strike.max })
add({ name = "Terra Strike", words = "exori tera", kind = "attack", voc = "SD", lvl = 13, mana = 20, cd = 2000, group = "attack", elem = COMBAT_EARTHDAMAGE, fx = CONST_ME_CARNIPHILA, min = strike.min, max = strike.max })
add({ name = "Flame Strike", words = "exori flam", kind = "attack", voc = "SD", lvl = 14, mana = 20, cd = 2000, group = "attack", elem = COMBAT_FIREDAMAGE, fx = CONST_ME_FIREATTACK, min = strike.min, max = strike.max })
add({ name = "Ice Strike", words = "exori frigo", kind = "attack", voc = "SD", lvl = 15, mana = 20, cd = 2000, group = "attack", elem = COMBAT_ICEDAMAGE, fx = CONST_ME_ICEATTACK, min = strike.min, max = strike.max })
add({ name = "Death Strike", words = "exori mort", kind = "attack", voc = "S", lvl = 16, mana = 20, cd = 2000, group = "attack", elem = COMBAT_DEATHDAMAGE, fx = CONST_ME_MORTAREA, min = strike.min, max = strike.max })
add({ name = "Physical Strike", words = "exori moe ico", kind = "attack", voc = "D", lvl = 16, mana = 20, cd = 2000, group = "attack", elem = COMBAT_PHYSICALDAMAGE, fx = CONST_ME_HITAREA, min = strike.min, max = strike.max })
add({ name = "Lightning", words = "exori amp vis", kind = "attack", voc = "S", lvl = 55, mana = 60, cd = 8000, group = "attack", elem = COMBAT_ENERGYDAMAGE, fx = CONST_ME_ENERGYHIT, min = ml(2.2, 12), max = ml(3.4, 21) })
add({ name = "Strong Flame Strike", words = "exori gran flam", kind = "attack", voc = "S", lvl = 70, mana = 60, cd = 8000, group = "attack", elem = COMBAT_FIREDAMAGE, fx = CONST_ME_FIREATTACK, min = strong.min, max = strong.max })
add({ name = "Strong Terra Strike", words = "exori gran tera", kind = "attack", voc = "D", lvl = 70, mana = 60, cd = 8000, group = "attack", elem = COMBAT_EARTHDAMAGE, fx = CONST_ME_CARNIPHILA, min = strong.min, max = strong.max })
add({ name = "Strong Energy Strike", words = "exori gran vis", kind = "attack", voc = "S", lvl = 80, mana = 60, cd = 8000, group = "attack", elem = COMBAT_ENERGYDAMAGE, fx = CONST_ME_ENERGYAREA, min = strong.min, max = strong.max })
add({ name = "Strong Ice Strike", words = "exori gran frigo", kind = "attack", voc = "D", lvl = 80, mana = 60, cd = 8000, group = "attack", elem = COMBAT_ICEDAMAGE, fx = CONST_ME_ICEATTACK, min = strong.min, max = strong.max })
add({ name = "Ultimate Flame Strike", words = "exori max flam", kind = "attack", voc = "S", lvl = 90, mana = 100, cd = 30000, group = "attack", elem = COMBAT_FIREDAMAGE, fx = CONST_ME_FIREATTACK, min = ultimate.min, max = ultimate.max })
add({ name = "Ultimate Terra Strike", words = "exori max tera", kind = "attack", voc = "D", lvl = 90, mana = 100, cd = 30000, group = "attack", elem = COMBAT_EARTHDAMAGE, fx = CONST_ME_CARNIPHILA, min = ultimate.min, max = ultimate.max })
add({ name = "Ultimate Energy Strike", words = "exori max vis", kind = "attack", voc = "S", lvl = 100, mana = 100, cd = 30000, group = "attack", elem = COMBAT_ENERGYDAMAGE, fx = CONST_ME_ENERGYAREA, min = ultimate.min, max = ultimate.max })
add({ name = "Ultimate Ice Strike", words = "exori max frigo", kind = "attack", voc = "D", lvl = 100, mana = 100, cd = 30000, group = "attack", elem = COMBAT_ICEDAMAGE, fx = CONST_ME_ICEATTACK, min = ultimate.min, max = ultimate.max })

-- area (magos)
add({ name = "Fire Wave", words = "exevo flam hur", kind = "area", area = "wave", range = 4, voc = "S", lvl = 18, mana = 25, cd = 4000, group = "attack", elem = COMBAT_FIREDAMAGE, fx = CONST_ME_FIREAREA, min = ml(1.25, 4), max = ml(2, 12) })
add({ name = "Ice Wave", words = "exevo frigo hur", kind = "area", area = "wave", range = 4, voc = "D", lvl = 18, mana = 25, cd = 4000, group = "attack", elem = COMBAT_ICEDAMAGE, fx = CONST_ME_ICEAREA, min = ml(0.81, 4), max = ml(2, 12) })
add({ name = "Energy Beam", words = "exevo vis lux", kind = "area", area = "beam", range = 5, voc = "S", lvl = 23, mana = 40, cd = 4000, group = "attack", elem = COMBAT_ENERGYDAMAGE, fx = CONST_ME_ENERGYHIT, min = ml(1.8, 11), max = ml(3, 19) })
add({ name = "Great Energy Beam", words = "exevo gran vis lux", kind = "area", area = "beam", range = 7, voc = "S", lvl = 29, mana = 110, cd = 6000, group = "attack", elem = COMBAT_ENERGYDAMAGE, fx = CONST_ME_ENERGYHIT, min = ml(4), max = ml(7) })
add({ name = "Energy Wave", words = "exevo vis hur", kind = "area", area = "wave", range = 5, voc = "S", lvl = 38, mana = 170, cd = 8000, group = "attack", elem = COMBAT_ENERGYDAMAGE, fx = CONST_ME_ENERGYAREA, min = ml(4.5), max = ml(9) })
add({ name = "Terra Wave", words = "exevo tera hur", kind = "area", area = "wave", range = 5, voc = "D", lvl = 38, mana = 170, cd = 4000, group = "attack", elem = COMBAT_EARTHDAMAGE, fx = CONST_ME_SMALLPLANTS, min = ml(3.5), max = ml(7) })
add({ name = "Strong Ice Wave", words = "exevo gran frigo hur", kind = "area", area = "wave", range = 3, voc = "D", lvl = 40, mana = 170, cd = 8000, group = "attack", elem = COMBAT_ICEDAMAGE, fx = CONST_ME_ICEAREA, min = ml(4.5, 20), max = ml(7.6, 48) })
add({ name = "Rage of the Skies", words = "exevo gran mas vis", kind = "area", area = "circle", range = 6, voc = "S", lvl = 55, mana = 600, cd = 40000, group = "attack", elem = COMBAT_ENERGYDAMAGE, fx = CONST_ME_BIGCLOUDS, min = ml(7), max = ml(14) })
add({ name = "Wrath of Nature", words = "exevo gran mas tera", kind = "area", area = "circle", range = 6, voc = "D", lvl = 55, mana = 700, cd = 40000, group = "attack", elem = COMBAT_EARTHDAMAGE, fx = CONST_ME_SMALLPLANTS, min = ml(5), max = ml(10) })
add({ name = "Hell's Core", words = "exevo gran mas flam", kind = "area", area = "circle", range = 5, voc = "S", lvl = 60, mana = 1100, cd = 40000, group = "attack", elem = COMBAT_FIREDAMAGE, fx = CONST_ME_FIREAREA, min = ml(10), max = ml(14) })
add({ name = "Eternal Winter", words = "exevo gran mas frigo", kind = "area", area = "circle", range = 5, voc = "D", lvl = 60, mana = 1050, cd = 40000, group = "attack", elem = COMBAT_ICEDAMAGE, fx = CONST_ME_ICETORNADO, min = ml(6), max = ml(12) })

-- paladino
add({ name = "Ethereal Spear", words = "exori con", kind = "attack", voc = "P", lvl = 23, mana = 25, cd = 2000, group = "attack", elem = COMBAT_PHYSICALDAMAGE, fx = CONST_ME_HITAREA, min = function(c)
	return c.level / 5 + (c.skill + 25) / 3
end, max = function(c)
	return c.level / 5 + c.skill + 25
end })
add({ name = "Divine Missile", words = "exori san", kind = "attack", voc = "P", lvl = 40, mana = 20, cd = 2000, group = "attack", elem = COMBAT_HOLYDAMAGE, fx = CONST_ME_HOLYDAMAGE, min = ml(1.79, 11), max = ml(3, 18) })
add({ name = "Divine Caldera", words = "exevo mas san", kind = "area", area = "circle", range = 3, voc = "P", lvl = 50, mana = 160, cd = 4000, group = "attack", elem = COMBAT_HOLYDAMAGE, fx = CONST_ME_HOLYAREA, min = ml(4), max = ml(6) })
add({ name = "Strong Ethereal Spear", words = "exori gran con", kind = "attack", voc = "P", lvl = 90, mana = 55, cd = 8000, group = "attack", elem = COMBAT_PHYSICALDAMAGE, fx = CONST_ME_HITAREA, min = function(c)
	return c.level / 5 + (c.skill + 25) * 0.7
end, max = function(c)
	return c.level / 5 + (c.skill + 25) * 1.7
end })

-- cavaleiro (skill + ataque da arma)
add({ name = "Brutal Strike", words = "exori ico", kind = "attack", voc = "K", lvl = 16, mana = 30, cd = 6000, group = "attack", elem = COMBAT_PHYSICALDAMAGE, fx = CONST_ME_HITAREA, min = function(c)
	return c.level / 5 + (c.skill + c.atk) / 3
end, max = function(c)
	return c.level / 5 + c.skill + c.atk
end })
add({ name = "Whirlwind Throw", words = "exori hur", kind = "attack", voc = "K", lvl = 28, mana = 40, cd = 6000, group = "attack", elem = COMBAT_PHYSICALDAMAGE, fx = CONST_ME_HITAREA, min = function(c)
	return c.level / 5 + (c.skill + c.atk) / 3
end, max = function(c)
	return c.level / 5 + c.skill + c.atk
end })
add({ name = "Groundshaker", words = "exori mas", kind = "area", area = "circle", range = 3, voc = "K", lvl = 33, mana = 160, cd = 8000, group = "attack", elem = COMBAT_PHYSICALDAMAGE, fx = CONST_ME_GROUNDSHAKER, min = function(c)
	return c.level / 5 + (c.skill + c.atk) * 0.5
end, max = function(c)
	return c.level / 5 + (c.skill + c.atk) * 1.1
end })
add({ name = "Berserk", words = "exori", kind = "area", area = "circle", range = 1, voc = "K", lvl = 35, mana = 115, cd = 4000, group = "attack", elem = COMBAT_PHYSICALDAMAGE, fx = CONST_ME_HITAREA, min = function(c)
	return c.level / 5 + (c.skill + c.atk) * 0.5
end, max = function(c)
	return c.level / 5 + (c.skill + c.atk) * 1.5
end })
add({ name = "Fierce Berserk", words = "exori gran", kind = "area", area = "circle", range = 1, voc = "K", lvl = 90, mana = 340, cd = 6000, group = "attack", elem = COMBAT_PHYSICALDAMAGE, fx = CONST_ME_HITAREA, min = function(c)
	return c.level / 5 + (c.skill + 2 * c.atk) * 1.1
end, max = function(c)
	return c.level / 5 + (c.skill + 2 * c.atk) * 3
end })

-- suporte
add({ name = "Magic Shield", words = "utamo vita", kind = "shield", voc = "SD", lvl = 14, mana = 50, cd = 14000, group = "support" })
add({ name = "Haste", words = "utani hur", kind = "haste", voc = "SDPK", lvl = 14, mana = 60, cd = 2000, group = "support", speed = 0.3 })
add({ name = "Strong Haste", words = "utani gran hur", kind = "haste", voc = "SD", lvl = 20, mana = 100, cd = 2000, group = "support", speed = 0.7 })

-- pocoes (custam gold do banco a cada uso, como no Huntera)
add({ name = "Lesser Health Potion", kind = "potion", voc = "SDPK", lvl = 1, cost = 0, cd = 1000, group = "item", hp = { 60, 90 } })
add({ name = "Health Potion", kind = "potion", voc = "SDPK", lvl = 1, cost = 50, cd = 1000, group = "item", hp = { 125, 175 } })
add({ name = "Strong Health Potion", kind = "potion", voc = "PK", lvl = 50, cost = 115, cd = 1000, group = "item", hp = { 250, 350 } })
add({ name = "Great Health Potion", kind = "potion", voc = "K", lvl = 80, cost = 225, cd = 1000, group = "item", hp = { 425, 575 } })
add({ name = "Ultimate Health Potion", kind = "potion", voc = "K", lvl = 130, cost = 379, cd = 1000, group = "item", hp = { 650, 850 } })
add({ name = "Mana Potion", kind = "potion", voc = "SDPK", lvl = 1, cost = 56, cd = 1000, group = "item", mp = { 75, 125 } })
add({ name = "Strong Mana Potion", kind = "potion", voc = "SDP", lvl = 50, cost = 93, cd = 1000, group = "item", mp = { 115, 185 } })
add({ name = "Great Mana Potion", kind = "potion", voc = "SD", lvl = 80, cost = 144, cd = 1000, group = "item", mp = { 150, 250 } })
add({ name = "Great Spirit Potion", kind = "potion", voc = "P", lvl = 80, cost = 254, cd = 1000, group = "item", hp = { 250, 350 }, mp = { 100, 200 } })
add({ name = "Ultimate Mana Potion", kind = "potion", voc = "SD", lvl = 130, cost = 350, cd = 1000, group = "item", mp = { 425, 575 } })

I.GROUP_CD = { heal = 1000, attack = 2000, support = 2000, item = 1000 }

-- --------------------------------------------------------------------------
-- Magias reais do Canary: le os scripts de magia (ataque, cura, suporte) e guarda a funcao de lancar
-- de cada uma. O cacador usa o combate de verdade (formula, efeito, area) e cuida de mana e cooldown.
-- Assim entram todas as magias de cada vocacao, iguais as do Tibia.
-- --------------------------------------------------------------------------
I.SPELL_ROOT = "/canary/data/scripts/spells/"
local SPELL_VOC = {
	sorcerer = "S", ["master sorcerer"] = "S", druid = "D", ["elder druid"] = "D",
	paladin = "P", ["royal paladin"] = "P", knight = "K", ["elite knight"] = "K",
}
-- suporte que serve na cacada (luz, invisivel, levitar, achar pessoa... ficam de fora)
local SUPPORT_KIND = {
	["Magic Shield"] = "shield", ["Haste"] = "haste", ["Strong Haste"] = "haste", ["Charge"] = "haste", ["Swift Foot"] = "haste",
	["Sharpshooter"] = "support", ["Protector"] = "support", ["Blood Rage"] = "support", ["Expose Weakness"] = "support",
	["Sap Strength"] = "support", ["Avatar of Light"] = "support", ["Avatar of Nature"] = "support", ["Avatar of Steel"] = "support",
	["Avatar of Storm"] = "support", ["Divine Empowerment"] = "support", ["Mentor Other"] = nil,
}
-- cura que precisa de alvo de fora ou nao cura vida
local HEAL_SKIP = { ["Heal Friend"] = true, ["Cure Poison"] = true, ["Cure Burning"] = true, ["Cure Electrification"] = true, ["Cure Bleeding"] = true, ["Cure Curse"] = true }

local function guessElem(name, words)
	local s = (name .. " " .. (words or "")):lower()
	if s:find("energy") or s:find(" vis") or s:find("lightning") or s:find("thunder") or s:find("storm") or s:find("skies") then
		return COMBAT_ENERGYDAMAGE
	elseif s:find("flam") or s:find("fire") or s:find("hell") or s:find("scorch") then
		return COMBAT_FIREDAMAGE
	elseif s:find("ice") or s:find("frigo") or s:find("winter") or s:find("frost") then
		return COMBAT_ICEDAMAGE
	elseif s:find("terra") or s:find("tera") or s:find("nature") or s:find("stone") or s:find("earth") then
		return COMBAT_EARTHDAMAGE
	elseif s:find("death") or s:find("mort") or s:find("curse") then
		return COMBAT_DEATHDAMAGE
	elseif s:find("divine") or s:find("holy") or s:find(" san") then
		return COMBAT_HOLYDAMAGE
	end
	return COMBAT_PHYSICALDAMAGE
end

local function vocLetters(v)
	local list = type(v) == "table" and v or { v }
	local out = {}
	for _, s in ipairs(list) do
		local name = tostring(s):lower():match("^([^;]+)")
		local l = name and SPELL_VOC[name]
		if l and not out[l] then
			out[l] = true
			out[#out + 1] = l
		end
	end
	table.sort(out)
	return table.concat(out)
end

function I.loadRealSpells()
	local realSpell = Spell
	local captured = {}
	Spell = function(kind)
		local meta = { kind = kind }
		local obj = {}
		setmetatable(obj, {
			__index = function(_, key)
				if key == "register" then
					return function()
						captured[#captured + 1] = { meta = meta, obj = obj }
						return true
					end
				end
				return function(_, ...)
					local args = { ... }
					meta[key] = (#args <= 1) and args[1] or args
					return true
				end
			end,
		})
		return obj
	end
	local files, failed = 0, 0
	for _, dir in ipairs({ "attack", "healing", "support" }) do
		local ok, p = pcall(io.popen, "ls " .. I.SPELL_ROOT .. dir .. " 2>/dev/null")
		if ok and p then
			for f in p:lines() do
				if f:match("%.lua$") then
					files = files + 1
					local okf = pcall(dofile, I.SPELL_ROOT .. dir .. "/" .. f)
					if not okf then
						failed = failed + 1
					end
				end
			end
			p:close()
		end
	end
	Spell = realSpell

	local added, replaced = 0, 0
	for _, c in ipairs(captured) do
		local m, fn = c.meta, rawget(c.obj, "onCastSpell")
		local name = m.name
		if type(name) == "string" and type(fn) == "function" and m.kind == "instant" then
			local group = m.group == "healing" and "heal" or m.group == "support" and "support" or m.group == "attack" and "attack" or nil
			local kind
			if group == "heal" then
				kind = (not HEAL_SKIP[name]) and "heal" or nil
			elseif group == "attack" then
				kind = (m.needTarget or m.needCasterTargetOrDirection) and "attack" or "area"
			elseif group == "support" then
				kind = SUPPORT_KIND[name]
			end
			local voc = vocLetters(m.vocation)
			if kind and voc ~= "" and (tonumber(m.level) or 0) > 0 then
				local old = I.ACTIONS[name]
				local def = old or { name = name }
				def.name = name
				def.key = name
				def.words = m.words or (old and old.words) or ""
				def.kind = kind
				def.voc = voc
				def.lvl = tonumber(m.level) or 1
				def.mana = tonumber(m.mana) or 0
				def.cd = tonumber(m.cooldown) or 2000
				def.gcdMs = tonumber(m.groupCooldown) or nil
				def.group = group == "heal" and "heal" or group == "attack" and "attack" or "support"
				def.real = fn
				def.range = tonumber(m.range) or def.range
				def.needDirection = m.needDirection and true or false
				def.area = def.area or (kind == "area" and (m.needDirection and "wave" or "circle")) or ""
				def.elem = def.elem or (kind ~= "heal" and guessElem(name, m.words)) or nil
				if old then
					replaced = replaced + 1
				else
					added = added + 1
				end
				I.ACTIONS[name] = def
			end
		end
	end
	logger.info("[Idle] magias reais: {} arquivos ({} com erro), {} trocadas, {} novas", files, failed, replaced, added)
end

-- barras sugeridas (mesma logica do Huntera: cura/pocao por % de vida, area por n de alvos)
I.DEFAULT_BAR = {
	S = {
		"Magic Shield|1|",
		"Ultimate Healing|1|self.hp.le.55.p",
		"Intense Healing|1|self.hp.le.70.p",
		"Light Healing|1|self.hp.le.85.p",
		"Health Potion|1|self.hp.le.40.p",
		"Lesser Health Potion|1|self.hp.le.60.p",
		"Great Mana Potion|1|self.mana.le.50.p",
		"Strong Mana Potion|1|self.mana.le.50.p",
		"Mana Potion|1|self.mana.le.50.p",
		"Rage of the Skies|1|area.targets.ge.4",
		"Hell's Core|1|area.targets.ge.4",
		"Energy Wave|1|area.targets.ge.3",
		"Great Energy Beam|1|area.targets.ge.2",
		"Fire Wave|1|area.targets.ge.2",
		"Ultimate Energy Strike|1|",
		"Strong Energy Strike|1|",
		"Energy Strike|1|",
		"Flame Strike|1|",
	},
	D = {
		"Magic Shield|1|",
		"Ultimate Healing|1|self.hp.le.55.p",
		"Intense Healing|1|self.hp.le.70.p",
		"Light Healing|1|self.hp.le.85.p",
		"Health Potion|1|self.hp.le.40.p",
		"Lesser Health Potion|1|self.hp.le.60.p",
		"Great Mana Potion|1|self.mana.le.50.p",
		"Strong Mana Potion|1|self.mana.le.50.p",
		"Mana Potion|1|self.mana.le.50.p",
		"Wrath of Nature|1|area.targets.ge.4",
		"Eternal Winter|1|area.targets.ge.4",
		"Terra Wave|1|area.targets.ge.3",
		"Strong Ice Wave|1|area.targets.ge.2",
		"Ice Wave|1|area.targets.ge.2",
		"Ultimate Ice Strike|1|",
		"Strong Ice Strike|1|",
		"Ice Strike|1|",
		"Terra Strike|1|",
	},
	P = {
		"Salvation|1|self.hp.le.50.p",
		"Divine Healing|1|self.hp.le.65.p",
		"Intense Healing|1|self.hp.le.75.p",
		"Light Healing|1|self.hp.le.85.p",
		"Great Spirit Potion|1|self.hp.le.45.p",
		"Strong Health Potion|1|self.hp.le.40.p",
		"Health Potion|1|self.hp.le.40.p",
		"Lesser Health Potion|1|self.hp.le.60.p",
		"Strong Mana Potion|1|self.mana.le.30.p",
		"Mana Potion|1|self.mana.le.30.p",
		"Divine Caldera|1|area.targets.ge.3",
		"Strong Ethereal Spear|1|",
		"Divine Missile|1|",
		"Ethereal Spear|1|",
	},
	K = {
		"Wound Cleansing|1|self.hp.le.70.p",
		"Ultimate Health Potion|1|self.hp.le.50.p",
		"Great Health Potion|1|self.hp.le.50.p",
		"Strong Health Potion|1|self.hp.le.50.p",
		"Health Potion|1|self.hp.le.50.p",
		"Lesser Health Potion|1|self.hp.le.80.p",
		"Fierce Berserk|1|area.targets.ge.2",
		"Berserk|1|area.targets.ge.2",
		"Groundshaker|1|area.targets.ge.3",
		"Whirlwind Throw|1|",
		"Brutal Strike|1|",
	},
}

-- --------------------------------------------------------------------------
-- Utilidades
-- --------------------------------------------------------------------------
local VOC_LETTER = { [1] = "S", [2] = "D", [3] = "P", [4] = "K" }

local function vocLetter(player)
	local voc = player:getVocation()
	return voc and VOC_LETTER[voc:getBaseId()] or nil
end

local function jsonStr(s)
	s = tostring(s):gsub('[%c"\\]', function(c)
		if c == '"' then
			return '\\"'
		elseif c == "\\" then
			return "\\\\"
		elseif c == "\n" then
			return "\\n"
		end
		return string.format("\\u%04x", c:byte())
	end)
	return '"' .. s .. '"'
end

local function isArray(t)
	local n = 0
	for k in pairs(t) do
		if type(k) ~= "number" then
			return false
		end
		n = n + 1
	end
	return n == #t
end

function I.json(v)
	local t = type(v)
	if t == "nil" then
		return "null"
	elseif t == "boolean" then
		return v and "true" or "false"
	elseif t == "number" then
		if v ~= v or v == math.huge or v == -math.huge then
			return "0"
		end
		if math.floor(v) == v then
			return string.format("%d", v)
		end
		return string.format("%.2f", v)
	elseif t == "string" then
		return jsonStr(v)
	elseif t == "table" then
		local parts = {}
		if next(v) == nil then
			return "[]"
		end
		if isArray(v) then
			for _, x in ipairs(v) do
				parts[#parts + 1] = I.json(x)
			end
			return "[" .. table.concat(parts, ",") .. "]"
		end
		for k, x in pairs(v) do
			parts[#parts + 1] = jsonStr(k) .. ":" .. I.json(x)
		end
		return "{" .. table.concat(parts, ",") .. "}"
	end
	return "null"
end

local function log(h, text)
	local l = h.log
	l[#l + 1] = os.date("%H:%M:%S") .. " " .. text
	if #l > I.LOG_MAX then
		table.remove(l, 1)
	end
end

-- "self.hp.le.75.p&area.targets.ge.2" -> lista de condicoes
local OPS = { lt = true, le = true, eq = true, ge = true, gt = true }
local SUBJ = { self = { hp = true, mana = true, shield = true }, target = { hp = true }, area = { targets = true } }
function I.parseConds(s)
	local conds = {}
	for part in string.gmatch(s or "", "[^&]+") do
		local subj, attr, op, val, pct = part:match("^(%a+)%.(%a+)%.(%a+)%.(%d+)%.?(p?)$")
		if subj and SUBJ[subj] and SUBJ[subj][attr] and OPS[op] and #conds < 8 then
			conds[#conds + 1] = { subj = subj, attr = attr, op = op, val = tonumber(val), pct = pct == "p" }
		end
	end
	return conds
end

-- "Nome|1|conds\nNome|0|conds" -> slots (no maximo 20)
function I.parseBar(text)
	local bar = {}
	for line in string.gmatch(text or "", "[^\n]+") do
		local name, on, conds = line:match("^([^|]+)|([01])|(.*)$")
		if name and I.ACTIONS[name] and #bar < 20 then
			bar[#bar + 1] = { action = I.ACTIONS[name], enabled = on == "1", conds = I.parseConds(conds), raw = line }
		end
	end
	return bar
end

local function compare(a, op, b)
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

-- --------------------------------------------------------------------------
-- Banco
-- --------------------------------------------------------------------------
function I.setupDatabase()
	db.query([[CREATE TABLE IF NOT EXISTS `idle_commands` (
		`id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
		`player_name` VARCHAR(255) NOT NULL,
		`cmd` VARCHAR(16) NOT NULL,
		`arg` VARCHAR(64) NOT NULL DEFAULT '',
		`created` INT UNSIGNED NOT NULL,
		PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
	db.query([[CREATE TABLE IF NOT EXISTS `idle_settings` (
		`player_id` INT NOT NULL,
		`hunt` VARCHAR(32) NOT NULL DEFAULT '',
		`pull` VARCHAR(16) NOT NULL DEFAULT 'ousado',
		`target` VARCHAR(16) NOT NULL DEFAULT 'perto',
		`distance` TINYINT NOT NULL DEFAULT 1,
		`stance` VARCHAR(16) NOT NULL DEFAULT 'equilibrado',
		`bar` TEXT NOT NULL,
		`seen` INT UNSIGNED NOT NULL DEFAULT 0,
		PRIMARY KEY (`player_id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
	db.query([[CREATE TABLE IF NOT EXISTS `idle_state` (
		`player_id` INT NOT NULL,
		`updated` INT UNSIGNED NOT NULL,
		`data` MEDIUMTEXT NOT NULL,
		PRIMARY KEY (`player_id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
	db.query([[CREATE TABLE IF NOT EXISTS `idle_catalog` (
		`name` VARCHAR(32) NOT NULL,
		`data` MEDIUMTEXT NOT NULL,
		PRIMARY KEY (`name`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
	db.query([[CREATE TABLE IF NOT EXISTS `idle_gear` (
		`player_id` INT NOT NULL,
		`updated` INT UNSIGNED NOT NULL,
		`data` MEDIUMTEXT NOT NULL,
		PRIMARY KEY (`player_id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
	db.query("ALTER TABLE `idle_settings` ADD COLUMN IF NOT EXISTS `ammo` INT NOT NULL DEFAULT 0")
	-- itens que o jogador NAO quer vender (o resto e vendido na Venda rapida / Despachar loot)
	db.query("ALTER TABLE `idle_settings` ADD COLUMN IF NOT EXISTS `keep` TEXT NULL")
	-- cacadas favoritas (estrela no catalogo)
	db.query("ALTER TABLE `idle_settings` ADD COLUMN IF NOT EXISTS `favs` TEXT NULL")
	-- recorde por cacada (como no Huntera: so caçadas de 5 min ou mais contam)
	db.query([[CREATE TABLE IF NOT EXISTS `idle_records` (
		`player_id` INT NOT NULL,
		`hunt` VARCHAR(64) NOT NULL,
		`xph` INT NOT NULL DEFAULT 0,
		`gph` INT NOT NULL DEFAULT 0,
		`kills` INT NOT NULL DEFAULT 0,
		`secs` INT NOT NULL DEFAULT 0,
		`updated` INT UNSIGNED NOT NULL,
		PRIMARY KEY (`player_id`, `hunt`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
	-- vender sozinho quando a mochila encher
	db.query("ALTER TABLE `idle_settings` ADD COLUMN IF NOT EXISTS `autosell` TINYINT NOT NULL DEFAULT 1")
	db.query([[CREATE TABLE IF NOT EXISTS `idle_bag` (
		`player_id` INT NOT NULL,
		`updated` INT UNSIGNED NOT NULL,
		`items` TEXT NOT NULL,
		`dispatch_at` INT UNSIGNED NOT NULL DEFAULT 0,
		`data` MEDIUMTEXT NOT NULL,
		PRIMARY KEY (`player_id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
end

local function monsterLook(name)
	local mt = MonsterType(name)
	local o = mt and mt:outfit()
	if not o or (o.lookType or 0) == 0 then
		return nil
	end
	return { t = o.lookType, h = o.lookHead or 0, b = o.lookBody or 0, l = o.lookLegs or 0, f = o.lookFeet or 0 }
end

function I.writeCatalog()
	local hunts = {}
	for _, h in ipairs(I.HUNTS) do
		local looks = {}
		for _, name in ipairs(h.monsters) do
			looks[#looks + 1] = monsterLook(name) or {}
		end
		hunts[#hunts + 1] = { id = h.id, name = h.name, min = h.min, max = h.max, monsters = h.monsters, looks = looks, lvl = h.lvl, xpKill = h.xpKill, lootKill = h.lootKill, xpPerHp = h.xpPerHp }
	end
	local actions = {}
	for _, a in pairs(I.ACTIONS) do
		actions[#actions + 1] = { name = a.name, words = a.words or "", kind = a.kind, voc = a.voc, lvl = a.lvl, mana = a.mana or 0, cost = a.cost or 0, cd = a.cd, group = a.group, area = a.area or "" }
	end
	table.sort(actions, function(a, b)
		return a.lvl < b.lvl or (a.lvl == b.lvl and a.name < b.name)
	end)
	local bars = {}
	for voc, lines in pairs(I.DEFAULT_BAR) do
		bars[voc] = table.concat(lines, "\n")
	end
	local solo = {}
	for _, m in ipairs(I.SOLO_LIST or {}) do
		solo[#solo + 1] = { name = m.name, class = m.class, min = m.min, lvl = m.lvl, xpKill = m.xpKill, lootKill = m.lootKill, xpPerHp = m.xpPerHp, look = monsterLook(m.name) }
	end
	local shop = {}
	for _, it in ipairs(I.SHOP_LIST or {}) do
		shop[#shop + 1] = it
	end
	local data = I.json({ hunts = hunts, solo = solo, shop = shop, actions = actions, defaultBars = bars, pulls = { "cauteloso", "ousado", "agressivo" }, maxUnwatchedHours = I.MAX_UNWATCHED / 3600 })
	db.query("REPLACE INTO `idle_catalog` (`name`, `data`) VALUES ('main', " .. db.escapeString(data) .. ")")
end

function I.loadSettings(player)
	local guid = player:getGuid()
	local s = { hunt = "", pull = "ousado", target = "perto", distance = 1, stance = "equilibrado", bar = nil, seen = 0, ammo = 0, autosell = true }
	local r = db.storeQuery("SELECT `hunt`, `pull`, `target`, `distance`, `stance`, `bar`, `seen`, `ammo`, `autosell` FROM `idle_settings` WHERE `player_id` = " .. guid)
	if r then
		s.hunt = Result.getString(r, "hunt")
		s.pull = Result.getString(r, "pull")
		s.target = Result.getString(r, "target")
		s.distance = Result.getNumber(r, "distance")
		s.stance = Result.getString(r, "stance")
		s.bar = Result.getString(r, "bar")
		s.seen = Result.getNumber(r, "seen")
		s.ammo = Result.getNumber(r, "ammo")
		s.autosell = Result.getNumber(r, "autosell") ~= 0
		Result.free(r)
	end
	if not s.bar or s.bar == "" then
		local letter = vocLetter(player) or "K"
		s.bar = table.concat(I.DEFAULT_BAR[letter], "\n")
		local distance = (letter == "K") and 1 or 3
		s.distance = r and s.distance or distance
		db.query(string.format("INSERT INTO `idle_settings` (`player_id`, `hunt`, `pull`, `target`, `distance`, `stance`, `bar`, `seen`) VALUES (%d, %s, %s, %s, %d, %s, %s, %d) ON DUPLICATE KEY UPDATE `bar` = VALUES(`bar`)", guid, db.escapeString(s.hunt), db.escapeString(s.pull), db.escapeString(s.target), s.distance, db.escapeString(s.stance), db.escapeString(s.bar), os.time()))
	end
	if not I.PULLS[s.pull] then
		s.pull = "ousado"
	end
	s.distance = math.max(1, math.min(4, s.distance or 1))
	return s
end

-- --------------------------------------------------------------------------
-- Salas
-- --------------------------------------------------------------------------
local groundId = nil

-- centro da sala/area; o andar e o andar real do recorte (as escadas levam para os andares vizinhos)
local function roomCenter(index, z)
	local col = (index - 1) % I.ROOM_COLS
	local row = math.floor((index - 1) / I.ROOM_COLS)
	local d = I.roomDims and I.roomDims[index]
	return Position(I.ROOM_BASE.x + col * I.ROOM_STEP, I.ROOM_BASE.y + row * I.ROOM_STEP, z or (d and d.z) or I.ROOM_BASE.z)
end

local function findGround()
	if groundId then
		return groundId
	end
	for _, town in ipairs(Game.getTowns()) do
		local tile = Tile(town:getTemplePosition())
		local ground = tile and tile:getGround()
		if ground then
			groundId = ground:getId()
			return groundId
		end
	end
	return nil
end

I.roomTemplate = I.roomTemplate or {} -- [indice] = id da sala/area montada ali
I.roomWalk = I.roomWalk or {} -- [indice] = tiles livres {dx, dy} do andar do meio
I.roomDims = I.roomDims or {} -- [indice] = {z, rx, ry, rz}
I.roomStairs = I.roomStairs or {} -- [indice] = escadas {dx, dy, dz}
I.RESPAWN = 20 -- segundos para um monstro da area renascer

local function isFree(pos)
	local t = Tile(pos)
	if not t or not t:getGround() then
		return false
	end
	return not (t:hasFlag(TILESTATE_BLOCKSOLID) or t:hasFlag(TILESTATE_FLOORCHANGE) or t:hasFlag(TILESTATE_TELEPORT) or t:hasFlag(TILESTATE_MAGICFIELD))
end

local function clearArea(index)
	local d = I.roomDims[index]
	if not d then
		return
	end
	local c = roomCenter(index, d.z)
	for dz = -d.rz, d.rz do
		for dx = -d.rx - 1, d.rx + 1 do
			for dy = -d.ry - 1, d.ry + 1 do
				local tile = Tile(Position(c.x + dx, c.y + dy, c.z + dz))
				if tile then
					local items = tile:getItems() or {}
					for i = #items, 1, -1 do
						items[i]:remove()
					end
					local g = tile:getGround()
					if g then
						g:remove()
					end
				end
			end
		end
	end
	I.roomDims[index] = nil
end

-- sala lisa (quando a cacada nao tem recorte do mapa)
local function buildFlat(index)
	local gid = findGround()
	if not gid then
		return false
	end
	I.roomDims[index] = { z = I.ROOM_BASE.z, rx = I.ROOM_RADIUS, ry = I.ROOM_RADIUS, rz = 0 }
	local c = roomCenter(index)
	for dx = -I.ROOM_RADIUS, I.ROOM_RADIUS do
		for dy = -I.ROOM_RADIUS, I.ROOM_RADIUS do
			local pos = Position(c.x + dx, c.y + dy, c.z)
			if not Tile(pos) then
				Game.createTile(pos)
			end
			Game.createItem(gid, 1, pos)
		end
	end
	return true
end

local function buildRoom(index, rid)
	local key = rid or "#lisa"
	if I.roomTemplate[index] == key then
		return true
	end
	clearArea(index)
	local tpl = rid and IdleRooms and IdleRooms[rid]
	if tpl then
		I.roomDims[index] = { z = tpl.z, rx = math.floor(tpl.w / 2), ry = math.floor(tpl.h / 2), rz = math.floor((tpl.floors or 1) / 2) }
		local c = roomCenter(index)
		for _, t in ipairs(tpl.tiles) do
			local pos = Position(c.x + t[1], c.y + t[2], c.z + t[3])
			if not Tile(pos) then
				Game.createTile(pos)
			end
			for k = 4, #t do
				Game.createItem(t[k], 1, pos)
			end
		end
	elseif not buildFlat(index) then
		return false
	end
	local d = I.roomDims[index]
	local c = roomCenter(index)
	local walk, stairs = {}, {}
	for dz = -d.rz, d.rz do
		for dx = -d.rx, d.rx do
			for dy = -d.ry, d.ry do
				local pos = Position(c.x + dx, c.y + dy, c.z + dz)
				if dz == 0 and isFree(pos) then
					walk[#walk + 1] = { dx, dy }
				end
				local tile = Tile(pos)
				if tile and tile:hasFlag(TILESTATE_FLOORCHANGE) then
					stairs[#stairs + 1] = { dx, dy, dz }
				end
			end
		end
	end
	if #walk < 6 then -- recorte ruim: cai para a sala lisa
		clearArea(index)
		buildFlat(index)
		walk, stairs = {}, {}
		for dx = -I.ROOM_RADIUS, I.ROOM_RADIUS do
			for dy = -I.ROOM_RADIUS, I.ROOM_RADIUS do
				walk[#walk + 1] = { dx, dy }
			end
		end
		key = "#lisa"
	end
	table.sort(walk, function(a, b)
		return (a[1] * a[1] + a[2] * a[2]) < (b[1] * b[1] + b[2] * b[2])
	end)
	I.roomWalk[index] = walk
	I.roomStairs[index] = stairs
	I.roomTemplate[index] = key
	return true
end

local function takeRoom(guid, rid)
	for i = 1, I.ROOM_COLS * 40 do
		if not I.rooms[i] or I.rooms[i] == guid then
			if buildRoom(i, rid) then
				I.rooms[i] = guid
				return i
			end
			return nil
		end
	end
	return nil
end

-- tile livre mais perto do centro (o personagem comeca ali)
local function startPos(index)
	local c = roomCenter(index)
	local w = I.roomWalk[index] and I.roomWalk[index][1]
	return w and Position(c.x + w[1], c.y + w[2], c.z) or c
end

-- --------------------------------------------------------------------------
-- Cacada
-- --------------------------------------------------------------------------
local function combatStats(player)
	local letter = vocLetter(player)
	local skill, atk = 10, 7
	if letter == "P" then
		skill = player:getEffectiveSkillLevel(SKILL_DISTANCE)
	elseif letter == "K" then
		skill = math.max(player:getEffectiveSkillLevel(SKILL_SWORD), player:getEffectiveSkillLevel(SKILL_AXE), player:getEffectiveSkillLevel(SKILL_CLUB))
	end
	for _, slot in ipairs({ CONST_SLOT_LEFT, CONST_SLOT_RIGHT }) do
		local item = player:getSlotItem(slot)
		if item then
			local a = ItemType(item:getId()):getAttack()
			if a and a > atk then
				atk = a
			end
		end
	end
	return { level = player:getLevel(), ml = player:getMagicLevel(), skill = skill, atk = atk }
end

local function aliveMonsters(h)
	local list = {}
	for id in pairs(h.monsters) do
		local m = Monster(id)
		if m and m:getHealth() > 0 then
			list[#list + 1] = m
		elseif not m then
			-- sumiu sem passar pelo evento de morte; o que esta morrendo (vida 0) fica ate o onDeath (abate e loot)
			h.monsters[id] = nil
		end
	end
	return list
end

local function spawnPull(h, player)
	local hunt = I.getHunt(h.hunt)
	local range = I.PULLS[h.settings.pull] or I.PULLS.ousado
	local amount = math.random(range[1], range[2])
	local c = roomCenter(h.room)
	for _ = 1, amount do
		local name = hunt.monsters[math.random(#hunt.monsters)]
		local walk = I.roomWalk[h.room] or {}
		for _ = 1, 8 do
			local w = walk[math.random(math.max(1, #walk))] or { math.random(-I.ROOM_RADIUS, I.ROOM_RADIUS), math.random(-I.ROOM_RADIUS, I.ROOM_RADIUS) }
			local pos = Position(c.x + w[1], c.y + w[2], c.z)
			if pos:getDistance(player:getPosition()) >= 2 then
				local m = Game.createMonster(name, pos, false, true)
				if m then
					h.monsters[m:getId()] = true
					I.owner[m:getId()] = h.guid
					m:registerEvent("IdleMonsterDeath")
					m:registerEvent("IdleMonsterHealth")
					m:setTarget(player)
				end
				break
			end
		end
	end
	h.pulls = h.pulls + 1
end

-- --------------------------------------------------------------------------
-- Area com spawns reais: os monstros ficam onde ficam no Tibia e renascem
-- --------------------------------------------------------------------------
local AROUND = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 }, { 1, 1 }, { -1, -1 }, { 1, -1 }, { -1, 1 } }

local function spawnAt(h, name, pos)
	local m = Game.createMonster(name, pos, false, false)
	if not m then
		for _, d in ipairs(AROUND) do
			m = Game.createMonster(name, Position(pos.x + d[1], pos.y + d[2], pos.z), false, false)
			if m then
				break
			end
		end
	end
	if m then
		h.monsters[m:getId()] = true
		I.owner[m:getId()] = h.guid
		m:registerEvent("IdleMonsterDeath")
		m:registerEvent("IdleMonsterHealth")
	end
	return m
end

local function populate(h)
	local tpl = IdleRooms and IdleRooms[I.roomTemplate[h.room]]
	h.spawnPts = {}
	if not tpl or not tpl.spawns then
		return
	end
	local c = roomCenter(h.room)
	local wake = I.PULL_WAKE[h.settings.pull] or 0.75
	for i, sp in ipairs(tpl.spawns) do
		-- escolha espalhada e sempre igual para o mesmo pull (razao aurea)
		if MonsterType(sp[4]) and (i * 0.6180339887) % 1 < wake then
			local pos = Position(c.x + sp[1], c.y + sp[2], c.z + sp[3])
			local m = spawnAt(h, sp[4], pos)
			h.spawnPts[#h.spawnPts + 1] = { pos = pos, name = sp[4], mid = m and m:getId() or nil, deadAt = (not m) and os.time() or nil }
		end
	end
end

local function respawn(h, player)
	local pp = player:getPosition()
	local t = os.time()
	for _, pt in ipairs(h.spawnPts or {}) do
		local alive = pt.mid and Monster(pt.mid)
		if not alive then
			pt.deadAt = pt.deadAt or t
			pt.mid = nil
			-- como no Tibia: nao nasce na cara do jogador
			if t - pt.deadAt >= I.RESPAWN and (pt.pos.z ~= pp.z or pt.pos:getDistance(pp) >= 5) then
				local m = spawnAt(h, pt.name, pt.pos)
				pt.mid = m and m:getId() or nil
				pt.deadAt = (not m) and t or nil
			end
		end
	end
end

-- --------------------------------------------------------------------------
-- O personagem caca como no Huntera: percorre a rota pelos spawns da area,
-- ataca o que cruzar o caminho, junta o pull, para para lutar (mantendo a
-- distancia e recuando), troca de andar pelas escadas e comeca outra volta
-- --------------------------------------------------------------------------
local DIRS = { [0] = { 0, -1 }, [1] = { 1, 0 }, [2] = { 0, 1 }, [3] = { -1, 0 }, [4] = { -1, 1 }, [5] = { 1, 1 }, [6] = { -1, -1 }, [7] = { 1, -1 } }

local function dirTo(from, to)
	local dx = to.x > from.x and 1 or (to.x < from.x and -1 or 0)
	local dy = to.y > from.y and 1 or (to.y < from.y and -1 or 0)
	for d, v in pairs(DIRS) do
		if v[1] == dx and v[2] == dy then
			return d
		end
	end
	return nil
end

local function isAttackingMe(m, player)
	local tg = m:getTarget()
	return tg and tg:getId() == player:getId()
end

local function planPath(player, dest, maxDist)
	local path = player:getPathTo(dest, 0, maxDist, true, true, 40)
	if type(path) == "table" and #path > 0 then
		return path
	end
	return nil
end

-- pontos da rota: um por grupo de spawn (spawns a ate 4 sqm entram no mesmo ponto)
local function buildRoute(h)
	h.route, h.lap = {}, 1
	for _, pt in ipairs(h.spawnPts or {}) do
		local near = false
		for _, w in ipairs(h.route) do
			if w.pos.z == pt.pos.z and w.pos:getDistance(pt.pos) <= 4 then
				near = true
				break
			end
		end
		if not near then
			h.route[#h.route + 1] = { pos = pt.pos, lap = 0 }
		end
	end
end

-- proximo ponto da rota neste andar; "escada" quando o que falta esta em outro andar
local function nextWaypoint(h, pp)
	for _ = 1, 2 do
		local best, bd, other = nil, nil, false
		for _, w in ipairs(h.route or {}) do
			if w.lap < h.lap and not (w.badUntil and w.badUntil > os.time()) then
				if w.pos.z == pp.z then
					local d = pp:getDistance(w.pos)
					if not bd or d < bd then
						best, bd = w, d
					end
				else
					other = true
				end
			end
		end
		if best then
			return best
		end
		if other then
			return "escada"
		end
		-- volta completa: comeca a proxima
		h.lap = h.lap + 1
		h.laps = (h.laps or 0) + 1
	end
	return nil
end

local function pickStairs(h, pp)
	local c = roomCenter(h.room)
	local best, bd, bkey = nil, nil, nil
	h.badStairs = h.badStairs or {}
	for _, s in ipairs(I.roomStairs[h.room] or {}) do
		local sp = Position(c.x + s[1], c.y + s[2], c.z + s[3])
		local key = s[1] .. ":" .. s[2] .. ":" .. s[3]
		if sp.z == pp.z and (h.badStairs[key] or 0) < os.time() then
			local d = pp:getDistance(sp)
			if not bd or d < bd then
				best, bd, bkey = sp, d, key
			end
		end
	end
	return best, bkey
end

-- tile livre e sem criatura
local function standable(pos)
	local t = Tile(pos)
	return t and isFree(pos) and not t:getTopCreature()
end

-- recuar: o passo que mais afasta dos monstros que estao batendo
local function stepAway(player, engaged)
	local pp = player:getPosition()
	local best, bs = nil, nil
	for d, v in pairs(DIRS) do
		local np = Position(pp.x + v[1], pp.y + v[2], pp.z)
		if standable(np) then
			local score = 99
			for _, m in ipairs(engaged) do
				score = math.min(score, np:getDistance(m:getPosition()))
			end
			if not bs or score > bs then
				best, bs = d, score
			end
		end
	end
	return best
end

-- escada de mao, buraco de corda, bueiro: nao se entra andando; faz o "use" (sobe ou desce um andar)
local function useStairs(h, player, sp)
	local d = I.roomDims[h.room]
	local c = roomCenter(h.room)
	for _, dz in ipairs({ -1, 1 }) do
		local z = sp.z + dz
		if d and math.abs(z - c.z) <= d.rz then
			local tries = { Position(sp.x, sp.y + 1, z), Position(sp.x, sp.y, z) }
			for _, v in pairs(DIRS) do
				tries[#tries + 1] = Position(sp.x + v[1], sp.y + v[2], z)
			end
			for _, pos in ipairs(tries) do
				if standable(pos) then
					player:teleportTo(pos)
					return true
				end
			end
		end
	end
	return false
end

-- escolhe para onde andar neste segundo (h.path) e o que o personagem esta fazendo
local function hunterMove(h, player, list, target)
	local pp = player:getPosition()
	local engaged = {}
	for _, m in ipairs(list) do
		local mp = m:getPosition()
		if mp.z == pp.z and isAttackingMe(m, player) and pp:getDistance(mp) <= 8 then
			engaged[#engaged + 1] = m
		end
	end
	local range = I.PULLS[h.settings.pull] or I.PULLS.ousado
	local hpPct = player:getHealth() * 100 / math.max(1, player:getMaxHealth())
	local dist = math.max(1, h.settings.distance or 1)
	h.path, h.stairGoal = nil, nil

	-- 1) lutar: juntou o pull, a vida baixou ou o alvo esta perto; mantem a distancia e recua
	local fight = target and target:getPosition().z == pp.z and (#engaged >= range[2] or hpPct < 70 or (#engaged > 0 and not h.route))
	if fight then
		local td = pp:getDistance(target:getPosition())
		if dist >= 2 then
			local close = false
			for _, m in ipairs(engaged) do
				if pp:getDistance(m:getPosition()) <= 1 then
					close = true
					break
				end
			end
			if close then
				local d = stepAway(player, engaged)
				if d then
					h.path = { d }
					h.moving = "recuando"
					return
				end
			end
		end
		if td > dist then
			h.path = planPath(player, target:getPosition(), dist)
			if not h.path and #engaged == 0 then
				h.lostTarget = target:getId() -- sem caminho ate ele: solta e segue a rota
			end
		end
		h.moving = "lutando"
		return
	end

	-- 2) andar a rota (atacando o que cruzar o caminho; os monstros vem atras = pull)
	local w = nextWaypoint(h, pp)
	if w == "escada" then
		local sp, key = pickStairs(h, pp)
		if sp then
			h.stairGoal = { pos = sp, key = key }
			if pp:getDistance(sp) > 1 then
				h.path = planPath(player, sp, 1)
			end
			h.moving = "trocando de andar"
			if h.path or pp:getDistance(sp) <= 1 then
				return
			end
			h.badStairs[key] = os.time() + 60 -- sem caminho ate ela
		end
		-- sem escada que sirva: da a volta de novo neste andar
		for _, r in ipairs(h.route or {}) do
			if r.pos.z ~= pp.z then
				r.lap = h.lap
			end
		end
		return
	elseif w then
		if pp:getDistance(w.pos) <= 2 then
			w.lap = h.lap
			return
		end
		h.path = planPath(player, w.pos, 2)
		if not h.path then
			w.badUntil = os.time() + 60 -- ponto sem caminho agora: tenta os outros
			w.lap = h.lap
			return
		end
		h.moving = #engaged > 0 and "puxando" or "andando"
		return
	end

	-- 3) sem rota (sala de um andar): vai ate o alvo
	if target and target:getPosition().z == pp.z and pp:getDistance(target:getPosition()) > dist then
		h.path = planPath(player, target:getPosition(), dist)
		h.moving = "lutando"
	end
end

-- passos: a cada 100 ms, anda um passo no ritmo da velocidade do personagem e manda o estado para a pagina
function I.walkTick()
	local t = now()
	for guid, h in pairs(I.hunters) do
		local p = Player(h.name)
		if p then
			if t >= (h.stepAt or 0) then
				local dir, toStairs = nil, false
				if h.path and #h.path > 0 then
					dir = table.remove(h.path, 1)
				elseif h.stairGoal and p:getPosition():getDistance(h.stairGoal.pos) <= 1 then
					dir = dirTo(p:getPosition(), h.stairGoal.pos)
					toStairs = true
				end
				if dir then
					local before = p:getPosition()
					local ret = p:move(dir)
					h.stepAt = t + math.max(200, math.min(900, math.floor(150000 / math.max(1, p:getSpeed()))))
					if ret ~= RETURNVALUE_NOERROR then
						h.path = nil
					end
					if toStairs then
						local g = h.stairGoal
						h.stairGoal = nil
						local after = p:getPosition()
						local d = I.roomDims[h.room]
						local c = roomCenter(h.room)
						if after.z == before.z then
							-- escada de mao / corda / bueiro: faz o "use"
							if not useStairs(h, p, g.pos) then
								h.badStairs[g.key] = os.time() + 120
							end
						elseif d and math.abs(after.z - c.z) > d.rz then
							-- levou para fora da area: volta e esquece esta escada
							p:teleportTo(before)
							h.badStairs[g.key] = os.time() + 3600
						end
					end
				end
			end
			if t - (h.lastState or 0) >= I.STATE_EVERY then
				h.lastState = t
				local ok, err = pcall(function()
					I.writeState(guid, I.snapshot(h, p, I.alive(h), h.targetId and Monster(h.targetId) or nil))
				end)
				if not ok then
					logger.error("[Idle] estado de {}: {}", h.name, tostring(err))
				end
				h.fx = {}
			end
		end
	end
end

I.alive = function(h)
	return aliveMonsters(h)
end

local function pickTarget(h, player, list)
	local mode = h.settings.target
	local ppos = player:getPosition()
	local best, bestScore = nil, nil
	for _, m in ipairs(list) do
		local score
		if mode == "fraco" then
			score = m:getHealth()
		elseif mode == "forte" then
			score = -m:getHealth()
		elseif mode == "fracopct" then
			score = m:getHealth() / math.max(1, m:getMaxHealth())
		elseif mode == "fortepct" then
			score = -m:getHealth() / math.max(1, m:getMaxHealth())
		else
			score = ppos:getDistance(m:getPosition())
		end
		if not bestScore or score < bestScore then
			best, bestScore = m, score
		end
	end
	return best
end

local function inRange(player, list, range)
	local ppos = player:getPosition()
	local out = {}
	for _, m in ipairs(list) do
		local d = ppos:getDistance(m:getPosition())
		if d <= range then
			out[#out + 1] = { m = m, d = d }
		end
	end
	table.sort(out, function(a, b)
		return a.d < b.d
	end)
	return out
end

local function areaTargets(action, player, list)
	local range = action.range or 3
	local hits = inRange(player, list, range)
	local cap = (action.area == "beam" and 3) or (action.area == "wave" and 4) or #hits
	local res = {}
	for i = 1, math.min(cap, #hits) do
		res[i] = hits[i].m
	end
	return res
end

local function condsOk(slot, player, target, list)
	for _, c in ipairs(slot.conds) do
		local value
		if c.subj == "self" then
			if c.attr == "hp" then
				value = c.pct and (player:getHealth() * 100 / math.max(1, player:getMaxHealth())) or player:getHealth()
			elseif c.attr == "mana" then
				value = c.pct and (player:getMana() * 100 / math.max(1, player:getMaxMana())) or player:getMana()
			elseif c.attr == "shield" then
				value = player:getCondition(CONDITION_MANASHIELD) and 1 or 0
			end
		elseif c.subj == "target" then
			if not target then
				return false
			end
			value = c.pct and (target:getHealth() * 100 / math.max(1, target:getMaxHealth())) or target:getHealth()
		elseif c.subj == "area" then
			value = #areaTargets(slot.action.kind == "area" and slot.action or { range = 2 }, player, list)
		end
		if value == nil or not compare(value, c.op, c.val) then
			return false
		end
	end
	return true
end

local payGold

function I.payGold(player, amount)
	return payGold(player, amount)
end

payGold = function(player, amount)
	if amount <= 0 then
		return true
	end
	local bank = player:getBankBalance()
	if bank < amount then
		return false
	end
	player:setBankBalance(bank - amount)
	return true
end

-- tenta usar a acao; devolve true se disparou
local function fire(h, player, slot, target, list, stats)
	local a = slot.action
	local t = now()
	if (h.cd[a.name] or 0) > t or (h.gcd[a.group] or 0) > t then
		return false
	end
	local letter = vocLetter(player)
	if not letter or not a.voc:find(letter, 1, true) or player:getLevel() < a.lvl then
		return false
	end
	if (a.mana or 0) > player:getMana() then
		return false
	end
	if not condsOk(slot, player, target, list) then
		return false
	end

	local k = a.kind
	if a.real and k ~= "potion" then
		local pp = player:getPosition()
		local var
		if k == "attack" then
			if not target or pp:getDistance(target:getPosition()) > math.max(a.range or 0, 7) then
				return false
			end
			var = Variant(target:getId())
		elseif k == "area" then
			local targets = areaTargets(a, player, list)
			if #targets == 0 then
				return false
			end
			if a.needDirection then
				-- onda/raio: vira para o alvo (so N, L, S, O) e lanca na frente
				local tp = (target and target:getPosition().z == pp.z and target or targets[1]):getPosition()
				local dx, dy = tp.x - pp.x, tp.y - pp.y
				local dir = math.abs(dx) >= math.abs(dy) and (dx >= 0 and DIRECTION_EAST or DIRECTION_WEST) or (dy >= 0 and DIRECTION_SOUTH or DIRECTION_NORTH)
				player:setDirection(dir)
				local front = Position(pp.x, pp.y, pp.z)
				front:getNextPosition(dir)
				var = Variant(front)
			else
				var = Variant(pp)
			end
		elseif k == "shield" then
			if player:getCondition(CONDITION_MANASHIELD) then
				return false
			end
			var = Variant(player:getId())
		elseif k == "haste" then
			if player:getCondition(CONDITION_HASTE) then
				return false
			end
			var = Variant(player:getId())
		else
			var = Variant(player:getId())
		end
		local ok, res = pcall(a.real, player, var)
		if not ok then
			logger.warn("[Idle] magia {}: {}", a.name, tostring(res))
			return false
		end
		if res == false then
			return false
		end
	elseif k == "potion" then
		if not payGold(player, a.cost) then
			h.noGold = true
			return false
		end
		h.supplies = h.supplies + a.cost
		if a.hp then
			doTargetCombatHealth(0, player, COMBAT_HEALING, a.hp[1], a.hp[2], CONST_ME_MAGIC_BLUE)
		end
		if a.mp then
			player:addMana(math.random(a.mp[1], a.mp[2]))
			player:getPosition():sendMagicEffect(CONST_ME_MAGIC_BLUE)
		end
	elseif k == "heal" then
		local mn, mx = math.floor(a.min(stats)), math.floor(a.max(stats))
		doTargetCombatHealth(player, player, COMBAT_HEALING, mn, mx, CONST_ME_MAGIC_BLUE)
	elseif k == "attack" then
		-- a sala tem 15x11: o alvo fica a no maximo 14 sqm
		if not target or player:getPosition():getDistance(target:getPosition()) > 14 then
			return false
		end
		local mn, mx = math.floor(a.min(stats)), math.floor(a.max(stats))
		doTargetCombatHealth(player, target, a.elem, -mn, -mx, a.fx or CONST_ME_HITAREA)
	elseif k == "area" then
		local targets = areaTargets(a, player, list)
		if #targets == 0 then
			return false
		end
		local mn, mx = math.floor(a.min(stats)), math.floor(a.max(stats))
		for _, m in ipairs(targets) do
			doTargetCombatHealth(player, m, a.elem, -mn, -mx, a.fx or CONST_ME_HITAREA)
		end
	elseif k == "shield" then
		if player:getCondition(CONDITION_MANASHIELD) then
			return false
		end
		local cond = Condition(CONDITION_MANASHIELD)
		cond:setParameter(CONDITION_PARAM_TICKS, 180000)
		cond:setParameter(CONDITION_PARAM_MANASHIELD, math.min(player:getMaxMana(), 300 + 7.6 * player:getLevel() + 7 * player:getMagicLevel()))
		player:addCondition(cond)
		player:getPosition():sendMagicEffect(CONST_ME_MAGIC_BLUE)
	elseif k == "haste" then
		if player:getCondition(CONDITION_HASTE) then
			return false
		end
		local cond = Condition(CONDITION_HASTE)
		cond:setParameter(CONDITION_PARAM_TICKS, 33000)
		pcall(function()
			cond:setFormula(a.speed, -24, a.speed, -24)
		end)
		player:addCondition(cond)
		player:getPosition():sendMagicEffect(CONST_ME_MAGIC_GREEN)
	else
		return false
	end

	if (a.mana or 0) > 0 then
		player:addMana(-a.mana)
		player:addManaSpent(a.mana)
	end
	h.cd[a.name] = t + a.cd
	h.gcd[a.group] = t + (a.gcdMs or I.GROUP_CD[a.group] or 1000)
	h.casts = h.casts + 1
	I.fx(h, { k = "cast", n = a.name, kind = a.kind, e = I.ELEM[a.elem or 0] or (a.kind == "heal" and "heal" or nil), to = target and target:getId() or nil })
	return true
end


-- --------------------------------------------------------------------------
-- Visao da cacada: posicoes, outfits e eventos (dano, cura, magia) por segundo
-- --------------------------------------------------------------------------
local ELEM = {
	[COMBAT_PHYSICALDAMAGE] = "phys", [COMBAT_FIREDAMAGE] = "fire", [COMBAT_ENERGYDAMAGE] = "energy", [COMBAT_EARTHDAMAGE] = "earth",
	[COMBAT_ICEDAMAGE] = "ice", [COMBAT_HOLYDAMAGE] = "holy", [COMBAT_DEATHDAMAGE] = "death", [COMBAT_HEALING] = "heal",
	[COMBAT_LIFEDRAIN] = "drain", [COMBAT_MANADRAIN] = "mana", [COMBAT_DROWNDAMAGE] = "drown",
}
I.ELEM = ELEM

function I.look(creature)
	local o = creature:getOutfit()
	if not o then
		return nil
	end
	return { t = o.lookType, ex = o.lookTypeEx, h = o.lookHead, b = o.lookBody, l = o.lookLegs, f = o.lookFeet, a = o.lookAddons }
end

function I.fx(h, ev)
	h.fx = h.fx or {}
	if #h.fx < 60 then
		ev.ms = os.mtime and (os.mtime() % 100000) or 0
		h.fx[#h.fx + 1] = ev
	end
end

local function snapshot(h, player, list, target)
	local elapsed = math.max(1, os.time() - h.startTime)
	local xp = math.max(0, player:getExperience() - h.startExp)
	local center = roomCenter(h.room)
	local pp = player:getPosition()
	local monsters = {}
	for _, m in ipairs(list) do
		local mp = m:getPosition()
		-- so o que o personagem enxerga (mesmo andar, perto): o resto nao vai para a pagina
		if mp.z == pp.z and math.abs(mp.x - pp.x) <= 10 and math.abs(mp.y - pp.y) <= 8 then
			monsters[#monsters + 1] = { id = m:getId(), name = m:getName(), hp = m:getHealth(), max = m:getMaxHealth(), dist = pp:getDistance(mp), target = (target and m:getId() == target:getId()) or false,
				x = mp.x - center.x, y = mp.y - center.y, z = mp.z - center.z, dir = m:getDirection(), look = I.look(m) }
		end
	end
	local hunt = I.getHunt(h.hunt)
	return {
		hunting = true,
		hunt = h.hunt,
		huntName = hunt and hunt.name or h.hunt,
		since = h.startTime,
		elapsed = elapsed,
		level = player:getLevel(),
		exp = player:getExperience(),
		hp = player:getHealth(),
		maxHp = player:getMaxHealth(),
		mana = player:getMana(),
		maxMana = player:getMaxMana(),
		stamina = player:getStamina(),
		bank = player:getBankBalance(),
		xp = xp,
		xpHour = math.floor(xp * 3600 / elapsed),
		loot = h.loot,
		supplies = h.supplies,
		profit = h.loot - h.supplies,
		profitHour = math.floor((h.loot - h.supplies) * 3600 / elapsed),
		kills = h.kills,
		killCount = h.killCount,
		monsters = monsters,
		me = { x = pp.x - center.x, y = pp.y - center.y, z = pp.z - center.z, dir = player:getDirection(), look = I.look(player), doing = h.moving },
		alive = #list,
		fx = h.fx or {},
		ground = groundId,
		room = I.roomTemplate[h.room],
		log = h.log,
		lastLoot = h.lastLoot,
		noGold = h.noGold or false,
		settings = { pull = h.settings.pull, target = h.settings.target, distance = h.settings.distance, stance = h.settings.stance },
	}
end

-- --------------------------------------------------------------------------
-- Loja de equipamentos (idle_shop.lua, gerado por tools/loja.py)
-- --------------------------------------------------------------------------
I.SHOP = I.SHOP or {}
I.SHOP_LIST = I.SHOP_LIST or {}
local KIND_SLOT = { capacete = CONST_SLOT_HEAD, armadura = CONST_SLOT_ARMOR, calcas = CONST_SLOT_LEGS, botas = CONST_SLOT_FEET }
local HANDS = { CONST_SLOT_LEFT, CONST_SLOT_RIGHT }
local GEAR_SLOTS = {
	{ "capacete", CONST_SLOT_HEAD },
	{ "amuleto", CONST_SLOT_NECKLACE },
	{ "armadura", CONST_SLOT_ARMOR },
	{ "calcas", CONST_SLOT_LEGS },
	{ "botas", CONST_SLOT_FEET },
	{ "mao1", CONST_SLOT_LEFT },
	{ "mao2", CONST_SLOT_RIGHT },
	{ "anel", CONST_SLOT_RING },
	{ "municao", CONST_SLOT_AMMO },
}
local STACK_KEEP = 100 -- municao / arma de arremesso: repor ate 100
local STACK_REFILL = 25 -- quando cair abaixo disso

function I.setShop(list)
	I.SHOP, I.SHOP_LIST = {}, {}
	for _, it in ipairs(list) do
		if ItemType(it.id):getId() ~= 0 then
			I.SHOP[it.id] = it
			I.SHOP_LIST[#I.SHOP_LIST + 1] = it
		end
	end
end

local function weaponType(id)
	return ItemType(id):getWeaponType()
end

local function isTwoHanded(id)
	return bit.band(ItemType(id):getSlotPosition(), SLOTP_TWO_HAND) ~= 0
end

local function isWeapon(id)
	local wt = weaponType(id)
	return wt ~= WEAPON_NONE and wt ~= WEAPON_SHIELD and wt ~= WEAPON_AMMO
end

-- vende de volta pelo preco de NPC e tira do corpo
local function sellBack(player, item)
	local price = ((IdlePrices and IdlePrices[item:getId()]) or 0) * math.max(1, item:getCount())
	if price > 0 then
		player:setBankBalance(player:getBankBalance() + price)
	end
	item:remove()
	return price
end

function I.writeGear(player, msg)
	local slots = {}
	for _, pair in ipairs(GEAR_SLOTS) do
		local item = player:getSlotItem(pair[2])
		if item then
			local t = ItemType(item:getId())
			slots[pair[1]] = { id = item:getId(), name = item:getName(), count = item:getCount(), attack = t:getAttack(), defense = t:getDefense(), armor = t:getArmor() }
		end
	end
	local data = { slots = slots, bank = player:getBankBalance(), level = player:getLevel(), msg = msg }
	db.asyncQuery(string.format("REPLACE INTO `idle_gear` (`player_id`, `updated`, `data`) VALUES (%d, %d, %s)", player:getGuid(), os.time(), db.escapeString(I.json(data))))
end

function I.buy(player, id)
	local it = I.SHOP[id]
	if not it then
		return false, "Esse item não está à venda."
	end
	local letter = vocLetter(player)
	if not letter or not it.voc:find(letter, 1, true) then
		return false, "Esse item não é para a sua vocação."
	end
	if player:getLevel() < it.level then
		return false, "Precisa do level " .. it.level .. "."
	end
	local qty = (it.kind == "municao" or it.stack) and STACK_KEEP or 1
	local cost = it.price * qty
	if player:getBankBalance() < cost then
		return false, "Gold insuficiente: custa " .. cost .. " gp."
	end

	local slot, sold = nil, 0
	if it.kind == "arma" or it.kind == "varinha" then
		for _, s in ipairs(HANDS) do
			local cur = player:getSlotItem(s)
			if cur and (isWeapon(cur:getId()) or (it.two and weaponType(cur:getId()) == WEAPON_SHIELD)) then
				sold = sold + sellBack(player, cur)
			end
		end
		for _, s in ipairs(HANDS) do
			if not player:getSlotItem(s) then
				slot = s
				break
			end
		end
	elseif it.kind == "escudo" then
		for _, s in ipairs(HANDS) do
			local cur = player:getSlotItem(s)
			if cur and isWeapon(cur:getId()) and isTwoHanded(cur:getId()) then
				return false, "Sua arma usa as duas mãos: não dá para usar escudo com ela."
			end
		end
		for _, s in ipairs(HANDS) do
			local cur = player:getSlotItem(s)
			if cur and weaponType(cur:getId()) == WEAPON_SHIELD then
				sold = sold + sellBack(player, cur)
			end
		end
		for _, s in ipairs({ CONST_SLOT_RIGHT, CONST_SLOT_LEFT }) do
			if not player:getSlotItem(s) then
				slot = s
				break
			end
		end
	elseif it.kind == "municao" then
		local cur = player:getSlotItem(CONST_SLOT_AMMO)
		if cur then
			sold = sold + sellBack(player, cur)
		end
		slot = CONST_SLOT_AMMO
		db.query(string.format("UPDATE `idle_settings` SET `ammo` = %d WHERE `player_id` = %d", id, player:getGuid()))
		local h = I.hunters[player:getGuid()]
		if h then
			h.settings.ammo = id
		end
	else
		slot = KIND_SLOT[it.kind]
		local cur = slot and player:getSlotItem(slot)
		if cur then
			sold = sold + sellBack(player, cur)
		end
	end
	if not slot then
		return false, "Não há onde equipar."
	end

	player:setBankBalance(player:getBankBalance() - cost)
	local item = player:addItem(id, qty, false, 1, slot)
	if not item then
		player:setBankBalance(player:getBankBalance() + cost)
		return false, "Não deu para equipar (capacidade?)."
	end
	return true, "Comprou " .. it.name .. " por " .. cost .. " gp" .. (sold > 0 and (" (o anterior foi vendido por " .. sold .. " gp)") or "") .. "."
end

-- municao e armas de arremesso: repoe durante a cacada, cobrando em gold (como no Huntera)
function I.refill(h, player)
	for _, s in ipairs(HANDS) do
		local w = player:getSlotItem(s)
		local it = w and I.SHOP[w:getId()]
		if it and it.stack and w:getCount() < STACK_REFILL then
			local add = STACK_KEEP - w:getCount()
			if I.payGold(player, add * it.price) then
				w:transform(w:getId(), STACK_KEEP)
				h.supplies = h.supplies + add * it.price
			else
				h.noGold = true
			end
		end
		if it and it.ammo and not it.stack then
			local want = I.SHOP[(h.settings and h.settings.ammo) or 0]
			if not want or want.ammo ~= it.ammo or want.level > player:getLevel() then
				-- a municao mais barata que serve no arco/besta
				want = nil
				for _, x in ipairs(I.SHOP_LIST) do
					if x.kind == "municao" and x.ammo == it.ammo and x.level <= player:getLevel() and (not want or x.price < want.price) then
						want = x
					end
				end
			end
			if want then
				local ammo = player:getSlotItem(CONST_SLOT_AMMO)
				if ammo and ammo:getId() ~= want.id then
					sellBack(player, ammo)
					ammo = nil
				end
				local have = ammo and ammo:getCount() or 0
				if have < STACK_REFILL then
					local add = STACK_KEEP - have
					if I.payGold(player, add * want.price) then
						if ammo then
							ammo:transform(want.id, STACK_KEEP)
						else
							player:addItem(want.id, STACK_KEEP, false, 1, CONST_SLOT_AMMO)
						end
						h.supplies = h.supplies + add * want.price
					else
						h.noGold = true
					end
				end
			end
		end
	end
end

I.snapshot = function(...)
	return snapshot(...)
end

function I.writeState(guid, data)
	db.asyncQuery(string.format("REPLACE INTO `idle_state` (`player_id`, `updated`, `data`) VALUES (%d, %d, %s)", guid, os.time(), db.escapeString(I.json(data))))
end

-- silent: troca de cacada (nao grava o "parou", senao a ponte pode derrubar a conexao)
function I.stop(guid, reason, silent)
	local h = I.hunters[guid]
	if not h then
		return
	end
	I.hunters[guid] = nil
	for id in pairs(h.monsters) do
		local m = Monster(id)
		if m then
			m:remove()
		end
		I.owner[id] = nil
	end
	if h.room and I.rooms[h.room] == guid then
		I.rooms[h.room] = nil
	end

	local player = Player(h.name)
	local summary = {
		hunting = false,
		reason = reason,
		hunt = h.hunt,
		elapsed = os.time() - h.startTime,
		loot = h.loot,
		supplies = h.supplies,
		profit = h.loot - h.supplies,
		killCount = h.killCount,
		kills = h.kills,
		log = h.log,
		endedAt = os.time(),
		huntName = (I.getHunt(h.hunt) or {}).name or h.hunt,
		killer = h.killer,
	}
	if player then
		summary.xp = math.max(0, player:getExperience() - h.startExp)
		summary.level = player:getLevel()
		if summary.elapsed >= 300 and summary.xp > 0 then
			local xph = math.floor(summary.xp * 3600 / summary.elapsed)
			local gph = math.floor(summary.profit * 3600 / summary.elapsed)
			db.asyncQuery(string.format("INSERT INTO `idle_records` (`player_id`, `hunt`, `xph`, `gph`, `kills`, `secs`, `updated`) VALUES (%d, %s, %d, %d, %d, %d, %d) "
				.. "ON DUPLICATE KEY UPDATE `gph` = IF(VALUES(`xph`) > `xph`, VALUES(`gph`), `gph`), `kills` = IF(VALUES(`xph`) > `xph`, VALUES(`kills`), `kills`), "
				.. "`secs` = IF(VALUES(`xph`) > `xph`, VALUES(`secs`), `secs`), `updated` = IF(VALUES(`xph`) > `xph`, VALUES(`updated`), `updated`), `xph` = GREATEST(`xph`, VALUES(`xph`))",
				h.guid, db.escapeString(h.hunt), xph, gph, h.killCount, summary.elapsed, os.time()))
		end
		player:unregisterEvent("IdlePlayerDeath")
		player:unregisterEvent("IdleHealthChange")
		I.writeBag(player)
		player:setTarget(nil)
		player:setFollowCreature(nil)
		if reason ~= "morte" then
			local town = player:getTown()
			if town then
				player:teleportTo(town:getTemplePosition())
			end
			-- grava ja: a pagina mostra o personagem pelo banco enquanto ele nao caca
			player:save()
			I.writeGear(player)
		end
		if player:getIp() == 0 then
			-- sem cliente: sai do mundo (e salva) depois de voltar ao templo
			local name = player:getName()
			addEvent(function()
				local p = Player(name)
				if p and p:getIp() == 0 and not I.hunters[p:getGuid()] then
					p:remove()
				end
			end, 500)
		end
	end
	if not silent then
		I.writeState(guid, summary)
	end
end

function I.start(player, huntId)
	local guid = player:getGuid()
	local settings = I.loadSettings(player)
	huntId = (huntId ~= "" and huntId) or settings.hunt
	local hunt = I.getHunt(huntId)
	if not hunt then
		return false, "cacada desconhecida"
	end
	if player:getStamina() < 1 then
		return false, "sem stamina"
	end
	if I.hunters[guid] then
		I.stop(guid, "troca de cacada", true)
	end
	local room = takeRoom(guid, hunt.id)
	if not room then
		return false, "sem sala livre"
	end
	settings.hunt = huntId
	db.query(string.format("UPDATE `idle_settings` SET `hunt` = %s WHERE `player_id` = %d", db.escapeString(huntId), guid))

	local h = {
		guid = guid,
		name = player:getName(),
		hunt = huntId,
		room = room,
		settings = settings,
		bar = I.parseBar(settings.bar),
		monsters = {},
		cd = {},
		gcd = {},
		log = {},
		kills = {},
		killCount = 0,
		lastLoot = {},
		loot = 0,
		supplies = 0,
		casts = 0,
		pulls = 0,
		startTime = os.time(),
		startExp = player:getExperience(),
		nextPull = 0,
		lastState = 0,
		seen = math.max(settings.seen or 0, os.time()),
		seenCheck = os.time(),
	}
	local tpl = IdleRooms and IdleRooms[I.roomTemplate[room]]
	h.area = tpl ~= nil and tpl.spawns ~= nil and #tpl.spawns > 0
	I.hunters[guid] = h
	player:registerEvent("IdlePlayerDeath")
	player:registerEvent("IdleHealthChange")
	I.writeBag(player)
	player:teleportTo(startPos(room))
	startPos(room):sendMagicEffect(CONST_ME_TELEPORT)
	if h.area then
		populate(h)
		buildRoute(h)
	end
	log(h, "Cacada iniciada: " .. hunt.name)
	return true
end

function I.reload(player)
	local h = I.hunters[player:getGuid()]
	if not h then
		return
	end
	h.settings = I.loadSettings(player)
	h.bar = I.parseBar(h.settings.bar)
	log(h, "Configuracao atualizada")
end

local function tickHunter(h)
	local player = Player(h.name)
	if not player then
		I.stop(h.guid, "saiu do jogo")
		return
	end
	local t = os.time()
	if h.bagDirty and t - (h.bagAt or 0) >= 2 then
		h.bagDirty = false
		h.bagAt = t
		I.writeBag(player)
	end

	-- quem esta olhando a pagina atualiza `seen`; sem isso por 12 h, a cacada para
	if t - h.seenCheck >= 60 then
		h.seenCheck = t
		local r = db.storeQuery("SELECT `seen` FROM `idle_settings` WHERE `player_id` = " .. h.guid)
		if r then
			h.seen = math.max(h.seen, Result.getNumber(r, "seen"))
			Result.free(r)
		end
	end
	if t - h.seen > I.MAX_UNWATCHED then
		I.stop(h.guid, "12 horas")
		return
	end
	if player:getStamina() < 1 then
		I.stop(h.guid, "stamina")
		return
	end

	local list = aliveMonsters(h)
	if h.area then
		respawn(h, player)
		list = aliveMonsters(h)
	elseif #list == 0 then
		if h.nextPull == 0 then
			h.nextPull = now() + 1500
		elseif now() >= h.nextPull then
			h.nextPull = 0
			spawnPull(h, player)
			list = aliveMonsters(h)
		end
	end

	-- alvo: fica fixo ate morrer (trocar reinicia o ataque); so monstros do mesmo andar e perto
	local pp = player:getPosition()
	local near = {}
	for _, m in ipairs(list) do
		local mp = m:getPosition()
		if mp.z == pp.z and pp:getDistance(mp) <= 9 then
			near[#near + 1] = m
		end
	end
	local target = h.targetId and Monster(h.targetId)
	-- solta o alvo que fugiu para longe (dragao com pouca vida foge) ou que ficou sem caminho
	if not target or not h.monsters[h.targetId] or target:getHealth() <= 0 or target:getPosition().z ~= pp.z
		or pp:getDistance(target:getPosition()) > 8 or (h.lostTarget == h.targetId) then
		h.lostTarget = nil
		local attacking = {}
		for _, m in ipairs(near) do
			if isAttackingMe(m, player) then
				attacking[#attacking + 1] = m
			end
		end
		target = pickTarget(h, player, #attacking > 0 and attacking or near)
		h.targetId = target and target:getId() or nil
	end
	if target then
		local current = player:getTarget()
		if not current or current:getId() ~= target:getId() then
			player:setTarget(target)
		end
	elseif player:getTarget() then
		player:setTarget(nil)
	end
	if player:getFollowCreature() then
		player:setFollowCreature(nil) -- quem anda e o hunterMove
	end
	hunterMove(h, player, list, target)

	local stats = combatStats(player)
	h.noGold = false
	I.refill(h, player)
	if t - (h.gearAt or 0) >= 30 then
		h.gearAt = t
		I.writeGear(player)
	end
	for _, slot in ipairs(h.bar) do
		if slot.enabled then
			fire(h, player, slot, target, list, stats)
		end
	end

	-- eventos para a visao: dano dado/recebido e XP, pela diferenca desde o ultimo segundo
	-- (o onHealthChange do Canary nao dispara para ataque basico de arma nem de monstro)
	h.hpSeen = h.hpSeen or {}
	for _, m in ipairs(list) do
		local id, cur = m:getId(), m:getHealth()
		local prev = h.hpSeen[id]
		if prev and cur < prev then
			I.fx(h, { k = "dmg", id = id, v = prev - cur })
		end
		h.hpSeen[id] = cur
	end
	local php = player:getHealth()
	if h.php and php < h.php then
		I.fx(h, { k = "hurt", v = h.php - php })
		log(h, "Voce perdeu " .. (h.php - php) .. " de vida")
	end
	h.php = php
	local exp = player:getExperience()
	if h.expSeen and exp > h.expSeen then
		I.fx(h, { k = "xp", v = exp - h.expSeen })
	end
	h.expSeen = exp

	-- o estado para a pagina sai pelo I.walkTick (a cada 400 ms)
end

-- comandos da pagina (so para personagens que ja estao no mundo; os outros esperam)
local function processCommands()
	local r = db.storeQuery("SELECT `id`, `player_name`, `cmd`, `arg`, `created` FROM `idle_commands` ORDER BY `id` LIMIT 50")
	if not r then
		return
	end
	local done = {}
	repeat
		local id = Result.getNumber(r, "id")
		local name = Result.getString(r, "player_name")
		local cmd = Result.getString(r, "cmd")
		local arg = Result.getString(r, "arg")
		local created = Result.getNumber(r, "created")
		local player = Player(name)
		if player then
			local guid = player:getGuid()
			if cmd == "start" then
				local ok, why = I.start(player, arg)
				if not ok then
					I.writeState(guid, { hunting = false, reason = why, endedAt = os.time() })
				end
			elseif cmd == "stop" then
				I.stop(guid, "parada pelo jogador")
			elseif cmd == "reload" then
				I.reload(player)
			elseif cmd == "buy" then
				local ok, why = I.buy(player, tonumber(arg) or 0)
				I.writeGear(player, { ok = ok, text = why, at = os.time() })
				player:save()
			elseif cmd == "gear" then
				I.writeGear(player)
				I.writeBag(player)
			elseif cmd == "sell" or cmd == "dispatch" then
				-- Venda rapida (cidade) ou Despachar loot (cacada); dentro da cacada a venda e sempre um despacho
				local mode = (cmd == "dispatch" or I.hunters[guid]) and "despacho" or "venda"
				local ok, why = I.sellBag(player, mode)
				if not ok then
					I.writeBag(player, { ok = false, text = why, at = os.time() })
				end
				I.writeGear(player)
				if not I.hunters[guid] then
					player:save()
				end
			end
			done[#done + 1] = id
		elseif cmd == "stop" or os.time() - created > 120 then
			done[#done + 1] = id
		end
	until not Result.next(r)
	Result.free(r)
	if #done > 0 then
		db.query("DELETE FROM `idle_commands` WHERE `id` IN (" .. table.concat(done, ",") .. ")")
	end
end

-- personagens sem cliente e sem cacada nao ficam no mundo
local function sweepIdlePlayers()
	local t = os.time()
	for _, p in ipairs(Game.getPlayers()) do
		local guid = p:getGuid()
		if p:getIp() == 0 and not I.hunters[guid] and not p:getGroup():getAccess() then
			local since = I.loginAt[guid] or 0
			if t - since > I.LOGIN_GRACE and not p:getCondition(CONDITION_INFIGHT) then
				p:remove()
			end
		end
	end
end

function I.tick()
	processCommands()
	for guid, h in pairs(I.hunters) do
		local ok, err = pcall(tickHunter, h)
		if not ok then
			logger.error("[Idle] erro na cacada de {}: {}", h.name, tostring(err))
			I.stop(guid, "erro")
		end
	end
	sweepIdlePlayers()
end

-- --------------------------------------------------------------------------
-- Mochila (como no Huntera): o loot vai para a mochila do personagem, limitada
-- pela capacidade, e vira gold na Venda rapida (cidade) ou no Despachar loot
-- (dentro da cacada, com tempo de recarga). Moedas vao direto para o banco.
-- Mochila cheia: com "vender sozinho" ligado, o mensageiro leva o que esta
-- marcado na hora; sem isso o loot fica no corpo do monstro.
-- --------------------------------------------------------------------------
local COINS = { [3031] = 1, [3035] = 100, [3043] = 10000 }
-- recarga do Despachar loot: 30 min no Premium, 60 min na conta normal (como no Huntera)
local function dispatchCooldown(player)
	return player:isPremium() and 30 * 60 or 60 * 60
end
I.bags = I.bags or {} -- [guid] = { items = { [id] = count }, dispatchAt = 0, msg = {} }

local function bagOf(guid)
	local b = I.bags[guid]
	if b then
		return b
	end
	b = { items = {}, dispatchAt = 0 }
	local r = db.storeQuery("SELECT `items`, `dispatch_at` FROM `idle_bag` WHERE `player_id` = " .. guid)
	if r then
		for id, count in Result.getString(r, "items"):gmatch("(%d+):(%d+)") do
			b.items[tonumber(id)] = tonumber(count)
		end
		b.dispatchAt = Result.getNumber(r, "dispatch_at")
		Result.free(r)
	end
	I.bags[guid] = b
	return b
end

local function bagWeight(b)
	local w = 0
	for id, count in pairs(b.items) do
		w = w + ItemType(id):getWeight() * count
	end
	return w
end

local function priceOf(id)
	return (IdlePrices and IdlePrices[id]) or 0
end

-- itens que o jogador marcou para NAO vender
local function keepSet(guid)
	local set = {}
	local r = db.storeQuery("SELECT `keep` FROM `idle_settings` WHERE `player_id` = " .. guid)
	if r then
		for id in (Result.getString(r, "keep") or ""):gmatch("%d+") do
			set[tonumber(id)] = true
		end
		Result.free(r)
	end
	return set
end

-- grava a mochila para a pagina (nome, preco de NPC e peso de cada item)
function I.writeBag(player, msg)
	local guid = player:getGuid()
	local b = bagOf(guid)
	if msg then
		b.msg = msg
	end
	local list, parts, weight = {}, {}, 0
	for id, count in pairs(b.items) do
		local t = ItemType(id)
		weight = weight + t:getWeight() * count
		list[#list + 1] = { id = id, count = count, name = t:getName(), price = priceOf(id), weight = t:getWeight() }
		parts[#parts + 1] = id .. ":" .. count
	end
	table.sort(list, function(x, y)
		return x.price * x.count > y.price * y.count
	end)
	local data = { items = list, weight = weight, cap = player:getFreeCapacity(), dispatchAt = b.dispatchAt or 0, cooldown = dispatchCooldown(player), msg = b.msg, now = os.time() }
	db.asyncQuery(string.format("REPLACE INTO `idle_bag` (`player_id`, `updated`, `items`, `dispatch_at`, `data`) VALUES (%d, %d, %s, %d, %s)",
		guid, os.time(), db.escapeString(table.concat(parts, ",")), b.dispatchAt or 0, db.escapeString(I.json(data))))
end

-- vende o que esta marcado: "venda" (Venda rapida, cidade), "despacho" (Despachar loot, com recarga)
-- e "auto" (mochila cheia com vender sozinho ligado)
function I.sellBag(player, mode)
	local guid = player:getGuid()
	local b = bagOf(guid)
	local now = os.time()
	if mode == "despacho" and (b.dispatchAt or 0) > now then
		local left = b.dispatchAt - now
		return false, string.format("O mensageiro volta em %d:%02d.", math.floor(left / 60), left % 60)
	end
	local keep = keepSet(guid)
	local total, n = 0, 0
	for id, count in pairs(b.items) do
		if not keep[id] then
			total = total + priceOf(id) * count
			n = n + count
			b.items[id] = nil
		end
	end
	if n == 0 then
		return false, "Nada marcado para vender."
	end
	player:setBankBalance(player:getBankBalance() + total)
	if mode == "despacho" then
		b.dispatchAt = now + dispatchCooldown(player)
	end
	local text = (mode == "venda" and "Venda rápida" or mode == "auto" and "Mochila cheia: o mensageiro vendeu" or "Despachou")
		.. " " .. n .. (n == 1 and " item" or " itens") .. " por " .. total .. " gold."
	local h = I.hunters[guid]
	if h then
		table.insert(h.log, os.date("%H:%M:%S") .. " " .. text)
		h.bagFull = false
	end
	I.writeBag(player, { ok = true, text = text, at = now })
	return true, text
end

function I.onLoot(monster, corpse)
	local guid = I.owner[monster:getId()]
	local h = guid and I.hunters[guid]
	if not h or not corpse or not corpse:isContainer() then
		return
	end
	local player = Player(h.name)
	if not player then
		return
	end
	local b = bagOf(guid)
	local cap = player:getFreeCapacity()
	local weight = bagWeight(b)
	local gold, value, names, left = 0, 0, {}, 0
	for _, item in ipairs(corpse:getItems(true)) do
		local id = item:getId()
		local count = item:getCount()
		if COINS[id] then
			gold = gold + COINS[id] * count
			item:remove()
		elseif priceOf(id) > 0 then
			local w = ItemType(id):getWeight() * count
			if weight + w <= cap then
				b.items[id] = (b.items[id] or 0) + count
				weight = weight + w
				value = value + priceOf(id) * count
				names[#names + 1] = (count > 1 and (count .. "x ") or "") .. item:getName()
				item:remove()
			else
				left = left + 1
			end
		end
	end
	if gold > 0 then
		player:setBankBalance(player:getBankBalance() + gold)
	end
	if gold + value > 0 then
		h.loot = h.loot + gold + value
		local line = monster:getName() .. ": " .. (gold > 0 and (gold .. " gp") or "") .. (#names > 0 and ((gold > 0 and " + " or "") .. table.concat(names, ", ")) or "")
		table.insert(h.lastLoot, 1, line)
		if #h.lastLoot > 10 then
			table.remove(h.lastLoot)
		end
	end
	if value > 0 then
		h.bagDirty = true
	end
	if left > 0 then
		-- mochila cheia: vende o que esta marcado (se o jogador deixou) ou o resto fica no corpo
		if not (h.settings.autosell and I.sellBag(player, "auto")) and not h.bagFull then
			h.bagFull = true
			table.insert(h.log, os.date("%H:%M:%S") .. " Mochila cheia: o loot está ficando no chão. Despache ou venda o loot.")
			h.bagDirty = true
		end
	end
end

function I.onMonsterDeath(monster)
	local id = monster:getId()
	local guid = I.owner[id]
	local h = guid and I.hunters[guid]
	if not h then
		return
	end
	h.monsters[id] = nil
	if h.hpSeen and h.hpSeen[id] and h.hpSeen[id] > 0 then
		I.fx(h, { k = "dmg", id = id, v = h.hpSeen[id], kill = true })
		h.hpSeen[id] = nil
	end
	local name = monster:getName()
	h.kills[name] = (h.kills[name] or 0) + 1
	h.killCount = h.killCount + 1
	log(h, "Voce matou " .. name)
	-- o corpo some logo: a sala nao enche de corpos
	addEvent(function()
		I.owner[id] = nil
	end, 1000)
end

-- as magias reais tem que ser lidas enquanto o servidor carrega os scripts (o Canary so aceita
-- montar a formula de combate nessa hora)
do
	local ok, err = pcall(I.loadRealSpells)
	if not ok then
		logger.error("[Idle] magias reais: {}", tostring(err))
	end
end
