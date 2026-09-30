-- Destruitor Idle: liga o sistema (idle.lua) aos eventos do Canary.

local startup = GlobalEvent("IdleStartup")
function startup.onStartup()
	Idle.setupDatabase()
	Idle.writeCatalog()
	logger.info("[Idle] pronto: {} cacadas", #Idle.HUNTS)
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

local login = CreatureEvent("IdleLogin")
function login.onLogin(player)
	Idle.loginAt[player:getGuid()] = os.time()
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
