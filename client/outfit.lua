-- Tibia-style outfit system: the 133-color palette (19x7 HSI grid) used by
-- the original game, plus template colorization (mask multiply).
--
-- Template convention (same as Tibia, plus skin):
--   yellow = hair, red = shirt/torso, green = legs, blue = feet/shoes,
--   cyan = skin (Aldruna extra; Tibia does not recolor skin).
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

-- Hand-picked skin tone ramp (pale to deep, plus two fantasy tones).
local function hex(s)
    return { tonumber(s:sub(1, 2), 16) / 255, tonumber(s:sub(3, 4), 16) / 255,
        tonumber(s:sub(5, 6), 16) / 255 }
end
M.skins = {
    hex("FFE7D1"), hex("F6D7B0"), hex("EAC086"), hex("D9A066"),
    hex("C68642"), hex("A56A3A"), hex("8D5524"), hex("6B4226"),
    hex("4A2C17"), hex("9FB5A8"), -- esverdeado (raças futuras)
}

-- Colorize a base sprite using its template mask.
-- baseData/maskData: ImageData of the same size. colors: table with rgb
-- tables { hair=, skin=, shirt=, legs=, shoes= }. Returns a new ImageData.
function M.colorize(baseData, maskData, colors)
    local out = baseData:clone()
    out:mapPixel(function(x, y, r, g, b, a)
        if a <= 0 then return r, g, b, a end
        local mr, mg, mb, ma = maskData:getPixel(x, y)
        if ma <= 0 then return r, g, b, a end
        local tint
        if mr > 0.5 and mg > 0.5 and mb < 0.5 then tint = colors.hair
        elseif mr > 0.5 and mg < 0.5 and mb < 0.5 then tint = colors.shirt
        elseif mr < 0.5 and mg > 0.5 and mb < 0.5 then tint = colors.legs
        elseif mr < 0.5 and mg < 0.5 and mb > 0.5 then tint = colors.shoes
        elseif mr < 0.5 and mg > 0.5 and mb > 0.5 then tint = colors.skin
        end
        if tint then
            return r * tint[1], g * tint[2], b * tint[3], a
        end
        return r, g, b, a
    end)
    return out
end

return M
