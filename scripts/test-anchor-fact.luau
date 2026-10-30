-- Evaluate the fixed anchor facts offline. Engine objects are small tables with the
-- exact members that the module reads; geometry uses the real Lune datatypes.
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local roblox = require("@lune/roblox")
local isGuiVisible = require("../plugin/src/GuiVisibility")

local paths: { [string]: any } = {}
local failures: { [string]: string } = {}
local hit: any = nil
local anchorFact = luau.load(fs.readFile("plugin/src/AnchorFact.luau"), {
	environment = {
		script = { Parent = { Collector = "Collector", GuiVisibility = "GuiVisibility" } },
		require = function(name)
			if name == "GuiVisibility" then return isGuiVisible end
			assert(name == "Collector")
			return { resolvePath = function(path) return paths[path], failures[path] end }
		end,
		workspace = { Raycast = function(_, origin, direction)
			assert(direction.Y == -8 and origin ~= nil, "The support ray points down from the root")
			return hit
		end },
		RaycastParams = { new = function() return {} end },
		Enum = { RaycastFilterType = { Exclude = "Exclude" } },
		Vector3 = roblox.Vector3,
	},
})()

local function basePart(cframe, size)
	return { CFrame = cframe, Size = size, CanCollide = true, Anchored = true,
		IsA = function(_, className) return className == "BasePart" end }
end
local state = "Running"
local root = basePart(roblox.CFrame.new(0, 3, 0), roblox.Vector3.new(2, 2, 1))
root.Position = roblox.Vector3.new(0, 3, 0)
local character = {
	IsDescendantOf = function() return true end,
	FindFirstChild = function(_, name) return if name == "HumanoidRootPart" then root else nil end,
	FindFirstChildOfClass = function(_, className)
		assert(className == "Humanoid")
		return { GetState = function() return { Name = state } end }
	end,
}
local player = { Character = character }
local actors = { primary = player }
local platform = basePart(roblox.CFrame.new(0, 0, 0), roblox.Vector3.new(4, 1, 4))
paths["game.Workspace.Platform"] = platform
local checks = 0
local function check(fact, expected: boolean, reason: string)
	assert(anchorFact.evaluate(fact, actors) == expected, reason)
	checks += 1
end
local function fails(fact, reason: string)
	assert(not pcall(anchorFact.evaluate, fact, actors), reason)
	checks += 1
end

check({ kind = "humanoid_state", actor = "primary", state = "Running" }, true, "The Humanoid state matches")
state = "Freefall"
check({ kind = "humanoid_state", actor = "primary", state = "Landed" }, false, "Another state does not match")
fails({ kind = "humanoid_state", actor = "absent", state = "Landed" }, "An unbound actor is an acquisition failure")

local onPart = { kind = "character_on_part", actor = "primary", path = "game.Workspace.Platform" }
hit = { Instance = platform }
check(onPart, true, "The support ray hits the declared part")
hit = { Instance = basePart(roblox.CFrame.new(), roblox.Vector3.new(1, 1, 1)) }
check(onPart, false, "Support by another part does not count")
hit = nil
check(onPart, false, "No support is not contact")
player.Character = nil
check(onPart, false, "A missing character is not on the part")
player.Character = character

local near = { kind = "character_near_part", actor = "primary", path = "game.Workspace.Platform", radiusStuds = 3 }
check(near, true, "Distance uses the box of the part: 2.5 studs above its top face")
near.radiusStuds = 2
check(near, false, "The root is outside a smaller aperture")
platform.CFrame = roblox.CFrame.new(0, 0, 0) * roblox.CFrame.Angles(0, 0, math.rad(90))
check(near, true, "The local frame of a rotated part is used: 1 stud from the rotated face")
platform.CFrame = roblox.CFrame.new(0, 0, 0)

local gui = { Visible = true, IsA = function(_, className) return className == "GuiObject" end }
paths["game.Players.LocalPlayer.PlayerGui.Banner"] = gui
check({ kind = "gui_visible", path = "game.Players.LocalPlayer.PlayerGui.Banner", visible = true }, true,
	"A visible GUI object is present")
gui.Visible = false
check({ kind = "gui_visible", path = "game.Players.LocalPlayer.PlayerGui.Banner", visible = false }, true,
	"An anchor can wait for a GUI object to disappear")
check({ kind = "gui_visible", path = "game.Players.LocalPlayer.PlayerGui.Absent", visible = true }, false,
	"An absent GUI object is not visible")

check({ kind = "instance_present", path = "game.Workspace.Platform", present = true }, true, "Presence")
check({ kind = "instance_present", path = "game.Workspace.Gone", present = false }, true, "Absence")
failures["role.door"] = "missing"
check({ kind = "instance_present", path = "role.door", present = false }, true,
	"An absent exactly_one role is an observed absence")
failures["role.door"] = "ambiguous"
fails({ kind = "instance_present", path = "role.door", present = false },
	"An ambiguous role binding is an acquisition failure, never an absence")

check({ kind = "part_can_collide", path = "game.Workspace.Platform", value = true }, true, "CanCollide")
platform.CanCollide = false
check({ kind = "part_can_collide", path = "game.Workspace.Platform", value = false }, true, "Collision off")
check({ kind = "part_anchored", path = "game.Workspace.Platform", value = false }, false, "Anchored")
check({ kind = "part_anchored", path = "game.Workspace.Gone", value = true }, false, "A missing part never matches")
fails({ kind = "replication_probe", path = "game.Workspace.Platform" }, "Only fixed anchor kinds evaluate")
print(string.format("Anchor fact regression passed: %d checks", checks))
return true
