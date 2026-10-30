--!strict

-- Fixed Studio-only movement probe. The hidden plan supplies only a BasePart
-- path; neither the candidate nor this module supplies the expected outcome.
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Collector = require(script.Parent.Collector)
local BarrierProbe = {}

local INTERVAL = 0.05
local DURATION = 2.5
local CORRIDOR_HALF_WIDTH = 3

local function point(value: Vector3): { x: number, y: number, z: number }
	return { x = value.X, y = value.Y, z = value.Z }
end

local function wall(position: Vector3, normal: Vector3, length: number): BasePart
	local part = Instance.new("Part")
	part.Name = "BasaltBarrierProbeWall"
	part.Anchored = true
	part.CanCollide = true
	part.CanTouch = false
	part.CanQuery = false
	part.Transparency = 1
	part.Size = Vector3.new(1, 12, length)
	part.CFrame = CFrame.lookAt(position, position + normal)
	part.Parent = workspace
	return part
end

function BarrierProbe.run(path: string, active: () -> boolean, trace: (string, { [string]: any }) -> ()): any
	assert(active(), "Barrier probe was cancelled")
	local barrier = Collector.resolvePath(path)
	assert(barrier ~= nil and barrier:IsA("BasePart") and barrier:IsDescendantOf(workspace),
		"Declared barrier is not a Workspace BasePart")
	local player = Players.LocalPlayer
	local character = if player then player.Character else nil
	local humanoid = if character then character:FindFirstChildOfClass("Humanoid") else nil
	local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
	assert(character ~= nil and character:IsDescendantOf(workspace) and humanoid ~= nil
		and root ~= nil and root:IsA("BasePart") and humanoid.Health > 0,
		"A living local avatar is required for the barrier probe")
	local gate = barrier :: BasePart
	local body = character :: Model
	local mover = humanoid :: Humanoid
	local base = root :: BasePart
	local depthOnX = gate.Size.X < gate.Size.Z
	local direction = if depthOnX then gate.CFrame.RightVector else gate.CFrame.LookVector
	local across = if depthOnX then gate.CFrame.LookVector else gate.CFrame.RightVector
	assert(math.abs(direction.Y) < 0.05 and math.abs(across.Y) < 0.05,
		"Barrier probe requires a level rectangular barrier")
	local normal = Vector3.new(direction.X, 0, direction.Z).Unit
	local lateral = Vector3.new(across.X, 0, across.Z).Unit
	local halfDepth = (if depthOnX then gate.Size.X else gate.Size.Z) / 2
	local halfWidth = (if depthOnX then gate.Size.Z else gate.Size.X) / 2
	local halfHeight = gate.Size.Y / 2
	assert(halfWidth >= CORRIDOR_HALF_WIDTH + 1 and halfHeight >= 2.5 and halfDepth >= 0.25,
		"Barrier cannot enclose the fixed avatar corridor")
	local origin = Vector3.new(gate.Position.X, base.Position.Y, gate.Position.Z)
	local start = origin + normal * (halfDepth + 6)
	local goal = origin - normal * (halfDepth + 6)
	local walls: { BasePart } = {}
	local function collect(): any
		body:PivotTo(body:GetPivot() + (start - base.Position))
		for _, sign in { -1, 1 } do
			table.insert(walls, wall(origin + lateral * sign * (CORRIDOR_HALF_WIDTH + 0.5),
				normal, 2 * (halfDepth + 8)))
		end
		task.wait(0.2) -- let avatar replication settle before the measured movement
		assert(active(), "Barrier probe was cancelled before movement")
		trace("barrier.setup", { path = path, start = point(start), goal = point(goal),
			center = point(gate.Position), normal = point(normal), halfDepth = halfDepth,
			halfWidth = halfWidth, halfHeight = halfHeight, corridorHalfWidth = CORRIDOR_HALF_WIDTH })
		local samples = {}
		local clock = os.clock()
		local function sample()
			local position = base.Position
			table.insert(samples, { elapsedMs = math.floor((os.clock() - clock) * 1000 + 0.5),
				x = position.X, y = position.Y, z = position.Z, health = mover.Health })
		end
		sample()
		mover:MoveTo(goal)
		local nextSample = clock + INTERVAL
		while os.clock() - clock < DURATION do
			RunService.Heartbeat:Wait()
			assert(active(), "Barrier probe was cancelled during movement")
			if os.clock() >= nextSample then
				sample()
				-- Missing a frame reduces sample count; it must never create two
				-- zero-time samples to make the report look complete.
				nextSample += INTERVAL
				if nextSample <= os.clock() then nextSample = os.clock() + INTERVAL end
			end
		end
		if samples[#samples].elapsedMs < 2450 then sample() end
		mover:MoveTo(base.Position)
		trace("barrier.sampled", { path = path, samples = #samples,
			elapsedMs = samples[#samples].elapsedMs })
		return { barrierPath = path, center = point(gate.Position), normal = point(normal),
			halfDepth = halfDepth, halfWidth = halfWidth, halfHeight = halfHeight,
			corridorHalfWidth = CORRIDOR_HALF_WIDTH, samples = samples }
	end
	local succeeded, result = pcall(collect)
	for _, part in walls do part:Destroy() end
	if not succeeded then error(result) end
	return result
end

return table.freeze(BarrierProbe)
