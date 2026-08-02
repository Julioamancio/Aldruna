-- Teleporte do GOD para uma coordenada, para poder ir ver a arte em qualquer
-- canto do mapa sem abrir editor.
--
-- Os nomes obvios ja estao ocupados pelo data pack do Canary: /t leva ao
-- templo (push_town) e /goto vai ate um jogador (teleport_to_creature). Por
-- isso o comando aqui e /tp, com /ir e /pos como apelidos.
--
-- Uso (aceita espaco ou virgula; o andar e opcional):
--   /tp 2529 1963 7        /ir 2529, 1963, 7        /pos 2529 1963

local function irPara(player, words, param)
	logCommand(player, words, param)

	-- aceita "x y z", "x,y,z" e mistura dos dois
	local numeros = {}
	for n in param:gmatch("-?%d+") do
		numeros[#numeros + 1] = tonumber(n)
	end

	if #numeros < 2 then
		player:sendCancelMessage("Uso: " .. words .. " x y z   (ex: " .. words .. " 2529 1963 7)")
		return true
	end

	local x, y = numeros[1], numeros[2]
	local z = numeros[3] or player:getPosition().z   -- sem andar, fica no mesmo

	if z < 0 or z > 15 then
		player:sendCancelMessage("O andar (z) vai de 0 a 15.")
		return true
	end

	local destino = Position(x, y, z)
	-- getTile devolve nil fora do mapa: sem isso o teleporte joga o char no vazio
	if not Tile(destino) then
		player:sendCancelMessage(string.format("Nao existe chao em %d, %d, %d.", x, y, z))
		return true
	end

	local origem = player:getPosition()
	player:teleportTo(destino)
	origem:sendMagicEffect(CONST_ME_TELEPORT)
	destino:sendMagicEffect(CONST_ME_TELEPORT)
	player:sendTextMessage(MESSAGE_ADMINISTRATOR,
		string.format("Voce foi para %d, %d, %d.", x, y, z))
	return true
end

-- os tres nomes fazem a mesma coisa; /tp e o curto
for _, comando in ipairs({ "/tp", "/ir", "/pos" }) do
	local acao = TalkAction(comando)
	acao.onSay = irPara
	acao:separator(" ")
	acao:groupType("god")
	acao:register()
end
