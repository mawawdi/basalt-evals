-- Exercise the actual collector with a deterministic clock and a delayed scheduler.
-- Loading a custom environment keeps engine services out of these offline tests.
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local roblox = require("@lune/roblox")
local isGuiVisible = require("../plugin/src/GuiVisibility")
local GuiLayout = luau.load(fs.readFile("plugin/src/GuiLayout.luau"), {
	environment = {
		script = { Parent = { GuiVisibility = "GuiVisibility" } },
		require = function(name) assert(name == "GuiVisibility"); return isGuiVisible end,
	},
})()
local world = roblox.Instance.new("Folder")
local part = roblox.Instance.new("Part"); part.Name = "Moving"; part.Parent = world
local gui = roblox.Instance.new("ScreenGui"); gui.Name = "Gui"; gui.Parent = world
local label = roblox.Instance.new("TextLabel"); label.Name = "Label"; label.Parent = gui
local clock, waits = 100, 0
local outputError, scriptError
local function connectDiagnostic(callback)
	local connection = { Connected = true }
	connection.Disconnect = function() connection.Connected = false end
	return connection
end
local physicsChanged = nil
local collisionChanged = nil
local physicsTransitions = {}
local collisionTransitions = {}
local physicsProbe = {
	Anchored = false,
	CanCollide = true,
	IsA = function(_, className) return className == "BasePart" end,
	IsDescendantOf = function() return true end,
	GetPropertyChangedSignal = function(_, property)
		assert(property == "Anchored" or property == "CanCollide")
		return { Connect = function(_, callback)
			if property == "Anchored" then physicsChanged = callback else collisionChanged = callback end
			return { Disconnect = function()
				if property == "Anchored" then physicsChanged = nil else collisionChanged = nil end
			end }
		end }
	end,
}
local routeFrames = nil
-- Each task.wait fires these Heartbeat steps (seconds) while a performance trace listens.
local heartbeatListener = nil
local heartbeatSteps = {}
-- InstanceCount reads succeed while statsReadable holds and until statsReadLimit reads.
local statsReadable = true
local statsReads = 0
local statsReadLimit = math.huge
local statsProbe = setmetatable({
	GetTotalMemoryUsageMb = function() return 812.5 end,
}, { __index = function(_, key)
	assert(key == "InstanceCount", "The performance trace reads only fixed Stats members")
	statsReads += 1
	if not statsReadable or statsReads > statsReadLimit then error("The current identity cannot read Stats") end
	return 5120
end })
local heartbeat = { Heartbeat = { Connect = function(_, callback)
	heartbeatListener = callback
	return { Disconnect = function() heartbeatListener = nil end }
end, Wait = function()
	if routeFrames == nil then error("Unexpected route heartbeat") end
	local frame = table.remove(routeFrames, 1)
	if frame == nil then error("Route trace exceeded its frame schedule") end
	clock += 0.1
	part.Position = roblox.Vector3.new(frame, 0, 0)
end } }
local tagged = { target = { part } }
part.Position = roblox.Vector3.new(0, 0, 0)
local collector = luau.load(fs.readFile("plugin/src/Collector.luau"), {
	environment = {
		game = {
			GetService = function(_, name)
				if name == "LogService" then
					return { MessageOut = { Connect = function(_, callback)
						outputError = callback
						return connectDiagnostic(callback)
					end } }
				end
				if name == "ScriptContext" then
					return { Error = { Connect = function(_, callback)
						scriptError = callback
						return connectDiagnostic(callback)
					end } }
				end
				if name == "CollectionService" then
					return { GetTagged = function(_, tag) return tagged[tag] or {} end }
				end
				if name == "RunService" then return heartbeat end
				if name == "Stats" then return statsProbe end
				return {}
			end,
			FindFirstChild = function(_, name)
				if name == "PhysicsProbe" then return physicsProbe end
				return world:FindFirstChild(name)
			end,
		},
		script = { Parent = { GuiVisibility = "GuiVisibility", GuiLayout = "GuiLayout" } },
		require = function(name)
			if name == "GuiLayout" then return GuiLayout end
			assert(name == "GuiVisibility"); return isGuiVisible
		end,
		os = { clock = function() return clock end },
		task = { wait = function(seconds)
			waits += 1
			clock += seconds + 0.017
			if heartbeatListener ~= nil then
				for _, step in heartbeatSteps do heartbeatListener(step) end
			end
			part.Position = roblox.Vector3.new(waits * 3, waits * 4, 0)
			for _, anchored in physicsTransitions do
				physicsProbe.Anchored = anchored
				assert(physicsChanged ~= nil)
				physicsChanged()
			end
			for _, canCollide in collisionTransitions do
				physicsProbe.CanCollide = canCollide
				assert(collisionChanged ~= nil)
				collisionChanged()
			end
		end },
		workspace = world,
		Vector2 = roblox.Vector2,
		Enum = roblox.Enum,
	},
})()
local result = collector.collect({ id = "motion", kind = "part_motion", path = "game.Moving", sampleCount = 3, intervalMs = 200 })
assert(#result.samples == 3 and result.delta == 10)
assert(result.samples[1].elapsedMs == 0 and result.samples[2].elapsedMs == 217 and result.samples[3].elapsedMs == 434,
	"Motion must record actual elapsed time including scheduler delay")
local fact = { id = "text", kind = "gui_text", path = "game.Gui.Label" }
assert(collector.collect(fact).visible)
gui.Enabled = false
assert(not collector.collect(fact).visible, "Text inside a disabled ScreenGui is hidden")
local missing = collector.collect({ id = "motion", kind = "part_motion", path = "game.Missing", sampleCount = 3, intervalMs = 200 })
assert(#missing.samples == 0 and missing.delta == 0)
collector.configureRoles({ { id = "target", className = "BasePart", scope = "workspace", cardinality = "exactly_one" } })
assert(collector.resolvePath("role.target") == part, "A single tagged public role resolves by class and scope")
local actualName = collector.collect({ id = "actual-name", kind = "instance_name", path = "role.target" })
assert(actualName.exists and actualName.name == "Moving", "A tagged role exposes the actual instance name")
collector.configureRoles({ { id = "target", className = "Instance", scope = "workspace", cardinality = "exactly_one" } })
assert(collector.resolvePath("role.target") == part, "An authored generic object may be a Part")
local container = roblox.Instance.new("Folder"); container.Parent = world
container:SetAttribute("State", "ready")
tagged.target = { container }
local generic = collector.collect({ id = "generic-state", kind = "replication_probe", path = "role.target", attribute = "State" })
assert(generic.exists and generic.value == "ready", "Generic attribute binding accepts a valid alternative class")
tagged.target = { part }
collector.configureRoles({ { id = "target", className = "BasePart", scope = "workspace", cardinality = "exactly_one" } })
local other = roblox.Instance.new("Part"); other.Parent = world
table.insert(tagged.target, other)
assert(collector.resolvePath("role.target") == nil, "Ambiguous public roles fail closed")
local ambiguous = collector.collect({ id = "ambiguous", kind = "instance", path = "role.target" })
assert(ambiguous.kind == "binding_failure" and ambiguous.reason == "ambiguous" and ambiguous.exists == nil,
  "An ambiguous binding must not masquerade as observed absence")
table.remove(tagged.target)
collector.configureRoles({ { id = "target", className = "GuiObject", scope = "workspace", cardinality = "exactly_one" } })
assert(collector.resolvePath("role.target") == nil, "Wrong-class public roles fail closed")
local wrongClass = collector.collect({ id = "wrong-class", kind = "instance", path = "role.target" })
assert(wrongClass.kind == "binding_failure" and wrongClass.reason == "wrong_class")
collector.configureRoles({ { id = "absent", className = "BasePart", scope = "workspace", cardinality = "exactly_one" } })
local missing = collector.collect({ id = "missing", kind = "instance", path = "role.absent" })
assert(missing.kind == "binding_failure" and missing.reason == "missing", "A missing required role is a public contract failure")
collector.configureRoles({ { id = "absent", className = "BasePart", scope = "workspace", cardinality = "zero_or_one" } })
local absent = collector.collect({ id = "absent", kind = "instance", path = "role.absent" })
assert(absent.kind == "instance" and absent.exists == false, "An optional binding can establish observed absence")
local character = roblox.Instance.new("Model"); character.Parent = world
local root = roblox.Instance.new("Part"); root.Name = "HumanoidRootPart"; root.Parent = character
part.Size = roblox.Vector3.new(8, 1, 8)
part.CFrame = roblox.CFrame.new(part.Position)
root.Position = part.Position + roblox.Vector3.new(0, 4, 0)
local carry = collector.collectScenario({ id = "carry", kind = "actor_part_motion", actor = "primary",
	path = "game.Moving", sampleCount = 2, intervalMs = 200 }, { primary = { Character = character } })
assert(carry.exists and #carry.samples == 2, "Actor and platform share one motion clock")
assert(carry.samples[1].x == part.Position.X - 3 and carry.samples[2].x == part.Position.X
	and carry.samples[1].actorX == carry.samples[2].actorX
	and carry.samples[2].elapsedMs == 217,
	"Actor motion contains independent platform and actor trajectories with measured time")
assert(carry.samples[1].sizeX == 8 and carry.samples[1].sizeY == 1 and carry.samples[1].sizeZ == 8,
	"Motion evidence includes platform footprint")
assert(carry.samples[1].localX == 0 and carry.samples[1].localY == 4 and carry.samples[1].localZ == 0,
	"Motion evidence locates the actor in platform-local coordinates")
local startMarker = roblox.Instance.new("Part"); startMarker.Name = "StartMarker"; startMarker.Parent = world
local endMarker = roblox.Instance.new("Part"); endMarker.Name = "EndMarker"; endMarker.Parent = world
startMarker.Position = roblox.Vector3.new(0, 0, 0)
endMarker.Position = roblox.Vector3.new(10, 0, 0)
part.Position = roblox.Vector3.new(0, 0, 0)
routeFrames = { 0, 0, 5, 10, 10 }
local route = collector.collect({ id = "route", kind = "part_route_trace", path = "game.Moving",
	startPath = "game.StartMarker", endPath = "game.EndMarker", durationMs = 490,
	proximityStuds = 1 })
assert(route.exists and route.sampleCount == 6 and #route.visits == 2,
	"Frame-level route trace retains both endpoint visits")
assert(route.visits[1].marker == "start" and route.visits[2].marker == "end"
	and route.visits[1].longestStillMs >= 100 and route.visits[2].longestStillMs >= 100,
	"Endpoint visits retain measured stable intervals")
assert(route.maxFrameGapMs >= 100 and route.maxFrameGapMs <= 101,
	"Route trace exposes actual acquisition gaps")
local physicsFact = { id = "physics", kind = "part_physics_trace", path = "game.PhysicsProbe", durationMs = 100 }
local initiallyFree = collector.collect(physicsFact)
assert(initiallyFree.exists and not initiallyFree.initialAnchored and not initiallyFree.finalAnchored
	and initiallyFree.everUnanchored and #initiallyFree.changes == 0,
	"An initially unanchored part is recorded even without a change event")
physicsProbe.Anchored = true
local stablePhysics = collector.collect(physicsFact)
assert(stablePhysics.initialAnchored and stablePhysics.finalAnchored and not stablePhysics.everUnanchored,
	"A stable anchored trace includes both endpoint states")
physicsTransitions = { false, true }
local changedPhysics = collector.collect(physicsFact)
assert(changedPhysics.initialAnchored and changedPhysics.finalAnchored and changedPhysics.everUnanchored
	and #changedPhysics.changes == 2 and physicsChanged == nil,
	"Physics trace retains a temporary unanchored state and disconnects its listener")
physicsTransitions = {}
collisionTransitions = { false, true }
local changedCollision = collector.collect(physicsFact)
assert(changedCollision.initialCanCollide and changedCollision.finalCanCollide
	and not changedCollision.everUnanchored and #changedCollision.changes == 2
	and not changedCollision.changes[1].canCollide and changedCollision.changes[2].canCollide
	and physicsChanged == nil and collisionChanged == nil,
	"Physics trace retains temporary collision changes and disconnects both listeners")
collisionTransitions = {}
part:SetAttribute("Enabled", false)
local presentAttribute = collector.collect({ id = "attribute", kind = "replication_probe", path = "game.Moving", attribute = "Enabled" })
local absentAttribute = collector.collect({ id = "attribute", kind = "replication_probe", path = "game.Moving", attribute = "Missing" })
assert(presentAttribute.exists and presentAttribute.value == false and not absentAttribute.exists,
	"A present false attribute confirms the instance and attribute, while absence is distinct")
local function newValue(className, name, value)
	local instance = roblox.Instance.new(className); instance.Name = name; instance.Value = value; instance.Parent = world
	return instance
end
newValue("IntValue", "Wins", 3)
newValue("StringValue", "Phase", "ready")
newValue("BoolValue", "Open", false)
local ratio = newValue("NumberValue", "Ratio", 0.5)
local function valueOf(path) return collector.collect({ id = "value", kind = "instance_value", path = path }) end
local wins = valueOf("game.Wins")
assert(wins.exists and wins.className == "IntValue" and wins.value == 3, "An IntValue exposes its Value")
assert(valueOf("game.Phase").value == "ready" and valueOf("game.Ratio").value == 0.5,
	"A StringValue and a NumberValue expose their Value")
local open = valueOf("game.Open")
assert(open.exists and open.className == "BoolValue" and open.value == false,
	"A present false BoolValue is distinct from absence")
local otherClass = valueOf("game.Moving")
local absentValue = valueOf("game.Missing")
assert(not otherClass.exists and otherClass.className == "" and otherClass.value == false
	and not absentValue.exists and absentValue.className == "" and absentValue.value == false,
	"Another class or an absent instance gives the fallback, not a value")
ratio.Value = 0 / 0
assert(not pcall(valueOf, "game.Ratio"), "A NumberValue that is not finite cannot become evidence")
heartbeatSteps = { 0.016, 0.016, 0.034 }
local performance = collector.collect({ id = "load", kind = "performance_trace", sampleCount = 2, intervalMs = 250 })
assert(performance.kind == "performance_trace" and #performance.samples == 2 and heartbeatListener == nil,
	"A performance trace takes every planned sample and disconnects its Heartbeat listener")
local first = performance.samples[1]
assert(first.elapsedMs == 267 and performance.samples[2].elapsedMs == 534 and first.frames == 3
	and math.abs(first.meanFrameMs - 22) < 1e-9 and math.abs(first.maxFrameMs - 34) < 1e-9
	and first.instanceCount == 5120 and first.memoryMb == 812.5,
	"Each sample covers its own interval with measured time, Heartbeat frame times and Stats values")
statsReadable = false
heartbeatSteps = {}
local unreadable = collector.collect({ id = "load", kind = "performance_trace", sampleCount = 2, intervalMs = 250 })
for _, sample in unreadable.samples do
	assert(sample.instanceCount == nil and sample.memoryMb == 812.5 and sample.frames == 0
		and sample.meanFrameMs == 0 and sample.maxFrameMs == 0,
		"A refused Stats value is left out of every sample, and an interval without frames records zero frames")
end
statsReadable, statsReads, statsReadLimit = true, 0, 2
assert(not pcall(collector.collect, { id = "load", kind = "performance_trace", sampleCount = 3, intervalMs = 250 })
	and heartbeatListener == nil,
	"A Stats value that becomes unreadable stops the trace, so all samples keep one shape")
statsReadLimit = math.huge
for _, path in { "game.Missing", "game.Moving" } do
	local layout = collector.collect({ id = "layout", kind = "gui_layout", path = path })
	assert(layout.kind == "gui_layout" and not layout.exists and layout.complete and #layout.elements == 0
		and layout.screen.w == 0 and layout.viewport.w == 0 and layout.guiInset.top == 0
		and not layout.ignoreGuiInset, "An absent or non-ScreenGui target gives the zero fallback")
end
local diagnosticFact = { id = "errors", kind = "diagnostics" }
local message = "loadstring() is not available"
outputError(message, roblox.Enum.MessageType.MessageError)
outputError(message, roblox.Enum.MessageType.MessageError)
scriptError(message, "Plugin.Settings:142\nPlugin:66", {
	ClassName = "ModuleScript", GetFullName = function() return "cloud_example.Plugin.Settings" end,
	IsDescendantOf = function() return false end,
})
scriptError(message, "ServerScriptService.Mechanic:12", {
	ClassName = "Script", GetFullName = function() return "ServerScriptService.Mechanic" end,
	IsDescendantOf = function() return true end,
})
scriptError("unknown", "unknown trace", nil)
scriptError("destroyed", "retained trace", { GetFullName = function() error("Source unavailable") end })
local diagnostic = collector.collect(diagnosticFact)
assert(#diagnostic.messages == 2 and #diagnostic.scriptErrors == 4,
	"Output and script errors remain separate channels, even when message text is identical")
assert(diagnostic.scriptErrors[1].source.kind == "script"
	and diagnostic.scriptErrors[1].source.path == "cloud_example.Plugin.Settings"
	and not diagnostic.scriptErrors[1].source.inDataModel
	and diagnostic.scriptErrors[1].stackTrace == "Plugin.Settings:142\nPlugin:66",
	"External plugin identity and original stack are retained")
assert(diagnostic.scriptErrors[2].source.inDataModel
	and diagnostic.scriptErrors[3].source.kind == "unavailable"
	and diagnostic.scriptErrors[4].source.kind == "unavailable",
	"Place membership is distinct from unavailable origin and does not claim candidate ownership")
collector.resetDiagnostics()
local cleared = collector.collect(diagnosticFact)
assert(#cleared.messages == 0 and #cleared.scriptErrors == 0)
assert(#diagnostic.messages == 2 and #diagnostic.scriptErrors == 4, "Reset does not mutate prior observations")
outputError("é" .. string.rep("x", 15997) .. "éé", roblox.Enum.MessageType.MessageError)
scriptError("oversized", string.rep("x", 16001), {
	ClassName = "Script", GetFullName = function() return string.rep("p", 2049) end,
	IsDescendantOf = function() return true end,
})
for index = 1, 102 do
	outputError("flood " .. index, roblox.Enum.MessageType.MessageError)
	scriptError("flood " .. index, "ServerScriptService.Mechanic:9", nil)
end
local flooded = collector.collect(diagnosticFact)
assert(#flooded.messages == 100 and #flooded.messages[1] == 15999 and utf8.len(flooded.messages[1]) ~= nil
	and flooded.messages[100] == "flood 99"
	and #flooded.scriptErrors == 100 and #flooded.scriptErrors[1].stackTrace == 16000
	and flooded.scriptErrors[1].source.kind == "unavailable" and flooded.scriptErrors[100].message == "flood 99",
	"A flood keeps each channel's first 100 errors, shortens oversized text whole-character, and drops an oversized origin")
collector.resetDiagnostics()
other:Destroy()
collector.disconnect()
assert(not pcall(function() collector.collect(diagnosticFact) end), "Disconnected error channels cannot report a clean session")
world:Destroy()
print("Collector regression tests passed: 21")
return true
