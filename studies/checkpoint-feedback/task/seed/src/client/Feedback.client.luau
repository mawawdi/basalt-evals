--!strict
-- Feedback is driven by replicated server state. Variant parameters never
-- enter the server mechanic. The top 9% is reserved for capture controls.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local StarterGui = game:GetService("StarterGui")
local variant = require(ReplicatedStorage:WaitForChild("Variant"))
local action = ReplicatedStorage:WaitForChild("CaptureAction") :: RemoteEvent
local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")
local serverState = player:WaitForChild("CheckpointState")
local pad = workspace:WaitForChild("CheckpointA") :: BasePart
local beacon = workspace:WaitForChild("Beacon") :: BasePart
pcall(function() StarterGui:SetCoreGuiEnabled(Enum.CoreGuiType.All, false) end)
local compact, dense = variant.layout == "compact", variant.layout == "dense"
local side = variant.layout == "side-card" or variant.layout == "side-silent"
local ground = variant.layout == "ground-only" or variant.layout == "ground-muted"
local quietGround = variant.layout == "ground-muted"
local silent = variant.layout == "silent" or variant.layout == "side-silent"
local ink = Color3.fromRGB(235, 244, 238)
local accent = if compact then Color3.fromRGB(116, 140, 141) elseif dense then Color3.fromRGB(255, 193, 77) else Color3.fromRGB(132, 240, 184)

local gui = Instance.new("ScreenGui")
gui.Name, gui.IgnoreGuiInset, gui.ResetOnSpawn = "CheckpointGui", true, false
gui.ScreenInsets = Enum.ScreenInsets.None
gui.Parent = playerGui
local panel = Instance.new("Frame")
panel.Name = "Panel"
panel.AnchorPoint, panel.Position = Vector2.new(0.5, 0), UDim2.fromScale(0.5, 0.14)
panel.Size = UDim2.fromOffset(if compact then 260 elseif dense then 700 else 430, if compact then 56 elseif dense then 150 else 92)
panel.BackgroundColor3, panel.BorderSizePixel = Color3.fromRGB(20, 34, 43), 0
panel.Parent = gui
local corner = Instance.new("UICorner")
corner.CornerRadius, corner.Parent = UDim.new(0, 12), panel
local scale = Instance.new("UIScale")
scale.Parent = panel
local function label(name: string, y: number, height: number, size: number): TextLabel
	local item = Instance.new("TextLabel")
	item.Name = name
	item.Position, item.Size = UDim2.new(0, 16, 0, y), UDim2.new(1, -32, 0, height)
	item.BackgroundTransparency = 1
	item.TextColor3, item.TextSize, item.Font = ink, size, Enum.Font.GothamBold
	item.Parent = panel
	return item
end
local heading = label("StatusText", if compact then 5 else 12, if compact then 22 else 32, if compact then 12 elseif dense then 34 else 22)
local detail = label("DetailText", if compact then 28 else 47, 24, if compact then 10 else 13)
detail.TextColor3 = Color3.fromRGB(153, 180, 183)
if silent then heading.TextTransparency, detail.TextTransparency = 1, 1 end
if dense then
	local extra = label("RouteBanner", 92, 35, 21)
	extra.Text, extra.TextColor3 = "RIDGELINE  /  EXPEDITION 01  /  KEEP MOVING", accent
end

local outline = Instance.new("Highlight")
outline.Name, outline.Adornee = "CheckpointOutline", pad
outline.FillTransparency = 1
outline.OutlineColor = accent
outline.DepthMode = Enum.HighlightDepthMode.Occluded
outline.Parent = pad
local sign = Instance.new("BillboardGui")
sign.Name, sign.Adornee = "CheckpointSign", beacon
sign.Size = UDim2.fromOffset(if compact then 100 else 220, if compact then 30 else 58)
sign.StudsOffsetWorldSpace = Vector3.new(0, 1.3, 0)
sign.AlwaysOnTop, sign.MaxDistance = false, 80
sign.Parent = gui
sign.Enabled = not silent
local signText = Instance.new("TextLabel")
signText.Size, signText.BackgroundTransparency = UDim2.fromScale(1, 1), 0.15
signText.BackgroundColor3 = Color3.fromRGB(20, 34, 43)
signText.TextColor3, signText.TextSize, signText.Font = ink, if compact then 10 else 17, Enum.Font.GothamBold
signText.Parent = sign
-- Validation layouts separate HUD feedback from world-space feedback. The
-- replicated mechanic and the capture action sequence remain identical.
if side then
	panel.AnchorPoint, panel.Position = Vector2.zero, UDim2.fromScale(0.04, 0.16)
	panel.Size = UDim2.fromOffset(320, 132)
	heading.TextSize, heading.TextWrapped = 20, true
	heading.Size = UDim2.new(1, -32, 0, 52)
	detail.Position, detail.Size = UDim2.fromOffset(16, 73), UDim2.new(1, -32, 0, 42)
	detail.TextWrapped = true
	sign.Enabled = false
elseif ground then
	panel.Visible = false
	sign.Size = UDim2.fromOffset(250, 70)
	signText.TextSize = 19
	if quietGround then
		accent = Color3.fromRGB(120, 141, 145)
		sign.Size, signText.TextSize = UDim2.fromOffset(120, 32), 11
	end
end
local bands: { Part } = {}
if dense then
	for index = 1, 5 do
		local band = Instance.new("Part")
		band.Name = "FeedbackBand"
		band.Anchored, band.CanCollide, band.CanTouch, band.CanQuery = true, false, false, false
		band.Size = Vector3.new(10 + index, 0.15, 0.3)
		band.Position = Vector3.new(0, index * 0.6, -4.8)
		band.Material, band.Color = Enum.Material.Neon, Color3.fromHSV(index / 7, 0.65, 1)
		band.Parent = workspace
		table.insert(bands, band)
	end
end

-- The connector reserves BasaltEvalCaptureControls for evaluator capture UI.
local controls = Instance.new("ScreenGui")
controls.Name, controls.IgnoreGuiInset, controls.ResetOnSpawn, controls.DisplayOrder = "BasaltEvalCaptureControls", true, false, 20
controls.ScreenInsets = Enum.ScreenInsets.None
controls.Parent = playerGui
local strip = Instance.new("Frame")
strip.Size = UDim2.fromScale(1, 0.09)
strip.BackgroundColor3, strip.BorderSizePixel = Color3.fromRGB(15, 18, 23), 0
strip.Parent = controls
-- Draw no candidate, phase or state text in the frame. A judge sees the frame, and
-- the CaptureState attributes give the connector the same values.
local buttons: { TextButton } = {}
for index, name in { "reset", "approach", "leave" } do
	local button = Instance.new("TextButton")
	button.Name, button.Text = name, string.upper(name)
	-- The top-left Roblox menu remains protected from virtual input even when
	-- other CoreGui is hidden. Keep harness targets in the central strip.
	button.Size, button.Position = UDim2.fromScale(0.15, 0.065), UDim2.fromScale(0.20 + (index - 1) * 0.165, 0.012)
	button.Font, button.TextSize, button.TextColor3 = Enum.Font.Code, 13, ink
	button.BackgroundColor3 = Color3.fromRGB(43, 50, 62)
	button.Visible = false
	button.Parent = controls
	button.Activated:Connect(function() action:FireServer(name) end)
	table.insert(buttons, button)
end
local capture = Instance.new("Folder")
capture.Name = "CaptureState"
capture:SetAttribute("CandidateId", variant.id)
capture.Parent = workspace
local cameraFrame = CFrame.lookAt(Vector3.new(17, 14, 26), Vector3.new(0, 1, 2))
RunService:BindToRenderStep("CheckpointFeedback", Enum.RenderPriority.Camera.Value + 1, function()
	local camera = workspace.CurrentCamera
	if camera then
		camera.CameraType, camera.CFrame, camera.FieldOfView = Enum.CameraType.Scriptable, cameraFrame, 60
		camera.Focus = CFrame.new(0, 1, 2)
	end
	scale.Scale = math.min(1.2, gui.AbsoluteSize.X / 1000, gui.AbsoluteSize.Y / 600)
	local active = serverState:GetAttribute("LastCheckpoint") == pad.Name
	local phase = serverState:GetAttribute("Phase")
	local ready = phase == "idle" or phase == "ready" or phase == "active" or phase == "departed"
	for _, button in buttons do button.Visible = ready end
	heading.Text = if active then "Checkpoint A secured" else "Reach checkpoint A"
	detail.Text = if active then "Progress recorded. Continue your route." else "Follow the path to the marker."
	signText.Text = if active then "A  /  SECURED" else "CHECKPOINT A"
	-- Feedback suppression never changes contact, server state or phase readiness.
	local showActivation = active and not silent
	pad.Color = if showActivation then accent else Color3.fromRGB(69, 83, 90)
	beacon.Color = if showActivation then accent else Color3.fromRGB(106, 127, 132)
	beacon.Material = if showActivation and not compact and not quietGround then Enum.Material.Neon else Enum.Material.SmoothPlastic
	outline.Enabled = showActivation and not compact and not quietGround
	for _, band in bands do band.Transparency = if active then 0.15 else 1 end
	-- Readiness follows the rendered feedback; engine facts still read the
	-- replicated server folder independently instead of this client marker.
	capture:SetAttribute("Phase", phase)
end)
