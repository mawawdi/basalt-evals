--!strict

local CaptureInput = {}

-- AbsolutePosition is relative to CoreUISafeInsets. The full-screen inset area
-- uses that same origin; subtracting its minimum gives VirtualInput screen pixels.
function CaptureInput.screenPoint(center: { x: number, y: number },
	viewport: { x: number, y: number, width: number, height: number }): { x: number, y: number }
	local point = { x = math.round(center.x - viewport.x), y = math.round(center.y - viewport.y) }
	assert(point.x >= 0 and point.y >= 0 and point.x < viewport.width and point.y < viewport.height,
		"Planned input target is outside the full-screen viewport")
	return point
end

-- A dispatched mouse event is not an acknowledgement. Wait for this exact
-- target's input acknowledgment and always release a successfully pressed button.
-- GuiButton uses Activated; other GuiObjects acknowledge a received down/up pair.
function CaptureInput.activate(io: {
	now: () -> number, wait: () -> (), active: () -> boolean,
	listen: (() -> ()) -> (() -> ()), move: () -> (), press: () -> (), release: () -> (),
})
	local activated = false
	local pressed = false
	local disconnect = io.listen(function() if pressed then activated = true end end)
	local ok, reason = pcall(function()
		assert(io.active(), "Input cancelled")
		io.move()
		io.wait() -- mouse movement must reach GUI hit testing before mouse-down
		assert(io.active(), "Input cancelled")
		io.press()
		pressed = true
		io.wait() -- allow an input frame between down and up
	end)
	local released, releaseError = true, nil
	if pressed then released, releaseError = pcall(io.release) end
	if ok and released then
		ok, reason = pcall(function()
			local deadline = io.now() + 2
			while not activated do
				assert(io.active(), "Input cancelled")
				assert(io.now() < deadline, "Mouse input was sent but the planned target did not acknowledge it; no automatic second click was sent")
				io.wait()
			end
			assert(io.active(), "Input cancelled")
		end)
	end
	disconnect()
	if not released then error("Could not release virtual mouse button: " .. tostring(releaseError), 0) end
	if not ok then error(reason, 0) end
end

return table.freeze(CaptureInput)
