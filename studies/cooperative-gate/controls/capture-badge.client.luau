--!strict

-- Test-only overlay: verify that two actor-bound captures contain different
-- player-visible UI. This source never enters a graded builder candidate.
local Players = game:GetService("Players")
local player = Players.LocalPlayer
local screen = player:WaitForChild("PlayerGui"):WaitForChild("GateGui")

local actorBadge = Instance.new("TextLabel")
actorBadge.Name = "ActorBadge"
actorBadge.Size = UDim2.fromOffset(250, 42)
actorBadge.Position = UDim2.fromOffset(30, 60)
actorBadge.BackgroundColor3 = if player.Name == "Player1" then Color3.fromRGB(26, 83, 153) else Color3.fromRGB(152, 65, 40)
actorBadge.TextColor3 = Color3.new(1, 1, 1)
actorBadge.TextSize = 20
actorBadge.Font = Enum.Font.GothamBold
actorBadge.Text = "CAPTURE " .. player.Name
actorBadge.Parent = screen
