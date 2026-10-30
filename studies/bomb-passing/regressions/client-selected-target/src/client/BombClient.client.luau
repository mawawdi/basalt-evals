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
panel.Size = UDim2.fromOffset(360, 72)
panel.BackgroundColor3 = Color3.fromRGB(38, 31, 43)
panel.Parent = gui

local status = Instance.new("TextLabel")
status.Name = "Status"
status.Size = UDim2.fromScale(1, 1)
status.BackgroundTransparency = 1
status.TextColor3 = Color3.fromRGB(255, 224, 108)
status.TextScaled = true
status.Font = Enum.Font.GothamBold
status.Parent = panel

local function rootPart(target: Player): BasePart?
	local character = target.Character
	return if character then character:FindFirstChild("HumanoidRootPart") :: BasePart? else nil
end

local function nearestPlayer(): Player?
	local ownRoot = rootPart(player)
	if not ownRoot then
		return nil
	end
	local nearest: Player? = nil
	local nearestDistance = math.huge
	for _, candidate in Players:GetPlayers() do
		if candidate ~= player then
			local candidateRoot = rootPart(candidate)
			if candidateRoot then
				local distance = (candidateRoot.Position - ownRoot.Position).Magnitude
				if distance < nearestDistance then
					nearest = candidate
					nearestDistance = distance
				end
			end
		end
	end
	return nearest
end

UserInputService.InputBegan:Connect(function(input, processed)
	if processed or input.KeyCode ~= Enum.KeyCode.E then
		return
	end
	if state:GetAttribute("HolderUserId") ~= player.UserId then
		return
	end
	local target = nearestPlayer()
	if target then
		passBomb:FireServer(target.UserId)
	end
end)

RunService.RenderStepped:Connect(function()
	local holderId = state:GetAttribute("HolderUserId") :: number? or 0
	local deadline = state:GetAttribute("FuseDeadline") :: number? or 0
	if holderId == 0 then
		status.Text = "Waiting for bomb"
	else
		local holder = Players:GetPlayerByUserId(holderId)
		local seconds = math.max(0, deadline - workspace:GetServerTimeNow())
		status.Text = string.format("BOMB: %s  %.1fs", if holder then holder.Name else "?", seconds)
	end
end)
