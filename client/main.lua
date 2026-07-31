-- Aldruna client — Step 1: tile-based world + grid movement (Tibia-style)

local TILE = 32              -- world logic runs on a 32px grid
local SCALE = 2              -- drawn at 2x so it fills the window
local WALK_TIME = 0.18       -- seconds to cross one tile

-- Map: 0 = grass (walkable), 1 = water (blocked), 2 = stone floor (walkable)
local MAP_W, MAP_H = 50, 40
local map = {}

local player = {
    tx = 25, ty = 20,        -- tile the player stands on
    fromX = 25, fromY = 20,  -- tile the player is walking from
    walking = false,
    walkT = 0,               -- 0..1 progress across the tile
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
            -- water border around the whole island
            if x <= 2 or y <= 2 or x >= MAP_W - 1 or y >= MAP_H - 1 then
                map[y][x] = 1
            else
                map[y][x] = 0
            end
        end
    end
    -- a small lake
    for y = 8, 12 do
        for x = 34, 42 do map[y][x] = 1 end
    end
    -- a stone plaza in the middle (future town center)
    for y = 17, 23 do
        for x = 21, 29 do map[y][x] = 2 end
    end
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
    love.graphics.setDefaultFilter("nearest", "nearest")
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
    -- held keys keep walking, like Tibia (checked only when a step can start)
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

-- player's smooth pixel position while sliding between tiles
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
    -- camera: keep the player dead-center, Tibia style
    local camX = px + TILE / 2 - screenW / (2 * SCALE)
    local camY = py + TILE / 2 - screenH / (2 * SCALE)
    love.graphics.translate(-camX, -camY)

    -- draw only tiles near the camera
    local x0 = math.max(1, math.floor(camX / TILE))
    local y0 = math.max(1, math.floor(camY / TILE))
    local x1 = math.min(MAP_W, x0 + math.ceil(screenW / (TILE * SCALE)) + 1)
    local y1 = math.min(MAP_H, y0 + math.ceil(screenH / (TILE * SCALE)) + 1)

    for y = y0, y1 do
        for x = x0, x1 do
            local t = map[y][x]
            if t == 1 then
                love.graphics.setColor(0.13, 0.25, 0.45)
            elseif t == 2 then
                love.graphics.setColor(0.42, 0.40, 0.38)
            else
                -- two greens in a checker pattern so movement is visible
                if (x + y) % 2 == 0 then
                    love.graphics.setColor(0.20, 0.35, 0.16)
                else
                    love.graphics.setColor(0.17, 0.31, 0.14)
                end
            end
            love.graphics.rectangle("fill", (x - 1) * TILE, (y - 1) * TILE, TILE, TILE)
        end
    end

    -- player placeholder (real sprite comes in a later step)
    love.graphics.setColor(0.85, 0.72, 0.45)
    love.graphics.rectangle("fill", px + 6, py + 4, TILE - 12, TILE - 8)
    love.graphics.setColor(0.1, 0.1, 0.1)
    love.graphics.rectangle("line", px + 6, py + 4, TILE - 12, TILE - 8)
    -- small mark showing which way the player faces
    love.graphics.setColor(0.9, 0.2, 0.2)
    local cx, cy = px + TILE / 2, py + TILE / 2
    if player.dir == "north" then love.graphics.rectangle("fill", cx - 2, py + 2, 4, 4)
    elseif player.dir == "south" then love.graphics.rectangle("fill", cx - 2, py + TILE - 6, 4, 4)
    elseif player.dir == "west" then love.graphics.rectangle("fill", px + 2, cy - 2, 4, 4)
    else love.graphics.rectangle("fill", px + TILE - 6, cy - 2, 4, 4) end

    love.graphics.pop()

    -- UI text (not scaled)
    love.graphics.setColor(1, 1, 1)
    love.graphics.print("ALDRUNA — passo 1: movimento em grid | Setas/WASD para andar | ESC sai", 8, 8)
    love.graphics.print(("Tile: %d, %d"):format(player.tx, player.ty), 8, 26)
end
