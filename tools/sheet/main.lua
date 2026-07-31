-- One-shot tool: turns a Flow character sheet (grid on green chroma) into a
-- transparent sprite sheet ready for the client.
-- Usage: love tools/sheet <name> [cols] [rows]  (reads in/<name>.jpg)

local function isGreen(r, g, b)
    return g > 0.40 and g > r * 1.30 and g > b * 1.30
end

function love.load(arglist)
    local name = arglist[1] or "warrior"
    local COLS = tonumber(arglist[2]) or 6
    local ROWS = tonumber(arglist[3]) or 4
    local src = love.image.newImageData("in/" .. name .. ".jpg")
    local W, H = src:getDimensions()
    local cw, ch = W / COLS, H / ROWS
    -- generous margin removes the black grid lines between cells
    local mx, my = math.floor(cw * 0.035), math.floor(ch * 0.035)
    local ocw, och = math.floor(cw) - 2 * mx, math.floor(ch) - 2 * my
    local out = love.image.newImageData(ocw * COLS, och * ROWS)
    for row = 0, ROWS - 1 do
        for col = 0, COLS - 1 do
            local x0 = math.floor(col * cw) + mx
            local y0 = math.floor(row * ch) + my
            for y = 0, och - 1 do
                for x = 0, ocw - 1 do
                    local r, g, b = src:getPixel(x0 + x, y0 + y)
                    if isGreen(r, g, b) then
                        out:setPixel(col * ocw + x, row * och + y, 0, 0, 0, 0)
                    else
                        -- despill: JPEG edges keep a green fringe; cap green
                        local m = math.max(r, b)
                        if g > m then g = m end
                        out:setPixel(col * ocw + x, row * och + y, r, g, b, 1)
                    end
                end
            end
        end
    end
    out:encode("png", name .. ".png")
    print(("ok %s: %dx%d cells of %dx%d"):format(name, COLS, ROWS, ocw, och))
    love.event.quit()
end
