--!strict

local ContextActionService = game:GetService("ContextActionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")

local player = Players.LocalPlayer
local state = ReplicatedStorage:WaitForChild("ShutterState") :: Folder
local remote = ReplicatedStorage:WaitForChild("ActivateShutter") :: RemoteEvent
local lever = Workspace:WaitForChild("Lever") :: BasePart

local screen = Instance.new("ScreenGui")
screen.Name = "ShutterGui"
screen.ResetOnSpawn = false
screen.Parent = player:WaitForChild("PlayerGui")

local panel = Instance.new("Frame")
panel.Name = "Panel"
panel.AnchorPoint = Vector2.new(0.5, 1)
panel.Position = UDim2.new(0.5, 0, 1, -28)
panel.Size = UDim2.fromOffset(420, 48)
panel.BackgroundColor3 = Color3.fromRGB(24, 35, 44)
panel.BackgroundTransparency = 0.1
panel.BorderSizePixel = 0
panel.Parent = screen

local status = Instance.new("TextLabel")
status.Name = "Status"
status.Size = UDim2.fromScale(1, 1)
status.BackgroundTransparency = 1
status.TextColor3 = Color3.fromRGB(242, 247, 251)
status.Font = Enum.Font.GothamMedium
status.TextSize = 18
status.TextWrapped = true
status.Parent = panel

local function update()
	if state:GetAttribute("IsOpen") == true then
		local deadline = state:GetAttribute("Deadline")
		local remaining = if type(deadline) == "number" then math.max(0, deadline - Workspace:GetServerTimeNow()) else 0
		status.Text = string.format("SHUTTER OPEN  •  closes in %.1fs", remaining)
	else
		status.Text = "PRESS E AT THE LEVER TO OPEN THE SHUTTER"
	end
end

ContextActionService:BindActionAtPriority("ActivateTimedShutter", function(_, inputState)
	if inputState ~= Enum.UserInputState.Begin then return Enum.ContextActionResult.Pass end
	local character = player.Character
	local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
	if root ~= nil and root:IsA("BasePart") and (root.Position - lever.Position).Magnitude <= 8 then
		remote:FireServer()
	end
	return Enum.ContextActionResult.Sink
end, false, 5000, Enum.KeyCode.E)

for _, attribute in { "IsOpen", "Deadline" } do
	state:GetAttributeChangedSignal(attribute):Connect(update)
end
task.spawn(function()
	while screen.Parent ~= nil do
		update()
		task.wait(0.1)
	end
end)
update()
