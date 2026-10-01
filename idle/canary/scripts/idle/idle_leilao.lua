--[[
Destruitor Idle — LEILAO (mercado entre jogadores), como a aba LEILAO da loja do Huntera.

Regras (L.CFG; a ponte e a pagina recebem as mesmas pelo idle_catalog 'leilao'):
  * Anunciar: um item da mochila (idle_bag) por um preco em gold por unidade, por 1, 3 ou 7 dias.
    Taxa de anuncio cobrada na hora: 2% do total (minimo 20, maximo 500 mil). Nao volta ao cancelar nem
    ao expirar (como no Huntera: "a taxa nao volta"). O preco nao fica abaixo do valor no NPC (abaixo
    disso a Venda rapida paga mais). Ate 10 ofertas ativas (25 no Premium) e 10.000 unidades por oferta.
  * Comprar: o gold sai do banco do comprador; o vendedor recebe o total menos a comissao da casa (3%);
    o item vai para a mochila do comprador. Da para comprar so uma parte da oferta.
  * Cancelar: o item volta para a mochila. Expirar: o item volta para a mochila.
  * So na cidade: anunciar, comprar e cancelar com o personagem fora de cacada (como no Huntera).

Consistencia: o item so sai da mochila e o gold so muda AQUI, no servidor.
  * a pagina manda comandos pela ponte (idle_commands: anunciar / comprar / cancelar);
  * a oferta e marcada como "reservado" (com um token conferido) antes de qualquer gold ou item mudar de dono;
  * tudo o que o leilao deve a alguem vira uma PENDENCIA (idle_auction_pending): gold da venda, item comprado,
    item de volta. Ela e entregue com o personagem no jogo e fora de cacada (na hora, ou quando ele entrar);
  * sempre tira de um lado antes de dar ao outro: se o servidor cair no meio, some, nao duplica. A compra
    guarda o banco que o comprador vai ter depois de pagar (reserve_bank): na partida, uma reserva que ficou
    para tras e concluida (o comprador ja tinha pago) ou desfeita (nao tinha).

Depende do idle.lua: Idle.bagOf, Idle.priceOf, Idle.writeBag, Idle.hunters e o gancho em processCommands.
]]

Idle = Idle or {}
local I = Idle
I.leilao = I.leilao or {}
local L = I.leilao

L.CFG = {
	taxaPct = 2, -- taxa de anuncio: % do total, cobrada na hora
	taxaMin = 20,
	taxaMax = 500000,
	comissaoPct = 3, -- a casa fica com isto da venda
	dias = { 1, 3, 7 },
	diasPadrao = 7,
	maxAtivos = 10,
	maxAtivosPremium = 25,
	maxQtd = 10000, -- unidades por oferta
	precoMax = 100000000, -- por unidade
	totalMax = 2000000000, -- preco x quantidade
	pisoNpc = true, -- preco por unidade >= valor no NPC
	avisoPct = 30, -- a pagina avisa quando o preco fica 30% longe do preco medio
	soNaCidade = true,
}

L.COMANDOS = { anunciar = true, comprar = true, cancelar = true }
L.feitos = L.feitos or {} -- [id do idle_commands] = true: o mesmo comando nunca roda duas vezes
L.nFeitos = L.nFeitos or 0
L.seq = L.seq or 0

-- --------------------------------------------------------------------------
-- utilidades
-- --------------------------------------------------------------------------
local function fmt(n) -- 1234567 -> "1.234.567"
	local s = string.format("%d", math.floor(n or 0))
	local neg = s:sub(1, 1) == "-"
	if neg then
		s = s:sub(2)
	end
	s = s:reverse():gsub("(%d%d%d)", "%1."):reverse()
	if s:sub(1, 1) == "." then
		s = s:sub(2)
	end
	return (neg and "-" or "") .. s
end
L.fmt = fmt

local function oz(w) -- peso em centesimos de oz -> "12,50"
	local s = string.format("%.2f", (w or 0) / 100)
	return (s:gsub("%.", ","))
end

local function cacando(player)
	return I.hunters ~= nil and I.hunters[player:getGuid()] ~= nil
end

-- em cacada o idle.lua nao grava o personagem (a posicao e a da sala); grava quando ela acaba
local function salvar(player)
	if not cacando(player) then
		player:save()
	end
end

local function msg(guid, ok, texto)
	db.query(string.format("INSERT INTO `idle_auction_msg` (`player_id`, `ok`, `texto`, `created`) VALUES (%d, %d, %s, %d)",
		guid, ok and 1 or 0, db.escapeString(texto), os.time()))
end

local function novoToken()
	L.seq = L.seq + 1
	return string.format("%d-%d-%d", os.time(), L.seq, math.random(100000, 999999))
end

function L.taxa(total)
	local c = L.CFG
	return math.min(c.taxaMax, math.max(c.taxaMin, math.floor(total * c.taxaPct / 100)))
end

function L.comissao(total)
	return math.floor(total * L.CFG.comissaoPct / 100)
end

local function diasOk(dias)
	for _, d in ipairs(L.CFG.dias) do
		if d == dias then
			return true
		end
	end
	return false
end

-- tipo do item para os filtros da pagina
local function tipoDoItem(t)
	local wt = t:getWeaponType()
	if wt == WEAPON_SHIELD then
		return "escudo"
	elseif wt == WEAPON_AMMO then
		return "municao"
	elseif wt ~= WEAPON_NONE then
		return "arma"
	end
	local slot = t:getSlotPosition()
	local has = function(bitv)
		return bitv ~= nil and bit.band(slot, bitv) ~= 0
	end
	if has(SLOTP_HEAD) then
		return "capacete"
	elseif has(SLOTP_NECKLACE) then
		return "amuleto"
	elseif has(SLOTP_ARMOR) then
		return "armadura"
	elseif has(SLOTP_LEGS) then
		return "calcas"
	elseif has(SLOTP_FEET) then
		return "botas"
	elseif has(SLOTP_RING) then
		return "anel"
	elseif t:isContainer() then
		return "recipiente"
	elseif t:isRune() then
		return "runa"
	end
	return "outros"
end
L.tipoDoItem = tipoDoItem

local function pesoMochila(b)
	local w = 0
	for id, count in pairs(b.items) do
		w = w + ItemType(id):getWeight() * count
	end
	return w
end

-- grava a mochila na hora (o idle.lua grava em segundo plano): o anuncio so entra no banco depois
-- de o item ter saido dela de verdade
local function gravarMochila(player)
	local guid = player:getGuid()
	local b = I.bagOf(guid)
	local parts = {}
	for id, count in pairs(b.items) do
		if count > 0 then
			parts[#parts + 1] = id .. ":" .. count
		end
	end
	db.query(string.format("INSERT INTO `idle_bag` (`player_id`, `updated`, `items`, `dispatch_at`, `data`) VALUES (%d, %d, %s, %d, '{}') "
		.. "ON DUPLICATE KEY UPDATE `items` = VALUES(`items`), `updated` = VALUES(`updated`)",
		guid, os.time(), db.escapeString(table.concat(parts, ",")), b.dispatchAt or 0))
	I.writeBag(player) -- a lista com nomes e precos para a pagina
end

-- --------------------------------------------------------------------------
-- banco
-- --------------------------------------------------------------------------
-- (manter igual ao SQL de gateway/leilao.js: quem subir primeiro cria)
function L.setupDatabase()
	db.query([[CREATE TABLE IF NOT EXISTS `idle_auction` (
		`id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
		`seller_id` INT NOT NULL,
		`seller_name` VARCHAR(255) NOT NULL,
		`item_id` INT NOT NULL,
		`item_name` VARCHAR(100) NOT NULL DEFAULT '',
		`kind` VARCHAR(16) NOT NULL DEFAULT '',
		`count` INT NOT NULL,
		`price` BIGINT NOT NULL,
		`fee` BIGINT NOT NULL DEFAULT 0,
		`created` INT UNSIGNED NOT NULL,
		`expires` INT UNSIGNED NOT NULL,
		`status` VARCHAR(12) NOT NULL DEFAULT 'ativo',
		`origem` VARCHAR(8) NOT NULL DEFAULT 'jogador',
		`token` VARCHAR(40) NOT NULL DEFAULT '',
		`buyer_id` INT NOT NULL DEFAULT 0,
		`reserve_count` INT NOT NULL DEFAULT 0,
		`reserve_bank` BIGINT NOT NULL DEFAULT -1,
		`reserved_at` INT UNSIGNED NOT NULL DEFAULT 0,
		`closed` INT UNSIGNED NOT NULL DEFAULT 0,
		PRIMARY KEY (`id`),
		KEY `status_expires` (`status`, `expires`),
		KEY `item_status` (`item_id`, `status`, `price`),
		KEY `seller_status` (`seller_id`, `status`)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
	db.query([[CREATE TABLE IF NOT EXISTS `idle_auction_history` (
		`id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
		`auction_id` INT UNSIGNED NOT NULL,
		`tipo` VARCHAR(12) NOT NULL,
		`item_id` INT NOT NULL,
		`item_name` VARCHAR(100) NOT NULL DEFAULT '',
		`count` INT NOT NULL,
		`price` BIGINT NOT NULL,
		`total` BIGINT NOT NULL,
		`fee` BIGINT NOT NULL DEFAULT 0,
		`seller_id` INT NOT NULL,
		`seller_name` VARCHAR(255) NOT NULL DEFAULT '',
		`buyer_id` INT NOT NULL DEFAULT 0,
		`buyer_name` VARCHAR(255) NOT NULL DEFAULT '',
		`created` INT UNSIGNED NOT NULL,
		PRIMARY KEY (`id`),
		KEY `item_tipo` (`item_id`, `tipo`, `id`),
		KEY `seller` (`seller_id`, `id`),
		KEY `buyer` (`buyer_id`, `id`)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
	db.query([[CREATE TABLE IF NOT EXISTS `idle_auction_pending` (
		`id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
		`player_id` INT NOT NULL,
		`gold` BIGINT NOT NULL DEFAULT 0,
		`item_id` INT NOT NULL DEFAULT 0,
		`count` INT NOT NULL DEFAULT 0,
		`motivo` VARCHAR(16) NOT NULL DEFAULT '',
		`auction_id` INT UNSIGNED NOT NULL DEFAULT 0,
		`texto` VARCHAR(255) NOT NULL DEFAULT '',
		`created` INT UNSIGNED NOT NULL,
		`delivered` INT UNSIGNED NOT NULL DEFAULT 0,
		PRIMARY KEY (`id`),
		KEY `player_delivered` (`player_id`, `delivered`)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
	db.query([[CREATE TABLE IF NOT EXISTS `idle_auction_msg` (
		`id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
		`player_id` INT NOT NULL,
		`ok` TINYINT NOT NULL DEFAULT 1,
		`texto` VARCHAR(255) NOT NULL,
		`created` INT UNSIGNED NOT NULL,
		PRIMARY KEY (`id`),
		KEY `player_id` (`player_id`, `id`)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4]])
end

-- itens negociaveis (os que entram na mochila: tem preco de NPC) e as regras, para a ponte e a pagina
function L.writeCatalog()
	local items = {}
	for id, npc in pairs(IdlePrices or {}) do
		local t = ItemType(id)
		if npc > 0 and t:getId() ~= 0 then
			items[#items + 1] = { id, t:getName(), npc, t:getWeight(), tipoDoItem(t), t:getRequiredLevel() or 0 }
		end
	end
	table.sort(items, function(a, b)
		return a[2] < b[2]
	end)
	local data = I.json({ cfg = L.CFG, items = items })
	db.query("REPLACE INTO `idle_catalog` (`name`, `data`) VALUES ('leilao', " .. db.escapeString(data) .. ")")
	return #items
end

local CAMPOS = "`id`, `seller_id`, `seller_name`, `item_id`, `item_name`, `kind`, `count`, `price`, `fee`, `expires`, `status`, `token`, `buyer_id`, `reserve_count`, `reserve_bank`"

local function lerOferta(r)
	return {
		id = Result.getNumber(r, "id"),
		seller = Result.getNumber(r, "seller_id"),
		sellerName = Result.getString(r, "seller_name"),
		item = Result.getNumber(r, "item_id"),
		itemName = Result.getString(r, "item_name"),
		kind = Result.getString(r, "kind"),
		count = Result.getNumber(r, "count"),
		price = Result.getNumber(r, "price"),
		fee = Result.getNumber(r, "fee"),
		expires = Result.getNumber(r, "expires"),
		status = Result.getString(r, "status"),
		token = Result.getString(r, "token"),
		buyer = Result.getNumber(r, "buyer_id"),
		reserveCount = Result.getNumber(r, "reserve_count"),
		reserveBank = Result.getNumber(r, "reserve_bank"),
	}
end

local function ofertas(where)
	local list = {}
	local r = db.storeQuery("SELECT " .. CAMPOS .. " FROM `idle_auction` WHERE " .. where)
	if r then
		repeat
			list[#list + 1] = lerOferta(r)
		until not Result.next(r)
		Result.free(r)
	end
	return list
end

local function oferta(id)
	return ofertas(string.format("`id` = %d", id))[1]
end

-- muda a oferta so se ela ainda estiver como `cond` diz. O token prova que foi ESTA chamada que mudou
-- (o db.query do Canary nao diz quantas linhas mudaram). Devolve o token, ou nil.
local function trocar(id, set, cond)
	local tok = novoToken()
	db.query(string.format("UPDATE `idle_auction` SET %s, `token` = %s WHERE `id` = %d AND %s", set, db.escapeString(tok), id, cond))
	local r = db.storeQuery(string.format("SELECT `token` FROM `idle_auction` WHERE `id` = %d", id))
	if not r then
		return nil
	end
	local got = Result.getString(r, "token")
	Result.free(r)
	return got == tok and tok or nil
end

local function ativos(guid)
	local n = 0
	local r = db.storeQuery(string.format("SELECT COUNT(*) AS `n` FROM `idle_auction` WHERE `seller_id` = %d AND `status` IN ('ativo', 'reservado')", guid))
	if r then
		n = Result.getNumber(r, "n")
		Result.free(r)
	end
	return n
end

local function pendencia(guid, gold, item, count, motivo, auctionId, texto)
	local ok = db.query(string.format("INSERT INTO `idle_auction_pending` (`player_id`, `gold`, `item_id`, `count`, `motivo`, `auction_id`, `texto`, `created`) VALUES (%d, %d, %d, %d, %s, %d, %s, %d)",
		guid, gold, item, count, db.escapeString(motivo), auctionId, db.escapeString(texto or ""), os.time()))
	if not ok then
		logger.error("[Idle] leilao: pendencia NAO gravada (player {}, gold {}, item {} x{}, oferta {})", guid, gold, item, count, auctionId)
	end
	return ok
end

local function historico(o, tipo, count, fee, buyerGuid, buyerName)
	return db.query(string.format("INSERT INTO `idle_auction_history` (`auction_id`, `tipo`, `item_id`, `item_name`, `count`, `price`, `total`, `fee`, `seller_id`, `seller_name`, `buyer_id`, `buyer_name`, `created`) "
		.. "VALUES (%d, %s, %d, %s, %d, %d, %d, %d, %d, %s, %d, %s, %d)",
		o.id, db.escapeString(tipo), o.item, db.escapeString(o.itemName), count, o.price, o.price * count, fee,
		o.seller, db.escapeString(o.sellerName), buyerGuid or 0, db.escapeString(buyerName or ""), os.time()))
end

-- --------------------------------------------------------------------------
-- pendencias: o que o leilao deve a cada personagem (entregue fora de cacada)
-- --------------------------------------------------------------------------
function L.entregar(player)
	if not player or cacando(player) then
		return 0
	end
	local guid = player:getGuid()
	local r = db.storeQuery(string.format("SELECT `id`, `gold`, `item_id`, `count` FROM `idle_auction_pending` WHERE `player_id` = %d AND `delivered` = 0 ORDER BY `id` LIMIT 50", guid))
	if not r then
		return 0
	end
	local list = {}
	repeat
		list[#list + 1] = { id = Result.getNumber(r, "id"), gold = Result.getNumber(r, "gold"), item = Result.getNumber(r, "item_id"), count = Result.getNumber(r, "count") }
	until not Result.next(r)
	Result.free(r)
	local t = os.time()
	local b = I.bagOf(guid)
	local gold, itens = 0, false
	for _, p in ipairs(list) do
		-- sai da pendencia antes de entrar no personagem (se o servidor cair aqui, some; nao duplica)
		db.query(string.format("UPDATE `idle_auction_pending` SET `delivered` = %d WHERE `id` = %d AND `delivered` = 0", t, p.id))
		if p.gold > 0 then
			gold = gold + p.gold
		end
		if p.item > 0 and p.count > 0 then
			b.items[p.item] = (b.items[p.item] or 0) + p.count
			itens = true
		end
	end
	if gold > 0 then
		player:setBankBalance(player:getBankBalance() + gold)
	end
	if itens then
		gravarMochila(player)
	end
	player:save()
	return #list
end

-- quem esta no jogo e fora de cacada recebe o que estiver pendente
function L.entregarOnline()
	local ids = {}
	for _, p in ipairs(Game.getPlayers()) do
		if not cacando(p) then
			ids[#ids + 1] = p:getGuid()
		end
	end
	if #ids == 0 then
		return
	end
	local r = db.storeQuery("SELECT DISTINCT `player_id` FROM `idle_auction_pending` WHERE `delivered` = 0 AND `player_id` IN (" .. table.concat(ids, ",") .. ")")
	if not r then
		return
	end
	local who = {}
	repeat
		who[#who + 1] = Result.getNumber(r, "player_id")
	until not Result.next(r)
	Result.free(r)
	for _, guid in ipairs(who) do
		local p = Player(guid)
		if p then
			L.entregar(p)
		end
	end
end

-- --------------------------------------------------------------------------
-- anunciar / comprar / cancelar / expirar
-- --------------------------------------------------------------------------
function L.anunciar(player, itemId, qtd, preco, dias)
	local guid = player:getGuid()
	local c = L.CFG
	local function nao(texto)
		msg(guid, false, texto)
		return false, texto
	end
	if c.soNaCidade and cacando(player) then
		return nao("A casa de leilões só negocia na cidade — saia da caçada para anunciar.")
	end
	local npc = I.priceOf(itemId)
	local it = ItemType(itemId)
	if npc <= 0 or it:getId() == 0 then
		return nao("Esse item não pode ser vendido no leilão.")
	end
	if qtd < 1 then
		return nao("Quantidade inválida.")
	elseif qtd > c.maxQtd then
		return nao("No máximo " .. fmt(c.maxQtd) .. " unidades por oferta.")
	end
	local b = I.bagOf(guid)
	local tem = b.items[itemId] or 0
	if tem < qtd then
		return nao("Você não tem essa quantidade na mochila.")
	end
	if preco < 1 then
		return nao("Ponha um preço por unidade.")
	elseif preco > c.precoMax then
		return nao("O preço máximo é " .. fmt(c.precoMax) .. " de gold cada.")
	elseif c.pisoNpc and preco < npc then
		return nao("O preço mínimo é o valor no NPC: " .. fmt(npc) .. " de gold cada — abaixo disso a Venda rápida paga mais.")
	end
	local total = preco * qtd
	if total > c.totalMax then
		return nao("O total da oferta passa de " .. fmt(c.totalMax) .. " de gold.")
	end
	if not diasOk(dias) then
		return nao("Escolha a duração: 1, 3 ou 7 dias.")
	end
	local limite = player:isPremium() and c.maxAtivosPremium or c.maxAtivos
	if ativos(guid) >= limite then
		return nao("Você já tem " .. limite .. " ofertas ativas — cancele uma ou espere vender.")
	end
	local taxa = L.taxa(total)
	local banco = player:getBankBalance()
	if banco < taxa then
		return nao("A taxa de " .. fmt(taxa) .. " de gold para anunciar é mais do que você tem no banco.")
	end

	-- 1) sai do personagem (item e taxa) e fica gravado; 2) so entao a oferta entra no banco
	if tem - qtd > 0 then
		b.items[itemId] = tem - qtd
	else
		b.items[itemId] = nil
	end
	player:setBankBalance(banco - taxa)
	gravarMochila(player)
	salvar(player)
	local t = os.time()
	local name = it:getName()
	local ok = db.query(string.format("INSERT INTO `idle_auction` (`seller_id`, `seller_name`, `item_id`, `item_name`, `kind`, `count`, `price`, `fee`, `created`, `expires`, `status`, `origem`) "
		.. "VALUES (%d, %s, %d, %s, %s, %d, %d, %d, %d, %d, 'ativo', 'jogador')",
		guid, db.escapeString(player:getName()), itemId, db.escapeString(name), db.escapeString(tipoDoItem(it)), qtd, preco, taxa, t, t + dias * 86400))
	if not ok then
		-- nao entrou: devolve tudo
		b.items[itemId] = (b.items[itemId] or 0) + qtd
		player:setBankBalance(player:getBankBalance() + taxa)
		gravarMochila(player)
		salvar(player)
		return nao("Não foi possível falar com o leilão — nada foi anunciado. Tente de novo.")
	end
	local texto = string.format("Sua oferta de %d× %s está no leilão por %s de gold cada (taxa de %s de gold).", qtd, name, fmt(preco), fmt(taxa))
	msg(guid, true, texto)
	return true, texto
end

-- fecha a venda de uma oferta reservada (token): oferta, historico e as pendencias dos dois lados
function L.fechar(o, tok, buyerGuid, buyerName, qtd)
	local resto = o.count - qtd
	local t = os.time()
	local total = o.price * qtd
	local com = L.comissao(total)
	local ok = db.query(string.format("UPDATE `idle_auction` SET `status` = %s, `count` = %d, `buyer_id` = 0, `reserve_count` = 0, `reserve_bank` = -1, `closed` = %d "
		.. "WHERE `id` = %d AND `token` = %s AND `status` = 'reservado'",
		db.escapeString(resto > 0 and "ativo" or "vendido"), resto, resto > 0 and 0 or t, o.id, db.escapeString(tok)))
	if not ok then
		return false
	end
	-- daqui em diante a venda aconteceu: o que falhar fica no log (nao desfaz)
	historico(o, "venda", qtd, com, buyerGuid, buyerName)
	pendencia(buyerGuid, 0, o.item, qtd, "compra", o.id, string.format("Comprou %d× %s de %s por %s de gold.", qtd, o.itemName, o.sellerName, fmt(total)))
	pendencia(o.seller, total - com, 0, 0, "venda", o.id, string.format("Vendeu %d× %s para %s por %s de gold (a casa ficou com %s).", qtd, o.itemName, buyerName, fmt(total), fmt(com)))
	msg(buyerGuid, true, string.format("Comprou %d× %s por %s de gold — está na sua mochila.", qtd, o.itemName, fmt(total)))
	local v = Player(o.seller)
	local now = v ~= nil and not cacando(v)
	msg(o.seller, true, string.format("Vendeu %d× %s para %s por %s de gold: %s de gold %s (a casa ficou com %s).", qtd, o.itemName, buyerName, fmt(total), fmt(total - com),
		now and "no banco" or "entram no banco quando você estiver na cidade", fmt(com)))
	return true
end

function L.comprar(player, id, qtd)
	local guid = player:getGuid()
	local function nao(texto)
		msg(guid, false, texto)
		return false, texto
	end
	if L.CFG.soNaCidade and cacando(player) then
		return nao("A casa de leilões só negocia na cidade — saia da caçada para comprar.")
	end
	local o = oferta(id)
	if not o or (o.status ~= "ativo" and o.status ~= "reservado") then
		return nao("Essa oferta não existe mais.")
	elseif o.status == "reservado" then
		return nao("Essa oferta está sendo comprada agora.")
	elseif o.expires <= os.time() then
		return nao("Essa oferta expirou.")
	elseif o.seller == guid then
		return nao("Você não pode comprar a sua própria oferta.")
	elseif qtd < 1 then
		return nao("Quantidade inválida.")
	elseif qtd > o.count then
		return nao("A oferta não tem mais essa quantidade.")
	end
	local total = o.price * qtd
	local banco = player:getBankBalance()
	if banco < total then
		return nao("Você precisa de " .. fmt(total) .. " de gold no banco para isso.")
	end
	local b = I.bagOf(guid)
	local peso = ItemType(o.item):getWeight() * qtd
	local livre = player:getFreeCapacity() - pesoMochila(b)
	if peso > livre then
		return nao("Sua mochila não aguenta: faltam " .. oz(peso - livre) .. " oz. Venda ou despache o loot antes.")
	end

	-- 1) reserva: so uma compra pega a oferta (o token confere)
	local tok = trocar(o.id, string.format("`status` = 'reservado', `buyer_id` = %d, `reserve_count` = %d, `reserve_bank` = %d, `reserved_at` = %d", guid, qtd, banco - total, os.time()),
		string.format("`status` = 'ativo' AND `count` >= %d AND `expires` > %d", qtd, os.time()))
	if not tok then
		return nao("Essa oferta acabou de ser levada.")
	end
	local pago = false
	local ok, err = pcall(function()
		-- 2) o gold sai do comprador e fica gravado antes de qualquer entrega
		player:setBankBalance(banco - total)
		pago = true
		salvar(player)
		-- 3) fecha: oferta, historico e as pendencias (item do comprador, gold do vendedor)
		if not L.fechar(o, tok, guid, player:getName(), qtd) then
			error("nao fechou a oferta " .. o.id)
		end
	end)
	if not ok then
		logger.error("[Idle] leilao: compra da oferta {} por {}: {}", o.id, player:getName(), tostring(err))
		if pago then
			player:setBankBalance(player:getBankBalance() + total)
			salvar(player)
		end
		db.query(string.format("UPDATE `idle_auction` SET `status` = 'ativo', `buyer_id` = 0, `reserve_count` = 0, `reserve_bank` = -1 WHERE `id` = %d AND `token` = %s AND `status` = 'reservado'", o.id, db.escapeString(tok)))
		return nao("A negociação não foi concluída — o seu pagamento voltou.")
	end
	-- 4) entrega: o comprador agora; o vendedor agora (na cidade) ou quando entrar/sair da cacada
	L.entregar(player)
	local v = Player(o.seller)
	if v then
		L.entregar(v)
	end
	return true
end

function L.cancelar(player, id)
	local guid = player:getGuid()
	local function nao(texto)
		msg(guid, false, texto)
		return false, texto
	end
	if L.CFG.soNaCidade and cacando(player) then
		return nao("A casa de leilões só negocia na cidade — saia da caçada para cancelar.")
	end
	local o = oferta(id)
	if not o then
		return nao("Essa oferta não existe mais.")
	elseif o.seller ~= guid then
		return nao("Essa oferta não é sua.")
	elseif o.status == "reservado" then
		return nao("Essa oferta está sendo comprada agora.")
	elseif o.status ~= "ativo" then
		return nao("Essa oferta não existe mais.")
	end
	local tok = trocar(o.id, string.format("`status` = 'cancelado', `closed` = %d", os.time()), string.format("`status` = 'ativo' AND `seller_id` = %d", guid))
	if not tok then
		return nao("O cancelamento não foi concluído — a oferta continua de pé.")
	end
	historico(o, "cancelado", o.count, 0)
	pendencia(guid, 0, o.item, o.count, "cancelado", o.id, string.format("Oferta cancelada: %d× %s de volta.", o.count, o.itemName))
	msg(guid, true, string.format("Oferta cancelada — %d× %s voltaram para a mochila (a taxa não volta).", o.count, o.itemName))
	L.entregar(player)
	return true
end

-- ofertas vencidas: o item volta para o vendedor
function L.expirar()
	local t = os.time()
	local list = ofertas(string.format("`status` = 'ativo' AND `expires` <= %d ORDER BY `expires` LIMIT 100", t))
	for _, o in ipairs(list) do
		local tok = trocar(o.id, string.format("`status` = 'expirado', `closed` = %d", t), string.format("`status` = 'ativo' AND `expires` <= %d", t))
		if tok then
			historico(o, "expirado", o.count, 0)
			pendencia(o.seller, 0, o.item, o.count, "expirado", o.id, string.format("Oferta expirada: %d× %s de volta.", o.count, o.itemName))
			local v = Player(o.seller)
			local now = v ~= nil and not cacando(v)
			msg(o.seller, true, string.format("Sua oferta de %d× %s expirou — %s.", o.count, o.itemName,
				now and "os itens voltaram para a mochila" or "os itens voltam para a mochila quando você estiver na cidade"))
			if now then
				L.entregar(v)
			end
		end
	end
	return #list
end

-- na partida: compra que ficou no meio (o servidor caiu entre a reserva e o fim)
function L.recuperar()
	for _, o in ipairs(ofertas("`status` = 'reservado'")) do
		local bal, name = -2, ""
		local r = db.storeQuery(string.format("SELECT `balance`, `name` FROM `players` WHERE `id` = %d", o.buyer))
		if r then
			bal = Result.getNumber(r, "balance")
			name = Result.getString(r, "name")
			Result.free(r)
		end
		if o.reserveBank >= 0 and o.reserveCount > 0 and bal == o.reserveBank then
			-- o banco gravado do comprador e o de depois de pagar: ele pagou, a venda se conclui
			L.fechar(o, o.token, o.buyer, name, o.reserveCount)
			logger.warn("[Idle] leilao: compra {} de {} concluida na partida", o.id, name)
		else
			db.query(string.format("UPDATE `idle_auction` SET `status` = 'ativo', `buyer_id` = 0, `reserve_count` = 0, `reserve_bank` = -1 WHERE `id` = %d AND `status` = 'reservado' AND `token` = %s", o.id, db.escapeString(o.token)))
			logger.warn("[Idle] leilao: reserva {} desfeita na partida (o comprador nao chegou a pagar)", o.id)
		end
	end
end

function L.limpar()
	local t = os.time()
	db.asyncQuery("DELETE FROM `idle_auction_msg` WHERE `created` < " .. (t - 14 * 86400))
	db.asyncQuery("DELETE FROM `idle_auction_pending` WHERE `delivered` > 0 AND `delivered` < " .. (t - 30 * 86400))
	db.asyncQuery("DELETE FROM `idle_auction` WHERE `status` IN ('vendido', 'cancelado', 'expirado') AND `closed` > 0 AND `closed` < " .. (t - 30 * 86400))
end

-- --------------------------------------------------------------------------
-- jogadores simulados (contas de bots) e eventos: poe uma oferta em nome de um personagem sem tirar nada
-- da mochila dele (o item e o loot simulado do bot) e sem taxa. O personagem nao precisa estar no jogo:
-- o gold da venda fica pendente ate ele entrar (ou para sempre, se for so um bot).
--   Idle.leilao.anunciarSistema(guid, "Nome", itemId, qtd, precoPorUnidade, dias)
-- (a ponte tem o mesmo em gateway/leilao.js: anunciarBot, com o "preco justo")
-- --------------------------------------------------------------------------
function L.anunciarSistema(guid, name, itemId, qtd, preco, dias, origem)
	local c = L.CFG
	local npc = I.priceOf and I.priceOf(itemId) or 0
	local it = ItemType(itemId)
	if npc <= 0 or it:getId() == 0 then
		return false, "item nao negociavel"
	end
	qtd = math.floor(qtd or 1)
	preco = math.floor(preco or 0)
	dias = diasOk(dias) and dias or c.diasPadrao
	if qtd < 1 or qtd > c.maxQtd or preco < npc or preco > c.precoMax or preco * qtd > c.totalMax then
		return false, "quantidade ou preco fora das regras"
	end
	local t = os.time()
	local ok = db.query(string.format("INSERT INTO `idle_auction` (`seller_id`, `seller_name`, `item_id`, `item_name`, `kind`, `count`, `price`, `fee`, `created`, `expires`, `status`, `origem`) "
		.. "VALUES (%d, %s, %d, %s, %s, %d, %d, 0, %d, %d, 'ativo', %s)",
		guid, db.escapeString(name), itemId, db.escapeString(it:getName()), db.escapeString(tipoDoItem(it)), qtd, preco, t, t + dias * 86400, db.escapeString(origem or "bot")))
	return ok == true, ok and "ok" or "falhou"
end

-- --------------------------------------------------------------------------
-- comandos da pagina (chamado pelo processCommands do idle.lua, com o personagem no jogo)
-- --------------------------------------------------------------------------
function L.comando(player, cmd, arg, cmdId)
	if cmdId then
		if L.feitos[cmdId] then
			return
		end
		if L.nFeitos > 5000 then
			L.feitos, L.nFeitos = {}, 0
		end
		L.feitos[cmdId] = true
		L.nFeitos = L.nFeitos + 1
	end
	if not (I.bagOf and I.priceOf and I.writeBag) then
		msg(player:getGuid(), false, "O leilão ainda não está pronto no servidor.")
		return
	end
	local n = {}
	for x in tostring(arg or ""):gmatch("%d+") do
		n[#n + 1] = tonumber(x)
	end
	local ok, err = pcall(function()
		if cmd == "anunciar" then
			if #n ~= 4 then
				msg(player:getGuid(), false, "Pedido inválido.")
				return
			end
			L.anunciar(player, n[1], n[2], n[3], n[4])
		elseif cmd == "comprar" then
			L.comprar(player, n[1] or 0, n[2] or 1)
		elseif cmd == "cancelar" then
			L.cancelar(player, n[1] or 0)
		end
	end)
	if not ok then
		logger.error("[Idle] leilao: {} '{}' de {}: {}", cmd, arg, player:getName(), tostring(err))
		msg(player:getGuid(), false, "O leilão não conseguiu concluir isso agora. Tente de novo.")
	end
end

function L.tick()
	local t = os.time()
	if t - (L.expAt or 0) >= 30 then
		L.expAt = t
		L.expirar()
	end
	if t - (L.entAt or 0) >= 10 then
		L.entAt = t
		L.entregarOnline()
	end
	if t - (L.limpaAt or 0) >= 3600 then
		L.limpaAt = t
		L.limpar()
	end
end

-- --------------------------------------------------------------------------
-- eventos do Canary
-- --------------------------------------------------------------------------
local startup = GlobalEvent("IdleLeilaoStartup")
function startup.onStartup()
	local ok, err = pcall(function()
		L.setupDatabase()
		L.recuperar()
		local n = L.writeCatalog()
		logger.info("[Idle] leilao pronto: {} itens negociaveis", n)
	end)
	if not ok then
		logger.error("[Idle] leilao na partida: {}", tostring(err))
	end
	return true
end
startup:register()

local think = GlobalEvent("IdleLeilaoTick")
function think.onThink(interval)
	local ok, err = pcall(L.tick)
	if not ok then
		logger.error("[Idle] leilao: {}", tostring(err))
	end
	return true
end
think:interval(5000)
think:register()

-- quem entra recebe o que o leilao deve (gold de vendas, itens de volta)
local login = CreatureEvent("IdleLeilaoLogin")
function login.onLogin(player)
	addEvent(function(guid)
		local p = Player(guid)
		if p then
			local ok, err = pcall(L.entregar, p)
			if not ok then
				logger.error("[Idle] leilao: entrega de {}: {}", guid, tostring(err))
			end
		end
	end, 3000, player:getGuid())
	return true
end
login:register()
