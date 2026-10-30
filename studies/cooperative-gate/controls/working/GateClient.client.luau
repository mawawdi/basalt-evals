--!strict

local ContextActionService = game:GetService("ContextActionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")

local player = Players.LocalPlayer
local state = ReplicatedStorage:WaitForChild("GateState") :: Folder
local remote = ReplicatedStorage:WaitForChild("ActivateGate") :: RemoteEvent
local consoles: {[string]: BasePart} = {
	Alpha = Workspace:WaitForChild("ConsoleA") :: BasePart,
	Beta = Workspace:WaitForChild("ConsoleB") :: BasePart,
}

local screen = Instance.new("ScreenGui")
screen.Name = "GateGui"
screen.ResetOnSpawn = false
screen.Parent = player:WaitForChild("PlayerGui")

local panel = Instance.new("Frame")
panel.Name = "Panel"
panel.AnchorPoint = Vector2.new(0.5, 1)
panel.Position = UDim2.new(0.5, 0, 1, -30)
panel.Size = UDim2.fromOffset(430, 48)
panel.BackgroundColor3 = Color3.fromRGB(20, 29, 40)
panel.BackgroundTransparency = 0.1
panel.BorderSizePixel = 0
panel.Parent = screen

local status = Instance.new("TextLabel")
status.Name = "Status"
status.Size = UDim2.fromScale(1, 1)
status.BackgroundTransparency = 1
status.TextColor3 = Color3.fromRGB(240, 248, 255)
status.Font = Enum.Font.GothamMedium
status.TextSize = 18
status.TextWrapped = true
status.Parent = panel

local function update()
	local mode = state:GetAttribute("Status")
	local deadline = state:GetAttribute("Deadline")
	local remaining = if type(deadline) == "number" then math.max(0, deadline - Workspace:GetServerTimeNow()) else 0
	if mode == "open" then
		status.Text = string.format("GATE OPEN  •  closes in %.1fs", remaining)
	elseif mode == "armed" then
		status.Text = string.format("ONE READY  •  other player press E (%.1fs)", remaining)
	else
		status.Text = "TWO PLAYERS  •  press E at opposite consoles"
	end
end

local function nearestConsole(): string?
	local character = player.Character
	local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
	if root == nil or not root:IsA("BasePart") then return nil end
	local best: string? = nil
	local bestDistance = 8
	for name, console in consoles do
		local distance = (root.Position - console.Position).Magnitude
		if distance <= bestDistance then
			best = name
			bestDistance = distance
		end
	end
	return best
end

ContextActionService:BindActionAtPriority("ActivateCooperativeGate", function(_, inputState)
	if inputState ~= Enum.UserInputState.Begin then return Enum.ContextActionResult.Pass end
	local choice = nearestConsole()
	if choice ~= nil then remote:FireServer(choice) end
	return Enum.ContextActionResult.Sink
end, false, 5000, Enum.KeyCode.E)

for _, attribute in {"Status", "GateOpen", "Deadline"} do
	state:GetAttributeChangedSignal(attribute):Connect(update)
end
task.spawn(function()
	while screen.Parent ~= nil do
		update()
		task.wait(0.1)
	end
end)
update()
