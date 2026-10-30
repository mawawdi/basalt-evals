--!strict

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local player = Players.LocalPlayer
local state = ReplicatedStorage:WaitForChild("BombState")
local passBomb = ReplicatedStorage:WaitForChild("PassBomb") :: RemoteEvent

local gui = Instance.new("ScreenGui")
gui.Name = "BombGui"
gui.ResetOnSpawn = false
gui.Parent = player:WaitForChild("PlayerGui")

local panel = Instance.new("Frame")
panel.Name = "Panel"
panel.AnchorPoint = Vector2.new(0.5, 0)
panel.Position = UDim2.fromScale(0.5, 0.04)
panel.Size = UDim2.fromOffset(380, 76)
panel.BackgroundColor3 = Color3.fromRGB(32, 27, 39)
panel.BackgroundTransparency = 0.08
panel.Parent = gui

local corner = Instance.new("UICorner")
corner.CornerRadius = UDim.new(0, 12)
corner.Parent = panel

local status = Instance.new("TextLabel")
status.Name = "Status"
status.Size = UDim2.fromScale(1, 1)
status.BackgroundTransparency = 1
status.TextColor3 = Color3.fromRGB(255, 225, 118)
status.TextScaled = true
status.Font = Enum.Font.GothamBold
status.Parent = panel

UserInputService.InputBegan:Connect(function(input, processed)
	if processed or input.KeyCode ~= Enum.KeyCode.E then return end
	if state:GetAttribute("HolderUserId") ~= player.UserId then return end
	passBomb:FireServer()
end)

RunService.RenderStepped:Connect(function()
	local holderId = state:GetAttribute("HolderUserId") :: number? or 0
	local fuseDeadline = state:GetAttribute("FuseDeadline") :: number? or 0
	if holderId == 0 then
		status.Text = "WAITING FOR BOMB"
		return
	end
	local seconds = math.max(0, fuseDeadline - workspace:GetServerTimeNow())
	if holderId == player.UserId then
		status.Text = string.format("YOU HAVE THE BOMB  ·  %.1fs  ·  E to pass", seconds)
	else
		local holder = Players:GetPlayerByUserId(holderId)
		status.Text = string.format("BOMB: %s  ·  %.1fs", if holder then holder.Name else "?", seconds)
	end
end)
