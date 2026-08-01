-- Aldruna outfit system.
--
-- Palette: the classic 133-color (19x7 HSI) grid ported from the original
-- Tibia client, so the color choices feel identical to the reference game.
--
-- Art: Liberated Pixel Cup (LPC) layered sprites. Each body part is its own
-- PNG sheet, so a character is built by tinting and stacking layers. That
-- replaces the old color-mask approach entirely -- there is no template
-- image and no magic red/green/blue regions anymore.
--
-- Slot mapping (matches Tibia's "Customise Character" tabs):
--   Head      -> hair
--   Primary   -> torso / tunic
--   Secondary -> legs
--   Detail    -> boots
--   Pele      -> body + head (Aldruna extra; Tibia does not recolor skin)
local M = {}

M.H_STEPS, M.SI_ROWS = 19, 7 -- 19 hues x 7 saturation/intensity rows

-- Color index -> r,g,b (0..1). Port of the classic client algorithm:
-- column 0 is a grayscale ramp; the other 18 columns are hues at 7
-- fixed saturation/intensity pairs.
function M.color(index)
    local total = M.H_STEPS * M.SI_ROWS
    if index < 0 or index >= total then index = 0 end
    local hue, sat, int = 0, 0, 1
    if index % M.H_STEPS ~= 0 then
        hue = (index % M.H_STEPS) / 18.0
        local row = math.floor(index / M.H_STEPS)
        if row == 0 then sat, int = 0.25, 1.00
        elseif row == 1 then sat, int = 0.25, 0.75
        elseif row == 2 then sat, int = 0.50, 0.75
        elseif row == 3 then sat, int = 0.667, 0.75
        elseif row == 4 then sat, int = 1.00, 1.00
        elseif row == 5 then sat, int = 1.00, 0.75
        else sat, int = 1.00, 0.50 end
    else
        hue, sat = 0, 0
        int = 1 - math.floor(index / M.H_STEPS) / 7.0
    end
    if int == 0 then return 0, 0, 0 end
    if sat == 0 then return int, int, int end
    local r, g, b
    local lo = int * (1 - sat)
    local h6 = hue * 6
    if h6 < 1 then
        r, b = int, lo; g = b + (r - b) * h6
    elseif h6 < 2 then
        g, b = int, lo; r = g - (g - b) * (h6 - 1)
    elseif h6 < 3 then
        g, r = int, lo; b = r + (g - r) * (h6 - 2)
    elseif h6 < 4 then
        b, r = int, lo; g = b - (b - r) * (h6 - 3)
    elseif h6 < 5 then
        b, g = int, lo; r = g + (b - g) * (h6 - 4)
    else
        r, g = int, lo; b = r - (r - g) * (h6 - 5)
    end
    return r, g, b
end

function M.palette()
    local t = {}
    for i = 0, M.H_STEPS * M.SI_ROWS - 1 do
        t[i + 1] = { M.color(i) }
    end
    return t
end

-- Skin is a MULTIPLIER over the original art, not a replacement color: the
-- head sheet carries the eyes, and graying it out first would tint them skin
-- colored too. Multiplying keeps the eyes blue while the face shifts tone.
-- 1.0 is the sprite's own tone; above it lightens, below it darkens.
M.skins = {
    { 1.18, 1.12, 1.06 }, -- muito clara
    { 1.08, 1.03, 0.98 },
    { 1.00, 1.00, 1.00 }, -- tom original da arte
    { 0.90, 0.80, 0.68 },
    { 0.78, 0.65, 0.50 },
    { 0.66, 0.52, 0.38 },
    { 0.54, 0.40, 0.28 },
    { 0.42, 0.30, 0.20 },
    { 0.31, 0.21, 0.14 }, -- muito escura
    { 0.62, 0.80, 0.66 }, -- esverdeada (raças futuras)
}

-- ---------------------------------------------------------------------------
-- LPC sheet geometry
-- ---------------------------------------------------------------------------
M.FRAME = 64  -- every cell is 64x64
M.COLS  = 9   -- 9 walk frames per direction
M.ROWS  = 4

-- Row order inside an LPC walk sheet.
M.DIR_ROW = { north = 0, west = 1, south = 2, east = 3 }

-- Measured from the art: the character occupies x 17..46, y 13..61 inside the
-- 64px cell -- 30 wide by 49 tall, feet resting on y=61. Drawing with the
-- origin at (MID_X, FOOT_Y) plants the feet exactly on the tile.
M.MID_X, M.FOOT_Y, M.CHAR_H = 32, 62, 49

M.hairstyles = {
    { key = "plain",   label = "Liso" },
    { key = "messy",   label = "Bagunçado" },
    { key = "buzzcut", label = "Raspado" },
    { key = "bob",     label = "Chanel" },
    { key = "long",    label = "Comprido" },
    { key = "curly",   label = "Cacheado" },
}

-- Layers that get an arbitrary hue are stored as luminance, so a flat color
-- multiply repaints them cleanly. GAIN lifts the midtones a little; without
-- it, dark source art (brown boots, dark tunic) tints muddy.
local GAIN = 1.30

local raw, gray = {}, {} -- name -> Image

local function loadLayer(name, tintable)
    local path = "assets/lpc/" .. name .. ".png"
    if not love.filesystem.getInfo(path) then return false end
    local data = love.image.newImageData(path)
    if tintable then
        data:mapPixel(function(_, _, r, g, b, a)
            if a <= 0 then return 0, 0, 0, 0 end
            local l = math.min((0.299 * r + 0.587 * g + 0.114 * b) * GAIN, 1)
            return l, l, l, a
        end)
        gray[name] = love.graphics.newImage(data)
        gray[name]:setFilter("nearest", "nearest")
    else
        raw[name] = love.graphics.newImage(data)
        raw[name]:setFilter("nearest", "nearest")
    end
    return true
end

-- Called once from love.load.
function M.load()
    for _, sex in ipairs({ "m", "f" }) do
        loadLayer("body_" .. sex, false) -- skin: multiplied, not grayed
        loadLayer("head_" .. sex, false)
        loadLayer("torso_" .. sex, true)
        loadLayer("legs_" .. sex, true)
        loadLayer("feet_" .. sex, true)
    end
    -- Some hairstyles may be missing; drop them so the picker never shows a
    -- style that cannot be drawn.
    local ok = {}
    for _, h in ipairs(M.hairstyles) do
        if loadLayer("hair_" .. h.key, true) then ok[#ok + 1] = h end
    end
    M.hairstyles = ok
end

-- Build the finished character sheet: every layer tinted and stacked into one
-- 576x256 texture. The creation preview and the world sprite both draw from
-- this, so what you customise IS what walks around the map.
--
-- app = { sex, hair (index), skin (index), head, primary, secondary, detail }
-- where head/primary/secondary/detail are palette indices.
function M.buildSheet(app)
    local pal = M.palette()
    local sex = (app.sex == "f") and "f" or "m"
    local style = M.hairstyles[app.hair] or M.hairstyles[1]

    local canvas = love.graphics.newCanvas(M.FRAME * M.COLS, M.FRAME * M.ROWS)
    canvas:setFilter("nearest", "nearest")

    -- The sheet may be rebuilt while the world camera transform is active.
    -- Without resetting it, the layers would be drawn hundreds of pixels off
    -- the canvas and the character would come out invisible.
    local prev = love.graphics.getCanvas()
    love.graphics.push("all")
    love.graphics.origin()
    love.graphics.setShader()
    love.graphics.setBlendMode("alpha")
    love.graphics.setCanvas(canvas)
    love.graphics.clear(0, 0, 0, 0)

    local skin = M.skins[app.skin] or M.skins[3]
    local function put(img, c)
        if not img then return end
        love.graphics.setColor(c[1], c[2], c[3], 1)
        love.graphics.draw(img, 0, 0)
    end
    -- draw order: skin first, then clothing bottom-up, hair last
    put(raw["body_" .. sex], skin)
    put(raw["head_" .. sex], skin)
    put(gray["legs_" .. sex], pal[app.secondary])
    put(gray["feet_" .. sex], pal[app.detail])
    put(gray["torso_" .. sex], pal[app.primary])
    if style then put(gray["hair_" .. style.key], pal[app.head]) end

    love.graphics.setCanvas(prev)
    love.graphics.pop()
    return canvas
end

-- Quads for one built sheet, indexed quads[dir][frame].
function M.buildQuads()
    local w, h = M.FRAME * M.COLS, M.FRAME * M.ROWS
    local q = {}
    for dir, row in pairs(M.DIR_ROW) do
        q[dir] = {}
        for i = 0, M.COLS - 1 do
            q[dir][i + 1] = love.graphics.newQuad(
                i * M.FRAME, row * M.FRAME, M.FRAME, M.FRAME, w, h)
        end
    end
    return q
end

return M
