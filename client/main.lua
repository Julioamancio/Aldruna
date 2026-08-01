-- Aldruna client — terrain sprites + layered LPC character

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

-- ---------------------------------------------------------------------------
-- Character appearance
--
-- One appearance table drives everything: the creation preview and the sprite
-- walking on the map are built from the SAME sheet, so what the player
-- customises is literally what they play as. Editing later (F2) reopens this
-- exact screen.
-- ---------------------------------------------------------------------------
local state = "create" -- "create" -> "play"
local palette = outfit.palette()

local appearance = {
    sex = "m",
    hair = 1,
    skin = 3,
    head = 96,       -- cabelo
    primary = 88,    -- túnica
    secondary = 118, -- calça
    detail = 130,    -- bota
}

-- The built sheet + quads, shared by the preview and the world.
local char = { sheet = nil, quads = nil, dirty = true }

local function rebuildChar()
    char.sheet = outfit.buildSheet(appearance)
    char.quads = char.quads or outfit.buildQuads()
    char.dirty = false
end

local function ensureChar()
    if char.dirty then rebuildChar() end
end

-- Color tabs, named exactly like Tibia's. "Pele" is an Aldruna addition.
local cats = {
    { key = "head",      label = "Cabeça" },
    { key = "primary",   label = "Primária" },
    { key = "secondary", label = "Secundária" },
    { key = "detail",    label = "Detalhe" },
    { key = "skin",      label = "Pele", skin = true },
}
local curCat = 1

local preview = { dir = "south", t = 0, moving = true }

local SAVE_FILE = "character.txt"

local function saveCharacter()
    local keys = { "sex", "hair", "skin", "head", "primary", "secondary", "detail" }
    local lines = {}
    for _, k in ipairs(keys) do
        lines[#lines + 1] = k .. "=" .. tostring(appearance[k])
    end
    love.filesystem.write(SAVE_FILE, table.concat(lines, "\n"))
end

local function loadCharacter()
    if not love.filesystem.getInfo(SAVE_FILE) then return false end
    local data = love.filesystem.read(SAVE_FILE) or ""
    local raw = {}
    for k, v in data:gmatch("(%w+)=(%w+)") do raw[k] = v end

    -- Saves written before the LPC rewrite used shirt/legs/shoes for the color
    -- slots and stored a *color* index in "hair" (there were no hairstyles
    -- yet). Migrate them so the player keeps the colors they already picked.
    if raw.shirt and not raw.primary then
        raw.head = raw.hair
        raw.primary, raw.secondary, raw.detail = raw.shirt, raw.legs, raw.shoes
        raw.hair = "1"
    end

    appearance.sex = (raw.sex == "f") and "f" or "m"
    for _, k in ipairs({ "hair", "skin", "head", "primary", "secondary", "detail" }) do
        if raw[k] then appearance[k] = tonumber(raw[k]) or appearance[k] end
    end

    -- Clamp everything: a stale index would silently blank out a layer.
    local function clamp(k, n)
        if appearance[k] < 1 or appearance[k] > n then appearance[k] = 1 end
    end
    clamp("hair", math.max(#outfit.hairstyles, 1))
    clamp("skin", #outfit.skins)
    for _, k in ipairs({ "head", "primary", "secondary", "detail" }) do
        clamp(k, #palette)
    end

    char.dirty = true
    return true
end

-- Layout shared by draw and mouse handling. Mirrors Tibia's "Customise
-- Character" dialog: preview top-left, hair picker on the right, color tabs
-- and palette bottom-left, Ok/Cancel at the bottom.
local function creationLayout()
    local W, H = love.graphics.getDimensions()
    local L = {}
    L.cell = 20
    L.gridW, L.gridH = outfit.H_STEPS * L.cell, outfit.SI_ROWS * L.cell
    L.panW, L.panH = 880, 690
    L.panX, L.panY = math.floor((W - L.panW) / 2), math.floor((H - L.panH) / 2)
    -- preview
    L.prevX, L.prevY = L.panX + 20, L.panY + 50
    L.prevW, L.prevH = 400, 260
    -- sex buttons under the preview
    L.sexY = L.prevY + L.prevH + 12
    L.sexX, L.sexW, L.sexH = L.prevX, 120, 30
    -- color tabs + palette
    L.tabY = L.sexY + L.sexH + 34
    L.tabW, L.tabH = 84, 28
    L.gridX, L.gridY = L.prevX, L.tabY + L.tabH + 10
    -- hair picker (right column)
    L.hairX, L.hairY = L.panX + 450, L.panY + 50
    L.hairCW, L.hairCH = 200, 54
    -- buttons
    L.btnW, L.btnH = 120, 36
    L.btnY = L.panY + L.panH - 56
    L.okX = L.panX + L.panW - 2 * L.btnW - 30
    L.cancelX = L.panX + L.panW - L.btnW - 20
    return L
end

local function catColor(c)
    if c.skin then
        local s = outfit.skins[appearance.skin]
        -- skin values are multipliers; show them against the sprite's own tone
        return { math.min(s[1] * 0.85, 1), math.min(s[2] * 0.72, 1), math.min(s[3] * 0.60, 1) }
    end
    return palette[appearance[c.key]]
end

-- Draw the real character sheet -- the same texture the world uses.
local function drawChar(cx, cy, scale, dir, frame)
    local q = char.quads[dir][frame]
    love.graphics.setColor(1, 1, 1)
    love.graphics.draw(char.sheet, q, cx, cy, 0, scale, scale,
        outfit.MID_X, outfit.FOOT_Y)
end

local function panel(x, y, w, h, title)
    love.graphics.setColor(0.24, 0.24, 0.26)
    love.graphics.rectangle("fill", x, y, w, h)
    love.graphics.setColor(0.42, 0.42, 0.45)
    love.graphics.rectangle("line", x, y, w, h)
    if title then
        love.graphics.setColor(0.92, 0.92, 0.92)
        love.graphics.printf(title, x, y - 18, w, "center")
    end
end

local function drawCreation()
    local L = creationLayout()
    local W, H = love.graphics.getDimensions()
    love.graphics.setColor(0.07, 0.08, 0.10)
    love.graphics.rectangle("fill", 0, 0, W, H)

    -- dialog frame
    love.graphics.setColor(0.30, 0.30, 0.32)
    love.graphics.rectangle("fill", L.panX, L.panY, L.panW, L.panH)
    love.graphics.setColor(0.50, 0.50, 0.54)
    love.graphics.rectangle("line", L.panX, L.panY, L.panW, L.panH)
    love.graphics.setColor(1, 1, 1)
    love.graphics.printf("Criar Personagem", L.panX, L.panY + 14, L.panW, "center")

    -- preview on a tile floor, like Tibia's "Show Floor"
    panel(L.prevX, L.prevY, L.prevW, L.prevH, "Prévia — clique para girar")
    love.graphics.setScissor(L.prevX + 1, L.prevY + 1, L.prevW - 2, L.prevH - 2)
    love.graphics.setColor(0.62, 0.62, 0.64)
    for gy = 0, L.prevH, 32 do
        for gx = 0, L.prevW, 32 do
            love.graphics.rectangle("line", L.prevX + gx, L.prevY + gy, 32, 32)
        end
    end
    local pframe = 1
    if preview.moving then
        pframe = math.floor(preview.t / 0.09) % outfit.COLS + 1
    end
    drawChar(L.prevX + L.prevW / 2, L.prevY + L.prevH - 40, 3.4, preview.dir, pframe)
    love.graphics.setScissor()

    -- sex
    local sexes = { { "m", "Masculino" }, { "f", "Feminino" } }
    for i, sx in ipairs(sexes) do
        local bx = L.sexX + (i - 1) * (L.sexW + 10)
        local on = appearance.sex == sx[1]
        love.graphics.setColor(on and 0.30 or 0.20, on and 0.45 or 0.20, on and 0.62 or 0.22)
        love.graphics.rectangle("fill", bx, L.sexY, L.sexW, L.sexH)
        love.graphics.setColor(0.55, 0.55, 0.58)
        love.graphics.rectangle("line", bx, L.sexY, L.sexW, L.sexH)
        love.graphics.setColor(1, 1, 1)
        love.graphics.printf(sx[2], bx, L.sexY + 8, L.sexW, "center")
    end

    -- color tabs
    love.graphics.setColor(0.92, 0.92, 0.92)
    love.graphics.print("Cores", L.prevX, L.tabY - 20)
    for i, c in ipairs(cats) do
        local bx = L.prevX + (i - 1) * (L.tabW + 4)
        local on = curCat == i
        love.graphics.setColor(on and 0.42 or 0.22, on and 0.42 or 0.22, on and 0.48 or 0.25)
        love.graphics.rectangle("fill", bx, L.tabY, L.tabW, L.tabH)
        love.graphics.setColor(0.55, 0.55, 0.58)
        love.graphics.rectangle("line", bx, L.tabY, L.tabW, L.tabH)
        local col = catColor(c)
        love.graphics.setColor(col[1], col[2], col[3])
        love.graphics.rectangle("fill", bx + 4, L.tabY + 6, 12, 16)
        love.graphics.setColor(1, 1, 1)
        love.graphics.print(c.label, bx + 20, L.tabY + 7)
    end

    -- palette: 19x7 grid, or the skin ramp when "Pele" is selected
    local cat = cats[curCat]
    if cat.skin then
        for i = 1, #outfit.skins do
            local x = L.gridX + ((i - 1) % 10) * (L.cell + 12)
            local y = L.gridY
            local s = outfit.skins[i]
            love.graphics.setColor(math.min(s[1] * 0.85, 1), math.min(s[2] * 0.72, 1),
                math.min(s[3] * 0.60, 1))
            love.graphics.rectangle("fill", x, y, L.cell + 8, L.cell + 8)
            if appearance.skin == i then
                love.graphics.setColor(1, 1, 1)
                love.graphics.rectangle("line", x - 2, y - 2, L.cell + 12, L.cell + 12)
            end
        end
    else
        for i = 1, #palette do
            local col = palette[i]
            local x = L.gridX + ((i - 1) % outfit.H_STEPS) * L.cell
            local y = L.gridY + math.floor((i - 1) / outfit.H_STEPS) * L.cell
            love.graphics.setColor(col[1], col[2], col[3])
            love.graphics.rectangle("fill", x, y, L.cell - 1, L.cell - 1)
            if appearance[cat.key] == i then
                love.graphics.setColor(1, 1, 1)
                love.graphics.rectangle("line", x - 1.5, y - 1.5, L.cell + 2, L.cell + 2)
            end
        end
    end

    -- hair picker
    local rows = math.ceil(#outfit.hairstyles / 2)
    panel(L.hairX, L.hairY, 2 * L.hairCW + 10, rows * L.hairCH + 20, "Cabelo")
    for i, h in ipairs(outfit.hairstyles) do
        local hx = L.hairX + 5 + ((i - 1) % 2) * L.hairCW
        local hy = L.hairY + 10 + math.floor((i - 1) / 2) * L.hairCH
        local on = appearance.hair == i
        love.graphics.setColor(on and 0.22 or 0.18, on and 0.38 or 0.18, on and 0.58 or 0.20)
        love.graphics.rectangle("fill", hx, hy, L.hairCW - 10, L.hairCH - 8)
        love.graphics.setColor(0.5, 0.5, 0.53)
        love.graphics.rectangle("line", hx, hy, L.hairCW - 10, L.hairCH - 8)
        love.graphics.setColor(1, 1, 1)
        love.graphics.print(h.label, hx + 12, hy + 14)
    end

    -- buttons
    love.graphics.setColor(0.22, 0.50, 0.26)
    love.graphics.rectangle("fill", L.okX, L.btnY, L.btnW, L.btnH)
    love.graphics.setColor(1, 1, 1)
    love.graphics.printf("Ok", L.okX, L.btnY + 10, L.btnW, "center")
    love.graphics.setColor(0.35, 0.25, 0.25)
    love.graphics.rectangle("fill", L.cancelX, L.btnY, L.btnW, L.btnH)
    love.graphics.setColor(1, 1, 1)
    love.graphics.printf("Cancelar", L.cancelX, L.btnY + 10, L.btnW, "center")

    love.graphics.setColor(0.75, 0.75, 0.78)
    love.graphics.print("Tab troca a aba | setas mudam a cor | M/F sexo | Enter confirma",
        L.panX + 20, L.btnY + 11)
end

local function creationMouse(mx, my)
    local L = creationLayout()
    local function hit(x, y, w, h)
        return mx >= x and mx <= x + w and my >= y and my <= y + h
    end
    -- clicking the preview rotates the character, like turning in-game
    if hit(L.prevX, L.prevY, L.prevW, L.prevH) then
        local order = { "south", "west", "north", "east" }
        for i, d in ipairs(order) do
            if preview.dir == d then
                preview.dir = order[i % #order + 1]
                return
            end
        end
        return
    end
    for i = 1, 2 do
        if hit(L.sexX + (i - 1) * (L.sexW + 10), L.sexY, L.sexW, L.sexH) then
            appearance.sex = (i == 2) and "f" or "m"
            char.dirty = true
            return
        end
    end
    for i = 1, #cats do
        if hit(L.prevX + (i - 1) * (L.tabW + 4), L.tabY, L.tabW, L.tabH) then
            curCat = i
            return
        end
    end
    for i in ipairs(outfit.hairstyles) do
        local hx = L.hairX + 5 + ((i - 1) % 2) * L.hairCW
        local hy = L.hairY + 10 + math.floor((i - 1) / 2) * L.hairCH
        if hit(hx, hy, L.hairCW - 10, L.hairCH - 8) then
            appearance.hair = i
            char.dirty = true
            return
        end
    end
    local cat = cats[curCat]
    if cat.skin then
        for i = 1, #outfit.skins do
            local x = L.gridX + ((i - 1) % 10) * (L.cell + 12)
            if hit(x, L.gridY, L.cell + 8, L.cell + 8) then
                appearance.skin = i
                char.dirty = true
                return
            end
        end
    elseif hit(L.gridX, L.gridY, L.gridW, L.gridH) then
        local gx = math.floor((mx - L.gridX) / L.cell)
        local gy = math.floor((my - L.gridY) / L.cell)
        appearance[cat.key] = gy * outfit.H_STEPS + gx + 1
        char.dirty = true
        return
    end
    if hit(L.okX, L.btnY, L.btnW, L.btnH) then
        saveCharacter()
        state = "play"
    elseif hit(L.cancelX, L.btnY, L.btnW, L.btnH) then
        if loadCharacter() then state = "play" end
    end
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
    outfit.load()
    rebuildChar()
    buildMasks()
    buildMap()
    if loadCharacter() then state = "play" end
end

function love.update(dt)
    if state == "create" then
        preview.t = preview.t + dt
        return
    end
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
        local cat = cats[curCat]
        if key == "tab" then
            curCat = curCat % #cats + 1
        elseif key == "left" or key == "right" then
            local step = (key == "right") and 1 or -1
            if cat.skin then
                appearance.skin = (appearance.skin - 1 + step) % #outfit.skins + 1
            else
                appearance[cat.key] = (appearance[cat.key] - 1 + step) % #palette + 1
            end
            char.dirty = true
        elseif key == "up" or key == "down" then
            local step = (key == "down") and 1 or -1
            appearance.hair = (appearance.hair - 1 + step) % #outfit.hairstyles + 1
            char.dirty = true
        elseif key == "m" then
            appearance.sex = "m"; char.dirty = true
        elseif key == "f" then
            appearance.sex = "f"; char.dirty = true
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
    -- Rebuild the sheet here, at the top of the draw phase with the identity
    -- transform still in place. Doing it from love.update leaves the draw
    -- commands outside the render frame and the canvas comes out blank; doing
    -- it later in this function would bake the world camera into the canvas.
    ensureChar()

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

    -- Hero: the very sheet built in the creation screen. The art has 9 real
    -- walk frames per direction, so no procedural bob is needed anymore, and
    -- all four facings exist -- nothing is mirrored.
    local frame = 1
    if player.walking then
        frame = math.floor(player.animT / 0.09) % outfit.COLS + 1
    end
    drawChar(px + TILE / 2, py + TILE, 1, player.dir, frame)

    love.graphics.pop()

    love.graphics.setColor(1, 1, 1)
    love.graphics.print("ALDRUNA — Setas/WASD anda | F2 edita personagem | ESC sai", 8, 8)
    love.graphics.print(("Tile: %d, %d"):format(player.tx, player.ty), 8, 26)
end
