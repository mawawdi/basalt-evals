--!strict

-- Fixed inventory of the text that GUI layers show at one capture. It reads only Text,
-- and PlaceholderText of a TextBox. Visible candidate text routes a unit to human
-- review; it never makes a verdict. Visibility is the declared hierarchy only.
--
-- The prepared place is the complete candidate tree, so no runtime boundary separates
-- seed scripts from candidate scripts. One fixed, declared rule marks evaluator text:
-- the reserved ScreenGui below, directly under the local PlayerGui, when the frozen
-- plan drives a literal input target in it.
local isGuiVisible = require(script.Parent.GuiVisibility)

local SceneText = {}
local ENTRY_LIMIT = 256
local TEXT_LIMIT = 1000
local PATH_LIMIT = 2048
local EVALUATOR_LAYER = "BasaltEvalCaptureControls"
local EVALUATOR_PREFIX = "game.Players.LocalPlayer.PlayerGui." .. EVALUATOR_LAYER .. "."
local LAYERS = table.freeze({ ScreenGui = true, BillboardGui = true, SurfaceGui = true })

export type Entry = {
	path: string,
	className: string,
	layer: string,
	owner: string,
	property: string,
	text: string,
	visible: boolean,
}
export type Inventory = { complete: boolean, entries: { Entry } }

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

-- The nearest ScreenGui, BillboardGui or SurfaceGui ancestor. Text outside these layers
-- does not render, so the inventory omits it.
local function layerOf(instance: Instance): Instance?
	local current = instance.Parent
	while current do
		if LAYERS[current.ClassName] then return current end
		current = current.Parent
	end
	return nil
end

-- The shown strings of one text object, in a fixed property order.
local function shownText(instance: Instance): { { property: string, text: string } }
	if instance:IsA("TextBox") then
		local box = instance :: TextBox
		return { { property = "Text", text = box.Text }, { property = "PlaceholderText", text = box.PlaceholderText } }
	elseif instance:IsA("TextLabel") then
		return { { property = "Text", text = (instance :: TextLabel).Text } }
	elseif instance:IsA("TextButton") then
		return { { property = "Text", text = (instance :: TextButton).Text } }
	end
	return {}
end

-- True when a phase driver or a scenario GUI action of the frozen plan targets a literal
-- path inside the reserved layer. A plan without that declaration has no evaluator text.
function SceneText.declaresEvaluatorLayer(plan: any): boolean
	local function inside(path: any): boolean
		return type(path) == "string" and string.sub(path, 1, #EVALUATOR_PREFIX) == EVALUATOR_PREFIX
	end
	for _, phase in plan.phases do
		if phase.driver.kind == "gui_button" and inside(phase.driver.path) then return true end
	end
	for _, scenario in plan.scenarios do
		for _, step in scenario.steps do
			local action = step.action
			if (action.kind == "gui_activate" or action.kind == "gui_text_entry") and inside(action.path) then
				return true
			end
		end
	end
	return false
end

-- The one reserved ScreenGui directly under the local PlayerGui. A second child with the
-- reserved name, or one of another class, makes the owner ambiguous: none is returned.
function SceneText.evaluatorLayer(playerGui: Instance): Instance?
	local found: Instance? = nil
	for _, child in playerGui:GetChildren() do
		if child.Name ~= EVALUATOR_LAYER then continue end
		if found ~= nil or not child:IsA("ScreenGui") then return nil end
		found = child
	end
	return found
end

function SceneText.inventory(roots: { Instance }, evaluatorLayer: Instance?): Inventory
	local entries: { Entry } = {}
	local complete = true
	for _, root in roots do
		for _, instance in root:GetDescendants() do
			local strings = shownText(instance)
			if #strings == 0 then continue end
			local layer = layerOf(instance)
			if layer == nil then continue end
			for _, shown in strings do
				if shown.text == "" then continue end
				local path = instance:GetFullName()
				if #path > PATH_LIMIT or #entries >= ENTRY_LIMIT then
					complete = false
					continue
				end
				table.insert(entries, {
					path = path,
					className = instance.ClassName,
					layer = layer.ClassName,
					owner = if evaluatorLayer ~= nil and layer == evaluatorLayer then "evaluator" else "candidate",
					property = shown.property,
					text = bounded(shown.text),
					visible = isGuiVisible(instance),
				})
			end
		end
	end
	-- Sort for one canonical order; replication can change the order of siblings.
	table.sort(entries, function(a, b)
		if a.path ~= b.path then return a.path < b.path end
		if a.property ~= b.property then return a.property < b.property end
		return a.text < b.text
	end)
	return { complete = complete, entries = entries }
end

return table.freeze(SceneText)
