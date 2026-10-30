--!strict
-- GUI control of the connector spike. It makes two ScreenGuis with solid markers at known
-- offsets, so a reader can find each marker in a captured frame and compare its pixels with
-- the gui_layout rectangle. Every marker has BorderSizePixel 0 and a pure colour.
--
-- SpikeHudFull has IgnoreGuiInset true:
--   FullTopLeft      magenta (255, 0, 255)  offset (0, 0), size 40 x 40
--   FullBlue         blue    (0, 0, 255)    offset (400, 120), size 160 x 80
--   FullBottomRight  cyan    (0, 255, 255)  anchor (1, 1) at scale (1, 1), size 40 x 40
--   ScaledLabel      TextScaled true, offset (400, 240), size 240 x 60
--   FixedLabel       TextScaled false, TextSize 24, TextWrapped false, offset (400, 320),
--                    size 120 x 30. Its text is longer than its box, so TextFits is false.
--   ClipFrame        grey (40, 40, 40), ClipsDescendants true, offset (700, 120), size 100 x 100
--     ClipChild      orange (255, 128, 0), offset (50, 50) in ClipFrame, size 100 x 100.
--                    Its clippedRect is the 50 x 50 square at the bottom right of ClipFrame.
--   HiddenFrame      Visible false. gui_layout does not record it.
-- SpikeHudInset has IgnoreGuiInset false:
--   InsetTopLeft     green   (0, 255, 0)    offset (0, 0), size 40 x 40
--   InsetRed         red     (255, 0, 0)    offset (100, 120), size 160 x 80
local Players = game:GetService("Players")

local playerGui = (Players.LocalPlayer :: Player):WaitForChild("PlayerGui")

local function screen(name: string, ignoreGuiInset: boolean): ScreenGui
	local gui = Instance.new("ScreenGui")
	gui.Name = name
	gui.IgnoreGuiInset = ignoreGuiInset
	gui.ResetOnSpawn = false
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	gui.DisplayOrder = 10
	return gui
end

local function marker(name: string, parent: Instance, color: Color3, position: UDim2, size: UDim2): Frame
	local frame = Instance.new("Frame")
	frame.Name = name
	frame.BackgroundColor3 = color
	frame.BackgroundTransparency = 0
	frame.BorderSizePixel = 0
	frame.Position = position
	frame.Size = size
	frame.Parent = parent
	return frame
end

local function label(name: string, parent: Instance, text: string, position: UDim2, size: UDim2, scaled: boolean): TextLabel
	local textLabel = Instance.new("TextLabel")
	textLabel.Name = name
	textLabel.Text = text
	textLabel.TextScaled = scaled
	textLabel.TextSize = 24
	textLabel.TextWrapped = false
	textLabel.Font = Enum.Font.SourceSans
	textLabel.TextColor3 = Color3.fromRGB(0, 0, 0)
	textLabel.BackgroundColor3 = Color3.fromRGB(255, 255, 255)
	textLabel.BorderSizePixel = 0
	textLabel.Position = position
	textLabel.Size = size
	textLabel.Parent = parent
	return textLabel
end

local full = screen("SpikeHudFull", true)
marker("FullTopLeft", full, Color3.fromRGB(255, 0, 255), UDim2.fromOffset(0, 0), UDim2.fromOffset(40, 40))
marker("FullBlue", full, Color3.fromRGB(0, 0, 255), UDim2.fromOffset(400, 120), UDim2.fromOffset(160, 80))
local bottomRight = marker("FullBottomRight", full, Color3.fromRGB(0, 255, 255), UDim2.fromScale(1, 1),
	UDim2.fromOffset(40, 40))
bottomRight.AnchorPoint = Vector2.new(1, 1)
label("ScaledLabel", full, "Scaled label", UDim2.fromOffset(400, 240), UDim2.fromOffset(240, 60), true)
label("FixedLabel", full, "This fixed label is longer than its box", UDim2.fromOffset(400, 320),
	UDim2.fromOffset(120, 30), false)
local clip = marker("ClipFrame", full, Color3.fromRGB(40, 40, 40), UDim2.fromOffset(700, 120),
	UDim2.fromOffset(100, 100))
clip.ClipsDescendants = true
marker("ClipChild", clip, Color3.fromRGB(255, 128, 0), UDim2.fromOffset(50, 50), UDim2.fromOffset(100, 100))
marker("HiddenFrame", full, Color3.fromRGB(255, 255, 0), UDim2.fromOffset(0, 400), UDim2.fromOffset(40, 40)).Visible =
	false

local inset = screen("SpikeHudInset", false)
marker("InsetTopLeft", inset, Color3.fromRGB(0, 255, 0), UDim2.fromOffset(0, 0), UDim2.fromOffset(40, 40))
marker("InsetRed", inset, Color3.fromRGB(255, 0, 0), UDim2.fromOffset(100, 120), UDim2.fromOffset(160, 80))

-- Parent the ScreenGui that the phase waits for last, so both layers exist when it appears.
inset.Parent = playerGui
full.Parent = playerGui
