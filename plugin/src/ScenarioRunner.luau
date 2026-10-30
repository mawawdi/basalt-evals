--!strict

-- Executes one frozen multiplayer scenario in every Studio test context. The
-- server publishes a shared clock only after each Play client has attached and
-- the required rendered recorder has retained a pre-roll frame for every actor;
-- clients derive stable actor names by sorting the same test-player identities.
-- Steps run in plan order. Each step waits on one anchor: the shared clock, the
-- completion of an earlier step, or the first sighting of a fixed anchor fact.
-- The server publishes the schedule of every step on the runtime marker, and
-- the actor of an action performs it once at that time. A context with
-- observations in a fact-anchored step anchors them on its own sighting.
-- Candidate code never receives the hidden plan or the resulting assertions.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Collector = require(script.Parent.Collector)
local ObservationBatch = require(script.Parent.ObservationBatch)

local ScenarioRunner = {}
local MARKER_PREFIX = "BasaltEvalRuntime-"
local OBSERVED = "observed"
local NOT_OBSERVED = "not_observed_within_horizon"
local FAILED = "acquisition_failed"
-- Anchor facts and published signals are polled once each frame.
local POLL_SECONDS = 1 / 60
-- A context that follows the published schedule waits this much longer than its
-- horizon, because the deciding context can start the same step a little later.
local SIGNAL_SLACK_SECONDS = 5

export type IO = {
	active: () -> boolean,
	sequenceReady: () -> boolean,
	now: () -> number,
	wait: (number) -> (),
	spawn: (() -> ()) -> (),
	collect: (any, { [string]: Player }) -> any,
	anchor: (any, { [string]: Player }) -> boolean,
	moveCharacter: (string) -> boolean,
	placeOnPart: (string) -> boolean,
	placeRelativeToPart: (string, { number }) -> boolean,
	moveRelativeToPart: (string, { number }) -> boolean,
	probeBarrier: (string) -> any,
	pressKey: (string) -> boolean,
	holdKey: ((string, number) -> boolean)?,
	activateGui: ((string) -> boolean)?,
	enterText: ((string, string) -> boolean)?,
	fireRemote: (string, { any }) -> boolean,
	disconnect: () -> (),
	post: (any) -> any,
	status: () -> any,
	endTest: (any) -> (),
	trace: (string, { [string]: any }) -> (),
	-- Sets the declared viewport of this Play client. Only a client calls it.
	configureView: () -> (),
}

local function sortedPlayers(expected: number, io: IO): { Player }
	local deadline = os.clock() + 60
	while true do
		assert(io.active(), "Scenario readiness was cancelled")
		local players = Players:GetPlayers()
		if #players == expected then
			table.sort(players, function(left, right)
				return if left.UserId == right.UserId then left.Name < right.Name else left.UserId < right.UserId
			end)
			return players
		end
		if #players > expected then error("Scenario received more players than the frozen plan") end
		if os.clock() >= deadline then error("Scenario players did not join within 60 seconds") end
		io.wait(0.05)
	end
end

local function actorMap(actors: { string }, players: { Player }): { [string]: Player }
	local result = {}
	for index, actor in actors do
		result[actor] = players[index]
	end
	return result
end

local function actorReady(player: Player): boolean
	local character = player.Character
	if character == nil or not character:IsDescendantOf(workspace) then return false end
	local humanoid = character:FindFirstChildOfClass("Humanoid")
	local root = character:FindFirstChild("HumanoidRootPart")
	return humanoid ~= nil and humanoid.Health > 0 and root ~= nil and root:IsA("BasePart")
end

local function actorsReady(players: { Player }): boolean
	for _, player in players do
		if not actorReady(player) then return false end
	end
	return true
end

-- Returns the shared start, the runtime marker and its signal event.
local function startTime(sessionId: string, isServer: boolean, players: { Player }, io: IO): (number, any, any)
	local markerName = MARKER_PREFIX .. sessionId
	if isServer then
		assert(ReplicatedStorage:FindFirstChild(markerName) == nil, "Candidate collides with the evaluator runtime marker")
		local marker = Instance.new("Folder")
		marker.Name = markerName
		local readyEvent = Instance.new("RemoteEvent")
		readyEvent.Name = "Ready"
		readyEvent.Parent = marker
		local signalEvent = Instance.new("RemoteEvent")
		signalEvent.Name = "Signal"
		signalEvent.Parent = marker
		local allowed: { [Player]: boolean } = {}
		local ready: { [Player]: boolean } = {}
		local readyCount = 0
		for _, player in players do allowed[player] = true end
		readyEvent.OnServerEvent:Connect(function(player: Player)
			if not allowed[player] or ready[player] then return end
			ready[player] = true
			readyCount += 1
			io.trace("scenario.context_ready", { context = "server", userId = player.UserId,
				ready = readyCount, expected = #players })
		end)
		marker.Parent = ReplicatedStorage
		local deadline = os.clock() + 120
		while true do
			assert(io.active(), "Scenario readiness was cancelled")
			if readyCount == #players and actorsReady(players) and io.sequenceReady() then
				assert(io.active(), "Scenario readiness was cancelled")
				marker:SetAttribute("StartAt", io.now() + 2)
			end
			local value = marker:GetAttribute("StartAt")
			if type(value) == "number" then return value, marker, signalEvent end
			if os.clock() >= deadline then error("Scenario actors or sequence recorder did not become ready within 120 seconds") end
			io.wait(0.05)
		end
	end
	-- The client sets its viewport before it can report ready, so the shared
	-- clock also waits for the viewport of each client.
	io.configureView()
	local deadline = os.clock() + 120
	local announced = false
	while true do
		assert(io.active(), "Scenario readiness was cancelled")
		local marker = ReplicatedStorage:FindFirstChild(markerName)
		if marker then
			local readyEvent = marker:FindFirstChild("Ready")
			local signalEvent = marker:FindFirstChild("Signal")
			local localPlayer = Players.LocalPlayer
			if not announced and localPlayer and actorReady(localPlayer)
				and readyEvent and readyEvent:IsA("RemoteEvent") then
				readyEvent:FireServer()
				announced = true
				io.trace("scenario.context_ready", { context = "client", actorReady = true })
			end
			local value = marker:GetAttribute("StartAt")
			if announced and type(value) == "number" and signalEvent and signalEvent:IsA("RemoteEvent") then
				return value, marker, signalEvent
			end
		end
		if os.clock() >= deadline then error("Scenario actor or server clock did not become ready within 120 seconds") end
		io.wait(0.05)
	end
end

local function waitUntil(target: number, io: IO)
	while io.now() < target do
		assert(io.active(), "Scenario was cancelled")
		io.wait(math.min(0.02, target - io.now()))
	end
end

local function argumentValues(arguments: { any }, actors: { [string]: Player }): { any }
	local values = {}
	for _, argument in arguments do
		if argument.kind == "literal" then
			table.insert(values, argument.value)
		elseif argument.kind == "actor_user_id" then
			local player = actors[argument.actor]
			table.insert(values, player.UserId)
		else
			error("Unknown scenario remote argument")
		end
	end
	return values
end

-- The published schedule of a step: "o:<anchorAt>:<scheduledAt>", "n" or "a".
local function encodeSchedule(state: string, anchorAt: number?, scheduledAt: number?): string
	if state == OBSERVED and anchorAt ~= nil and scheduledAt ~= nil then
		return string.format("o:%.6f:%.6f", anchorAt, scheduledAt)
	end
	return if state == NOT_OBSERVED then "n" else "a"
end

local function decodeSchedule(value: any): (string, number?, number?)
	if value == "n" then return NOT_OBSERVED, nil, nil end
	if type(value) == "string" then
		local anchorText, scheduledText = string.match(value, "^o:(%-?[%d%.]+):(%-?[%d%.]+)$")
		local anchorAt, scheduledAt = tonumber(anchorText), tonumber(scheduledText)
		if anchorAt ~= nil and scheduledAt ~= nil then return OBSERVED, anchorAt, scheduledAt end
	end
	return FAILED, nil, nil
end

-- The published completion of a step: "o:<completedAt>", "n" or "a".
local function encodeDone(state: string, completedAt: number?): string
	if state == OBSERVED and completedAt ~= nil then return string.format("o:%.6f", completedAt) end
	return if state == NOT_OBSERVED then "n" else "a"
end

local function decodeDone(value: any): (string, number?)
	if value == nil or value == "n" then return NOT_OBSERVED, nil end
	if type(value) == "string" then
		local completedAt = tonumber(string.match(value, "^o:(%-?[%d%.]+)$"))
		if completedAt ~= nil then return OBSERVED, completedAt end
	end
	return FAILED, nil
end

-- A wait step completes at its scheduled time.
local function doneFromSchedule(value: any): string
	local state, _, scheduledAt = decodeSchedule(value)
	return encodeDone(state, scheduledAt)
end

-- A fact anchor counts only after it holds for holdMs, so its step never starts
-- before that confirmation: scheduledAt = anchorObservedAt + max(offsetMs, holdMs).
local function factSchedule(step: any, anchorAt: number): number
	return anchorAt + math.max(step.at.offsetMs, step.holdMs) / 1000
end

-- The longest declared observation window of the scenario, in seconds.
local function longestWindowSeconds(scenario: any): number
	local longest = 0
	for _, step in scenario.steps do
		for _, request in step.observations do
			local fact = request.fact
			local window = fact.durationMs or 0
			if fact.sampleCount and fact.intervalMs then window = (fact.sampleCount - 1) * fact.intervalMs end
			longest = math.max(longest, window / 1000)
		end
	end
	return longest
end

function ScenarioRunner.run(session: any, scenario: any, context: string, isServer: boolean, io: IO)
	local plan = session.plan
	local players = sortedPlayers(plan.clients, io)
	local actors = actorMap(plan.actors, players)
	local actorOf: { [Player]: string } = {}
	local actorIdentities = {}
	for index, actor in plan.actors do
		local player = players[index]
		actorOf[player] = actor
		table.insert(actorIdentities, { actor = actor, userId = player.UserId, name = player.Name })
	end
	local start, marker, signalEvent = startTime(session.sessionId, isServer, players, io)
	local budgetEnd = start + scenario.durationMs / 1000
	local shouldReport = table.find(scenario.reportContexts, context) ~= nil
	local stepIndex: { [string]: number } = {}
	for index, step in scenario.steps do stepIndex[step.id] = index end
	io.trace("scenario.started", { scenarioId = scenario.id, context = context, startAt = start })
	local observing = true
	local connections: { RBXScriptConnection } = {}
	-- These probes come only from the validated canonical plan. The listener
	-- observes state while actions continue; it does not drive gameplay.
	local seen: { [string]: boolean } = {}
	for _, step in scenario.steps do
		for _, request in step.observations do
			local fact = request.fact
			if request.context ~= context or fact.kind ~= "replication_probe" then continue end
			local key = fact.path .. "\0" .. fact.attribute
			if seen[key] then continue end
			seen[key] = true
			io.spawn(function()
				while observing do
					local target = Collector.resolvePath(fact.path)
					if target ~= nil then
						local function observe()
							io.trace("scenario.state", { scenarioId = scenario.id, context = context,
								at = io.now(), path = fact.path, attribute = fact.attribute,
								value = target:GetAttribute(fact.attribute) })
						end
						observe()
						table.insert(connections, target:GetAttributeChangedSignal(fact.attribute):Connect(observe))
						return
					end
					io.wait(0.1)
				end
			end)
		end
	end
	if not isServer then
		io.spawn(function()
			while observing do
				local player = Players.LocalPlayer
				local character = if player then player.Character else nil
				local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
				local camera = workspace.CurrentCamera
				local position = if root and root:IsA("BasePart") then root.Position else nil
				local cameraPosition = if camera then camera.CFrame.Position else nil
				local look = if camera then camera.CFrame.LookVector else nil
				local viewport = if camera then camera.ViewportSize else nil
				io.trace("scenario.sample", { scenarioId = scenario.id, context = context,
					at = io.now(), userId = if player then player.UserId else nil,
					avatarX = if position then position.X else nil,
					avatarY = if position then position.Y else nil,
					avatarZ = if position then position.Z else nil,
					cameraX = if cameraPosition then cameraPosition.X else nil,
					cameraY = if cameraPosition then cameraPosition.Y else nil,
					cameraZ = if cameraPosition then cameraPosition.Z else nil,
					lookX = if look then look.X else nil,
					lookY = if look then look.Y else nil,
					lookZ = if look then look.Z else nil,
					viewportWidth = if viewport then viewport.X else nil,
					viewportHeight = if viewport then viewport.Y else nil })
				io.wait(0.5)
			end
		end)
	end

	-- The server is the only writer of the published schedule.
	local published: { [string]: string } = {}
	local function publish(name: string, value: string)
		if published[name] ~= nil then return end
		published[name] = value
		marker:SetAttribute(name, value)
		io.trace("scenario.published", { scenarioId = scenario.id, name = name, value = value, at = io.now() })
	end
	local function read(name: string): any
		if isServer then return published[name] end
		return marker:GetAttribute(name)
	end
	local function waitFor(name: string, deadline: number): any
		while true do
			assert(io.active(), "Scenario was cancelled")
			local value = read(name)
			if value ~= nil then return value end
			if io.now() >= deadline then return nil end
			io.wait(POLL_SECONDS)
		end
	end
	local listener: RBXScriptConnection? = nil
	if isServer then
		-- Clients report a scope sighting or an action completion. The first
		-- signal from the planned context for that step wins.
		listener = signalEvent.OnServerEvent:Connect(function(player: Player, kind: any, index: any, state: any, value: any)
			local actor = actorOf[player]
			local step = if type(index) == "number" then scenario.steps[index] else nil
			if actor == nil or step == nil or (state ~= OBSERVED and state ~= NOT_OBSERVED and state ~= FAILED) then return end
			local time = if state == OBSERVED and type(value) == "number" and value == value then value else nil
			local result = if state == OBSERVED and time == nil then FAILED else state
			if kind == "anchor" then
				local after = step.at.after
				if after == nil or after.fact == nil or after.scope ~= actor then return end
				local schedule = encodeSchedule(result, time, if time then factSchedule(step, time) else nil)
				publish("S" .. index, schedule)
				if step.action.kind == "wait" then publish("D" .. index, doneFromSchedule(schedule)) end
			elseif kind == "done" then
				if step.action.kind == "wait" or step.action.actor ~= actor then return end
				publish("D" .. index, encodeDone(result, time))
			end
		end)
	end

	-- Poll a fixed anchor fact each frame until it holds for holdSeconds or the deadline.
	local function watch(fact: any, deadline: number, holdSeconds: number): (string, number?, number, boolean)
		local runStart: number? = nil
		local previous: number? = nil
		local largestGap = 0
		local firstPoll = true
		local preexisting = false
		while true do
			assert(io.active(), "Scenario was cancelled")
			local polledAt = io.now()
			local ok, holds = pcall(io.anchor, fact, actors)
			if previous ~= nil then largestGap = math.max(largestGap, polledAt - previous) end
			previous = polledAt
			if not ok then
				io.trace("scenario.anchor_failed", { scenarioId = scenario.id, context = context,
					kind = fact.kind, error = tostring(holds) })
				return FAILED, nil, largestGap * 1000, false
			end
			if holds == true then
				if runStart == nil then
					runStart = polledAt
					preexisting = firstPoll
				end
				local started = runStart :: number
				if polledAt - started >= holdSeconds then return OBSERVED, started, largestGap * 1000, preexisting end
			else
				runStart = nil
				preexisting = false
			end
			firstPoll = false
			if polledAt >= deadline then return NOT_OBSERVED, nil, largestGap * 1000, false end
			io.wait(POLL_SECONDS)
		end
	end

	local reportSteps = {}
	local pendingBatches = 0
	local batchFailure: string? = nil
	for index, step in scenario.steps do
		local dueAt = io.now()
		local record: { [string]: any } = { stepId = step.id, dueAt = dueAt, observations = {} }
		local action = step.action
		local isActor = action.kind ~= "wait" and action.actor == context
		local requestCount = 0
		for _, request in step.observations do
			if request.context == context then requestCount += 1 end
		end
		local at = step.at
		local after = at.after
		local horizon = step.horizonMs / 1000
		local offset = if at.offsetMs ~= nil then at.offsetMs / 1000 else 0
		local lookUntil = math.min(dueAt + horizon, budgetEnd)
		local followUntil = lookUntil + SIGNAL_SLACK_SECONDS
		local scheduleName = "S" .. index
		local watcher = after ~= nil and after.fact ~= nil
			and (after.scope == context or (requestCount > 0 and not isActor))
		local state: string, anchorAt: number?, scheduledAt: number? = NOT_OBSERVED, nil, nil

		if dueAt >= budgetEnd then
			-- No step starts after the outer observation budget.
			if isServer then publish(scheduleName, "n") end
		else
			if watcher then
				local result, sightedAt, gapMs, preexisting = watch(after.fact, lookUntil, step.holdMs / 1000)
				record.pollIntervalMs = math.round(gapMs * 1000) / 1000
				if preexisting then record.anchorPreexisting = true end
				state, anchorAt = result, sightedAt
				scheduledAt = if sightedAt ~= nil then factSchedule(step, sightedAt) else nil
				if after.scope == context then
					if isServer then
						publish(scheduleName, encodeSchedule(state, anchorAt, scheduledAt))
					else
						signalEvent:FireServer("anchor", index, state, anchorAt)
					end
				end
			end
			if isActor or not watcher then
				local value: any
				if at.startMs ~= nil and not isActor then
					value = encodeSchedule(OBSERVED, start, start + at.startMs / 1000)
				elseif isServer and after ~= nil and after.step ~= nil then
					local doneState, completedAt = decodeDone(waitFor("D" .. stepIndex[after.step], lookUntil))
					value = encodeSchedule(doneState, completedAt, if completedAt then completedAt + offset else nil)
				else
					-- Actions and non-watching contexts take the server schedule.
					value = waitFor(scheduleName, followUntil)
				end
				local followed, followedAnchor, followedSchedule = decodeSchedule(value)
				state, scheduledAt = followed, followedSchedule
				if not watcher then anchorAt = followedAnchor end
			end
			if isServer and published[scheduleName] == nil then
				if at.startMs ~= nil or (after ~= nil and after.step ~= nil) then
					publish(scheduleName, encodeSchedule(state, anchorAt, scheduledAt))
				elseif waitFor(scheduleName, followUntil) == nil then
					publish(scheduleName, "a")
				end
			end
		end
		if isServer then
			local decided = decodeSchedule(published[scheduleName])
			if action.kind == "wait" or decided ~= OBSERVED then
				publish("D" .. index, doneFromSchedule(published[scheduleName]))
			end
		end

		-- A step starts in [scheduledAt, scheduledAt + horizon], never later.
		if state == OBSERVED then
			local target = scheduledAt :: number
			if target > budgetEnd then
				state = NOT_OBSERVED
			else
				waitUntil(target, io)
				if io.now() > target + horizon then state = NOT_OBSERVED end
			end
		end

		if isActor then
			if state == OBSERVED then
				record.actedAt = io.now()
				io.trace("scenario.action_started", { scenarioId = scenario.id, stepId = step.id,
					context = context, kind = action.kind, at = record.actedAt })
				if action.kind == "disconnect" then
					-- The client leaves Play, so it reports completion first.
					signalEvent:FireServer("done", index, OBSERVED, io.now())
				end
				local succeeded, outcome = pcall(function()
					if action.kind == "move_to" then
						return io.moveCharacter(action.targetPath)
					elseif action.kind == "place_on_part" then
						return io.placeOnPart(action.targetPath)
					elseif action.kind == "place_relative_to_part" then
						return io.placeRelativeToPart(action.targetPath, action.offsetStuds)
					elseif action.kind == "move_relative_to_part" then
						return io.moveRelativeToPart(action.targetPath, action.offsetStuds)
					elseif action.kind == "probe_barrier" then
						return io.probeBarrier(action.barrierPath)
					elseif action.kind == "press_key" then
						return io.pressKey(action.key)
					elseif action.kind == "hold_key" then
						assert(io.holdKey ~= nil, "Held input capability is unavailable")
						return io.holdKey(action.key, action.durationMs)
					elseif action.kind == "gui_activate" then
						assert(io.activateGui ~= nil, "GUI activation capability is unavailable")
						return io.activateGui(action.path)
					elseif action.kind == "gui_text_entry" then
						assert(io.enterText ~= nil, "Text entry capability is unavailable")
						return io.enterText(action.path, action.text)
					elseif action.kind == "fire_remote" then
						return io.fireRemote(action.path, argumentValues(action.arguments, actors))
					elseif action.kind == "disconnect" then
						io.trace("scenario.disconnecting", { scenarioId = scenario.id, stepId = step.id, actor = context })
						io.disconnect()
						return true
					end
					error("Unknown scenario action")
				end)
				local completed = succeeded and (if action.kind == "probe_barrier" then type(outcome) == "table" else outcome == true)
				-- Lua omits nil-valued table fields during JSON encoding. The report
				-- contract therefore omits action unless this context performed it.
				record.action = { kind = action.kind, succeeded = completed,
					probe = if completed and action.kind == "probe_barrier" then outcome else nil }
				io.trace("scenario.action", { scenarioId = scenario.id, stepId = step.id,
					context = context, kind = action.kind, succeeded = completed,
					at = io.now(), error = if succeeded then "" else tostring(outcome) })
				if action.kind ~= "disconnect" then signalEvent:FireServer("done", index, OBSERVED, io.now()) end
			else
				signalEvent:FireServer("done", index, state)
			end
		end

		if state == OBSERVED and requestCount > 0 then
			-- Observations run in the background, so they never delay later steps.
			record.capturedAt = io.now()
			pendingBatches += 1
			local capture = record
			io.spawn(function()
				local ok, result = pcall(ObservationBatch.collect, step.observations, context, actors, io)
				if ok then capture.observations = result else batchFailure = tostring(result) end
				pendingBatches -= 1
			end)
		end
		record.outcome = state
		if anchorAt ~= nil then record.anchorObservedAt = anchorAt end
		if scheduledAt ~= nil then record.scheduledAt = scheduledAt end
		io.trace("scenario.step", { scenarioId = scenario.id, context = context, stepId = step.id,
			outcome = state, dueAt = dueAt, anchorObservedAt = anchorAt, scheduledAt = scheduledAt,
			actedAt = record.actedAt, capturedAt = record.capturedAt, pollIntervalMs = record.pollIntervalMs })
		table.insert(reportSteps, record)
	end

	while pendingBatches > 0 do
		assert(io.active(), "Scenario was cancelled")
		io.wait(0.05)
	end
	observing = false
	for _, connection in connections do connection:Disconnect() end
	if batchFailure ~= nil then error(batchFailure) end
	io.trace("scenario.steps_completed", { scenarioId = scenario.id, context = context,
		elapsedMs = math.floor((io.now() - start) * 1000) })

	if not shouldReport then return end
	local receipt = io.post({
		schema = "basalt-evals/scenario-report",
		sessionId = session.sessionId,
		scenarioId = scenario.id,
		report = { context = context, startAt = start, actors = actorIdentities, steps = reportSteps },
	})
	assert(type(receipt) == "table" and receipt.accepted == true, "Scenario report was not accepted")
	io.trace("scenario.reported", { scenarioId = scenario.id, context = context, complete = receipt.complete == true })
	if not isServer then return end
	-- Clients can still finish anchored steps and background observations after the
	-- server. Wait for them through the budget, the signal slack and the longest window.
	local tail = math.max(0, budgetEnd - io.now()) + SIGNAL_SLACK_SECONDS + longestWindowSeconds(scenario) + 30
	local deadline = os.clock() + tail
	while true do
		local status = io.status()
		if type(status) == "table" and status.complete == true then
			assert(type(status.runtimeHash) == "string" and #status.runtimeHash == 64, "Invalid scenario completion hash")
			if listener then listener:Disconnect() end
			io.trace("scenario.completed", { scenarioId = scenario.id, runtimeHash = status.runtimeHash })
			io.endTest({ basaltScenarioId = scenario.id, runtimeHash = status.runtimeHash })
			return
		end
		if os.clock() >= deadline then error("Scenario reports did not complete within the scenario budget") end
		io.wait(0.1)
	end
end

return table.freeze(ScenarioRunner)
