local roblox = require("@lune/roblox")
local Vector3, CFrame = roblox.Vector3, roblox.CFrame
local target, healthy, active = nil, true, true
local frame = CFrame.new()
local root = setmetatable({ IsA = function(_, class) return class == "BasePart" end }, {
	__index = function(_, key)
		if key == "CFrame" then return frame end
		if key == "Position" then return frame.Position end
	end,
	__newindex = function(self, key, value)
		if key == "CFrame" then frame = value else rawset(self, key, value) end
	end,
})
local character = {
	IsDescendantOf = function() return true end,
	FindFirstChildOfClass = function() return { Health = if healthy then 100 else 0 } end,
	FindFirstChild = function() return root end,
}
local trace = {}
local walkGoal = nil
local humanoid = { Health = 100, MoveTo = function(_, destination) walkGoal = destination end }
character.FindFirstChildOfClass = function() humanoid.Health = if healthy then 100 else 0; return humanoid end
local module = require("@lune/luau").load(require("@lune/fs").readFile("plugin/src/StudioCapture.luau"), {
	environment = {
		Vector3 = Vector3, CFrame = CFrame, workspace = {},
		game = { GetService = function(_, name)
			return if name == "Players" then { LocalPlayer = { Character = character } } else {}
		end },
		script = { Parent = { Collector = "Collector", CaptureInput = "CaptureInput", ActorView = "ActorView", GuiVisibility = "GuiVisibility" } },
		require = function(name)
			return if name == "Collector" then { resolvePath = function() return target end } else {}
		end,
	},
})()
local function place(offset)
	return module.placeRelativeToPart("role.target", offset, function() return active end,
		function(_, data) table.insert(trace, data) end)
end
for _, targetFrame in { CFrame.new(0, 1, 0), CFrame.new(200, 50, -300) * CFrame.Angles(0, math.pi / 2, 0) } do
	target = { IsA = function(_, class) return class == "BasePart" end,
		CFrame = targetFrame, Position = targetFrame.Position }
	assert(place({ 0, 3, 20 }))
	local observed = targetFrame:PointToObjectSpace(frame.Position)
	assert((observed - Vector3.new(0, 3, 20)).Magnitude < 0.001)
	assert((frame.Position - target.Position).Magnitude > 8)
	assert(math.abs(trace[#trace].localZ - 20) < 0.001)
	assert(root.AssemblyLinearVelocity == Vector3.zero)
	local beforeWalk = frame
	assert(module.moveRelativeToPart("role.target", { 0, 3, -20 }, function() return active end, function() end))
	assert((walkGoal - targetFrame:PointToWorldSpace(Vector3.new(0, 3, -20))).Magnitude < 0.001)
	assert(frame == beforeWalk, "A relative walking request must not teleport the actor")
end
local previous = frame
healthy = false; assert(not place({ 0, 0, 20 })); healthy = true
target = nil; assert(not place({ 0, 0, 20 }))
assert(frame == previous)
assert(not pcall(place, { 0, 0, math.huge }))
assert(not pcall(place, { 0, 0, 10001 }))
assert(not pcall(place, { 0, 0 }))
active = false; assert(not pcall(place, { 0, 0, 20 }))
assert(frame == previous)
print("Relative actor placement regression passed: layout, rotation, bounds, missing target, health and cancellation")
return true
