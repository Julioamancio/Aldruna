-- One-shot tool: makes each terrain texture truly tileable.
-- Method: shift the image by half its size (seams move to a center cross),
-- then cross-fade that region with the original interior. Edges then wrap
-- perfectly with zero mirroring artifacts.

local NAMES = {
    "grass1", "grass2", "grass3", "grass4",
    "water1", "water2", "water3", "water4",
}

-- Removes large-scale lighting gradients (e.g. a sun glint covering half the
-- image) so the texture repeats without visible bright patches. Estimates the
-- low-frequency color on a coarse grid and re-centers every pixel around the
-- global mean.
local function flattenLighting(src)
    local W, H = src:getDimensions()
    local C = 48
    local bw, bh = math.ceil(W / C), math.ceil(H / C)
    local sums, counts = {}, {}
    for i = 0, C * C - 1 do sums[i] = { 0, 0, 0 }; counts[i] = 0 end
    for y = 0, H - 1, 2 do
        for x = 0, W - 1, 2 do
            local r, g, b = src:getPixel(x, y)
            local ci = math.floor(y / bh) * C + math.floor(x / bw)
            local s = sums[ci]
            s[1] = s[1] + r; s[2] = s[2] + g; s[3] = s[3] + b
            counts[ci] = counts[ci] + 1
        end
    end
    local mr, mg, mb, n = 0, 0, 0, 0
    for i = 0, C * C - 1 do
        if counts[i] > 0 then
            local s = sums[i]
            s[1] = s[1] / counts[i]; s[2] = s[2] / counts[i]; s[3] = s[3] / counts[i]
            mr = mr + s[1]; mg = mg + s[2]; mb = mb + s[3]; n = n + 1
        end
    end
    mr, mg, mb = mr / n, mg / n, mb / n
    local function cell(cx, cy)
        if cx < 0 then cx = 0 elseif cx > C - 1 then cx = C - 1 end
        if cy < 0 then cy = 0 elseif cy > C - 1 then cy = C - 1 end
        return sums[cy * C + cx]
    end
    local function lowAt(x, y)
        local fx, fy = x / bw - 0.5, y / bh - 0.5
        local x0, y0 = math.floor(fx), math.floor(fy)
        local tx, ty = fx - x0, fy - y0
        local a, b, c, d = cell(x0, y0), cell(x0 + 1, y0), cell(x0, y0 + 1), cell(x0 + 1, y0 + 1)
        local r = (a[1] * (1 - tx) + b[1] * tx) * (1 - ty) + (c[1] * (1 - tx) + d[1] * tx) * ty
        local g = (a[2] * (1 - tx) + b[2] * tx) * (1 - ty) + (c[2] * (1 - tx) + d[2] * tx) * ty
        local bl = (a[3] * (1 - tx) + b[3] * tx) * (1 - ty) + (c[3] * (1 - tx) + d[3] * tx) * ty
        return r, g, bl
    end
    local out = love.image.newImageData(W, H)
    local function cl(v) if v < 0 then return 0 elseif v > 1 then return 1 else return v end end
    for y = 0, H - 1 do
        for x = 0, W - 1 do
            local r, g, b = src:getPixel(x, y)
            local lr, lg, lb = lowAt(x, y)
            out:setPixel(x, y, cl(r - lr + mr), cl(g - lg + mg), cl(b - lb + mb), 1)
        end
    end
    return out
end

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

function love.load(arglist)
    local names = (arglist and #arglist > 0) and arglist or NAMES
    for _, name in ipairs(names) do
        local ok, src = pcall(love.image.newImageData, "in/" .. name .. ".jpg")
        if ok then
            if name:find("^water") then
                src = flattenLighting(src)
            end
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
