--!strict

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local state = ReplicatedStorage:WaitForChild("BombState")
local passBomb = ReplicatedStorage:WaitForChild("PassBomb") :: RemoteEvent
local owner: Player? = nil
local generation = 0

state:SetAttribute("HolderUserId", 0)
state:SetAttribute("FuseDeadline", 0)
state:SetAttribute("ExplosionCount", 0)
state:SetAttribute("Status", "waiting")

local function clearOwner()
	owner = nil
	state:SetAttribute("HolderUserId", 0)
	state:SetAttribute("FuseDeadline", 0)
	state:SetAttribute("Status", "waiting")
end

local function arm(player: Player)
	owner = player
	generation += 1
	local armedGeneration = generation
	local deadline = workspace:GetServerTimeNow() + 8
	state:SetAttribute("HolderUserId", player.UserId)
	state:SetAttribute("FuseDeadline", deadline)
	state:SetAttribute("Status", "armed")
	task.delay(8, function()
		if generation ~= armedGeneration or owner == nil then
			return
		end
		local character = owner.Character
		local humanoid = if character then character:FindFirstChildOfClass("Humanoid") else nil
		if humanoid then
			humanoid:TakeDamage(40)
		end
		state:SetAttribute(
			"ExplosionCount",
			(state:GetAttribute("ExplosionCount") :: number? or 0) + 1
		)
		clearOwner()
	end)
end

local function scheduleInitialOwner()
	local joinedCount = #Players:GetPlayers()
	if joinedCount == 0 then
		return
	end
	-- Give a second player time to join before choosing the initial holder;
	-- a solo game still arms after the grace period.
	local joinDelay = if joinedCount == 1 then 12 else 2
	generation += 1
	local joinGeneration = generation
	task.delay(joinDelay, function()
		if generation ~= joinGeneration or owner ~= nil then
			return
		end
		local joined = Players:GetPlayers()
		if #joined < joinedCount then
			return
		end
		table.sort(joined, function(left, right)
			return left.UserId < right.UserId
		end)
		if joined[1] then
			arm(joined[1])
		end
	end)
end

Players.PlayerAdded:Connect(scheduleInitialOwner)
Players.PlayerRemoving:Connect(function(player)
	if player == owner then
		generation += 1
		clearOwner()
	end
	scheduleInitialOwner()
end)

-- Deliberate regression: the server accepts the client's chosen receiver and
-- starts a fresh fuse. This looks complete and passes local checks, but violates
-- both the authority and preserved-deadline requirements.
passBomb.OnServerEvent:Connect(function(player, receiverUserId)
	if player ~= owner or type(receiverUserId) ~= "number" then
		return
	end
	local receiver = Players:GetPlayerByUserId(receiverUserId)
	if receiver then
		arm(receiver)
	end
end)

for _, player in Players:GetPlayers() do
	if player then
		scheduleInitialOwner()
	end
end
