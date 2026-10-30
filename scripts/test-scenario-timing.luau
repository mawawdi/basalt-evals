-- Exercise the actual scenario runner without Studio or a model. A discrete-event
-- simulation runs the server and each client as coroutines on one virtual clock.
-- Published attributes and client signals arrive after a per-client lag.
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local batch = require("../plugin/src/ObservationBatch")
local source = fs.readFile("plugin/src/ScenarioRunner.luau")
local FRAME = 1 / 60
local HASH = string.rep("a", 64)

local function near(actual: number?, expected: number, tolerance: number, label: string)
	assert(actual ~= nil, label .. ": value is absent")
	assert(math.abs((actual :: number) - expected) <= tolerance,
		string.format("%s: %.4f is not within %.4f of %.4f", label, actual :: number, tolerance, expected))
end

local function simulation()
	local sim = { now = 0, queue = {}, order = 0 }
	function sim.at(time: number, callback: () -> ())
		sim.order += 1
		table.insert(sim.queue, { time = time, order = sim.order, thread = coroutine.create(callback) })
	end
	function sim.wait(seconds: number)
		coroutine.yield(sim.now + math.max(seconds, FRAME))
	end
	function sim.run(limit: number)
		while #sim.queue > 0 do
			table.sort(sim.queue, function(left, right)
				return if left.time == right.time then left.order < right.order else left.time < right.time
			end)
			local item = table.remove(sim.queue, 1)
			sim.now = math.max(sim.now, item.time)
			assert(sim.now <= limit, "Simulation exceeded its time limit")
			local ok, wake = coroutine.resume(item.thread)
			if not ok then error(wake) end
			if coroutine.status(item.thread) == "suspended" then
				sim.order += 1
				table.insert(sim.queue, { time = wake, order = sim.order, thread = item.thread })
			end
		end
	end
	return sim
end

local function playerMock(userId: number, name: string)
	local root = { Position = { X = 0, Y = 0, Z = 0 }, IsA = function(_, className) return className == "BasePart" end }
	local character = {
		IsDescendantOf = function() return true end,
		FindFirstChildOfClass = function() return { Health = 100 } end,
		FindFirstChild = function(_, name) return if name == "HumanoidRootPart" then root else nil end,
	}
	return { UserId = userId, Name = name, Character = character }
end

-- A shared Studio world: the server marker, its attribute history and remote events.
local function world(actors: { string }, lags: { [string]: number })
	local w = { sim = simulation(), lags = lags, history = {}, events = {}, marker = nil, markerAt = math.huge,
		players = {}, playerOf = {}, reports = {}, traces = {}, captures = {}, actions = {}, facts = {},
		results = {}, ended = nil, expectedReports = 0, views = {}, viewFailures = {} }
	for index, actor in actors do
		local player = playerMock(index, actor)
		table.insert(w.players, player)
		w.playerOf[actor] = player
	end
	function w.lag(context: string): number return if context == "server" then 0 else w.lags[context] end
	function w.environment(context: string)
		local player = w.playerOf[context]
		local lag = w.lag(context)
		local players = { LocalPlayer = player, GetPlayers = function() return table.clone(w.players) end }
		local view = {
			GetAttribute = function(_, name)
				local latest = nil
				for _, entry in w.history do
					if entry.name == name and entry.at + lag <= w.sim.now then latest = entry.value end
				end
				return latest
			end,
			FindFirstChild = function(_, name)
				for _, event in w.events do
					if event.Name == name and event.Parent == w.marker then
						return { IsA = function(_, className) return className == "RemoteEvent" end,
							FireServer = function(_, ...)
								local arguments = table.pack(...)
								w.sim.at(w.sim.now + lag, function()
									for _, callback in event.callbacks do
										callback(player, table.unpack(arguments, 1, arguments.n))
									end
								end)
							end }
					end
				end
				return nil
			end,
		}
		local replicated = { FindFirstChild = function(_, name)
			local marker = w.marker
			if marker == nil or marker.Name ~= name then return nil end
			if context == "server" then return if marker.Parent ~= nil then marker else nil end
			return if w.markerAt + lag <= w.sim.now then view else nil
		end }
		return {
			game = { GetService = function(_, name)
				if name == "Players" then return players end
				assert(name == "ReplicatedStorage")
				return replicated
			end },
			Instance = { new = function(className)
				assert(context == "server", "Only the server creates the runtime marker")
				if className == "RemoteEvent" then
					local event = { callbacks = {} }
					event.OnServerEvent = { Connect = function(_, callback)
						table.insert(event.callbacks, callback)
						return { Disconnect = function() end }
					end }
					table.insert(w.events, event)
					return event
				end
				assert(className == "Folder")
				local marker = {}
				marker.SetAttribute = function(_, name, value)
					table.insert(w.history, { name = name, value = value, at = w.sim.now })
				end
				marker.GetAttribute = function(_, name)
					local latest = nil
					for _, entry in w.history do if entry.name == name then latest = entry.value end end
					return latest
				end
				w.marker = setmetatable(marker, { __newindex = function(target, key, value)
					rawset(target, key, value)
					if key == "Parent" then w.markerAt = w.sim.now end
				end })
				return w.marker
			end },
			os = { clock = function() return w.sim.now end },
			script = { Parent = { Collector = "Collector", ObservationBatch = "ObservationBatch" } },
			require = function(name) return if name == "ObservationBatch" then batch else {} end,
			workspace = {},
		}
	end
	function w.io(context: string)
		local function act(kind: string)
			table.insert(w.actions, { context = context, kind = kind, at = w.sim.now })
			local effect = w.effects[kind .. ":" .. context]
			if effect then effect(w.sim.now) end
			return true
		end
		return {
			active = function() return true end,
			sequenceReady = function() return true end,
			now = function() return w.sim.now end,
			wait = w.sim.wait,
			spawn = function(callback) w.sim.at(w.sim.now, callback) end,
			collect = function(fact)
				table.insert(w.captures, { context = context, factId = fact.id, at = w.sim.now })
				return { factId = fact.id, kind = fact.kind }
			end,
			anchor = function(fact)
				local evaluate = w.facts[fact.kind .. ":" .. (fact.path or fact.actor)]
				assert(evaluate ~= nil, "Unexpected anchor " .. fact.kind)
				return evaluate(context, w.sim.now)
			end,
			moveCharacter = function() return act("move_to") end,
			pressKey = function() return act("press_key") end,
			fireRemote = function() return act("fire_remote") end,
			placeOnPart = function() return act("place_on_part") end,
			placeRelativeToPart = function() return act("place_relative_to_part") end,
			moveRelativeToPart = function() return act("move_relative_to_part") end,
			probeBarrier = function() return act("probe_barrier") end,
			disconnect = function() act("disconnect") end,
			post = function(body)
				w.reports[context] = body.report
				local count = 0
				for _ in w.reports do count += 1 end
				return { accepted = true, complete = count == w.expectedReports }
			end,
			status = function()
				local count = 0
				for _ in w.reports do count += 1 end
				return { complete = count == w.expectedReports, runtimeHash = HASH }
			end,
			endTest = function(value) w.ended = value end,
			trace = function(stage, data)
				table.insert(w.traces, { context = context, stage = stage, data = data, at = w.sim.now })
			end,
			configureView = function()
				assert(context ~= "server", "The Play server never sets a viewport")
				for _, entry in w.traces do
					assert(entry.context ~= context or entry.stage ~= "scenario.context_ready",
						"A client sets its viewport before it reports ready")
				end
				local failure = w.viewFailures[context]
				if failure then error(failure, 0) end
				w.views[context] = (w.views[context] or 0) + 1
			end,
		}
	end
	function w.run(session, scenario, contexts: { string }, limit: number)
		w.expectedReports = #scenario.reportContexts
		for _, context in contexts do
			local runner = luau.load(source, { environment = w.environment(context) })()
			w.sim.at(0, function()
				w.results[context] = table.pack(pcall(runner.run, session, scenario, context, context == "server", w.io(context)))
			end)
		end
		w.sim.run(limit)
		for _, context in contexts do
			local result = w.results[context]
			assert(result ~= nil, context .. " did not finish")
			assert(result[1], context .. " failed: " .. tostring(result[2]))
		end
	end
	return w
end

local function step(id: string, at: any, horizonMs: number, holdMs: number, action: any, observations: { any }?)
	return { id = id, at = at, horizonMs = horizonMs, holdMs = holdMs, action = action,
		observations = observations or {} }
end
local function observe(context: string, id: string)
	return { context = context, fact = { id = id, kind = "part_physics", path = "game.Workspace.Door" } }
end
local function record(report, stepId: string)
	for _, entry in report.steps do if entry.stepId == stepId then return entry end end
	error("Report has no step " .. stepId)
end
local function factAnchor(fact, scope: string, offsetMs: number?)
	return { after = { fact = fact, scope = scope }, offsetMs = offsetMs or 0 }
end
local DOOR_OPEN = { kind = "part_can_collide", path = "game.Workspace.Door", value = false }

-- One client: arrival, a delayed effect, an expired horizon and a failed acquisition.
local function singleClient(doorDelay: number)
	local w = world({ "primary" }, { primary = 0.03 })
	local moveAt, doorAt = nil, nil
	w.effects = {
		["move_to:primary"] = function(now) moveAt = now end,
		["press_key:primary"] = function(now) doorAt = now + doorDelay end,
	}
	w.facts = {
		-- The own character is local; the server door replicates to the client after its lag.
		["character_on_part:role.lever"] = function(_, now) return moveAt ~= nil and now >= moveAt + 1.2 end,
		["part_can_collide:game.Workspace.Door"] = function(context, now)
			return doorAt ~= nil and now - w.lag(context) >= doorAt
		end,
		["instance_present:game.Workspace.Ghost"] = function() return false end,
		["gui_visible:game.Players.LocalPlayer.PlayerGui.Broken"] = function() error("Anchor binding failed: ambiguous") end,
	}
	local scenario = { id = "door", durationMs = 20000, reportContexts = { "server", "primary" }, steps = {
		step("approach", { startMs = 0 }, 1000, 0, { kind = "move_to", actor = "primary", targetPath = "role.lever" }),
		step("arrived", factAnchor({ kind = "character_on_part", actor = "primary", path = "role.lever" }, "primary"),
			3000, 200, { kind = "wait" }, { observe("primary", "contact") }),
		step("press", { after = { step = "arrived" }, offsetMs = 100 }, 1000, 0,
			{ kind = "press_key", actor = "primary", key = "E" }),
		step("door-open", factAnchor(DOOR_OPEN, "server"), 2000, 0, { kind = "wait" },
			{ observe("server", "door"), observe("primary", "door") }),
		step("never", factAnchor({ kind = "instance_present", path = "game.Workspace.Ghost", present = true }, "server"),
			500, 0, { kind = "wait" }, { observe("server", "ghost") }),
		step("broken", factAnchor({ kind = "gui_visible", path = "game.Players.LocalPlayer.PlayerGui.Broken",
			visible = true }, "primary"), 500, 0, { kind = "wait" }, { observe("primary", "banner") }),
		step("after-broken", { after = { step = "broken" }, offsetMs = 0 }, 500, 0, { kind = "wait" },
			{ observe("server", "late") }),
	} }
	w.run({ sessionId = "timing", plan = { clients = 1, actors = { "primary" } } }, scenario,
		{ "server", "primary" }, 60)
	return w
end

for _, delay in { 0.4, 1.5 } do
	local w = singleClient(delay)
	local server, primary = w.reports.server, w.reports.primary
	local start = server.startAt
	assert(primary.startAt == start, "Every context reports one shared start")
	local presses = 0
	for _, action in w.actions do if action.kind == "press_key" then presses += 1 end end
	assert(presses == 1, "An action is never retried")

	local move = record(primary, "approach")
	near(move.actedAt, start, 2 * FRAME, "The first action starts at its clock anchor")
	local arrived = record(primary, "arrived")
	assert(arrived.outcome == "observed" and arrived.anchorPreexisting == nil)
	near(arrived.anchorObservedAt, (move.actedAt :: number) + 1.2, FRAME + 1e-9,
		"move_to is followed by the observed arrival, not by a guessed delay")
	assert(arrived.pollIntervalMs <= FRAME * 1000 + 0.001, "The poll interval bounds the sighting precision")
	near(arrived.scheduledAt, arrived.anchorObservedAt + 0.2, 1e-5, "A held fact schedules after its hold")
	assert(arrived.capturedAt >= arrived.anchorObservedAt + 0.2 - 1e-9, "A held anchor is confirmed before capture")

	local press = record(primary, "press")
	local serverArrived = record(server, "arrived")
	near(serverArrived.anchorObservedAt, arrived.anchorObservedAt, 1e-5,
		"The server records the scope sighting that it published")
	near(press.scheduledAt, arrived.scheduledAt + 0.1, 1e-5, "after.step schedules from the completion")
	assert(press.actedAt >= press.scheduledAt and press.actedAt <= press.scheduledAt + 1,
		"The actor acts at the server schedule and inside its horizon")
	assert(press.action.kind == "press_key" and press.action.succeeded)
	assert(record(server, "press").action == nil, "Only the actor reports the action receipt")

	local serverDoor, primaryDoor = record(server, "door-open"), record(primary, "door-open")
	local opened = (press.actedAt :: number) + delay
	assert(serverDoor.outcome == "observed" and primaryDoor.outcome == "observed")
	near(serverDoor.anchorObservedAt, opened, FRAME + 1e-9, "The server sees the effect when it occurs")
	near(serverDoor.capturedAt, opened, FRAME + 1e-9,
		"The observation moves with the effect, so a late candidate is observed at the right moment")
	near(primaryDoor.anchorObservedAt - serverDoor.anchorObservedAt, 0.03, FRAME + 1e-9,
		"The client anchors on its own sighting, so replication lag is measured")
	assert(#serverDoor.observations == 1 and #primaryDoor.observations == 1)

	local never = record(server, "never")
	assert(never.outcome == "not_observed_within_horizon" and never.capturedAt == nil
		and #never.observations == 0 and never.anchorObservedAt == nil,
		"Expiry is recorded as not observed and captures nothing")
	assert(record(primary, "never").outcome == "not_observed_within_horizon",
		"A follower takes the published expiry")

	local broken = record(primary, "broken")
	assert(broken.outcome == "acquisition_failed" and #broken.observations == 0,
		"An evaluation error is an acquisition failure, not a candidate failure")
	assert(record(server, "broken").outcome == "acquisition_failed")
	for _, report in { server, primary } do
		assert(record(report, "after-broken").outcome == "acquisition_failed",
			"A step anchored on a failed step cannot be observed")
	end
	assert(w.ended ~= nil and w.ended.runtimeHash == HASH, "The server ends Play after every report")
	assert(w.sim.now < start + 20, "The scenario ends when its steps finish, inside the budget")
end
print("Scenario anchor regression passed: arrival, delayed effects at 0.4 s and 1.5 s, expiry, acquisition failure")

-- The effect occurs after the horizon: inconclusive, never captured at a wrong moment.
do
	local w = singleClient(3)
	for _, report in { w.reports.server, w.reports.primary } do
		local door = record(report, "door-open")
		assert(door.outcome == "not_observed_within_horizon" and door.capturedAt == nil
			and #door.observations == 0)
	end
	print("Scenario horizon regression passed: a late effect is not observed and not captured")
end

-- Two clients. The server schedules actions; each client anchors on its own sighting.
do
	local w = world({ "alpha", "beta" }, { alpha = 0.03, beta = 0.09 })
	local pressAt = nil
	w.effects = { ["press_key:alpha"] = function(now) pressAt = now end }
	w.facts = {
		["part_can_collide:game.Workspace.Door"] = function(context, now)
			return pressAt ~= nil and now - w.lag(context) >= pressAt + 0.4
		end,
		["gui_visible:game.Players.LocalPlayer.PlayerGui.Banner"] = function(context, now)
			assert(context == "alpha", "Only the scope client evaluates its GUI")
			return pressAt ~= nil and now >= pressAt + 0.6
		end,
	}
	local scenario = { id = "pair", durationMs = 20000, reportContexts = { "server", "alpha", "beta" }, steps = {
		step("press", { startMs = 500 }, 1000, 0, { kind = "press_key", actor = "alpha", key = "E" }),
		step("open", factAnchor(DOOR_OPEN, "server"), 3000, 0, { kind = "wait" },
			{ observe("server", "door"), observe("alpha", "door"), observe("beta", "door") }),
		step("banner", factAnchor({ kind = "gui_visible", path = "game.Players.LocalPlayer.PlayerGui.Banner",
			visible = true }, "alpha", 250), 3000, 0, { kind = "press_key", actor = "beta", key = "E" }),
		step("settle", { after = { step = "banner" }, offsetMs = 300 }, 3000, 0, { kind = "wait" },
			{ { context = "server", fact = { id = "players", kind = "player_count" } } }),
	} }
	w.run({ sessionId = "pair", plan = { clients = 2, actors = { "alpha", "beta" } } }, scenario,
		{ "server", "alpha", "beta" }, 60)
	local server, alpha, beta = w.reports.server, w.reports.alpha, w.reports.beta
	local press = record(alpha, "press")
	near(press.actedAt, server.startAt + 0.5, 2 * FRAME, "The clock anchor uses the shared start")
	local open = { server = record(server, "open"), alpha = record(alpha, "open"), beta = record(beta, "open") }
	near(open.server.anchorObservedAt, (press.actedAt :: number) + 0.4, FRAME + 1e-9, "Server fact time")
	near(open.alpha.anchorObservedAt - open.server.anchorObservedAt, 0.03, FRAME + 1e-9, "Alpha replication lag")
	near(open.beta.anchorObservedAt - open.server.anchorObservedAt, 0.09, FRAME + 1e-9, "Beta replication lag")
	for context, entry in open do
		near(entry.capturedAt, entry.anchorObservedAt, FRAME + 1e-9, context .. " captures at its own sighting")
	end
	local sighting = record(alpha, "banner")
	local relayed = record(beta, "banner")
	assert(sighting.action == nil and relayed.action ~= nil, "The actor, not the scope client, performs the action")
	near(record(server, "banner").anchorObservedAt, sighting.anchorObservedAt, 1e-5,
		"The server publishes the sighting of the scope client")
	near(relayed.scheduledAt, sighting.anchorObservedAt + 0.25, 1e-5, "The server schedules the action")
	assert(relayed.actedAt >= relayed.scheduledAt and relayed.actedAt <= relayed.scheduledAt + 2 * FRAME,
		"The actor receives the schedule before its time")
	local settle = record(server, "settle")
	assert(settle.anchorObservedAt > relayed.actedAt, "after.step anchors on the action completion")
	near(settle.scheduledAt, settle.anchorObservedAt + 0.3, 1e-5, "The step offset follows the completion")
	near(settle.capturedAt, settle.scheduledAt, FRAME + 1e-9, "The server captures at the schedule")
	assert(w.views.alpha == 1 and w.views.beta == 1 and w.views.server == nil,
		"Each client sets its viewport one time, and the server never does")
	print("Scenario multi-client regression passed: server schedule, own sightings, measured replication lag")
end

do
	-- A client that cannot set its viewport fails with the reason and never reports ready,
	-- so the server never starts the shared clock.
	local w = world({ "alpha", "beta" }, { alpha = 0.03, beta = 0.09 })
	w.viewFailures.beta = "Device Simulator has no Desktop preset"
	local scenario = { id = "view", durationMs = 5000, reportContexts = { "server" },
		steps = { step("observe", { startMs = 500 }, 1000, 0, { kind = "wait" }) } }
	w.expectedReports = 1
	for _, context in { "server", "alpha", "beta" } do
		local runner = luau.load(source, { environment = w.environment(context) })()
		w.sim.at(0, function()
			w.results[context] = table.pack(pcall(runner.run,
				{ sessionId = "view", plan = { clients = 2, actors = { "alpha", "beta" } } },
				scenario, context, context == "server", w.io(context)))
		end)
	end
	w.sim.run(200)
	assert(not w.results.beta[1] and w.results.beta[2] == "Device Simulator has no Desktop preset",
		"The client failure keeps its reason")
	assert(not w.results.server[1] and string.find(tostring(w.results.server[2]), "within 120 seconds", 1, true),
		"The server does not start without the viewport of each client")
	for _, entry in w.history do assert(entry.name ~= "StartAt", "The shared clock never starts") end
	for _, entry in w.traces do
		assert(entry.context ~= "beta" or entry.stage ~= "scenario.context_ready", "The failed client never reports ready")
	end
	print("Scenario client viewport regression passed: each client before Ready, a failure keeps its reason")
end

local function serverReadiness(mode)
	local now, scheduled, reported, readinessCalls = 0, nil, false, 0
	local events, announced = {}, false
	local runtimeMarker = nil
	local recorderReadyAt = 0.738 -- Recorded first-frame acquisition duration.
	local player = playerMock(1, "Actor")
	local players = { GetPlayers = function() return { player } end }
	local attributes = {}
	local serverRunner = luau.load(source, {
		environment = {
			game = { GetService = function(_, name)
				if name == "Players" then return players end
				assert(name == "ReplicatedStorage")
				return { FindFirstChild = function() return runtimeMarker end }
			end },
			Instance = { new = function(className)
				if className == "RemoteEvent" then
					local event = {}
					event.OnServerEvent = { Connect = function(_, callback)
						event.callback = callback
						return { Disconnect = function() end }
					end }
					table.insert(events, event)
					return event
				end
				assert(className == "Folder")
				runtimeMarker = {
					GetAttribute = function(_, name) return attributes[name] end,
					SetAttribute = function(_, name, value)
						if name == "StartAt" then
							assert(now >= recorderReadyAt, "Client attachment cannot start the clock before a frame is retained")
							scheduled = value
						end
						attributes[name] = value
					end,
				}
				return runtimeMarker
			end },
			os = { clock = function() return now end },
			script = { Parent = { Collector = "Collector", ObservationBatch = "ObservationBatch" } },
			require = function(name) return if name == "ObservationBatch" then batch else {} end,
			workspace = {},
		},
	})()
	local ok, failure = pcall(function()
		serverRunner.run({ sessionId = "timing", plan = { clients = 1, actors = { "primary" } } }, {
			id = "recording",
			durationMs = 1500,
			reportContexts = { "server" },
			steps = { step("observe", { startMs = 500 }, 1000, 0, { kind = "wait" }) },
		}, "server", true, {
			active = function() return mode ~= "stopped" or now < 0.3 end,
			sequenceReady = function()
				readinessCalls += 1
				if mode == "failed" and now >= 0.2 then error("Recorder failed") end
				return mode == "ready" and now >= recorderReadyAt
			end,
			now = function() return now end,
			spawn = function(callback) callback() end,
			anchor = function() error("No anchor fact in this scenario") end,
			wait = function(seconds)
				now += seconds
				local ready = events[1]
				if ready and ready.callback and not announced then
					announced = true
					ready.callback(player)
					assert(scheduled == nil, "The Ready event must not bypass recorder readiness")
				end
			end,
			post = function(report)
				reported = true
				local observed = report.report.steps[1]
				assert(observed.outcome == "observed" and observed.scheduledAt == report.report.startAt + 0.5)
				return { accepted = true, complete = true }
			end,
			status = function() return { complete = true, runtimeHash = HASH } end,
			endTest = function() end,
			trace = function() end,
		})
	end)
	assert(readinessCalls > 0)
	if mode == "ready" then
		assert(ok, tostring(failure))
		assert(scheduled >= recorderReadyAt + 2 and reported)
		assert(now >= scheduled + 0.5, "The server reports after its scheduled step")
	else
		assert(not ok and scheduled == nil and not reported)
		if mode == "timeout" then
			assert(now >= 120 and now < 121 and string.find(tostring(failure), "within 120 seconds"))
		else
			assert(now < 0.5, "Stop or recorder failure must exit the readiness wait promptly")
			assert(string.find(tostring(failure), if mode == "stopped" then "cancelled" else "Recorder failed"))
		end
	end
end
for _, mode in { "ready", "stopped", "failed", "timeout" } do serverReadiness(mode) end

do
	local clock = 0
	local player = playerMock(1, "Actor")
	local marker = { GetAttribute = function() return nil end, FindFirstChild = function(_, name)
		if name == "Ready" then return { IsA = function() return true end, FireServer = function() end } end
		return nil
	end }
	local clientRunner = luau.load(source, {
		environment = {
			game = { GetService = function(_, name)
				if name == "Players" then return { LocalPlayer = player, GetPlayers = function() return { player } end } end
				return { FindFirstChild = function() return marker end }
			end },
			os = { clock = function() return clock end },
			script = { Parent = { Collector = "Collector", ObservationBatch = "ObservationBatch" } },
			require = function(name) return if name == "ObservationBatch" then batch else {} end,
			workspace = {},
		},
	})()
	local clientOk, clientFailure = pcall(function()
		clientRunner.run({ sessionId = "timing", plan = { clients = 1, actors = { "primary" } } }, {
			id = "recording", durationMs = 1500, reportContexts = {}, steps = {},
		}, "primary", false, {
			active = function() return clock < 0.3 end,
			wait = function(seconds) clock += seconds end,
			now = function() return clock end,
			spawn = function() end,
			trace = function() end,
			configureView = function() end,
		} :: any)
	end)
	assert(not clientOk and clock < 0.5 and string.find(tostring(clientFailure), "cancelled"),
		"A client waiting for the shared clock must also exit on Stop")
end
print("Scenario recorder readiness regression passed: pre-roll, Stop, failure, bounded timeout")
return true
