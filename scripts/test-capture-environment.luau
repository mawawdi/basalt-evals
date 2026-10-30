local Input = require("../plugin/src/CaptureInput")
local isGuiVisible = require("../plugin/src/GuiVisibility")
local Instance = require("@lune/roblox").Instance
local roblox = require("@lune/roblox")
local TrialTrace = require("../plugin/src/TrialTrace")
local ActorView = require("@lune/luau").load(require("@lune/fs").readFile("plugin/src/ActorView.luau"), {
	environment = { Vector3 = roblox.Vector3, CFrame = roblox.CFrame, Enum = roblox.Enum },
})()
local passed = 0
local function test(name, run)
	local ok, reason = pcall(run)
	assert(ok, name .. ": " .. tostring(reason)); passed += 1
end
local function reject(run, expected)
	local ok, reason = pcall(run)
	assert(not ok and string.find(tostring(reason), expected, 1, true), tostring(reason))
end
local function input()
	local now, listener, presses, releases, disconnected = 0, nil, 0, 0, false
	local active, acknowledge = true, true
	local moves, moved, hovering, pressedOverTarget = 0, false, false, false
	local io = {
		now = function() return now end,
		wait = function() now += 0.05; hovering = moved end,
		active = function() return active end,
		listen = function(callback) listener = callback; return function() disconnected = true; listener = nil end end,
		move = function() moves += 1; moved = true end,
		press = function() presses += 1; pressedOverTarget = hovering end,
		release = function() releases += 1; if acknowledge and pressedOverTarget and hovering then listener() end end,
	}
	return io, function() return presses, releases, disconnected, moves end,
		function() active = false end, function() acknowledge = false end
end

test("GUI observations and input honor hidden ancestors and disabled layer collectors", function()
	for _, layerClass in { "ScreenGui", "SurfaceGui", "BillboardGui" } do
		local layer = Instance.new(layerClass)
		local frame = Instance.new("Frame"); frame.Parent = layer
		local label = Instance.new("TextLabel"); label.Parent = frame
		assert(isGuiVisible(label))
		frame.Visible = false; assert(not isGuiVisible(label))
		frame.Visible = true; layer.Enabled = false; assert(not isGuiVisible(label))
		layer.Enabled = true; label.Visible = false; assert(not isGuiVisible(label))
		label.Visible = true; assert(isGuiVisible(label))
		layer:Destroy()
	end
end)

test("The cursor reaches GUI hit testing before exactly one press/release", function()
	local io, counts = input()
	Input.activate(io)
	local down, up, disconnected, moves = counts()
	assert(down == 1 and up == 1 and disconnected and moves == 1)
end)

test("Full-screen controls keep their screen center when GUI origin includes the top bar", function()
	local screen = { x = 128, y = 692 } -- center of the impact-vfx before control at 672..712
	for _, origin in { { x = 0, y = 0 }, { x = 0, y = -36 }, { x = 0, y = -58 }, { x = -59, y = -58 } } do
		local point = Input.screenPoint({ x = screen.x + origin.x, y = screen.y + origin.y },
			{ x = origin.x, y = origin.y, width = 1280, height = 720 })
		assert(point.x == screen.x and point.y == screen.y)
	end
end)

test("Inset conversion rejects points beyond the actual screen", function()
	local viewport = { x = 0, y = -58, width = 1280, height = 720 }
	for _, center in { { x = 128, y = -59 }, { x = 128, y = 662 }, { x = 1280, y = 200 } } do
		reject(function() Input.screenPoint(center, viewport) end, "outside")
	end
end)

test("An ignored click never reports success or retries a possible side effect", function()
	local io, counts, _, ignore = input()
	ignore()
	reject(function() Input.activate(io) end, "did not acknowledge")
	local down, up, disconnected = counts()
	assert(down == 1 and up == 1 and disconnected)
end)

test("An activation before the automated press cannot acknowledge that press", function()
	local io, _, _, ignore = input()
	local listen = io.listen
	io.listen = function(callback)
		local disconnect = listen(callback)
		callback()
		return disconnect
	end
	ignore()
	reject(function() Input.activate(io) end, "did not acknowledge")
end)

test("Stop after mouse-down still releases and removes its event listener", function()
	local io, counts, stop = input()
	local wait = io.wait
	io.wait = function()
		wait()
		local down = counts()
		if down > 0 then stop() end
	end
	reject(function() Input.activate(io) end, "cancelled")
	local down, up, disconnected = counts()
	assert(down == 1 and up == 1 and disconnected)
end)

test("Cancellation after cursor movement sends no mouse-down", function()
	local io, counts, stop = input()
	io.wait = stop
	reject(function() Input.activate(io) end, "cancelled")
	local down, up, disconnected, moves = counts()
	assert(down == 0 and up == 0 and disconnected and moves == 1)
end)

test("Rejected cursor movement disconnects listeners without sending a click", function()
	local io, counts = input()
	io.move = function() error("CoreGui blocks pointer movement") end
	reject(function() Input.activate(io) end, "CoreGui blocks")
	local down, up, disconnected = counts()
	assert(down == 0 and up == 0 and disconnected)
end)

test("Input exceptions clean up the listener and surface release failures", function()
	local io, counts = input()
	io.release = function() error("blocked release") end
	reject(function() Input.activate(io) end, "blocked release")
	local _, _, disconnected = counts(); assert(disconnected)
end)

local function actorFixture()
	local actor = Instance.new("Model")
	local head = Instance.new("Part"); head.Name = "Head"; head.Position = roblox.Vector3.new(7, 5, -9); head.LocalTransparencyModifier = 0; head.Parent = actor
	local root = Instance.new("Part"); root.Name = "HumanoidRootPart"; root.Position = roblox.Vector3.new(7, 3, -9); root.LocalTransparencyModifier = 0; root.Parent = actor
	local humanoid = Instance.new("Humanoid"); humanoid.Health = 100; humanoid.Parent = actor
	local camera = Instance.new("Camera"); camera.CFrame = roblox.CFrame.new(0, 30, 50); camera.FieldOfView = 73; camera.CameraSubject = humanoid
	return actor, head, root, camera
end

test("Actor acquisition aims in any direction without imposing a world position or moving scene geometry", function()
	local actor, head, root, camera = actorFixture()
	local target = Instance.new("Part")
	local wall = Instance.new("Part"); wall.Transparency = 0; wall.CanCollide = true
	local original, actorPosition, fieldOfView = camera.CFrame, root.Position, camera.FieldOfView
	for _, offset in { roblox.Vector3.new(30, 0, 0), roblox.Vector3.new(-30, 0, 0), roblox.Vector3.new(0, 0, 30), roblox.Vector3.new(0, 30, 0) } do
		target.Position = head.Position + offset
		local events = {}
		local receipt = ActorView.capture(camera, actor, target, function()
			assert(camera.CFrame.Position == head.Position)
			assert(camera.CFrame.LookVector:Dot(offset.Unit) > 0.999)
			assert(camera.FieldOfView == fieldOfView and root.Position == actorPosition)
			assert(head.LocalTransparencyModifier == 1 and target.Transparency == 0 and wall.Transparency == 0 and wall.CanCollide)
			return "original-viewport-bytes"
		end, function(stage, data) events[stage] = data end)
		assert(receipt == "original-viewport-bytes" and events["capture.actor_target"].aimed)
		assert(events["capture.actor_view"].originX == head.Position.X)
		assert(camera.CFrame == original and head.LocalTransparencyModifier == 0 and root.Position == actorPosition)
	end
end)

test("Missing targets retain an actor view while missing acquisition machinery fails", function()
	local actor, head, _, camera = actorFixture()
	local captured, observed = false, nil
	ActorView.capture(camera, actor, nil, function()
		captured = true; assert(camera.CFrame.Position == head.Position)
	end, function(stage, data) if stage == "capture.actor_target" then observed = data end end)
	assert(captured and observed.targetPresent == false and observed.aimed == false)
	reject(function() ActorView.capture(camera, nil, nil, function() error("must not capture") end, function() end) end, "no live local avatar")
	reject(function() ActorView.capture(nil, actor, nil, function() error("must not capture") end, function() end) end, "no camera")
end)

test("Actor acquisition restores camera and avatar transparency after capture failure", function()
	local actor, head, root, camera = actorFixture()
	head.LocalTransparencyModifier = 0.35
	local frame, focus, cameraType, position = camera.CFrame, camera.Focus, camera.CameraType, root.Position
	reject(function()
		ActorView.capture(camera, actor, head, function() error("capture unavailable") end, function() end)
	end, "capture unavailable")
	assert(camera.CFrame == frame and camera.Focus == focus and camera.CameraType == cameraType)
	assert(math.abs(head.LocalTransparencyModifier - 0.35) < 0.0001 and root.Position == position)
end)

test("Actor geometry survives the real bounded trace transport with phase and capture bindings", function()
	local actor, head, _, camera = actorFixture()
	local target = Instance.new("Part"); target.Position = roblox.Vector3.new(0, 4, 6)
	local state = TrialTrace.new("")
	local function trace(stage, data)
		data.phaseId, data.captureId = "view-from-spawn", "beacon-from-spawn"
		TrialTrace.record(state, stage, data, "2026-09-26T00:00:00.000Z", "trial-0123456789abcdef01234567")
	end
	ActorView.capture(camera, actor, target, function()
		trace("capture.camera_restored", { stable = true })
	end, trace)
	local batch = TrialTrace.batch(state)
	assert(#batch == 4 and batch[1].stage == "capture.actor_view" and batch[2].stage == "capture.actor_target")
	for _, event in batch do
		assert(event.data.phaseId == "view-from-spawn" and event.data.captureId == "beacon-from-spawn")
		assert(event.data.droppedEvents == 0)
	end
	for _, key in { "originX", "originY", "originZ", "actorX", "actorY", "actorZ", "lookX", "lookY", "lookZ", "fieldOfView" } do
		assert(type(batch[1].data[key]) == "number", "Transport lost " .. key)
	end
	assert(batch[1].data.originX == head.Position.X and batch[1].data.fieldOfView == 73)
	assert(batch[2].data.targetX == 0 and batch[2].data.targetY == 4 and batch[2].data.targetZ == 6)
	assert(batch[2].data.targetPresent and batch[2].data.aimed)
end)

print("Capture environment regression tests passed: " .. tostring(passed))
return true
