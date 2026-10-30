-- Exercise the fixed GUI layout inventory offline. Lune cannot compute AbsolutePosition,
-- AbsoluteSize or TextBounds, so these tests use plain instance tables with set values.
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local isGuiVisible = require("../plugin/src/GuiVisibility")
local GuiLayout = luau.load(fs.readFile("plugin/src/GuiLayout.luau"), {
	environment = {
		script = { Parent = { GuiVisibility = "GuiVisibility" } },
		require = function(name) assert(name == "GuiVisibility"); return isGuiVisible end,
	},
})()
local passed = 0
local function test(name, run)
	local ok, reason = pcall(run)
	assert(ok, name .. ": " .. tostring(reason)); passed += 1
end

local CLASSES = {
	PlayerGui = { PlayerGui = true },
	Folder = { Folder = true },
	ScreenGui = { ScreenGui = true, LayerCollector = true, GuiBase2d = true },
	BillboardGui = { BillboardGui = true, LayerCollector = true, GuiBase2d = true },
	Frame = { Frame = true, GuiObject = true, GuiBase2d = true },
	ScrollingFrame = { ScrollingFrame = true, GuiObject = true, GuiBase2d = true },
	TextLabel = { TextLabel = true, GuiObject = true, GuiBase2d = true },
	TextButton = { TextButton = true, GuiButton = true, GuiObject = true, GuiBase2d = true },
}

-- A plain instance with the fixed members that the inventory and GuiVisibility read.
local function node(className: string, name: string, parent: any, properties: any?): any
	local self: any = properties or {}
	self.ClassName, self.Name, self.Parent, self.children = className, name, parent, {}
	if CLASSES[className].GuiObject then
		if self.Visible == nil then self.Visible = true end
		if self.ClipsDescendants == nil then self.ClipsDescendants = false end
		if self.ZIndex == nil then self.ZIndex = 1 end
	end
	if CLASSES[className].LayerCollector and self.Enabled == nil then self.Enabled = true end
	if parent then table.insert(parent.children, self) end
	self.IsA = function(_, other) return CLASSES[className][other] == true or other == "Instance" end
	self.GetFullName = function(instance)
		local names, current = {}, instance
		while current do table.insert(names, 1, current.Name); current = current.Parent end
		return table.concat(names, ".")
	end
	self.GetDescendants = function(instance)
		local found = {}
		local function visit(item)
			for _, child in item.children do table.insert(found, child); visit(child) end
		end
		visit(instance)
		return found
	end
	return self
end
local function box(x, y, w, h) return { AbsolutePosition = { X = x, Y = y }, AbsoluteSize = { X = w, Y = h } } end
local function withText(properties, text, fits)
	properties.Text, properties.TextBounds = text, { X = 40, Y = 14 }
	properties.TextSize, properties.TextScaled, properties.TextWrapped, properties.TextFits = 14, false, true, fits
	return properties
end
local inset = { GetGuiInset = function() return { X = 0, Y = 58 }, { X = 0, Y = 0 } end }
local camera = { ViewportSize = { X = 1280, Y = 720 } }

test("Visible GuiObjects of the layer keep their rectangles, clipped rectangles and text fit", function()
	local playerGui = node("PlayerGui", "PlayerGui", nil)
	local screen = node("ScreenGui", "Hud", playerGui, box(0, 58, 1280, 662))
	screen.IgnoreGuiInset = false
	local panel = node("Frame", "Panel", screen, box(10, 68, 100, 50))
	panel.ClipsDescendants = true
	node("TextLabel", "Score", panel, withText(box(60, 80, 100, 20), "Score 4", false))
	node("Frame", "Outside", panel, box(200, 200, 10, 10))
	node("TextButton", "Empty", screen, withText(box(300, 300, 50, 20), "", true))
	local hidden = node("Frame", "Hidden", screen, box(0, 0, 10, 10))
	hidden.Visible = false
	node("TextLabel", "Inner", hidden, withText(box(0, 0, 10, 10), "secret", true))
	local folder = node("Folder", "Group", screen)
	node("Frame", "Grouped", folder, box(5, 5, 5, 5))
	local nested = node("BillboardGui", "Nested", screen, box(0, 0, 1, 1))
	node("TextLabel", "Elsewhere", nested, withText(box(0, 0, 10, 10), "other layer", true))
	local layout = GuiLayout.observe("layout", screen, inset, camera)
	assert(layout.exists and layout.complete and not layout.ignoreGuiInset)
	assert(layout.screen.y == 58 and layout.screen.h == 662 and layout.guiInset.top == 58
		and layout.guiInset.left == 0 and layout.viewport.w == 1280 and layout.viewport.h == 720)
	local seen = {}
	for _, item in layout.elements do table.insert(seen, item.path) end
	assert(table.concat(seen, "|") == table.concat({ "PlayerGui.Hud.Empty", "PlayerGui.Hud.Group.Grouped",
		"PlayerGui.Hud.Panel", "PlayerGui.Hud.Panel.Outside", "PlayerGui.Hud.Panel.Score" }, "|"), table.concat(seen, "|"))
	local byPath = {}
	for _, item in layout.elements do byPath[item.path] = item end
	local score = byPath["PlayerGui.Hud.Panel.Score"]
	assert(score.hasText and score.textFits == false and score.textBounds.w == 40 and score.textSize == 14
		and score.textWrapped and not score.textScaled and score.text == nil, "Text fit is recorded, text is not")
	assert(score.clippedRect.x == 60 and score.clippedRect.w == 50 and score.clippedRect.y == 80
		and score.clippedRect.h == 20, "An ancestor with ClipsDescendants cuts the rectangle")
	assert(byPath["PlayerGui.Hud.Panel.Outside"].clippedRect == nil, "A fully clipped element has no clipped rectangle")
	local empty = byPath["PlayerGui.Hud.Empty"]
	assert(not empty.hasText and empty.textBounds == nil and empty.clippedRect.w == 50,
		"A text object with empty Text has no text fields, and an element without a clip ancestor keeps its rectangle")
	assert(byPath["PlayerGui.Hud.Panel"].className == "Frame" and byPath["PlayerGui.Hud.Panel"].zIndex == 1)
end)

test("A disabled ScreenGui shows no element", function()
	local screen = node("ScreenGui", "Hud", node("PlayerGui", "PlayerGui", nil), box(0, 0, 800, 600))
	screen.IgnoreGuiInset, screen.Enabled = true, false
	node("Frame", "Panel", screen, box(0, 0, 10, 10))
	local layout = GuiLayout.observe("layout", screen, inset, camera)
	assert(layout.exists and layout.ignoreGuiInset and #layout.elements == 0 and layout.complete)
end)

test("An inventory beyond the element limit is marked incomplete", function()
	local screen = node("ScreenGui", "Hud", node("PlayerGui", "PlayerGui", nil), box(0, 0, 800, 600))
	screen.IgnoreGuiInset = false
	for index = 1, 257 do node("Frame", string.format("F%03d", index), screen, box(index, 0, 1, 1)) end
	local layout = GuiLayout.observe("layout", screen, inset, camera)
	assert(not layout.complete and #layout.elements == 256)
end)

test("An absent camera stops the acquisition, and absence keeps the zero fallback", function()
	local screen = node("ScreenGui", "Hud", node("PlayerGui", "PlayerGui", nil), box(0, 0, 800, 600))
	assert(not pcall(GuiLayout.observe, "layout", screen, inset, nil))
	local absent = GuiLayout.absent("layout")
	assert(not absent.exists and absent.complete and #absent.elements == 0 and absent.viewport.w == 0)
end)

print(string.format("GUI layout inventory tests passed: %d", passed))
return true
