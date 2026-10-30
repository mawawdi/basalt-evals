--!strict

-- Study-only positive control: identify the lever and the moving barrier.
-- It changes presentation, never the shutter's server behavior or collisions.
local Workspace = game:GetService("Workspace")

local function label(partName: string, text: string, color: Color3)
	local part = Workspace:WaitForChild(partName) :: BasePart
	local marker = Instance.new("BillboardGui")
	marker.Name = "FeedbackTargetMarker"
	marker.Adornee = part
	marker.AlwaysOnTop = true
	marker.Size = UDim2.fromOffset(225, 44)
	marker.StudsOffsetWorldSpace = Vector3.new(0, part.Size.Y / 2 + 2, 0)
	marker.Parent = part
	local caption = Instance.new("TextLabel")
	caption.Size = UDim2.fromScale(1, 1)
	caption.BackgroundColor3 = color
	caption.BackgroundTransparency = 0.08
	caption.TextColor3 = Color3.new(1, 1, 1)
	caption.TextSize = 20
	caption.Font = Enum.Font.GothamBold
	caption.Text = text
	caption.Parent = marker
end

label("Lever", "LEVER · PRESS E", Color3.fromRGB(26, 83, 153))
label("Shutter", "TIMED SHUTTER", Color3.fromRGB(35, 45, 64))
