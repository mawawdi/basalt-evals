--!strict

-- Evaluator-side control. Builders receive only tasks/pilot/cooperative-gate/seed.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")

local gate = Workspace:WaitForChild("Gate") :: BasePart
local state = ReplicatedStorage:WaitForChild("GateState") :: Folder
local remote = ReplicatedStorage:WaitForChild("ActivateGate") :: RemoteEvent
local consoles: {[string]: BasePart} = {
	Alpha = Workspace:WaitForChild("ConsoleA") :: BasePart,
	Beta = Workspace:WaitForChild("ConsoleB") :: BasePart,
}
local PAIR_SECONDS = 4
local OPEN_SECONDS = 5
local RANGE = 8
local closedTransparency = gate.Transparency
local openingCount = 0
local generation = 0
local pendingPlayer: Player? = nil
local pendingConsole: string? = nil
local pendingDeadline = 0
local gateOpen = false

local function setWaiting()
	generation += 1
	pendingPlayer = nil
	pendingConsole = nil
	pendingDeadline = 0
	gateOpen = false
	gate.CanCollide = true
	gate.Transparency = closedTransparency
	state:SetAttribute("Status", "waiting")
	state:SetAttribute("ActiveCount", 0)
	state:SetAttribute("GateOpen", false)
	state:SetAttribute("Deadline", 0)
end

state:SetAttribute("OpenCount", openingCount)
setWaiting()

local function near(player: Player, console: BasePart): boolean
	local character = player.Character
	local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
	return root ~= nil and root:IsA("BasePart") and (root.Position - console.Position).Magnitude <= RANGE
end

local function arm(player: Player, consoleName: string)
	generation += 1
	local thisGeneration = generation
	pendingPlayer = player
	pendingConsole = consoleName
	pendingDeadline = Workspace:GetServerTimeNow() + PAIR_SECONDS
	state:SetAttribute("Status", "armed")
	state:SetAttribute("ActiveCount", 1)
	state:SetAttribute("Deadline", pendingDeadline)
	task.delay(PAIR_SECONDS, function()
		if generation == thisGeneration and pendingPlayer ~= nil then
			setWaiting()
		end
	end)
end

local function openForPair()
	generation += 1
	local thisGeneration = generation
	pendingPlayer = nil
	pendingConsole = nil
	pendingDeadline = 0
	gateOpen = true
	openingCount += 1
	gate.CanCollide = false
	gate.Transparency = math.max(closedTransparency, 0.65)
	state:SetAttribute("Status", "open")
	state:SetAttribute("ActiveCount", 0)
	state:SetAttribute("GateOpen", true)
	state:SetAttribute("OpenCount", openingCount)
	state:SetAttribute("Deadline", Workspace:GetServerTimeNow() + OPEN_SECONDS)
	task.delay(OPEN_SECONDS, function()
		if generation == thisGeneration and gateOpen then
			setWaiting()
		end
	end)
end

remote.OnServerEvent:Connect(function(player: Player, claimed: any)
	if gateOpen or type(claimed) ~= "string" or (claimed ~= "Alpha" and claimed ~= "Beta") then return end
	local console = consoles[claimed]
	if not near(player, console) then return end
	if pendingPlayer ~= nil and Workspace:GetServerTimeNow() > pendingDeadline then
		setWaiting()
	end
	if pendingPlayer == nil then
		arm(player, claimed)
	elseif player ~= pendingPlayer and claimed ~= pendingConsole then
		openForPair()
	end
end)

Players.PlayerRemoving:Connect(function(player: Player)
	if player == pendingPlayer then
		setWaiting()
	end
end)
