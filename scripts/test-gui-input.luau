-- Run the real pointer-input adapter against deterministic GUI events; no Studio.
local roblox = require("@lune/roblox")
local Vector2, Enum = roblox.Vector2, roblox.Enum
local CaptureInput = require("../plugin/src/CaptureInput")
local target, top, clock, pressed, released, emitEvents, isButton
local function signal()
	local listeners = {}
	return { Connect = function(_, callback)
		table.insert(listeners, callback)
		return { Disconnect = function() local index = table.find(listeners, callback); if index then table.remove(listeners, index) end end }
	end, fire = function(...) for _, callback in table.clone(listeners) do callback(...) end end,
	count = function() return #listeners end }
end
local playerGui = { GetGuiObjectsAtPosition = function() return { top } end }
local viewport = { Min = Vector2.zero, Width = 800, Height = 600 }
local point = Vector2.new(50, 30)
local event = { UserInputType = Enum.UserInputType.MouseButton1, Position = point }
local virtual = {
	SendMousePosition = function() end,
	SendMouseButton = function(_, _, _, down)
		if down then pressed += 1 else released += 1 end
		if emitEvents then
			if down then target.InputBegan.fire(event) else
				target.InputEnded.fire(event)
				if isButton then target.Activated.fire(event, 1) end
			end
		end
	end,
}
local module = require("@lune/luau").load(require("@lune/fs").readFile("plugin/src/StudioCapture.luau"), {
	environment = {
		Vector2 = Vector2, Enum = Enum, workspace = { CurrentCamera = {} },
		os = { clock = function() return clock end }, task = { wait = function(seconds) clock += seconds end },
		game = { GetService = function(_, name)
			if name == "Players" then return { LocalPlayer = { FindFirstChildOfClass = function() return playerGui end } } end
			if name == "GuiService" then return { GetInsetArea = function() return viewport end } end
			if name == "UserInputService" then return { CreateVirtualInput = function() return virtual end, GetMouseLocation = function() return point end } end
			return {}
		end },
		script = { Parent = { Collector = "Collector", CaptureInput = "CaptureInput", ActorView = "ActorView", GuiVisibility = "GuiVisibility" } },
		require = function(name)
			if name == "Collector" then return { resolvePath = function() return target end } end
			if name == "CaptureInput" then return CaptureInput end
			if name == "GuiVisibility" then return function() return true end end
			return {}
		end,
	},
})()
local function reset(button)
	clock, pressed, released, emitEvents, isButton = 0, 0, 0, true, button
	target = {
		IsA = function(_, class) return class == "GuiObject" or (class == "GuiButton" and isButton) end,
		IsDescendantOf = function() return true end, GetFullName = function() return "PlayerGui.CustomControl" end,
		AbsolutePosition = Vector2.new(10, 10), AbsoluteSize = Vector2.new(80, 40),
		Active = button, Interactable = true, InputBegan = signal(), InputEnded = signal(),
		Activated = if button then signal() else nil,
	}
	top = target
end
local function click() return module.click("role.control", function() return true end, function() end) end
for _, button in { true, false } do
	reset(button)
	assert(click() and pressed == 1 and released == 1, "Button and custom GuiObject each receive exactly one click")
	assert(target.InputBegan.count() == 0 and target.InputEnded.count() == 0, "Input listeners are cleaned up")
	reset(button); emitEvents = false
	local ok, failure = pcall(click)
	assert(not ok and string.find(tostring(failure), "did not acknowledge") and pressed == 1 and released == 1,
		"Unacknowledged input is never repeated and its pressed button is released")
end
reset(false); top = { GetFullName = function() return "Occluder" end, IsDescendantOf = function() return false end }
assert(not pcall(click) and pressed == 0, "Occluded input is rejected before dispatch")
print("GUI input regressions passed: button, custom GuiObject, missing acknowledgment, cleanup and occlusion")
return true
