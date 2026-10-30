--!strict

-- Fixed phase sequence, separated from Studio APIs so cancellation, timeouts and
-- readiness can be tested without launching Studio or manufacturing evidence.
local PhaseCapture = {}

export type IO = {
	now: () -> number,
	wait: (number) -> (),
	active: () -> boolean,
	actorReady: (() -> boolean)?,
	click: (string) -> boolean,
	moveCharacter: (string) -> boolean,
	characterOnPart: (string) -> boolean,
	collect: (any) -> any,
	capture: (any, string?) -> any,
	trace: (string, { [string]: any }) -> (),
}

function PhaseCapture.collect(phase: any, io: IO): ({ any }, { any })
	local driver = phase.driver
	local started = io.now()
	io.trace("phase.started", { driver = driver.kind })
	local deadline = started + (if driver.kind == "manual" then 120 else driver.timeoutMs / 1000)
	-- Facts run sequentially. Their observation windows belong to acquisition,
	-- independently of the readiness timeout and any criterion success threshold.
	local observationSeconds = 0
	for _, fact in phase.facts do
		observationSeconds += (fact.durationMs or 0) / 1000
		if fact.sampleCount and fact.intervalMs then
			observationSeconds += math.max(0, fact.sampleCount - 1) * fact.intervalMs / 1000
		end
	end
	local acquisitionDeadline = deadline + observationSeconds + math.max(30, #phase.captures * 30)
	local function checkActive()
		if not io.active() then error("Capture cancelled: Play stopped, paused, or the session changed") end
		if io.now() >= acquisitionDeadline then error("Capture acquisition timed out in phase " .. phase.id) end
	end
	local lastReady = ""
	local function waitUntil(predicate: () -> boolean): boolean
		while true do
			checkActive()
			if io.now() >= deadline then return false end
			local ready = predicate()
			checkActive()
			if ready then return true end
			io.wait(0.05)
		end
	end
	local function ready(): boolean
		if driver.kind == "manual" or driver.kind == "wait_for_session" then return true end
		if driver.kind == "character_reach_part" then return io.characterOnPart(driver.targetPath) end
		if driver.kind == "observe_from_actor" then
			return io.collect({ id = "view-target", kind = "instance", path = driver.targetPath }).exists == true
		end
		for _, fact in phase.facts do
			if fact.id == driver.readyFactId then
				local observed = io.collect(fact)
				local value = tostring(observed.exists) .. ":" .. tostring(observed.value)
				if value ~= lastReady then
					lastReady = value
					io.trace("phase.readiness", { factId = fact.id, exists = observed.exists, value = tostring(observed.value), expected = if driver.kind == "wait_for_exists" then "exists" else driver.readyValue })
				end
				return observed.exists == true and (driver.kind == "wait_for_exists" or observed.value == driver.readyValue)
			end
		end
		return false
	end
	checkActive()
	if driver.kind == "observe_from_actor" then
		assert(io.actorReady ~= nil, "Actor view readiness is unavailable")
		if not waitUntil(io.actorReady) then error("Actor view acquisition has no live local avatar or camera") end
	end
	local baseline = {}
	for _, fact in phase.facts do
		if fact.id == driver.readyFactId then table.insert(baseline, io.collect(fact)) end
	end
	io.trace("phase.baseline", { observations = baseline })
	local wasReady = ready()
	if wasReady and driver.kind ~= "wait_for_session" and driver.kind ~= "manual" then
		io.trace("phase.preexisting_state", { factId = driver.readyFactId })
	end
	if driver.kind == "gui_button" then
		io.trace("input.waiting", { path = driver.path, timeoutMs = driver.timeoutMs })
		if waitUntil(function() return io.click(driver.path) end) then
			io.trace("input.clicked", { path = driver.path, elapsedMs = math.floor((io.now() - started) * 1000) })
		else
			io.trace("input.unavailable", { path = driver.path })
		end
	elseif driver.kind == "character_move_to" or driver.kind == "character_reach_part" then
		io.trace("input.waiting", { path = driver.targetPath, timeoutMs = driver.timeoutMs })
		if waitUntil(function() return io.moveCharacter(driver.targetPath) end) then
			io.trace("input.move_requested", { path = driver.targetPath, elapsedMs = math.floor((io.now() - started) * 1000) })
		else
			io.trace("input.unavailable", { path = driver.targetPath })
		end
	elseif driver.kind == "wait_for_session" then
		io.trace("phase.ready", { elapsedMs = math.floor((io.now() - started) * 1000) })
	elseif driver.kind == "wait_for_fact" or driver.kind == "wait_for_exists" then
		io.trace("phase.waiting", { factId = driver.readyFactId, timeoutMs = driver.timeoutMs })
	end
	if driver.kind ~= "manual" and driver.kind ~= "wait_for_session" then
		if waitUntil(ready) then
			io.trace("phase.ready", { elapsedMs = math.floor((io.now() - started) * 1000) })
			io.wait(0.15)
		else
			io.trace("phase.readiness_unmet", { elapsedMs = math.floor((io.now() - started) * 1000) })
		end
	end
	checkActive()
	local observations = {}
	for _, fact in phase.facts do
		io.trace("observation.started", { factId = fact.id, kind = fact.kind })
		table.insert(observations, io.collect(fact))
		checkActive()
	end
	io.trace("observations.collected", { count = #observations, observations = observations })
	local captures = {}
	for _, capture in phase.captures do
		checkActive()
		io.trace("capture.requested", { captureId = capture.id })
		local receipt = io.capture(capture, if driver.kind == "observe_from_actor" then driver.targetPath else nil)
		checkActive()
		table.insert(captures, receipt)
		io.trace("capture.received", { captureId = receipt.captureId, hash = receipt.hash })
	end
	if driver.kind ~= "manual" and driver.kind ~= "wait_for_session" and not ready() then
		io.trace("phase.readiness_changed", { elapsedMs = math.floor((io.now() - started) * 1000) })
	end
	io.trace("phase.completed", { elapsedMs = math.floor((io.now() - started) * 1000) })
	return observations, captures
end

return table.freeze(PhaseCapture)
