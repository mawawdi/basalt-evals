--!strict

-- Evaluator-side control. Builders receive only tasks/pilot/timed-shutter/seed.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")

local shutter = Workspace:WaitForChild("Shutter") :: BasePart
local lever = Workspace:WaitForChild("Lever") :: BasePart
local state = ReplicatedStorage:WaitForChild("ShutterState") :: Folder
local remote = ReplicatedStorage:WaitForChild("ActivateShutter") :: RemoteEvent
local OPEN_SECONDS = 5
local RANGE = 8
local closedTransparency = shutter.Transparency
local generation = 0
local openingCount = 0
local isOpen = false

local function close()
	generation += 1
	isOpen = false
	shutter.CanCollide = true
	shutter.Transparency = closedTransparency
	state:SetAttribute("Status", "closed")
	state:SetAttribute("IsOpen", false)
	state:SetAttribute("Deadline", 0)
end

state:SetAttribute("OpenCount", openingCount)
close()

local function nearLever(player: Player): boolean
	local character = player.Character
	local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
	return root ~= nil and root:IsA("BasePart") and (root.Position - lever.Position).Magnitude <= RANGE
end

remote.OnServerEvent:Connect(function(player: Player)
	if isOpen or not nearLever(player) then return end
	generation += 1
	local openedGeneration = generation
	isOpen = true
	openingCount += 1
	shutter.CanCollide = false
	shutter.Transparency = math.max(closedTransparency, 0.7)
	state:SetAttribute("Status", "open")
	state:SetAttribute("IsOpen", true)
	state:SetAttribute("OpenCount", openingCount)
	state:SetAttribute("Deadline", Workspace:GetServerTimeNow() + OPEN_SECONDS)
	task.delay(OPEN_SECONDS, function()
		if generation == openedGeneration and isOpen then close() end
	end)
end)
