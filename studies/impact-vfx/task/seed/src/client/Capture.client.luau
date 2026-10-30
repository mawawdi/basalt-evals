--!strict
-- Authored analytic fixture. The connector clicks named controls through virtual
-- player input; held samples do not establish continuous timing or game feel.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local StarterGui = game:GetService("StarterGui")
local config = require(ReplicatedStorage:WaitForChild("Variant"))
local player = Players.LocalPlayer
local character = player.Character or player.CharacterAdded:Wait()
local root = character:WaitForChild("HumanoidRootPart") :: BasePart
local humanoid = character:WaitForChild("Humanoid") :: Humanoid
root.Anchored = true
root.CFrame = CFrame.lookAt(Vector3.new(0, 3, 14), Vector3.new(0, 3, 0))
humanoid.WalkSpeed = 0
humanoid.JumpPower = 0
humanoid.AutoRotate = false
pcall(function() StarterGui:SetCoreGuiEnabled(Enum.CoreGuiType.All, false) end)

local state = Instance.new("Folder")
state.Name = "CaptureState"
state:SetAttribute("CandidateId", config.id)
state.Parent = workspace

local effect = Instance.new("Folder")
effect.Name = "ImpactEffect"
effect.Parent = workspace

local function part(name: string, size: Vector3, position: Vector3, color: Color3, parent: Instance): Part
	local item = Instance.new("Part")
	item.Name = name
	item.Anchored = true
	item.CanCollide = false
	item.CanTouch = false
	item.CanQuery = false
	item.CastShadow = false
	item.Size = size
	item.Position = position
	item.Color = color
	item.Material = Enum.Material.SmoothPlastic
	item.Parent = parent
	return item
end

part("ImpactTarget", Vector3.new(6, 4, 2), Vector3.new(0, 2, 0), Color3.fromRGB(75, 80, 87), workspace)
local contact = Vector3.new(0, 2, 1.1)
local projectile = part("Projectile", Vector3.new(0.35, 0.35, 0.35), contact, Color3.fromRGB(235, 235, 235), workspace)
projectile.Shape = Enum.PartType.Ball
if config.occluder > 0 then
	part("ForegroundGeometry", Vector3.new(6 * config.occluder, 5, 1.2), Vector3.new(1.5, 2.5, 4), Color3.fromRGB(90, 85, 80), workspace)
end

local sparks: { Part } = {}
for index = 1, config.density do
	local spark = part("Cue", Vector3.one, contact, Color3.fromRGB(config.color[1], config.color[2], config.color[3]), effect)
	spark.Material = Enum.Material.Neon
	spark.Shape = if config.shape == "Block" then Enum.PartType.Block else Enum.PartType.Ball
	if config.multicolor then spark.Color = Color3.fromHSV(index / config.density, 0.85, 1) end
	table.insert(sparks, spark)
end

local gui = Instance.new("ScreenGui")
-- The connector reserves BasaltEvalCaptureControls for evaluator capture UI.
gui.Name = "BasaltEvalCaptureControls"
gui.IgnoreGuiInset = true
gui.ScreenInsets = Enum.ScreenInsets.None
gui.ResetOnSpawn = false
gui.Parent = player:WaitForChild("PlayerGui")
-- Draw no candidate, phase or time text in the frame. A judge sees the frame, and
-- the CaptureState attributes give the connector the same identity.

local phaseName = "before"
local elapsedMs = -100
local previewStarted: number? = nil
local fixedCamera = CFrame.lookAt(Vector3.new(14, 9, 24), Vector3.new(0, 2, 0))

local function render(timeMs: number)
	local age = timeMs / 1000 - config.delay
	local active = age >= 0 and age <= config.duration and config.scale > 0
	local progress = math.clamp(age / config.duration, 0, 1)
	local scale = config.scale * (0.8 + 0.7 * progress)
	local center = contact + Vector3.new(config.offset[1], config.offset[2], config.offset[3])
	for index, spark in sparks do
		local angle = 2 * math.pi * (index - 1) / #sparks
		local radius = scale * (0.25 + progress * 1.6)
		-- Each declared family has its own layout. Sibling parameter variants share
		-- that layout and split; avoid near-identical reference effects across splits.
		local x, y, z = math.cos(angle) * radius, math.sin(angle) * radius, 0.12
		if config.layout == 2 then
			x *= if index % 2 == 0 then 0.45 else 1
			y *= if index % 2 == 0 then 0.45 else 1
		elseif config.layout == 3 then
			x = (index / #sparks - 0.5) * radius * 3
			y = math.sin(index * math.pi / 2) * radius * 0.35
		elseif config.layout == 4 then
			local spoke = (index % 4) * math.pi / 2
			local reach = radius * (0.4 + math.ceil(index / 4) / 3)
			x, y = math.cos(spoke) * reach, math.sin(spoke) * reach
		elseif config.layout == 5 then
			x, y = math.cos(angle * 2) * radius * index / #sparks, math.sin(angle * 2) * radius * index / #sparks
		elseif config.layout == 6 then
			local edge = math.max(math.abs(math.cos(angle)), math.abs(math.sin(angle)))
			x, y = x / edge, y / edge
		elseif config.layout == 7 then
			x, y = math.cos(angle / 2) * radius, math.sin(angle / 2) * radius * 1.6
		elseif config.layout == 8 then
			x, y, z = math.cos(angle) * radius * 0.5, math.sin(angle) * radius * 1.8, (index % 3) * radius * 0.8
		end
		spark.Position = center + Vector3.new(x, y, z + index * 0.008)
		spark.Size = Vector3.one * math.max(0.025, scale * (0.35 - progress * 0.2))
		spark.Transparency = if active then 1 - config.opacity * (1 - progress * 0.7) else 1
	end
	projectile.Position = contact + Vector3.new(0, 0, math.max(0, -timeMs / 1000) * 40)
	projectile.Transparency = if timeMs >= 0 then 1 else 0
	state:SetAttribute("Phase", phaseName)
	state:SetAttribute("ElapsedMs", timeMs)
	state:SetAttribute("Contact", timeMs >= 0)
	-- Fullscreen GUI extent, not Camera.ViewportSize's device-safe UI rectangle.
	-- Native pixel dimensions are checked independently by the screenshot host.
	state:SetAttribute("ViewportWidth", math.round(gui.AbsoluteSize.X))
	state:SetAttribute("ViewportHeight", math.round(gui.AbsoluteSize.Y))
end

local names = { "before", "onset", "peak", "decay", "preview" }
local times = { -100, 50, 180, 650 }
for index, name in names do
	local button = Instance.new("TextButton")
	button.Name = name
	button.Size = UDim2.new(0.2, -8, 0, 40)
	button.Position = UDim2.new((index - 1) * 0.2, 4, 1, -48)
	button.BackgroundColor3 = Color3.fromRGB(25, 30, 38)
	button.TextColor3 = Color3.new(1, 1, 1)
	button.TextSize = 18
	button.Text = string.upper(name)
	button.Parent = gui
	button.Activated:Connect(function()
		phaseName = name
		previewStarted = if name == "preview" then os.clock() else nil
		elapsedMs = times[index] or -100
		render(elapsedMs)
	end)
end

-- Reapply after Roblox's camera update, including while holding a phase.
RunService:BindToRenderStep("ImpactCaptureCamera", Enum.RenderPriority.Camera.Value + 1, function()
	-- Studio can create or replace CurrentCamera during startup and view changes.
	local camera = workspace.CurrentCamera
	if camera == nil then return end
	camera.CameraType = Enum.CameraType.Scriptable
	camera.CFrame = fixedCamera
	camera.Focus = CFrame.new(0, 2, 0)
	camera.FieldOfView = 60
	local start = previewStarted
	render(if start then ((os.clock() - start) % 3) * 1000 - 100 else elapsedMs)
end)
