--!strict

-- Evaluate one fixed anchor fact in this context. Every kind reads platform state:
-- Humanoid state, character support or position, GUI visibility, or part state.
-- No kind reads a candidate attribute, so a candidate cannot choose when the
-- runner observes. An error means the runner could not acquire the fact.
local Collector = require(script.Parent.Collector)
local isGuiVisible = require(script.Parent.GuiVisibility)

local AnchorFact = {}

-- An absent zero_or_one or exactly_one role is an observed absence. Any other
-- binding failure (ambiguous, wrong class, wrong scope) stops acquisition.
local function resolve(path: string): Instance?
	local instance, failure = Collector.resolvePath(path)
	if failure ~= nil and failure ~= "missing" then
		error("Anchor binding " .. path .. " failed: " .. failure)
	end
	return instance
end

local function characterRoot(fact: any, actors: { [string]: Player }): (Model?, BasePart?)
	local player: Player? = actors[fact.actor]
	if player == nil then error("Anchor actor " .. tostring(fact.actor) .. " is not bound") end
	local character = player.Character
	if character == nil or not character:IsDescendantOf(workspace) then return nil, nil end
	local root = character:FindFirstChild("HumanoidRootPart")
	if root == nil or not root:IsA("BasePart") then return character, nil end
	return character, root
end

local function part(path: string): BasePart?
	local instance = resolve(path)
	if instance ~= nil and instance:IsA("BasePart") then return instance end
	return nil
end

function AnchorFact.evaluate(fact: any, actors: { [string]: Player }): boolean
	if fact.kind == "humanoid_state" then
		local character = characterRoot(fact, actors)
		local humanoid = if character then character:FindFirstChildOfClass("Humanoid") else nil
		return humanoid ~= nil and humanoid:GetState().Name == fact.state
	elseif fact.kind == "character_on_part" then
		local character, root = characterRoot(fact, actors)
		local target = part(fact.path)
		if character == nil or root == nil or target == nil then return false end
		local parameters = RaycastParams.new()
		parameters.FilterType = Enum.RaycastFilterType.Exclude
		parameters.FilterDescendantsInstances = { character }
		parameters.IgnoreWater = true
		local hit = workspace:Raycast(root.Position, Vector3.new(0, -8, 0), parameters)
		return hit ~= nil and hit.Instance == target
	elseif fact.kind == "character_near_part" then
		local _, root = characterRoot(fact, actors)
		local target = part(fact.path)
		if root == nil or target == nil then return false end
		-- Distance to the box of the part, not to its center, so large parts are fair.
		local relative = target.CFrame:PointToObjectSpace(root.Position)
		local half = target.Size / 2
		local nearest = Vector3.new(
			math.clamp(relative.X, -half.X, half.X),
			math.clamp(relative.Y, -half.Y, half.Y),
			math.clamp(relative.Z, -half.Z, half.Z)
		)
		return (relative - nearest).Magnitude <= fact.radiusStuds
	elseif fact.kind == "gui_visible" then
		local instance = resolve(fact.path)
		local visible = instance ~= nil and instance:IsA("GuiObject") and isGuiVisible(instance)
		return visible == fact.visible
	elseif fact.kind == "instance_present" then
		return (resolve(fact.path) ~= nil) == fact.present
	elseif fact.kind == "part_can_collide" then
		local target = part(fact.path)
		return target ~= nil and target.CanCollide == fact.value
	elseif fact.kind == "part_anchored" then
		local target = part(fact.path)
		return target ~= nil and target.Anchored == fact.value
	end
	error("Unsupported fixed anchor fact kind")
end

return table.freeze(AnchorFact)
