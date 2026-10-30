--!strict
-- Authored fixture: visual variants share input and progression.
-- The top 9% is reserved for capture controls; all product UI starts below it.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local StarterGui = game:GetService("StarterGui")
local Progression = require(ReplicatedStorage:WaitForChild("Progression"))
local variant = require(ReplicatedStorage:WaitForChild("Variant"))
local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")
pcall(function() StarterGui:SetCoreGuiEnabled(Enum.CoreGuiType.All, false) end)

local compact = variant.layout == "compact"
local dense = variant.layout == "dense"
local rail = variant.layout == "rail" or variant.layout == "rail-muted"
local dock = variant.layout == "dock" or variant.layout == "dock-silent"
local silent = variant.layout == "silent" or variant.layout == "dock-silent"
local ink = Color3.fromRGB(231, 240, 237)
local muted = if compact then Color3.fromRGB(116, 130, 135) else Color3.fromRGB(156, 177, 178)
local accent = if dense then Color3.fromRGB(251, 177, 83) else Color3.fromRGB(153, 230, 181)
local function round(parent: Instance, radius: number)
	local item = Instance.new("UICorner")
	item.CornerRadius = UDim.new(0, radius)
	item.Parent = parent
end
local function frame(parent: Instance, name: string, position: UDim2, size: UDim2, color: Color3): Frame
	local item = Instance.new("Frame")
	item.Name, item.Position, item.Size, item.BackgroundColor3 = name, position, size, color
	item.BorderSizePixel = 0
	item.Parent = parent
	return item
end
local function label(parent: Instance, name: string, text: string, x: number, y: number, w: number, h: number, size: number, color: Color3): TextLabel
	local item = Instance.new("TextLabel")
	item.Name, item.Text = name, text
	item.Position, item.Size = UDim2.fromOffset(x, y), UDim2.fromOffset(w, h)
	item.BackgroundTransparency = 1
	item.TextColor3, item.TextSize = color, size
	item.Font = Enum.Font.GothamMedium
	item.TextXAlignment = Enum.TextXAlignment.Left
	item.Parent = parent
	return item
end
local function screen(name: string, order: number): ScreenGui
	local item = Instance.new("ScreenGui")
	item.Name, item.DisplayOrder = name, order
	item.IgnoreGuiInset = true
	item.ScreenInsets = Enum.ScreenInsets.None
	item.ResetOnSpawn = false
	item.Parent = playerGui
	return item
end

local gui = screen("ProgressGui", 1)
local background = frame(gui, "Backdrop", UDim2.fromScale(0, 0), UDim2.fromScale(1, 1), Color3.fromRGB(14, 25, 32))
local gradient = Instance.new("UIGradient")
gradient.Color = ColorSequence.new(Color3.fromRGB(31, 57, 61), Color3.fromRGB(10, 19, 28))
gradient.Rotation = 35
gradient.Parent = background
-- Quiet course geometry gives the panel a product context without external assets.
for index = 1, 7 do
	local contour = frame(background, "Contour", UDim2.fromScale(-0.1, 0.35 + index * 0.1), UDim2.fromScale(1.3, 0.003), Color3.fromRGB(63, 97, 97))
	contour.Rotation, contour.BackgroundTransparency = -14, 0.75
end

local width, height = if compact then 480 else 680, if compact then 238 else 370
local panel = frame(gui, "Panel", UDim2.fromScale(0.5, 0.56), UDim2.fromOffset(width, height), Color3.fromRGB(22, 37, 45))
panel.AnchorPoint = Vector2.new(0.5, 0.5)
round(panel, 18)
local border = Instance.new("UIStroke")
border.Color, border.Transparency = Color3.fromRGB(108, 149, 146), 0.55
border.Parent = panel
local scale = Instance.new("UIScale")
scale.Parent = panel
local padding = if compact then 22 else 36
label(panel, "Brand", "RIDGELINE   /   FIELD TRAINING", padding, 18, width - 2 * padding, 26, if compact then 11 else 13, muted)
label(panel, "Title", "Every step counts.", padding, if compact then 47 else 61, width - 2 * padding, 48, if compact then 21 else 34, ink)
local levelY = if compact then 101 else 137
local level = label(panel, "LevelLabel", "", padding, levelY, 220, 30, if compact then 14 else 22, accent)
local progress = label(panel, "ProgressText", "", width - padding - 200, levelY, 200, 30, if compact then 12 else 18, muted)
progress.TextXAlignment = Enum.TextXAlignment.Right
local barY = if compact then 139 else 184
local track = frame(panel, "Track", UDim2.fromOffset(padding, barY), UDim2.fromOffset(width - 2 * padding, if compact then 4 else 12), Color3.fromRGB(54, 69, 76))
round(track, 6)
local fill = frame(track, "Fill", UDim2.fromScale(0, 0), UDim2.fromScale(0.8, 1), if compact then muted else accent)
round(fill, 6)
local status = label(panel, "Status", "", padding, if compact then 151 else 209, width - 2 * padding, 24, if compact then 10 else 14, muted)
-- This presentation omits state feedback while the real action and underlying
-- values still update. Declared Visible flags do not establish rendered legibility.
if silent then
	level.TextTransparency, progress.TextTransparency, status.TextTransparency = 1, 1, 1
	track.BackgroundTransparency, fill.BackgroundTransparency = 1, 1
end
local button = Instance.new("TextButton")
button.Name = "GainXP"
button.Text = "Gain XP   +35"
button.Font = Enum.Font.GothamBold
button.TextSize = if compact then 12 else 17
button.TextColor3 = Color3.fromRGB(18, 36, 32)
button.BackgroundColor3 = if compact then Color3.fromRGB(116, 149, 141) else accent
button.BorderSizePixel = 0
button.Position = UDim2.fromOffset(padding, if compact then 185 else 271)
button.Size = UDim2.fromOffset(if compact then 144 else 208, if compact then 31 else 52)
round(button, 8)
button.Parent = panel
if not compact then
	label(panel, "Hint", "Train. Level up. Keep going.", 264, 280, 370, 32, 14, muted)
end
if dense then
	-- Competing decorative content changes presentation, never progression rules.
	local ribbon = frame(panel, "ActivityRibbon", UDim2.fromOffset(310, 260), UDim2.fromOffset(336, 78), Color3.fromRGB(81, 46, 99))
	round(ribbon, 9)
	label(ribbon, "Heading", "EXPEDITION BOARD", 14, 6, 308, 24, 18, ink)
	label(ribbon, "Stats", "3 ROUTES   /   12 BADGES   /   WEEKLY RUN", 14, 35, 308, 26, 12, accent)
end

-- Reserved validation families change the information hierarchy, not the rule
-- or input path. Their labels must come from independent rendered review.
if rail then
	panel.Position, panel.Size = UDim2.fromScale(0.20, 0.57), UDim2.fromOffset(340, 438)
	local brand = panel:FindFirstChild("Brand") :: TextLabel
	brand.Size, brand.TextSize = UDim2.fromOffset(292, 26), 10
	brand.Position = UDim2.fromOffset(24, 18)
	local heading = panel:FindFirstChild("Title") :: TextLabel
	heading.Text, heading.TextSize = "Field training", 26
	heading.Position, heading.Size = UDim2.fromOffset(24, 65), UDim2.fromOffset(292, 48)
	level.Position, level.Size = UDim2.fromOffset(24, 140), UDim2.fromOffset(292, 34)
	progress.Position, progress.Size = UDim2.fromOffset(24, 184), UDim2.fromOffset(292, 30)
	progress.TextXAlignment = Enum.TextXAlignment.Left
	track.Position, track.Size = UDim2.fromOffset(24, 229), UDim2.fromOffset(292, 12)
	status.Position, status.Size = UDim2.fromOffset(24, 257), UDim2.fromOffset(292, 52)
	status.TextWrapped = true
	button.Position, button.Size = UDim2.fromOffset(24, 346), UDim2.fromOffset(292, 58)
	local hint = panel:FindFirstChild("Hint") :: TextLabel
	hint.Visible = false
	if variant.layout == "rail-muted" then
		level.TextSize, progress.TextSize, status.TextSize = 14, 12, 11
		local quiet = Color3.fromRGB(100, 117, 121)
		level.TextColor3, progress.TextColor3, status.TextColor3 = quiet, quiet, quiet
		fill.BackgroundColor3, track.Size = quiet, UDim2.fromOffset(292, 3)
	end
elseif dock then
	panel.Position, panel.Size = UDim2.fromScale(0.5, 0.82), UDim2.fromOffset(920, 164)
	local brand = panel:FindFirstChild("Brand") :: TextLabel
	brand.Position, brand.Size = UDim2.fromOffset(24, 12), UDim2.fromOffset(590, 22)
	local heading = panel:FindFirstChild("Title") :: TextLabel
	heading.Visible = false
	level.Position, level.Size = UDim2.fromOffset(24, 46), UDim2.fromOffset(230, 34)
	progress.Position, progress.Size = UDim2.fromOffset(380, 46), UDim2.fromOffset(250, 34)
	track.Position, track.Size = UDim2.fromOffset(24, 94), UDim2.fromOffset(606, 12)
	status.Position, status.Size = UDim2.fromOffset(24, 122), UDim2.fromOffset(606, 24)
	button.Position, button.Size = UDim2.fromOffset(678, 53), UDim2.fromOffset(218, 60)
	local hint = panel:FindFirstChild("Hint") :: TextLabel
	hint.Visible = false
end

-- The connector reserves BasaltEvalCaptureControls for evaluator capture UI.
local controls = screen("BasaltEvalCaptureControls", 20)
frame(controls, "Strip", UDim2.fromScale(0, 0), UDim2.fromScale(1, 0.09), Color3.fromRGB(15, 18, 23))
local reset = Instance.new("TextButton")
reset.Name, reset.Text = "reset", "RESET"
-- Keep the automation control away from Roblox's protected top-left buttons,
-- including in a smaller native Studio viewport. The same top strip is masked.
reset.Size, reset.Position = UDim2.fromScale(0.18, 0.065), UDim2.fromScale(0.35, 0.012)
reset.Font, reset.TextSize = Enum.Font.Code, 14
reset.TextColor3, reset.BackgroundColor3 = ink, Color3.fromRGB(43, 50, 62)
reset.Parent = controls
-- Draw no candidate, phase or state text in the frame. A judge sees the frame, and
-- the CaptureState attributes give the connector the same values.
local capture = Instance.new("Folder")
capture.Name = "CaptureState"
capture:SetAttribute("CandidateId", variant.id)
capture.Parent = workspace
local state = Progression.initial()

local function render()
	level.Text = string.format("Level %d", state.level)
	progress.Text = string.format("%d / %d XP", state.xp, Progression.threshold)
	fill.Size = UDim2.fromScale(state.xp / Progression.threshold, 1)
	status.Text = if state.level > 1 then "Level unlocked. Excess XP carried forward." else "20 XP to your next level."
end
button.Activated:Connect(function()
	state = Progression.grant(state, Progression.reward)
	render()
end)
reset.Activated:Connect(function()
	state = Progression.initial()
	render()
end)
render()
local fixedCamera = CFrame.lookAt(Vector3.new(14, 9, 24), Vector3.new(0, 2, 0))
-- Publish readiness only after rendering. Extra operator clicks invalidate the
-- planned phase rather than silently collecting a different progression state.
RunService:BindToRenderStep("ProgressCaptureState", Enum.RenderPriority.Last.Value, function()
	-- Fullscreen UI still needs a stable capture camera: the default follow
	-- camera can move behind the panel while MCP is acquiring the viewport.
	local camera = workspace.CurrentCamera
	if camera then
		camera.CameraType = Enum.CameraType.Scriptable
		camera.CFrame, camera.Focus, camera.FieldOfView = fixedCamera, CFrame.new(0, 2, 0), 60
	end
	scale.Scale = math.min(1.25, gui.AbsoluteSize.X / (if dock then 1050 else 900), gui.AbsoluteSize.Y / (if rail then 630 else 540))
	local phase = ({ "ready", "leveled", "progress" })[state.actions + 1] or "interactive"
	capture:SetAttribute("Level", state.level)
	capture:SetAttribute("XP", state.xp)
	capture:SetAttribute("Actions", state.actions)
	capture:SetAttribute("BarFraction", fill.Size.X.Scale)
	capture:SetAttribute("Phase", phase)
end)
