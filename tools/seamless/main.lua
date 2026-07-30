-- One-shot tool: makes each terrain texture truly tileable.
-- Method: shift the image by half its size (seams move to a center cross),
-- then cross-fade that region with the original interior. Edges then wrap
-- perfectly with zero mirroring artifacts.

local NAMES = {
    "grass1", "grass2", "grass3", "grass4",
    "water1", "water2", "water3", "water4",
}

local function makeSeamless(src)
    local W, H = src:getDimensions()
    local out = love.image.newImageData(W, H)
    local halfW, halfH = math.floor(W / 2), math.floor(H / 2)
    local F = W / 8
    for y = 0, H - 1 do
        for x = 0, W - 1 do
            local sx = (x + halfW) % W
            local sy = (y + halfH) % H
            local r, g, b = src:getPixel(sx, sy)
            local dx = math.abs(x - halfW)
            local dy = math.abs(y - halfH)
            local w = math.max(1 - dx / F, 1 - dy / F)
            if w > 0 then
                if w > 1 then w = 1 end
                w = w * w * (3 - 2 * w)
                local r2, g2, b2 = src:getPixel(x, y)
                r = r + (r2 - r) * w
                g = g + (g2 - g) * w
                b = b + (b2 - b) * w
            end
            out:setPixel(x, y, r, g, b, 1)
        end
    end
    return out
end

function love.load()
    for _, name in ipairs(NAMES) do
        local ok, src = pcall(love.image.newImageData, "in/" .. name .. ".jpg")
        if ok then
            local out = makeSeamless(src)
            out:encode("png", name .. ".png")
            print("ok " .. name)
        else
            print("MISSING " .. name)
        end
    end
    print("DONE")
    love.event.quit()
end
