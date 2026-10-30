--!strict

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local state = ReplicatedStorage:WaitForChild("BombState")
local passBomb = ReplicatedStorage:WaitForChild("PassBomb") :: RemoteEvent

local holder: Player? = nil
local deadline = 0
local joinGeneration = 0
local fuseGeneration = 0
local explosions = 0

local function publish(status: string)
	state:SetAttribute("HolderUserId", if holder then holder.UserId else 0)
	state:SetAttribute("FuseDeadline", deadline)
	state:SetAttribute("ExplosionCount", explosions)
	state:SetAttribute("Status", status)
end

local function clear(status: string)
	holder = nil
	deadline = 0
	fuseGeneration += 1
	publish(status)
end

local function arm(player: Player)
	holder = player
	deadline = workspace:GetServerTimeNow() + 8
	fuseGeneration += 1
	local generation = fuseGeneration
	publish("armed")
	task.delay(8, function()
		if generation ~= fuseGeneration or holder == nil then return end
		local victim = holder
		local character = victim.Character
		local humanoid = if character then character:FindFirstChildOfClass("Humanoid") else nil
		explosions += 1
		clear("inactive")
		if humanoid then humanoid:TakeDamage(40) end
	end)
end

local function scheduleInitialOwner()
	joinGeneration += 1
	local generation = joinGeneration
	if holder ~= nil then return end
	local joined = Players:GetPlayers()
	if #joined == 0 then return end
	-- Allow a multiplayer server to finish admitting its second player. A solo
	-- presentation still arms after this bounded grace period.
	local settleSeconds = if #joined == 1 then 12 else 2
	task.delay(settleSeconds, function()
		if generation ~= joinGeneration or holder ~= nil then return end
		local stable = Players:GetPlayers()
		if #stable ~= #joined then return end
		table.sort(stable, function(left, right) return left.UserId < right.UserId end)
		if stable[1] then arm(stable[1]) end
	end)
end

local function rootPart(player: Player): BasePart?
	local character = player.Character
	return if character then character:FindFirstChild("HumanoidRootPart") :: BasePart? else nil
end

passBomb.OnServerEvent:Connect(function(sender, ...)
	if sender ~= holder or select("#", ...) ~= 0 then return end
	if workspace:GetServerTimeNow() >= deadline then return end
	local senderRoot = rootPart(sender)
	if senderRoot == nil then return end
	local nearest: Player? = nil
	local nearestDistance = 12
	for _, player in Players:GetPlayers() do
		if player ~= sender then
			local targetRoot = rootPart(player)
			if targetRoot then
				local distance = (senderRoot.Position - targetRoot.Position).Magnitude
				if distance <= nearestDistance and
					(nearest == nil or distance < nearestDistance or player.UserId < nearest.UserId) then
					nearest = player
					nearestDistance = distance
				end
			end
		end
	end
	if nearest == nil then return end
	holder = nearest
	-- The deadline and delayed expiration remain unchanged across passes.
	publish("armed")
end)

Players.PlayerAdded:Connect(scheduleInitialOwner)
Players.PlayerRemoving:Connect(function(player)
	joinGeneration += 1
	if player == holder then clear("waiting") end
	-- Disconnect recovery waits for a new join instead of silently rearming.
end)

publish("waiting")
scheduleInitialOwner()
