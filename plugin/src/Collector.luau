--!strict

local LogService = game:GetService("LogService")
local ScriptContext = game:GetService("ScriptContext")
local Players = game:GetService("Players")
local CollectionService = game:GetService("CollectionService")
local RunService = game:GetService("RunService")
local Stats = game:GetService("Stats")
local GuiService = game:GetService("GuiService")
local isGuiVisible = require(script.Parent.GuiVisibility)
local GuiLayout = require(script.Parent.GuiLayout)

local Collector = {}
local semanticRoles: { [string]: any } = {}
local errorMessages: { string } = {}
local scriptErrors: { any } = {}
-- Each channel keeps its first 100 errors. A flood of candidate errors is evidence about
-- the build, so a full channel stops retaining instead of failing the capture.
local CHANNEL_LIMIT = 100
local TEXT_LIMIT = 16000
-- An instance_value observation reads the Value of these classes only.
local VALUE_CLASSES: { [string]: boolean } = table.freeze({ IntValue = true, NumberValue = true, BoolValue = true, StringValue = true })

-- Keep the leading bytes of an oversized text without splitting a UTF-8 sequence.
local function bounded(text: string): string
	if #text <= TEXT_LIMIT then return text end
	local cut = TEXT_LIMIT
	for _ = 1, 3 do
		if utf8.len(string.sub(text, 1, cut)) ~= nil then break end
		cut -= 1
	end
	return string.sub(text, 1, cut)
end

-- A history-array index silently loses errors when Studio clears or rotates Output.
-- Subscribe once and retain only bounded errors since the connection/last Stop.
local diagnosticsConnection = LogService.MessageOut:Connect(function(message, messageType)
	if messageType ~= Enum.MessageType.MessageError or #errorMessages >= CHANNEL_LIMIT then return end
	table.insert(errorMessages, bounded(message))
end)

-- Keep engine-supplied origin separately from Output. The two channels can
-- describe the same error; matching message text is not a reliable event ID.
local scriptErrorConnection = ScriptContext.Error:Connect(function(message, stackTrace, errorScript)
	if #scriptErrors >= CHANNEL_LIMIT then return end
	local source: { [string]: any } = { kind = "unavailable" }
	if errorScript ~= nil then
		local ok, identity = pcall(function()
			return { kind = "script", path = errorScript:GetFullName(), className = errorScript.ClassName,
				inDataModel = errorScript:IsDescendantOf(game) }
		end)
		-- An origin too long to retain whole is recorded as unavailable, never shortened.
		if ok and #identity.path <= 2048 and #identity.className <= 80 then
			source = identity
		end
	end
	table.insert(scriptErrors, { message = bounded(message), stackTrace = bounded(stackTrace), source = source })
end)

function Collector.configureRoles(roles: { any })
	local nextRoles = {}
	for _, role in roles do
		nextRoles[role.id] = role
	end
	semanticRoles = nextRoles
end

function Collector.resolvePath(path: string): (Instance?, string?)
	local parts = string.split(path, ".")
	if parts[1] == "role" then
		if #parts ~= 2 then return nil, "undeclared_role" end
		local role = semanticRoles[parts[2]]
		if role == nil then return nil, "undeclared_role" end
		local root: Instance?
		if role.scope == "workspace" then
			root = workspace
		elseif role.scope == "replicated_storage" then
			root = game:GetService("ReplicatedStorage")
		elseif role.scope == "local_player_gui" then
			local player = Players.LocalPlayer
			root = if player then player:FindFirstChildOfClass("PlayerGui") else nil
		end
		if root == nil then return nil, "unavailable_scope" end
		local found: Instance? = nil
		-- The role id is the CollectionService tag of the object.
		local tagged = CollectionService:GetTagged(role.id)
		for _, instance in tagged do
			if instance:IsDescendantOf(root) then
				if found ~= nil then return nil, "ambiguous" end
				found = instance
			end
		end
		if found == nil then return nil, if #tagged > 0 then "wrong_scope" elseif role.cardinality == "exactly_one" then "missing" else nil end
		if not found:IsA(role.className) then return nil, "wrong_class" end
		return found, nil
	end
	if parts[1] ~= "game" then
		return nil, nil
	end
	local current: Instance = game
	for index = 2, #parts do
		local name = parts[index]
		if current == Players and name == "LocalPlayer" then
			local player = Players.LocalPlayer
			if player == nil then
				return nil, nil
			end
			current = player
		else
			local child = current:FindFirstChild(name)
			if child == nil then
				return nil, nil
			end
			current = child
		end
	end
	return current, nil
end

local function diagnostics(factId: string): { [string]: any }
	if not diagnosticsConnection.Connected or not scriptErrorConnection.Connected then
		error("Studio diagnostics are incomplete")
	end
	return { factId = factId, kind = "diagnostics", messages = table.clone(errorMessages),
		scriptErrors = table.clone(scriptErrors) }
end

function Collector.resetDiagnostics()
	errorMessages = {}
	scriptErrors = {}
end

function Collector.disconnect()
	diagnosticsConnection:Disconnect()
	scriptErrorConnection:Disconnect()
end

local function finiteStats(read: () -> number): (boolean, number?)
	local ok, value = pcall(read)
	if not ok or type(value) ~= "number" or value ~= value or math.abs(value) == math.huge then return false, nil end
	return true, value
end

-- The reader of one Stats value, or nil when Studio refuses the first read. Then every sample
-- omits that field, so all samples of a trace have one shape. A refusal after a good first
-- read stops the trace as incomplete.
local function statsReader(read: () -> number): (() -> number)?
	if not finiteStats(read) then return nil end
	return function(): number
		local ok, value = finiteStats(read)
		if not ok then error("Performance trace lost a Stats value") end
		return value :: number
	end
end

local function readInstanceCount(): number return Stats.InstanceCount end
local function readMemoryMb(): number return Stats:GetTotalMemoryUsageMb() end

-- Frame times come from RunService.Heartbeat between samples, so they need no Stats access.
-- Each sample covers the interval since the previous sample.
local function performanceTrace(fact: { [string]: any }): { [string]: any }
	local instanceCount = statsReader(readInstanceCount)
	local memoryMb = statsReader(readMemoryMb)
	local frames, totalSeconds, longestSeconds = 0, 0, 0
	local connection = RunService.Heartbeat:Connect(function(seconds: number)
		frames += 1
		totalSeconds += seconds
		longestSeconds = math.max(longestSeconds, seconds)
	end)
	local started = os.clock()
	local samples = {}
	local ok, failure = pcall(function()
		for _ = 1, fact.sampleCount do
			task.wait(fact.intervalMs / 1000)
			table.insert(samples, {
				elapsedMs = math.round((os.clock() - started) * 1000),
				frames = frames,
				meanFrameMs = if frames > 0 then totalSeconds * 1000 / frames else 0,
				maxFrameMs = longestSeconds * 1000,
				instanceCount = if instanceCount then instanceCount() else nil,
				memoryMb = if memoryMb then memoryMb() else nil,
			})
			frames, totalSeconds, longestSeconds = 0, 0, 0
		end
	end)
	connection:Disconnect()
	if not ok then error(failure) end
	return { factId = fact.id, kind = "performance_trace", samples = samples }
end

function Collector.collect(fact: { [string]: any }): { [string]: any }
	if fact.kind == "diagnostics" then
		return diagnostics(fact.id)
	end
	if fact.kind == "player_count" then
		return { factId = fact.id, kind = "player_count", value = #Players:GetPlayers() }
	end
	if fact.kind == "performance_trace" then
		return performanceTrace(fact)
	end
	local instance, bindingFailure = Collector.resolvePath(fact.path)
	if bindingFailure then
		return { factId = fact.id, kind = "binding_failure", requestedKind = fact.kind, path = fact.path, reason = bindingFailure }
	end
	if fact.kind == "instance" then
		return {
			factId = fact.id,
			kind = "instance",
			exists = instance ~= nil,
			className = if instance then instance.ClassName else "",
		}
	elseif fact.kind == "instance_name" then
		return { factId = fact.id, kind = "instance_name", exists = instance ~= nil,
			name = if instance then instance.Name else "" }
	elseif fact.kind == "instance_value" then
		-- Read only the Value of the four fixed ValueBase classes. Another class is not a value.
		if not instance or not VALUE_CLASSES[instance.ClassName] then
			return { factId = fact.id, kind = "instance_value", exists = false, className = "", value = false }
		end
		local value = (instance :: IntValue | NumberValue | BoolValue | StringValue).Value
		if type(value) == "number" and (value ~= value or math.abs(value) == math.huge) then
			error("An instance value must be a finite number")
		end
		return { factId = fact.id, kind = "instance_value", exists = true,
			className = instance.ClassName, value = value }
	elseif fact.kind == "part_physics_trace" then
		if not instance or not instance:IsA("BasePart") then
			return { factId = fact.id, kind = "part_physics_trace", exists = false,
				initialAnchored = false, finalAnchored = false, everUnanchored = false,
				initialCanCollide = false, finalCanCollide = false,
				observedMs = 0, changes = {} }
		end
		local started = os.clock()
		local initial = instance.Anchored
		local initialCanCollide = instance.CanCollide
		local everUnanchored = not initial
		local changes = {}
		local overflow = false
		local function changed()
			local anchored = instance.Anchored
			everUnanchored = everUnanchored or not anchored
			if #changes >= 256 then overflow = true; return end
			table.insert(changes, { elapsedMs = math.round((os.clock() - started) * 1000), anchored = anchored, canCollide = instance.CanCollide })
		end
		local anchoredConnection = instance:GetPropertyChangedSignal("Anchored"):Connect(changed)
		local collisionConnection = instance:GetPropertyChangedSignal("CanCollide"):Connect(changed)
		task.wait(fact.durationMs / 1000)
		local final = instance.Anchored
		local finalCanCollide = instance.CanCollide
		local observedMs = math.round((os.clock() - started) * 1000)
		anchoredConnection:Disconnect()
		collisionConnection:Disconnect()
		if overflow or not instance:IsDescendantOf(game) then error("Part physics trace is incomplete") end
		if (if #changes > 0 then changes[#changes].anchored else initial) ~= final
			or (if #changes > 0 then changes[#changes].canCollide else initialCanCollide) ~= finalCanCollide then
			if #changes >= 256 then error("Part physics trace is incomplete") end
			table.insert(changes, { elapsedMs = observedMs, anchored = final, canCollide = finalCanCollide })
		end
		everUnanchored = everUnanchored or not final
		return { factId = fact.id, kind = "part_physics_trace", exists = true,
			initialAnchored = initial, finalAnchored = final,
			initialCanCollide = initialCanCollide, finalCanCollide = finalCanCollide,
			everUnanchored = everUnanchored, observedMs = observedMs, changes = changes }
	elseif fact.kind == "part_route_trace" then
		local startMarker = Collector.resolvePath(fact.startPath)
		local endMarker = Collector.resolvePath(fact.endPath)
		if not instance or not instance:IsA("BasePart")
			or not startMarker or not startMarker:IsA("BasePart")
			or not endMarker or not endMarker:IsA("BasePart") then
			return { factId = fact.id, kind = "part_route_trace", exists = false,
				observedMs = 0, sampleCount = 0, maxFrameGapMs = 0, visits = {} }
		end
		local started = os.clock()
		local previousMs = 0
		local previousPosition = instance.Position
		local maxFrameGapMs = 0
		local sampleCount = 0
		local visits = {}
		local active = { start = nil, ["end"] = nil }
		local markers: { [string]: BasePart } = { start = startMarker, ["end"] = endMarker }
		local function sample()
			local elapsedMs = math.round((os.clock() - started) * 1000)
			local position = instance.Position
			local frameGapMs = if sampleCount == 0 then 0 else elapsedMs - previousMs
			maxFrameGapMs = math.max(maxFrameGapMs, frameGapMs)
			sampleCount += 1
			local movement = (position - previousPosition).Magnitude
			for markerName, marker in markers do
				local offset = Vector2.new(position.X - marker.Position.X, position.Z - marker.Position.Z)
				local distance = offset.Magnitude
				local visit = active[markerName]
				if distance <= fact.proximityStuds then
					if visit == nil then
						visit = { marker = markerName, enterMs = elapsedMs, exitMs = elapsedMs,
							travelStuds = 0, minDistanceStuds = distance, longestStillMs = 0,
							maxFrameGapMs = 0, stillFromMs = elapsedMs }
						active[markerName] = visit
					else
						visit.travelStuds += movement
						visit.minDistanceStuds = math.min(visit.minDistanceStuds, distance)
						visit.maxFrameGapMs = math.max(visit.maxFrameGapMs, frameGapMs)
						if movement > 0.001 then
							visit.longestStillMs = math.max(visit.longestStillMs, previousMs - visit.stillFromMs)
							visit.stillFromMs = elapsedMs
						else
							visit.longestStillMs = math.max(visit.longestStillMs, elapsedMs - visit.stillFromMs)
						end
					end
				else
					if visit ~= nil then
						visit.exitMs = previousMs
						visit.stillFromMs = nil
						table.insert(visits, visit)
						active[markerName] = nil
					end
				end
			end
			if #visits > 256 then error("Part route trace exceeds visit limit") end
			previousMs, previousPosition = elapsedMs, position
		end
		sample()
		while (os.clock() - started) * 1000 < fact.durationMs do
			RunService.Heartbeat:Wait()
			if Collector.resolvePath(fact.path) ~= instance
				or Collector.resolvePath(fact.startPath) ~= startMarker
				or Collector.resolvePath(fact.endPath) ~= endMarker then
				error("Part route trace lost a required instance")
			end
			sample()
		end
		local observedMs = previousMs
		for markerName, visit in active do
			if visit ~= nil then
				visit.exitMs = observedMs
				visit.stillFromMs = nil
				table.insert(visits, visit)
				active[markerName] = nil
			end
		end
		if #visits > 256 then error("Part route trace exceeds visit limit") end
		table.sort(visits, function(a, b) return a.enterMs < b.enterMs end)
		return { factId = fact.id, kind = "part_route_trace", exists = true,
			observedMs = observedMs, sampleCount = sampleCount,
			maxFrameGapMs = maxFrameGapMs, visits = visits }
	elseif fact.kind == "part_motion" then
		local samples = {}
		if instance and instance:IsA("BasePart") then
			local origin = instance.Position
			local started = os.clock()
			local maximumDelta = 0
			for index = 1, fact.sampleCount do
				if index > 1 then
					task.wait(fact.intervalMs / 1000)
				end
				-- task.wait resumes on a later frame; nominal intervals are not measurements.
				local position = if index == 1 then origin else instance.Position
				local elapsed = if index == 1 then 0 else math.round((os.clock() - started) * 1000)
				maximumDelta = math.max(maximumDelta, (position - origin).Magnitude)
				table.insert(samples, { elapsedMs = elapsed, x = position.X, y = position.Y, z = position.Z })
			end
			return { factId = fact.id, kind = "part_motion", samples = samples, delta = maximumDelta }
		end
		return { factId = fact.id, kind = "part_motion", samples = samples, delta = 0 }
	elseif fact.kind == "gui_text" then
		if instance and (instance:IsA("TextLabel") or instance:IsA("TextButton") or instance:IsA("TextBox")) then
			local textObject = instance :: (TextLabel | TextButton | TextBox)
			return { factId = fact.id, kind = "gui_text", exists = true, text = textObject.Text, visible = isGuiVisible(instance) }
		end
		return { factId = fact.id, kind = "gui_text", exists = false, text = "", visible = false }
	elseif fact.kind == "gui_geometry" then
		if instance and instance:IsA("GuiObject") then
			local gui = instance :: GuiObject
			local position = gui.AbsolutePosition
			local size = gui.AbsoluteSize
			return { factId = fact.id, kind = "gui_geometry", exists = true,
				visible = isGuiVisible(gui), x = position.X, y = position.Y,
				width = size.X, height = size.Y }
		end
		return { factId = fact.id, kind = "gui_geometry", exists = false,
			visible = false, x = 0, y = 0, width = 0, height = 0 }
	elseif fact.kind == "gui_layout" then
		if not instance or not instance:IsA("ScreenGui") then return GuiLayout.absent(fact.id) end
		return GuiLayout.observe(fact.id, instance :: ScreenGui, GuiService, workspace.CurrentCamera)
	elseif fact.kind == "part_position" then
		if instance and instance:IsA("BasePart") then
			local position = instance.Position
			return { factId = fact.id, kind = "part_position", exists = true,
				x = position.X, y = position.Y, z = position.Z }
		end
		return { factId = fact.id, kind = "part_position", exists = false, x = 0, y = 0, z = 0 }
	elseif fact.kind == "part_physics" then
		if instance and instance:IsA("BasePart") then
			return { factId = fact.id, kind = "part_physics", exists = true,
				anchored = instance.Anchored, canCollide = instance.CanCollide }
		end
		return { factId = fact.id, kind = "part_physics", exists = false,
			anchored = false, canCollide = false }
	elseif fact.kind == "particle_state" then
		local emitter = if instance and instance:IsA("ParticleEmitter") then instance else nil
		return {
			factId = fact.id,
			kind = "particle_state",
			exists = emitter ~= nil,
			enabled = if emitter then emitter.Enabled else false,
			emissionRate = if emitter then emitter.Rate else 0,
		}
	elseif fact.kind == "replication_probe" then
		local value = if instance then instance:GetAttribute(fact.attribute) else nil
		local valueType = typeof(value)
		if value ~= nil and valueType ~= "boolean" and valueType ~= "number" and valueType ~= "string" then
			error("Replication probe attributes must be boolean, number, or string")
		end
		return {
			factId = fact.id,
			kind = "replication_probe",
			exists = instance ~= nil and value ~= nil,
			value = if value == nil then false else value,
			observedFrom = "studio",
		}
	end
	error("Unsupported fixed fact kind")
end

function Collector.collectScenario(fact: { [string]: any }, actors: { [string]: Player }): { [string]: any }
  if fact.path and string.sub(fact.path, 1, 5) == "role." then
    local _, failure = Collector.resolvePath(fact.path)
    if failure then return { factId = fact.id, kind = "binding_failure", requestedKind = fact.kind, path = fact.path, reason = failure } end
  end
	if fact.kind == "actor_part_support" then
		local player = actors[fact.actor]
		local character = if player then player.Character else nil
		local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
		local target = Collector.resolvePath(fact.path)
		local empty = { factId = fact.id, kind = "actor_part_support", actor = fact.actor,
			exists = false, localX = 0, localY = 0, localZ = 0,
			sizeX = 0, sizeY = 0, sizeZ = 0, hitTarget = false, hitDistance = 0 }
		if not root or not root:IsA("BasePart") or not target or not target:IsA("BasePart") then
			return empty
		end
		local relative = target.CFrame:PointToObjectSpace(root.Position)
		local parameters = RaycastParams.new()
		parameters.FilterType = Enum.RaycastFilterType.Exclude
		parameters.FilterDescendantsInstances = { character :: Model }
		parameters.IgnoreWater = true
		local hit = workspace:Raycast(root.Position, Vector3.new(0, -8, 0), parameters)
		return { factId = fact.id, kind = "actor_part_support", actor = fact.actor,
			exists = true, localX = relative.X, localY = relative.Y, localZ = relative.Z,
			sizeX = target.Size.X, sizeY = target.Size.Y, sizeZ = target.Size.Z,
			hitTarget = hit ~= nil and hit.Instance == target,
			hitDistance = if hit then (root.Position - hit.Position).Magnitude else 0 }
	end
	if fact.kind == "actor_part_motion" then
		local player = actors[fact.actor]
		local character = if player then player.Character else nil
		local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
		local target = Collector.resolvePath(fact.path)
		local empty = { factId = fact.id, kind = "actor_part_motion", actor = fact.actor,
			exists = false, samples = {}, partDelta = 0, actorDelta = 0, maxRelativeDelta = 0 }
		if not root or not root:IsA("BasePart") or not target or not target:IsA("BasePart") then
			return empty
		end
		local initialPart = target.Position
		local initialActor = root.Position
		local initialRelative = initialActor - initialPart
		local started = os.clock()
		local samples = {}
		local partDelta = 0
		local actorDelta = 0
		local maxRelativeDelta = 0
		for index = 1, fact.sampleCount do
			if index > 1 then task.wait(fact.intervalMs / 1000) end
			if not root:IsDescendantOf(workspace) or not target:IsDescendantOf(workspace) then return empty end
			local partPosition = target.Position
			local actorPosition = root.Position
			local localPosition = target.CFrame:PointToObjectSpace(actorPosition)
			local partSize = target.Size
			partDelta = math.max(partDelta, (partPosition - initialPart).Magnitude)
			actorDelta = math.max(actorDelta, (actorPosition - initialActor).Magnitude)
			maxRelativeDelta = math.max(maxRelativeDelta,
				((actorPosition - partPosition) - initialRelative).Magnitude)
			table.insert(samples, { elapsedMs = if index == 1 then 0 else math.round((os.clock() - started) * 1000),
				x = partPosition.X, y = partPosition.Y, z = partPosition.Z,
				actorX = actorPosition.X, actorY = actorPosition.Y, actorZ = actorPosition.Z,
				localX = localPosition.X, localY = localPosition.Y, localZ = localPosition.Z,
				sizeX = partSize.X, sizeY = partSize.Y, sizeZ = partSize.Z })
		end
		return { factId = fact.id, kind = "actor_part_motion", actor = fact.actor,
			exists = true, samples = samples, partDelta = partDelta,
			actorDelta = actorDelta, maxRelativeDelta = maxRelativeDelta }
	end
	if fact.kind ~= "actor_health" then return Collector.collect(fact) end
	local player = actors[fact.actor]
	local character = if player then player.Character else nil
	local humanoid = if character then character:FindFirstChildOfClass("Humanoid") else nil
	return {
		factId = fact.id,
		kind = "actor_health",
		actor = fact.actor,
		exists = humanoid ~= nil,
		value = if humanoid then humanoid.Health else 0,
	}
end

return table.freeze(Collector)
