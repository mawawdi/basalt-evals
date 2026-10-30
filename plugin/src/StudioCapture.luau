--!strict

-- The pinned Luau definitions predate VirtualInput. Keep the small
-- typed boundary here, rather than weakening the rest of the connector.
-- https://create.roblox.com/docs/reference/engine/classes/VirtualInput
type Input = {
	SendMousePosition: (Input, Vector2) -> (),
	SendMouseButton: (Input, Vector2, Enum.UserInputType, boolean, number) -> (),
	SendKey: (Input, boolean, Enum.KeyCode, boolean) -> (),
	SendTextInput: (Input, string) -> (),
}

type InputService = { CreateVirtualInput: (InputService) -> Input?, GetMouseLocation: (InputService) -> Vector2,
	GetFocusedTextBox: (InputService) -> TextBox? }

local inputService: InputService = game:GetService("UserInputService") :: any
local GuiService = game:GetService("GuiService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Collector = require(script.Parent.Collector)
local CaptureInput = require(script.Parent.CaptureInput)
local ActorView = require(script.Parent.ActorView)
local isGuiVisible = require(script.Parent.GuiVisibility)
local StudioCapture = {}
local virtualInput: Input? = nil
local CAPTURE_CAMERA_BINDING = "BasaltEvalCaptureCamera"

local function input(): Input
	local current = virtualInput
	if current == nil then
		current = inputService:CreateVirtualInput()
		if current == nil then error("Studio virtual input is unavailable in this client") end
		virtualInput = current
	end
	return current :: Input
end

function StudioCapture.click(path: string, active: () -> boolean, trace: (string, { [string]: any }) -> ()): boolean
	local target = Collector.resolvePath(path)
	if target == nil then return false end
	if not target:IsA("GuiObject") then error("Planned input target is not a GuiObject") end
	local isButton = target:IsA("GuiButton")
	if not isGuiVisible(target) or target.AbsoluteSize.X <= 0 or target.AbsoluteSize.Y <= 0 then return false end
	local player = Players.LocalPlayer
	local playerGui = if player then player:FindFirstChildOfClass("PlayerGui") else nil
	if workspace.CurrentCamera == nil or playerGui == nil then return false end
	local bounds, targetSize = target.AbsolutePosition, target.AbsoluteSize
	local guiCenter = bounds + targetSize / 2
	local viewport = GuiService:GetInsetArea(Enum.ScreenInsets.None)
	local point = CaptureInput.screenPoint({ x = guiCenter.X, y = guiCenter.Y }, {
		x = viewport.Min.X, y = viewport.Min.Y, width = viewport.Width, height = viewport.Height,
	})
	local position = Vector2.new(point.x, point.y)
	-- GetGuiObjectsAtPosition uses inset GUI coordinates; VirtualInput uses the
	-- full screen. Keep both in the trace instead of guessing a fixed top-bar offset.
	local function topHit(): GuiObject?
		return playerGui:GetGuiObjectsAtPosition(math.round(guiCenter.X), math.round(guiCenter.Y))[1]
	end
	local hit = topHit()
	trace("input.target", { path = path, guiX = guiCenter.X, guiY = guiCenter.Y,
		screenX = position.X, screenY = position.Y, originX = viewport.Min.X, originY = viewport.Min.Y,
		width = targetSize.X, height = targetSize.Y, viewportWidth = viewport.Width, viewportHeight = viewport.Height,
		active = target.Active, interactable = target.Interactable, hitTarget = if hit then hit:GetFullName() else "none" })
	local function checkTarget()
		assert(not isButton or (target.Active and target.Interactable), "Planned input button is not active and interactable")
		assert(isGuiVisible(target) and target:IsDescendantOf(playerGui) and Collector.resolvePath(path) == target
			and target.AbsolutePosition == bounds and target.AbsoluteSize == targetSize
			and GuiService:GetInsetArea(Enum.ScreenInsets.None) == viewport,
			"Planned input target moved or disappeared before mouse-down")
		local top = topHit()
		assert(top ~= nil and (top == target or top:IsDescendantOf(target)),
			"Planned input target is not the top GUI at its center; found " .. (if top then top:GetFullName() else "none"))
	end
	checkTarget()
	local input = input()
	CaptureInput.activate({
		now = os.clock, wait = function() task.wait(0.05) end, active = active,
		listen = function(callback)
			local began, ended, activated = 0, 0, 0
			local connections = {
				target.InputBegan:Connect(function(event)
					if event.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
					began += 1
					trace("input.received", { state = "begin", x = event.Position.X, y = event.Position.Y })
				end),
				target.InputEnded:Connect(function(event)
					if event.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
					ended += 1
					trace("input.received", { state = "end", x = event.Position.X, y = event.Position.Y })
					if not isButton and began > 0 then callback() end
				end),
			}
			if target:IsA("GuiButton") then
				table.insert(connections, target.Activated:Connect(function(event, clickCount)
					if event.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
					activated += 1
					trace("input.activated", { x = event.Position.X, y = event.Position.Y, clickCount = clickCount })
					callback()
				end))
			end
			return function()
				for _, connection in connections do connection:Disconnect() end
				trace("input.finished", { began = began, ended = ended, activated = activated })
			end
		end,
		move = function() input:SendMousePosition(position) end,
		press = function()
			checkTarget()
			local pointer = inputService:GetMouseLocation()
			trace("input.pointer", { x = pointer.X, y = pointer.Y, expectedX = position.X, expectedY = position.Y,
				guiState = tostring(target.GuiState) })
			input:SendMouseButton(position, Enum.UserInputType.MouseButton1, true, 0)
		end,
		release = function() input:SendMouseButton(position, Enum.UserInputType.MouseButton1, false, 0) end,
	})
	return true
end

function StudioCapture.pressKey(key: string, active: () -> boolean, trace: (string, { [string]: any }) -> ()): boolean
	if not active() then error("Input cancelled") end
	assert(key == "E", "The fixed scenario runner only permits the declared E action")
	local virtual = input()
	trace("input.key", { key = key, state = "down" })
	virtual:SendKey(true, Enum.KeyCode.E, false)
	task.wait(0.05)
	if not active() then
		virtual:SendKey(false, Enum.KeyCode.E, false)
		error("Input cancelled during key press")
	end
	virtual:SendKey(false, Enum.KeyCode.E, false)
	trace("input.key", { key = key, state = "up" })
	return true
end

function StudioCapture.holdKey(key: string, durationMs: number, active: () -> boolean, trace: (string, { [string]: any }) -> ()): boolean
	assert((key == "E" or key == "F" or key == "Space") and durationMs >= 50 and durationMs <= 5000,
		"Held key is outside the fixed action bounds")
	if not active() then error("Input cancelled") end
	local code = if key == "E" then Enum.KeyCode.E else if key == "F" then Enum.KeyCode.F else Enum.KeyCode.Space
	local virtual = input()
	virtual:SendKey(true, code, false)
	trace("input.key", { key = key, state = "down", durationMs = durationMs })
	local started = os.clock()
	local ok, failure = pcall(function()
		while (os.clock() - started) * 1000 < durationMs do
			if not active() then error("Input cancelled during held key") end
			task.wait(math.min(0.05, durationMs / 1000))
		end
	end)
	virtual:SendKey(false, code, false)
	trace("input.key", { key = key, state = "up", heldMs = math.floor((os.clock() - started) * 1000) })
	if not ok then error(failure) end
	return true
end

function StudioCapture.enterText(path: string, text: string, active: () -> boolean, trace: (string, { [string]: any }) -> ()): boolean
	assert(#text > 0 and #text <= 256, "Text input exceeds the fixed action bounds")
	if not active() then error("Input cancelled") end
	local target = Collector.resolvePath(path)
	if target == nil then return false end
	if not target:IsA("TextBox") then error("Planned text target is not a TextBox") end
	if not isGuiVisible(target) or target.AbsoluteSize.X <= 0 or target.AbsoluteSize.Y <= 0 then return false end
	local player = Players.LocalPlayer
	local playerGui = if player then player:FindFirstChildOfClass("PlayerGui") else nil
	if workspace.CurrentCamera == nil or playerGui == nil or not target:IsDescendantOf(playerGui) then return false end
	local center = target.AbsolutePosition + target.AbsoluteSize / 2
	local viewport = GuiService:GetInsetArea(Enum.ScreenInsets.None)
	local point = CaptureInput.screenPoint({ x = center.X, y = center.Y }, {
		x = viewport.Min.X, y = viewport.Min.Y, width = viewport.Width, height = viewport.Height,
	})
	local position = Vector2.new(point.x, point.y)
	local hit = playerGui:GetGuiObjectsAtPosition(math.round(center.X), math.round(center.Y))[1]
	assert(hit == target, "Planned text box is not the top GUI at its center")
	local virtual = input()
	virtual:SendMousePosition(position)
	virtual:SendMouseButton(position, Enum.UserInputType.MouseButton1, true, 0)
	virtual:SendMouseButton(position, Enum.UserInputType.MouseButton1, false, 0)
	task.wait(0.05)
	if not active() then error("Input cancelled before text entry") end
	assert(inputService:GetFocusedTextBox() == target, "Planned text box did not receive focus")
	virtual:SendTextInput(text)
	trace("input.text", { path = path, bytes = #text, target = target:GetFullName() })
	return true
end

function StudioCapture.fireRemote(path: string, arguments: { any }, active: () -> boolean, trace: (string, { [string]: any }) -> ()): boolean
	if not active() then error("Input cancelled") end
	local target = Collector.resolvePath(path)
	if target == nil then return false end
	assert(target:IsA("RemoteEvent"), "Planned negative request target is not a RemoteEvent")
	assert(#arguments <= 8, "Planned negative request exceeds the argument limit")
	trace("input.remote", { path = path, arguments = #arguments })
	target:FireServer(table.unpack(arguments))
	return true
end

-- A typed test hook moves only the local avatar toward one declared BasePart.
-- The server still owns collision handling and derives any authoritative identity.
function StudioCapture.moveCharacter(path: string, active: () -> boolean, trace: (string, { [string]: any }) -> ()): boolean
	if not active() then error("Input cancelled") end
	local target = Collector.resolvePath(path)
	if target == nil then return false end
	if not target:IsA("BasePart") then error("Planned movement target is not a BasePart") end
	local player = Players.LocalPlayer
	local character = if player then player.Character else nil
	local humanoid = if character then character:FindFirstChildOfClass("Humanoid") else nil
	local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
	if character == nil or not character:IsDescendantOf(workspace) or humanoid == nil
		or root == nil or not root:IsA("BasePart") or humanoid.Health <= 0 then return false end
	local destination = target.Position + Vector3.new(0, target.Size.Y / 2, 0)
	trace("input.target", { path = path, targetClass = target.ClassName,
		startDistance = (root.Position - destination).Magnitude,
		x = destination.X, y = destination.Y, z = destination.Z,
		startX = root.Position.X, startY = root.Position.Y, startZ = root.Position.Z })
	humanoid:MoveTo(destination)
	return true
end

-- Establish a declared actor-on-part starting state for carry experiments.
-- This is a test action, not evidence that a player could discover or reach it.
function StudioCapture.placeOnPart(path: string, active: () -> boolean, trace: (string, { [string]: any }) -> ()): boolean
	if not active() then error("Input cancelled") end
	local target = Collector.resolvePath(path)
	if target == nil then return false end
	if not target:IsA("BasePart") then error("Planned placement target is not a BasePart") end
	local player = Players.LocalPlayer
	local character = if player then player.Character else nil
	local humanoid = if character then character:FindFirstChildOfClass("Humanoid") else nil
	local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
	if character == nil or not character:IsDescendantOf(workspace) or humanoid == nil
		or root == nil or not root:IsA("BasePart") or humanoid.Health <= 0 then return false end
	local height = target.Size.Y / 2 + humanoid.HipHeight + root.Size.Y / 2 + 0.1
	root.AssemblyLinearVelocity = Vector3.zero
	root.AssemblyAngularVelocity = Vector3.zero
	root.CFrame = target.CFrame * CFrame.new(0, height, 0)
	task.wait(0.1)
	local relative = target.CFrame:PointToObjectSpace(root.Position)
	local placed = math.abs(relative.X) <= target.Size.X / 2 + 0.5
		and math.abs(relative.Z) <= target.Size.Z / 2 + 0.5
		and relative.Y > target.Size.Y / 2
		and relative.Y <= target.Size.Y / 2 + 8
	trace("input.actor_placed", { path = path, placed = placed,
		localX = relative.X, localY = relative.Y, localZ = relative.Z,
		sizeX = target.Size.X, sizeY = target.Size.Y, sizeZ = target.Size.Z })
	return placed
end

-- Controlled proximity setup relative to candidate geometry, without assuming its layout.
local function relativeToPart(path: string, offset: { number }, walk: boolean, active: () -> boolean, trace: (string, { [string]: any }) -> ()): boolean
	if not active() then error("Input cancelled") end
	assert(#offset == 3, "Placement requires three coordinates")
	for _, coordinate in offset do
		assert(coordinate == coordinate and math.abs(coordinate) <= 10000, "Invalid placement coordinate")
	end
	local target = Collector.resolvePath(path)
	if target == nil then return false end
	if not target:IsA("BasePart") then error("Planned placement target is not a BasePart") end
	local player = Players.LocalPlayer
	local character = if player then player.Character else nil
	local humanoid = if character then character:FindFirstChildOfClass("Humanoid") else nil
	local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
	if character == nil or not character:IsDescendantOf(workspace) or humanoid == nil
		or root == nil or not root:IsA("BasePart") or humanoid.Health <= 0 then return false end
	local destination = target.CFrame * CFrame.new(offset[1], offset[2], offset[3])
	if walk then
		trace("input.actor_relative_movement", { path = path,
			requestedX = offset[1], requestedY = offset[2], requestedZ = offset[3],
			worldX = destination.Position.X, worldY = destination.Position.Y, worldZ = destination.Position.Z,
			startX = root.Position.X, startY = root.Position.Y, startZ = root.Position.Z })
		humanoid:MoveTo(destination.Position)
		return true
	end
	root.AssemblyLinearVelocity = Vector3.zero
	root.AssemblyAngularVelocity = Vector3.zero
	root.CFrame = destination
	local relative = target.CFrame:PointToObjectSpace(root.Position)
	trace("input.actor_relative_placement", { path = path,
		requestedX = offset[1], requestedY = offset[2], requestedZ = offset[3],
		localX = relative.X, localY = relative.Y, localZ = relative.Z,
		worldX = root.Position.X, worldY = root.Position.Y, worldZ = root.Position.Z,
		targetX = target.Position.X, targetY = target.Position.Y, targetZ = target.Position.Z })
	return (root.Position - destination.Position).Magnitude <= 0.01
end

function StudioCapture.placeRelativeToPart(path: string, offset: { number }, active: () -> boolean, trace: (string, { [string]: any }) -> ()): boolean
	return relativeToPart(path, offset, false, active, trace)
end

function StudioCapture.moveRelativeToPart(path: string, offset: { number }, active: () -> boolean, trace: (string, { [string]: any }) -> ()): boolean
	return relativeToPart(path, offset, true, active, trace)
end

-- Geometry is measured for diagnostics. The host receives original MCP viewport bytes.
-- No device simulator mutation, OS window crop, marker overlay, or pixel-size guess.
local function captureLocked(active: () -> boolean, captureViewport: () -> any, trace: (string, { [string]: any }) -> ()): any
	if not active() then error("Capture cancelled") end
	local camera = workspace.CurrentCamera
	assert(camera ~= nil, "The Play client has no camera")
	local size, frame, focus, fov = camera.ViewportSize, camera.CFrame, camera.Focus, camera.FieldOfView
	local cameraType, subject = camera.CameraType, camera.CameraSubject
	trace("capture.geometry", { cameraSafeWidth = size.X, cameraSafeHeight = size.Y,
		fieldOfView = fov, cameraType = tostring(cameraType) })

	-- MCP acquisition yields for several seconds. Freeze the exact view already
	-- selected by the candidate so Roblox's default follow camera cannot drift
	-- while bytes are acquired. This changes no framing or field of view and is
	-- always restored, including when acquisition fails.
	camera.CameraType = Enum.CameraType.Scriptable
	camera.CFrame, camera.Focus, camera.FieldOfView = frame, focus, fov
	RunService:UnbindFromRenderStep(CAPTURE_CAMERA_BINDING)
	RunService:BindToRenderStep(CAPTURE_CAMERA_BINDING, Enum.RenderPriority.Last.Value, function()
		if workspace.CurrentCamera ~= camera then return end
		camera.CameraType = Enum.CameraType.Scriptable
		camera.CFrame, camera.Focus, camera.FieldOfView = frame, focus, fov
	end)
	trace("capture.camera_locked", { cameraType = tostring(cameraType) })
	local succeeded, result = pcall(captureViewport)
	RunService:UnbindFromRenderStep(CAPTURE_CAMERA_BINDING)
	local sameCamera = workspace.CurrentCamera == camera
	local sameViewport = camera.ViewportSize == size
	local sameFrame = camera.CFrame == frame
	local sameFocus = camera.Focus == focus
	local sameFov = camera.FieldOfView == fov
	local sameType = camera.CameraType == Enum.CameraType.Scriptable
	local stable = active() and sameCamera and sameViewport and sameFrame and sameFocus and sameFov and sameType
	camera.CameraSubject = subject
	camera.CameraType = cameraType
	trace("capture.camera_restored", { stable = stable, cameraType = tostring(cameraType),
		sameCamera = sameCamera, sameViewport = sameViewport, sameFrame = sameFrame,
		sameFocus = sameFocus, sameFov = sameFov, sameType = sameType,
		viewportWidth = camera.ViewportSize.X, viewportHeight = camera.ViewportSize.Y })
	if not succeeded then error(result) end
	if not stable then
		error("Capture cancelled or camera changed; raw acquisition is retained for inspection")
	end
	return result
end

function StudioCapture.capture(active: () -> boolean, captureViewport: () -> any, trace: (string, { [string]: any }) -> (), targetPath: string?): any
	if not active() then error("Capture cancelled") end
	if targetPath == nil then return captureLocked(active, captureViewport, trace) end
	local player = Players.LocalPlayer
	local character = if player then player.Character else nil
	assert(character ~= nil and character:IsDescendantOf(workspace), "Actor view acquisition has no live local avatar")
	return ActorView.capture(workspace.CurrentCamera, character, Collector.resolvePath(targetPath), function()
		return captureLocked(active, captureViewport, trace)
	end, trace)
end

return table.freeze(StudioCapture)
