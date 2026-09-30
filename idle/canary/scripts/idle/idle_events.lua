-- Destruitor Idle: liga o sistema (idle.lua) aos eventos do Canary.

local startup = GlobalEvent("IdleStartup")
function startup.onStartup()
	if IdleHuntsData then
		Idle.setHunts(IdleHuntsData, true)
	end
	if IdleSoloData then
		Idle.setSolo(IdleSoloData)
	end
	if IdleShopData then
		Idle.setShop(IdleShopData)
	end
	Idle.setupDatabase()
	Idle.writeCatalog()
	logger.info("[Idle] pronto: {} cacadas, {} monstros na cacada livre, {} itens na loja", #Idle.HUNTS, #(Idle.SOLO_LIST or {}), #(Idle.SHOP_LIST or {}))
	return true
end
startup:register()

local think = GlobalEvent("IdleTick")
function think.onThink(interval)
	Idle.tick()
	return true
end
think:interval(1000)
think:register()

-- passos do personagem e estado para a pagina
local walk = GlobalEvent("IdleWalk")
function walk.onThink(interval)
	Idle.walkTick()
	return true
end
walk:interval(100)
walk:register()

local login = CreatureEvent("IdleLogin")
function login.onLogin(player)
	Idle.loginAt[player:getGuid()] = os.time()
	-- a pagina mostra o equipamento pelo banco
	addEvent(function(name)
		local p = Player(name)
		if p then
			Idle.writeGear(p)
		end
	end, 2000, player:getName())
	return true
end
login:register()

local death = CreatureEvent("IdlePlayerDeath")
function death.onDeath(creature, corpse, killer, mostDamageKiller, lastHitUnjustified, mostDamageUnjustified)
	local player = creature:getPlayer()
	if player then
		local h = Idle.hunters[player:getGuid()]
		if h then
			local by = killer and killer:getName() or "?"
			table.insert(h.log, os.date("%H:%M:%S") .. " Voce morreu para " .. by)
		end
		Idle.stop(player:getGuid(), "morte")
	end
	return true
end
death:register()

local hurt = CreatureEvent("IdleHealthChange")
function hurt.onHealthChange(creature, attacker, primaryDamage, primaryType, secondaryDamage, secondaryType, origin)
	local player = creature:getPlayer()
	local h = player and Idle.hunters[player:getGuid()]
	if h and primaryType == COMBAT_HEALING and (primaryDamage or 0) > 0 then
		Idle.fx(h, { k = "heal", v = primaryDamage })
	end
	if h and attacker and attacker:isMonster() and primaryType ~= COMBAT_HEALING then
		local total = (primaryDamage or 0) + (secondaryDamage or 0)
		if total > 0 then
			table.insert(h.log, os.date("%H:%M:%S") .. " " .. attacker:getName() .. " tirou " .. total .. " de vida")
			if #h.log > Idle.LOG_MAX then
				table.remove(h.log, 1)
			end
		end
	end
	return primaryDamage, primaryType, secondaryDamage, secondaryType
end
hurt:register()

local monsterHurt = CreatureEvent("IdleMonsterHealth")
function monsterHurt.onHealthChange(creature, attacker, primaryDamage, primaryType, secondaryDamage, secondaryType, origin)
	local guid = Idle.owner[creature:getId()]
	local h = guid and Idle.hunters[guid]
	if h and primaryType ~= COMBAT_HEALING then
		local total = (primaryDamage or 0) + (secondaryDamage or 0)
		if total > 0 then
			-- so guarda o elemento da magia: a pagina pinta o numero de dano com ele
			Idle.fx(h, { k = "elem", id = creature:getId(), e = Idle.ELEM[primaryType] or "phys" })
		end
	end
	return primaryDamage, primaryType, secondaryDamage, secondaryType
end
monsterHurt:register()

local monsterDeath = CreatureEvent("IdleMonsterDeath")
function monsterDeath.onDeath(creature, corpse, killer, mostDamageKiller, lastHitUnjustified, mostDamageUnjustified)
	local monster = creature:getMonster()
	if monster then
		Idle.onMonsterDeath(monster)
	end
	return true
end
monsterDeath:register()

local loot = EventCallback("IdleAutoLoot")
function loot.monsterPostDropLoot(monster, corpse)
	Idle.onLoot(monster, corpse)
end
loot:register()
