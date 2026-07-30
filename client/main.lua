-- Aldruna client — Step 2: real terrain sprites (grass + water from art_raw)

local TILE = 32              -- world logic runs on a 32px grid
local SCALE = 2              -- drawn at 2x so it fills the window
local WALK_TIME = 0.18       -- seconds to cross one tile
local ATLAS_GRID = 4         -- each terrain image is used as a 4x4 atlas of subtiles
                             -- (bigger source cells = finer-looking grass per tile)

-- Each Flow variation only tiles seamlessly with itself, so a map uses ONE
-- variation per terrain; other variations are reserved for other regions.
local MAP_TERRAIN_VAR = { grass = 1, water = 1 }

-- Map: 0 = grass (walkable), 1 = water (blocked), 2 = stone floor (walkable)
local MAP_W, MAP_H = 50, 40
local map = {}

local terrains = {}          -- terrains[id] = { images = {..}, quads = {..}, cell = px }

local player = {
    tx = 25, ty = 20,
    fromX = 25, fromY = 20,
    walking = false,
    walkT = 0,
    dir = "south",
}

local function isWalkable(tx, ty)
    if tx < 1 or ty < 1 or tx > MAP_W or ty > MAP_H then return false end
    return map[ty][tx] ~= 1
end

local function buildMap()
    for y = 1, MAP_H do
        map[y] = {}
        for x = 1, MAP_W do
            if x <= 2 or y <= 2 or x >= MAP_W - 1 or y >= MAP_H - 1 then
                map[y][x] = 1
            else
                map[y][x] = 0
            end
        end
    end
    for y = 8, 12 do
        for x = 34, 42 do map[y][x] = 1 end
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
    local BAND, FEATHER = 0.30, 0.20
    local function edgeAlpha(along, dist)
        local w = love.math.noise(along * 6.0, 3.7) * 0.18
        return ((BAND + w) - dist) / FEATHER
    end
    maskImgs.n = newMask(function(u, v) return edgeAlpha(u, v) end)
    maskImgs.s = newMask(function(u, v) return edgeAlpha(u, 1 - v) end)
    maskImgs.w = newMask(function(u, v) return edgeAlpha(v, u) end)
    maskImgs.e = newMask(function(u, v) return edgeAlpha(v, 1 - u) end)
    local function cornerAlpha(u, v)
        local d = math.sqrt(u * u + v * v)
        local w = love.math.noise(u * 4.0 + 11.3, v * 4.0 + 5.9) * 0.14
        return ((0.34 + w) - d) / FEATHER
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
    buildMasks()
    buildMap()
end

function love.update(dt)
    if player.walking then
        player.walkT = player.walkT + dt / WALK_TIME
        if player.walkT >= 1 then
            player.walking = false
            player.walkT = 0
        end
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
    local screenW, screenH = love.graphics.getDimensions()
    local px, py = playerPixelPos()

    love.graphics.push()
    love.graphics.scale(SCALE, SCALE)
    local camX = px + TILE / 2 - screenW / (2 * SCALE)
    local camY = py + TILE / 2 - screenH / (2 * SCALE)
    love.graphics.translate(-camX, -camY)

    local x0 = math.max(1, math.floor(camX / TILE))
    local y0 = math.max(1, math.floor(camY / TILE))
    local x1 = math.min(MAP_W, x0 + math.ceil(screenW / (TILE * SCALE)) + 1)
    local y1 = math.min(MAP_H, y0 + math.ceil(screenH / (TILE * SCALE)) + 1)

    for y = y0, y1 do
        for x = x0, x1 do
            local t = map[y][x]
            if t == 1 then
                drawTerrainTile("water", x, y)
                drawGrassOverhang(x, y, camX, camY)
            elseif t == 2 then
                -- stone plaza: no sprite yet, flat color until the stone texture arrives
                love.graphics.setColor(0.42, 0.40, 0.38)
                love.graphics.rectangle("fill", (x - 1) * TILE, (y - 1) * TILE, TILE, TILE)
            else
                drawTerrainTile("grass", x, y)
            end
        end
    end

    -- player placeholder (hero sprites come in a later step)
    love.graphics.setColor(0.85, 0.72, 0.45)
    love.graphics.rectangle("fill", px + 6, py + 4, TILE - 12, TILE - 8)
    love.graphics.setColor(0.1, 0.1, 0.1)
    love.graphics.rectangle("line", px + 6, py + 4, TILE - 12, TILE - 8)
    love.graphics.setColor(0.9, 0.2, 0.2)
    local cx, cy = px + TILE / 2, py + TILE / 2
    if player.dir == "north" then love.graphics.rectangle("fill", cx - 2, py + 2, 4, 4)
    elseif player.dir == "south" then love.graphics.rectangle("fill", cx - 2, py + TILE - 6, 4, 4)
    elseif player.dir == "west" then love.graphics.rectangle("fill", px + 2, cy - 2, 4, 4)
    else love.graphics.rectangle("fill", px + TILE - 6, cy - 2, 4, 4) end

    love.graphics.pop()

    love.graphics.setColor(1, 1, 1)
    love.graphics.print("ALDRUNA — passo 2: terreno com sprites | Setas/WASD anda | ESC sai", 8, 8)
    love.graphics.print(("Tile: %d, %d"):format(player.tx, player.ty), 8, 26)
end
