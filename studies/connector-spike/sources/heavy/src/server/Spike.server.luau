--!strict
-- Heavy control of the connector spike. The server does a known amount of work:
--   1. It creates 2000 parts each second in ServerStorage, up to 40000 parts. The parts do
--      not replicate, so the instance count and the memory of the server increase.
--   2. It keeps each Heartbeat busy for 20 ms, so the frame time of the server increases.
-- The source has no other behavior.
local RunService = game:GetService("RunService")
local ServerStorage = game:GetService("ServerStorage")

local PARTS_PER_SECOND = 2000
local PART_LIMIT = 40000
local BUSY_SECONDS = 0.020

local folder = Instance.new("Folder")
folder.Name = "SpikeLoad"
folder.Parent = ServerStorage

local created = 0
local owed = 0
RunService.Heartbeat:Connect(function(deltaTime: number)
	local started = os.clock()
	repeat
		-- Keep the frame busy without a yield.
	until os.clock() - started >= BUSY_SECONDS
	if created >= PART_LIMIT then return end
	owed += deltaTime * PARTS_PER_SECOND
	local count = math.min(math.floor(owed), PART_LIMIT - created)
	owed -= count
	for _ = 1, count do
		created += 1
		local part = Instance.new("Part")
		part.Name = "Load"
		part.Anchored = true
		part.Parent = folder
	end
end)
