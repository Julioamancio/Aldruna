-- Aldruna client — Step 2: real terrain sprites (grass + water from art_raw)

local outfit = require("outfit")

local TILE = 32              -- world logic runs on a 32px grid
local SCALE = 2              -- drawn at 2x so it fills the window
local WALK_TIME = 0.18       -- seconds to cross one tile
local ATLAS_GRID = 4         -- each terrain image is used as a 4x4 atlas of subtiles
                             -- (bigger source cells = finer-looking grass per tile)

-- Each Flow variation only tiles seamlessly with itself, so a map uses ONE
-- variation per terrain; other variations are reserved for other regions.
local MAP_TERRAIN_VAR = { grass = 1, water = 1, stone = 1 }

-- Map: 0 = grass (walkable), 1 = water (blocked), 2 = stone floor (walkable)
local MAP_W, MAP_H = 50, 40
local map = {}

local terrains = {}          -- terrains[id] = { images = {..}, quads = {..}, cell = px }

local player = {
    tx = 25, ty = 20,
    fromX = 25, fromY = 20,
    walking = false,
    walkT = 0,
    animT = 0,
    dir = "south",
}

-- Warrior sheet: 6 cols x 4 rows (down, left, left-alt, up); east is west
-- mirrored at draw time (Flow produced no right-facing row).
local hero = { cols = 6, rows = 4 }

-- ---------------------------------------------------------------------------
-- Character creation (Tibia-style): new characters start as plain citizens
-- and pick hair / skin / shirt (skirt when female) / legs / shoes colors from
-- the classic 19x7 palette. Choices persist in the LOVE save dir.
-- ---------------------------------------------------------------------------
local state = "create" -- "create" -> "play"
local palette = outfit.palette()
local creation = {
    sex = "m",
    cat = 1,
    cats = {
        { key = "hair",  label = "Cabelo",  idx = 96 },
        { key = "skin",  label = "Pele",    idx = 3, skin = true },
        { key = "shirt", label = "Camisa",  idx = 88 },
        { key = "legs",  label = "Pernas",  idx = 118 },
        { key = "shoes", label = "Sapatos", idx = 130 },
    },
}

local function creationColor(key)
    for _, c in ipairs(creation.cats) do
        if c.key == key then
            if c.skin then return outfit.skins[c.idx] end
            return palette[c.idx]
        end
    end
end

local SAVE_FILE = "character.txt"

local function saveCharacter()
    local lines = { "sex=" .. creation.sex }
    for _, c in ipairs(creation.cats) do
        lines[#lines + 1] = c.key .. "=" .. c.idx
    end
    love.filesystem.write(SAVE_FILE, table.concat(lines, "\n"))
end

local function loadCharacter()
    if not love.filesystem.getInfo(SAVE_FILE) then return false end
    local data = love.filesystem.read(SAVE_FILE) or ""
    for k, v in data:gmatch("(%w+)=(%w+)") do
        if k == "sex" then
            creation.sex = (v == "f") and "f" or "m"
        else
            for _, c in ipairs(creation.cats) do
                if c.key == k then c.idx = tonumber(v) or c.idx end
            end
        end
    end
    return true
end

-- Layout shared by draw and mouse handling.
local function creationLayout()
    local W, H = love.graphics.getDimensions()
    local L = {}
    L.cell = 24
    L.gridW, L.gridH = outfit.H_STEPS * L.cell, outfit.SI_ROWS * L.cell
    L.gridX, L.gridY = W - L.gridW - 30, 150
    L.catX, L.catY, L.catW, L.catH = 30, 150, 170, 40
    L.sexY = 90
    L.dollX = L.catX + L.catW + (L.gridX - L.catX - L.catW) / 2
    L.dollY = 190
    L.btnW, L.btnH = 300, 44
    L.btnX, L.btnY = (W - L.btnW) / 2, H - 70
    return L
end

-- Paper-doll preview drawn with primitives; replaced by the real citizen
-- sprite once the base art + template exist.
local function drawDoll(cx, cy, s)
    local hair = creationColor("hair")
    local skin = creationColor("skin")
    local shirt = creationColor("shirt")
    local legs = creationColor("legs")
    local shoes = creationColor("shoes")
    local female = creation.sex == "f"
    local function rect(c, x, y, w, h, r)
        love.graphics.setColor(c[1], c[2], c[3])
        love.graphics.rectangle("fill", cx + x * s, cy + y * s, w * s, h * s, (r or 0) * s)
    end
    -- head + hair
    rect(skin, -3, 0, 6, 6, 1.4)
    rect(hair, -3.6, -1.4, 7.2, 3.2, 1.4)
    if female then
        rect(hair, -4.2, 0.4, 1.6, 7.5, 0.7)
        rect(hair, 2.6, 0.4, 1.6, 7.5, 0.7)
    end
    -- torso (shirt) + arms + hands
    rect(shirt, -4, 6.4, 8, 8, 1.2)
    rect(shirt, -5.8, 6.8, 1.8, 6.4, 0.8)
    rect(shirt, 4.0, 6.8, 1.8, 6.4, 0.8)
    rect(skin, -5.8, 13.2, 1.8, 1.8, 0.8)
    rect(skin, 4.0, 13.2, 1.8, 1.8, 0.8)
    if female then
        -- skirt (legs color) + lower legs in skin
        love.graphics.setColor(legs[1], legs[2], legs[3])
        love.graphics.polygon("fill",
            cx - 4.4 * s, cy + 14.2 * s, cx + 4.4 * s, cy + 14.2 * s,
            cx + 5.6 * s, cy + 20 * s, cx - 5.6 * s, cy + 20 * s)
        rect(skin, -2.9, 20, 2.1, 3.2)
        rect(skin, 0.8, 20, 2.1, 3.2)
        rect(shoes, -3.1, 23.2, 2.5, 1.6, 0.5)
        rect(shoes, 0.6, 23.2, 2.5, 1.6, 0.5)
    else
        rect(legs, -3.4, 14.2, 3.0, 8.0)
        rect(legs, 0.4, 14.2, 3.0, 8.0)
        rect(shoes, -3.6, 22.2, 3.2, 1.8, 0.5)
        rect(shoes, 0.4, 22.2, 3.2, 1.8, 0.5)
    end
end

local function drawCreation()
    local L = creationLayout()
    local W = love.graphics.getDimensions()
    love.graphics.setColor(0.09, 0.09, 0.12)
    love.graphics.rectangle("fill", 0, 0, W, select(2, love.graphics.getDimensions()))
    love.graphics.setColor(1, 1, 1)
    love.graphics.print("CRIAÇÃO DE PERSONAGEM — clique nas opções | Enter confirma", 30, 30)

    -- sex buttons
    local sexes = { { "m", "Masculino" }, { "f", "Feminino" } }
    for i, sx in ipairs(sexes) do
        local bx = 30 + (i - 1) * 140
        local on = creation.sex == sx[1]
        love.graphics.setColor(on and 0.85 or 0.25, on and 0.7 or 0.25, 0.2)
        love.graphics.rectangle("fill", bx, L.sexY, 130, 34, 6)
        love.graphics.setColor(1, 1, 1)
        love.graphics.printf(sx[2], bx, L.sexY + 9, 130, "center")
    end

    -- category buttons with current color swatch
    for i, c in ipairs(creation.cats) do
        local by = L.catY + (i - 1) * (L.catH + 8)
        local on = creation.cat == i
        love.graphics.setColor(on and 0.30 or 0.17, on and 0.30 or 0.17, on and 0.38 or 0.22)
        love.graphics.rectangle("fill", L.catX, by, L.catW, L.catH, 6)
        local col = c.skin and outfit.skins[c.idx] or palette[c.idx]
        love.graphics.setColor(col[1], col[2], col[3])
        love.graphics.rectangle("fill", L.catX + L.catW - 34, by + 8, 24, 24, 4)
        love.graphics.setColor(1, 1, 1)
        love.graphics.print(c.label, L.catX + 12, by + 11)
    end

    -- palette: full 19x7 grid, or the skin ramp when "Pele" is selected
    local cat = creation.cats[creation.cat]
    if cat.skin then
        for i, col in ipairs(outfit.skins) do
            local x = L.gridX + ((i - 1) % 5) * (L.cell + 8)
            local y = L.gridY + math.floor((i - 1) / 5) * (L.cell + 8)
            love.graphics.setColor(col[1], col[2], col[3])
            love.graphics.rectangle("fill", x, y, L.cell + 4, L.cell + 4, 4)
            if cat.idx == i then
                love.graphics.setColor(1, 1, 1)
                love.graphics.rectangle("line", x - 2, y - 2, L.cell + 8, L.cell + 8, 4)
            end
        end
    else
        for i = 1, #palette do
            local col = palette[i]
            local x = L.gridX + ((i - 1) % outfit.H_STEPS) * L.cell
            local y = L.gridY + math.floor((i - 1) / outfit.H_STEPS) * L.cell
            love.graphics.setColor(col[1], col[2], col[3])
            love.graphics.rectangle("fill", x, y, L.cell - 2, L.cell - 2)
            if cat.idx == i then
                love.graphics.setColor(1, 1, 1)
                love.graphics.rectangle("line", x - 1.5, y - 1.5, L.cell + 1, L.cell + 1)
            end
        end
    end

    drawDoll(L.dollX, L.dollY, 7)

    -- confirm button
    love.graphics.setColor(0.2, 0.55, 0.25)
    love.graphics.rectangle("fill", L.btnX, L.btnY, L.btnW, L.btnH, 8)
    love.graphics.setColor(1, 1, 1)
    love.graphics.printf("ENTRAR EM ALDRUNA (Enter)", L.btnX, L.btnY + 14, L.btnW, "center")
end

local function creationMouse(mx, my)
    local L = creationLayout()
    for i = 1, 2 do
        local bx = 30 + (i - 1) * 140
        if mx >= bx and mx <= bx + 130 and my >= L.sexY and my <= L.sexY + 34 then
            creation.sex = (i == 2) and "f" or "m"
            return
        end
    end
    for i = 1, #creation.cats do
        local by = L.catY + (i - 1) * (L.catH + 8)
        if mx >= L.catX and mx <= L.catX + L.catW and my >= by and my <= by + L.catH then
            creation.cat = i
            return
        end
    end
    local cat = creation.cats[creation.cat]
    if cat.skin then
        for i = 1, #outfit.skins do
            local x = L.gridX + ((i - 1) % 5) * (L.cell + 8)
            local y = L.gridY + math.floor((i - 1) / 5) * (L.cell + 8)
            if mx >= x and mx <= x + L.cell + 4 and my >= y and my <= y + L.cell + 4 then
                cat.idx = i
                return
            end
        end
    elseif mx >= L.gridX and my >= L.gridY and mx < L.gridX + L.gridW and my < L.gridY + L.gridH then
        local cx = math.floor((mx - L.gridX) / L.cell)
        local cy = math.floor((my - L.gridY) / L.cell)
        cat.idx = cy * outfit.H_STEPS + cx + 1
        return
    end
    if mx >= L.btnX and mx <= L.btnX + L.btnW and my >= L.btnY and my <= L.btnY + L.btnH then
        saveCharacter()
        state = "play"
    end
end

local function loadHero()
    hero.img = love.graphics.newImage("assets/warrior.png", { mipmaps = true })
    hero.img:setFilter("linear", "linear")
    hero.img:setMipmapFilter("linear")
    local w, h = hero.img:getDimensions()
    hero.cw, hero.ch = w / hero.cols, h / hero.rows
    local rowFor = { south = 0, east = 1, north = 3 }
    hero.quads = {}
    for dir, row in pairs(rowFor) do
        hero.quads[dir] = {}
        for i = 0, hero.cols - 1 do
            hero.quads[dir][i + 1] =
                love.graphics.newQuad(i * hero.cw, row * hero.ch, hero.cw, hero.ch, w, h)
        end
    end
    hero.quads.west = hero.quads.east -- drawn mirrored
end

local function isWalkable(tx, ty)
    if tx < 1 or ty < 1 or tx > MAP_W or ty > MAP_H then return false end
    return map[ty][tx] ~= 1
end

-- Island outline is a noisy radial curve: the radius varies smoothly with the
-- angle around the center, so the coast comes out rounded with natural coves
-- instead of straight rectangle edges. love.math.noise is deterministic, so
-- the island is identical on every run.
local function buildMap()
    local cx, cy = (MAP_W + 1) / 2, (MAP_H + 1) / 2
    for y = 1, MAP_H do
        map[y] = {}
        for x = 1, MAP_W do
            local dx = (x - cx) / (MAP_W / 2)
            local dy = (y - cy) / (MAP_H / 2)
            local d = math.sqrt(dx * dx + dy * dy)
            local ang = math.atan2(dy, dx)
            -- two noise octaves: big coves + small irregularities
            local n1 = love.math.noise(math.cos(ang) * 1.6 + 7.3, math.sin(ang) * 1.6 + 2.9)
            local n2 = love.math.noise(math.cos(ang) * 4.2 + 15.1, math.sin(ang) * 4.2 + 8.6)
            local coast = math.min(0.66 + 0.24 * n1 + 0.08 * n2, 0.94)
            -- per-tile wobble breaks up long straight runs along the shore
            local w = (love.math.noise(x * 0.21 + 3.7, y * 0.21 + 9.4) - 0.5) * 0.12
            map[y][x] = (d + w < coast) and 0 or 1
        end
    end
    -- smoothing passes: majority filter rounds off square teeth and single-tile
    -- spikes, so the coast reads as a soft curve instead of a staircase
    for _ = 1, 2 do
        local nxt = {}
        for y = 1, MAP_H do
            nxt[y] = {}
            for x = 1, MAP_W do
                local land = 0
                for oy = -1, 1 do
                    for ox = -1, 1 do
                        if not (ox == 0 and oy == 0) then
                            local nx, ny = x + ox, y + oy
                            if nx >= 1 and ny >= 1 and nx <= MAP_W and ny <= MAP_H
                                and map[ny][nx] ~= 1 then
                                land = land + 1
                            end
                        end
                    end
                end
                if map[y][x] == 1 and land >= 5 then nxt[y][x] = 0
                elseif map[y][x] == 0 and land <= 2 then nxt[y][x] = 1
                else nxt[y][x] = map[y][x] end
            end
        end
        map = nxt
    end
    for y = 17, 23 do
        for x = 21, 29 do map[y][x] = 2 end
    end
end

local function loadTerrain(id, baseName, count)
    local t = { images = {}, quads = {}, cell = 0 }
    for i = 1, count do
        local img = love.graphics.newImage("assets/" .. baseName .. i .. ".png", { mipmaps = true })
        img:setFilter("linear", "linear")
        img:setMipmapFilter("linear")
        t.images[i] = img
    end
    local w, h = t.images[1]:getDimensions()
    t.cell = math.floor(math.min(w, h) / ATLAS_GRID)
    for i = 1, count do
        t.quads[i] = {}
        for cy = 0, ATLAS_GRID - 1 do
            for cx = 0, ATLAS_GRID - 1 do
                t.quads[i][cy * ATLAS_GRID + cx] =
                    love.graphics.newQuad(cx * t.cell, cy * t.cell, t.cell, t.cell,
                        t.images[i]:getDimensions())
            end
        end
    end
    terrains[id] = t
end

-- Auto-transition: grass organically overhangs water tiles at every shore,
-- using procedural noise masks (no extra art needed).
local maskImgs = {}
local maskShader

local function buildMasks()
    local SIZE = 64
    local function newMask(fn)
        local id = love.image.newImageData(SIZE, SIZE)
        id:mapPixel(function(px, py)
            local a = fn(px / (SIZE - 1), py / (SIZE - 1))
            return 1, 1, 1, math.max(0, math.min(1, a))
        end)
        local img = love.graphics.newImage(id)
        img:setFilter("linear", "linear")
        return img
    end
    local BAND, FEATHER = 0.26, 0.22
    local function edgeAlpha(along, dist)
        local w = love.math.noise(along * 3.5, 3.7) * 0.30
        return ((BAND + w) - dist) / FEATHER
    end
    maskImgs.n = newMask(function(u, v) return edgeAlpha(u, v) end)
    maskImgs.s = newMask(function(u, v) return edgeAlpha(u, 1 - v) end)
    maskImgs.w = newMask(function(u, v) return edgeAlpha(v, u) end)
    maskImgs.e = newMask(function(u, v) return edgeAlpha(v, 1 - u) end)
    local function cornerAlpha(u, v)
        local d = math.sqrt(u * u + v * v)
        local w = love.math.noise(u * 3.0 + 11.3, v * 3.0 + 5.9) * 0.22
        return ((0.38 + w) - d) / FEATHER
    end
    maskImgs.nw = newMask(function(u, v) return cornerAlpha(u, v) end)
    maskImgs.ne = newMask(function(u, v) return cornerAlpha(1 - u, v) end)
    maskImgs.sw = newMask(function(u, v) return cornerAlpha(u, 1 - v) end)
    maskImgs.se = newMask(function(u, v) return cornerAlpha(1 - u, 1 - v) end)

    maskShader = love.graphics.newShader([[
        uniform Image maskTex;
        uniform vec4 tileRect;
        vec4 effect(vec4 color, Image tex, vec2 tc, vec2 sc) {
            vec2 muv = (sc - tileRect.xy) / tileRect.zw;
            float a = Texel(maskTex, muv).a;
            vec4 g = Texel(tex, tc);
            return vec4(g.rgb, g.a * a) * color;
        }
    ]])
end

local function isLand(x, y)
    if x < 1 or y < 1 or x > MAP_W or y > MAP_H then return false end
    return map[y][x] ~= 1
end

-- Textures are pre-processed into truly tileable versions by
-- tools/seamless, so a plain repeat is enough (no mirroring artifacts).
local function drawTerrainQuad(t, v, x, y)
    local cx = (x - 1) % ATLAS_GRID
    local cy = (y - 1) % ATLAS_GRID
    local quad = t.quads[v][cy * ATLAS_GRID + cx]
    love.graphics.draw(t.images[v], quad, (x - 1) * TILE, (y - 1) * TILE, 0,
        TILE / t.cell, TILE / t.cell)
end

local function drawGrassOverhang(x, y, camX, camY)
    local t = terrains.grass
    local v = MAP_TERRAIN_VAR.grass or 1
    local rect = { ((x - 1) * TILE - camX) * SCALE, ((y - 1) * TILE - camY) * SCALE,
        TILE * SCALE, TILE * SCALE }

    local n, s = isLand(x, y - 1), isLand(x, y + 1)
    local wl, e = isLand(x - 1, y), isLand(x + 1, y)

    local function overlay(maskName)
        maskShader:send("maskTex", maskImgs[maskName])
        maskShader:send("tileRect", rect)
        love.graphics.setShader(maskShader)
        love.graphics.setColor(1, 1, 1)
        drawTerrainQuad(t, v, x, y)
        love.graphics.setShader()
    end

    if n then overlay("n") end
    if s then overlay("s") end
    if wl then overlay("w") end
    if e then overlay("e") end
    if not n and not wl and isLand(x - 1, y - 1) then overlay("nw") end
    if not n and not e and isLand(x + 1, y - 1) then overlay("ne") end
    if not s and not wl and isLand(x - 1, y + 1) then overlay("sw") end
    if not s and not e and isLand(x + 1, y + 1) then overlay("se") end
end

local function drawTerrainTile(id, x, y)
    local t = terrains[id]
    local v = MAP_TERRAIN_VAR[id] or 1
    love.graphics.setColor(1, 1, 1)
    drawTerrainQuad(t, v, x, y)
end

local function tryStep(dx, dy, dir)
    if player.walking then return end
    player.dir = dir
    local nx, ny = player.tx + dx, player.ty + dy
    if not isWalkable(nx, ny) then return end
    player.fromX, player.fromY = player.tx, player.ty
    player.tx, player.ty = nx, ny
    player.walking = true
    player.walkT = 0
end

function love.load()
    loadTerrain("grass", "grass", 4)
    loadTerrain("water", "water", 4)
    loadTerrain("stone", "stone", 4)
    loadHero()
    buildMasks()
    buildMap()
    if loadCharacter() then state = "play" end
end

function love.update(dt)
    if state ~= "play" then return end
    if player.walking then
        player.walkT = player.walkT + dt / WALK_TIME
        player.animT = player.animT + dt
        if player.walkT >= 1 then
            player.walking = false
            player.walkT = 0
        end
    else
        player.animT = 0
    end
    if not player.walking then
        if love.keyboard.isDown("up", "w") then tryStep(0, -1, "north")
        elseif love.keyboard.isDown("down", "s") then tryStep(0, 1, "south")
        elseif love.keyboard.isDown("left", "a") then tryStep(-1, 0, "west")
        elseif love.keyboard.isDown("right", "d") then tryStep(1, 0, "east") end
    end
end

function love.keypressed(key)
    if key == "escape" then love.event.quit() end
    if state == "create" then
        local cat = creation.cats[creation.cat]
        local maxIdx = cat.skin and #outfit.skins or #palette
        if key == "tab" then
            creation.cat = creation.cat % #creation.cats + 1
        elseif key == "left" then
            cat.idx = (cat.idx - 2) % maxIdx + 1
        elseif key == "right" then
            cat.idx = cat.idx % maxIdx + 1
        elseif key == "m" then creation.sex = "m"
        elseif key == "f" then creation.sex = "f"
        elseif key == "return" or key == "kpenter" then
            saveCharacter()
            state = "play"
        end
    elseif state == "play" and key == "f2" then
        state = "create" -- re-open creation (choices keep their last values)
    end
end

function love.mousepressed(mx, my, button)
    if state == "create" and button == 1 then
        creationMouse(mx, my)
    end
end

local function playerPixelPos()
    local px = (player.fromX + (player.tx - player.fromX) * player.walkT - 1) * TILE
    local py = (player.fromY + (player.ty - player.fromY) * player.walkT - 1) * TILE
    if not player.walking then
        px, py = (player.tx - 1) * TILE, (player.ty - 1) * TILE
    end
    return px, py
end

function love.draw()
    if state == "create" then
        drawCreation()
        return
    end
    local screenW, screenH = love.graphics.getDimensions()
    local px, py = playerPixelPos()

    love.graphics.push()
    love.graphics.scale(SCALE, SCALE)
    local camX = px + TILE / 2 - screenW / (2 * SCALE)
    local camY = py + TILE / 2 - screenH / (2 * SCALE)
    love.graphics.translate(-camX, -camY)

    -- no clamping: everything outside the map is endless ocean
    local x0 = math.floor(camX / TILE)
    local y0 = math.floor(camY / TILE)
    local x1 = x0 + math.ceil(screenW / (TILE * SCALE)) + 1
    local y1 = y0 + math.ceil(screenH / (TILE * SCALE)) + 1

    for y = y0, y1 do
        for x = x0, x1 do
            local t = 1
            if x >= 1 and y >= 1 and x <= MAP_W and y <= MAP_H then
                t = map[y][x]
            end
            if t == 1 then
                drawTerrainTile("water", x, y)
                drawGrassOverhang(x, y, camX, camY)
            elseif t == 2 then
                drawTerrainTile("stone", x, y)
            else
                drawTerrainTile("grass", x, y)
            end
        end
    end

    -- hero sprite: ~1.9 tiles tall, feet on the tile, walk cycle while moving.
    -- Sheet frames are near-identical, so a procedural bob + slight sway is
    -- layered on top to make the walk read as fluid.
    local frame = 2
    local bob, sway = 0, 0
    if player.walking then
        frame = math.floor(player.animT / 0.07) % hero.cols + 1
        bob = -math.abs(math.sin(player.animT * 11)) * 2.5
        sway = math.sin(player.animT * 11) * 0.03
    end
    local q = hero.quads[player.dir][frame]
    local hscale = (TILE * 1.9) / hero.ch
    local sx = (player.dir == "west") and -hscale or hscale
    love.graphics.setColor(1, 1, 1)
    -- origin at bottom-center of the cell: feet stay planted, mirror and
    -- sway pivot around the feet
    love.graphics.draw(hero.img, q, px + TILE / 2, py + TILE + 2 + bob, sway,
        sx, hscale, hero.cw / 2, hero.ch)

    love.graphics.pop()

    love.graphics.setColor(1, 1, 1)
    love.graphics.print("ALDRUNA — Setas/WASD anda | F2 recria personagem | ESC sai", 8, 8)
    love.graphics.print(("Tile: %d, %d"):format(player.tx, player.ty), 8, 26)
end
