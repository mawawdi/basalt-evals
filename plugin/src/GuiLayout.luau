--!strict

-- Fixed geometry inventory of one ScreenGui of the local player. It reads only these
-- properties: AbsolutePosition, AbsoluteSize and IgnoreGuiInset of the ScreenGui; the
-- AbsolutePosition, AbsoluteSize, ZIndex, Visible and ClipsDescendants of each GuiObject;
-- and the TextBounds, TextSize, TextScaled, TextWrapped and TextFits of a text object.
-- It reads Text only to know if it is empty, and it records no text. The values are GUI
-- pixels. They tell geometry and text fit, not the rendered appearance.
local isGuiVisible = require(script.Parent.GuiVisibility)

local GuiLayout = {}
local ELEMENT_LIMIT = 256
local PATH_LIMIT = 2048
local TEXT_CLASSES = table.freeze({ TextLabel = true, TextButton = true, TextBox = true })

export type Rect = { x: number, y: number, w: number, h: number }

local function rectOf(gui: GuiBase2d): Rect
	local position, size = gui.AbsolutePosition, gui.AbsoluteSize
	return { x = position.X, y = position.Y, w = size.X, h = size.Y }
end

-- The common area of two rectangles, or nil when they have no common area.
local function intersect(a: Rect, b: Rect): Rect?
	local left, top = math.max(a.x, b.x), math.max(a.y, b.y)
	local right, bottom = math.min(a.x + a.w, b.x + b.w), math.min(a.y + a.h, b.y + b.h)
	if right <= left or bottom <= top then return nil end
	return { x = left, y = top, w = right - left, h = bottom - top }
end

-- The nearest LayerCollector ancestor. A GuiObject of a nested layer is not in this layout.
local function layerOf(instance: Instance): Instance?
	local current = instance.Parent
	while current do
		if current:IsA("LayerCollector") then return current end
		current = current.Parent
	end
	return nil
end

-- The rect inside every ancestor GuiObject with ClipsDescendants, up to the ScreenGui.
local function clippedRectOf(gui: GuiObject, rect: Rect, screenGui: Instance): Rect?
	local clipped: Rect? = rect
	local current = gui.Parent
	while clipped ~= nil and current ~= nil and current ~= screenGui do
		if current:IsA("GuiObject") and (current :: GuiObject).ClipsDescendants then
			clipped = intersect(clipped, rectOf(current :: GuiObject))
		end
		current = current.Parent
	end
	return clipped
end

local function element(gui: GuiObject, path: string, screenGui: Instance): { [string]: any }
	local rect = rectOf(gui)
	local entry: { [string]: any } = {
		path = path,
		className = gui.ClassName,
		rect = rect,
		clippedRect = clippedRectOf(gui, rect, screenGui),
		zIndex = gui.ZIndex,
		hasText = false,
	}
	if TEXT_CLASSES[gui.ClassName] then
		local text = gui :: TextLabel
		if text.Text ~= "" then
			local bounds = text.TextBounds
			entry.hasText = true
			entry.textBounds = { w = bounds.X, h = bounds.Y }
			entry.textSize = text.TextSize
			entry.textScaled = text.TextScaled
			entry.textWrapped = text.TextWrapped
			entry.textFits = text.TextFits
		end
	end
	return entry
end

-- The observation of an absent ScreenGui. Its zero values must not pass a comparison.
function GuiLayout.absent(factId: string): { [string]: any }
	return {
		factId = factId,
		kind = "gui_layout",
		exists = false,
		complete = true,
		screen = { x = 0, y = 0, w = 0, h = 0 },
		guiInset = { left = 0, top = 0, right = 0, bottom = 0 },
		viewport = { w = 0, h = 0 },
		ignoreGuiInset = false,
		elements = {},
	}
end

-- Record the layout of one ScreenGui. If the camera is absent, the acquisition stops,
-- because the viewport is part of the evidence.
function GuiLayout.observe(factId: string, screenGui: ScreenGui, guiService: GuiService, camera: Camera?): { [string]: any }
	if camera == nil then error("GUI layout has no camera") end
	local topLeft, bottomRight = guiService:GetGuiInset()
	local viewport = camera.ViewportSize
	local elements = {}
	local complete = true
	for _, instance in screenGui:GetDescendants() do
		if not instance:IsA("GuiObject") or layerOf(instance) ~= screenGui or not isGuiVisible(instance) then continue end
		local path = instance:GetFullName()
		if #path > PATH_LIMIT or #elements >= ELEMENT_LIMIT then
			complete = false
			continue
		end
		table.insert(elements, element(instance :: GuiObject, path, screenGui))
	end
	-- Sort for one canonical order; replication can change the order of siblings.
	table.sort(elements, function(a, b)
		if a.path ~= b.path then return a.path < b.path end
		if a.className ~= b.className then return a.className < b.className end
		if a.rect.x ~= b.rect.x then return a.rect.x < b.rect.x end
		if a.rect.y ~= b.rect.y then return a.rect.y < b.rect.y end
		if a.rect.w ~= b.rect.w then return a.rect.w < b.rect.w end
		if a.rect.h ~= b.rect.h then return a.rect.h < b.rect.h end
		return a.zIndex < b.zIndex
	end)
	return {
		factId = factId,
		kind = "gui_layout",
		exists = true,
		complete = complete,
		screen = rectOf(screenGui),
		guiInset = { left = topLeft.X, top = topLeft.Y, right = bottomRight.X, bottom = bottomRight.Y },
		viewport = { w = viewport.X, h = viewport.Y },
		ignoreGuiInset = screenGui.IgnoreGuiInset,
		elements = elements,
	}
end

return table.freeze(GuiLayout)
