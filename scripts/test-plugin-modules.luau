local validator = require("./load-plan-validator")

local function plan(phases, scenarios)
	return {
		schema = "basalt-evals/studio-plan",
		clients = 1,
		actors = { "primary" },
		roles = {},
		scenarios = scenarios or {},
		phases = phases,
	}
end

local Timestamp = require("../plugin/src/Timestamp")
assert(Timestamp(0) == "1970-01-01T00:00:00.000Z")
assert(Timestamp(7) == "1970-01-01T00:00:00.007Z")
assert(Timestamp(999) == "1970-01-01T00:00:00.999Z")
assert(Timestamp(1000) == "1970-01-01T00:00:01.000Z")
assert(Timestamp(1709251199123) == "2024-02-29T23:59:59.123Z")
assert(Timestamp(1709251200000) == "2024-03-01T00:00:00.000Z")
assert(not pcall(Timestamp, -1))
assert(not pcall(Timestamp, 0.5))
assert(not pcall(Timestamp, math.huge))

local valid, reason = validator.validate(plan({
		{
			id = "observe",
			label = "Observe",
			instruction = "Run the mechanic.", driver = { kind = "manual" },
			facts = { { id = "errors", kind = "diagnostics" } },
			captures = {},
		},
	}
))
assert(valid, reason)

local accepted = validator.validate(plan({
		{
			id = "observe",
			label = "Observe",
			instruction = "Run the mechanic.", driver = { kind = "manual" },
			facts = { { id = "bad", kind = "arbitrary_property", path = "game.Workspace.X" } },
			captures = {},
		},
	}
))
assert(not accepted, "arbitrary fact kinds must fail closed")

local bootstrap = {
	schema = "basalt-evals/studio-bootstrap",
	connectorUrl = "http://127.0.0.1:43123",
	token = string.rep("f", 64),
	treatmentId = "tr-0123456789abcdef0123",
	candidateHash = string.rep("a", 64),
	collectionPlanHash = string.rep("b", 64),
}
local bootstrapAccepted, bootstrapReason = validator.validateBootstrap(bootstrap)
assert(bootstrapAccepted, bootstrapReason)

local externalBootstrap = validator.validateBootstrap({
	schema = "basalt-evals/studio-bootstrap",
	connectorUrl = "https://example.com",
	token = string.rep("f", 64),
	treatmentId = "tr-0123456789abcdef0123",
	candidateHash = string.rep("a", 64),
	collectionPlanHash = string.rep("b", 64),
})
assert(not externalBootstrap, "bootstrap URLs must remain on exact loopback")

local wrongBootstrap = table.clone(bootstrap)
wrongBootstrap.schema = "basalt-evals/unknown-bootstrap"
assert(not validator.validateBootstrap(wrongBootstrap), "An unknown bootstrap format is rejected")
assert(require("./test-play-relay"))
assert(require("./test-capture-environment"))
assert(require("./test-collector"))
assert(require("./test-scene-text"))
assert(require("./test-gui-layout"))
assert(require("./test-scenario-timing"))
assert(require("./test-anchor-fact"))
assert(require("./test-relative-placement"))
assert(require("./test-gui-input"))

local sessionAccepted, sessionReason = validator.validateSession({
	sessionId = "studio-0123456789abcdef0123",
	treatmentId = "tr-0123456789abcdef0123",
	candidateHash = string.rep("a", 64),
	collectionPlanHash = string.rep("b", 64),
	connectorUrl = "http://127.0.0.1:43123",
	expectedStudioVersion = "test",
	plan = plan({
			{
				id = "observe",
				label = "Observe",
				instruction = "Run the mechanic.", driver = { kind = "manual" },
				facts = {},
				captures = {},
			},
		}
	),
})
assert(sessionAccepted, sessionReason)

local unknownSessionField = validator.validateSession({
	sessionId = "studio-0123456789abcdef0123",
	treatmentId = "tr-0123456789abcdef0123",
	candidateHash = string.rep("a", 64),
	collectionPlanHash = string.rep("b", 64),
	connectorUrl = "http://127.0.0.1:43123",
	expectedStudioVersion = "test",
	plan = plan({
			{
				id = "observe",
				label = "Observe",
				instruction = "Run the mechanic.", driver = { kind = "manual" },
				facts = {},
				captures = {},
			},
		}
	),
	extra = true,
})
assert(not unknownSessionField, "unknown session fields must fail closed")

local oversizedPhaseId = validator.validate(plan({
		{
			id = string.rep("a", 129),
			label = "Observe",
			instruction = "Run the mechanic.", driver = { kind = "manual" },
			facts = {},
			captures = {},
		},
	}
))
assert(not oversizedPhaseId, "oversized identifiers must fail closed")

local oversizedCapture = validator.validate(plan({{ id = "observe", label = "Observe", instruction = "Capture.", driver = { kind = "manual" }, facts = {},
		captures = {{ id = "wide", instruction = "Capture.", uiViewport = { width = 1280, height = 720 }, viewport = { width = 8192, height = 8192 } }},
	}}))
assert(not oversizedCapture, "plans must respect the decoder's pixel bound")

local CaptureState = require("../plugin/src/CaptureState")
local state = CaptureState.new()
assert(CaptureState.setPlaying(state, true, "first-start"))
local firstGeneration = state.generation
assert(CaptureState.record(state, firstGeneration, "before", {}, {}))
assert(not CaptureState.setPlaying(state, true, "paused-or-resumed"), "Pause must retain the attempt")
assert(state.phaseIndex == 2 and state.startedAt == "first-start")
assert(CaptureState.setPlaying(state, false, "stop"))
assert(not CaptureState.record(state, firstGeneration, "stale", {}, {}), "Stop must invalidate a yielding capture")
assert(CaptureState.setPlaying(state, true, "second-start"))
assert(state.phaseIndex == 1 and #state.captured == 0 and state.startedAt == "second-start", "F5 must start fresh")
assert(not CaptureState.record(state, firstGeneration, "stale", {}, {}), "A late capture must not enter the new attempt")
assert(not pcall(CaptureState.seal, state, "session", "test", 2, "end"), "Incomplete attempts cannot submit")
assert(CaptureState.record(state, state.generation, "before", {}, {}))
assert(CaptureState.record(state, state.generation, "peak", {}, {}))
local submission = CaptureState.seal(state, "session", "test", 2, "first-send")
assert(CaptureState.seal(state, "session", "test", 2, "retry") == submission, "Retry must reuse the exact payload")
assert(submission.endedAt == "first-send")
assert(not CaptureState.record(state, state.generation, "extra", {}, {}), "Submitted observations are sealed")
CaptureState.setPlaying(state, false, "stop")
assert(CaptureState.seal(state, "session", "test", 2, "retry-after-stop") == submission)
CaptureState.setPlaying(state, true, "third-start")
assert(state.submission == submission, "Starting Play must not replace an uncertain submission")
local pendingGeneration = state.generation
CaptureState.reset(state)
assert(state.submission == nil and state.phaseIndex == 1 and not state.playing)
assert(not CaptureState.record(state, pendingGeneration, "old-place", {}, {}), "Changing place invalidates collectors")

local PhaseCapture = require("../plugin/src/PhaseCapture")
local phase = {
	id = "held", label = "Held", instruction = "Capture held phase.",
	driver = { kind = "gui_button", path = "game.Players.LocalPlayer.PlayerGui.Controls.Hold",
		readyFactId = "marker", readyValue = "held", timeoutMs = 1000 },
	facts = {{ id = "marker", kind = "replication_probe", path = "game.Workspace.State", attribute = "Phase" }},
	captures = {{ id = "frame", instruction = "Capture." }},
}
assert(validator.validate(plan({ phase })))
assert(not validator.validate({ schema = "basalt-evals/unknown-plan", phases = { phase } }))
local capture = phase.captures[1]
capture.viewport = { width = 1280, height = 720 }
assert(not validator.validate(plan({ phase })), "Plans reject unknown geometry fields")
capture.viewport = nil
local invalidDriver = table.clone(phase)
invalidDriver.driver = table.clone(phase.driver)
invalidDriver.driver.readyFactId = "undeclared"
assert(not validator.validate(plan({ invalidDriver })))

local movementPhase = table.clone(phase)
movementPhase.driver = { kind = "character_move_to", targetPath = "game.Workspace.CheckpointA",
	readyFactId = "marker", readyValue = "held", timeoutMs = 1000 }
assert(validator.validate(plan({ movementPhase })))
local invalidMovement = table.clone(movementPhase)
invalidMovement.driver = table.clone(movementPhase.driver)
invalidMovement.driver.speed = 1000
assert(not validator.validate(plan({ invalidMovement })))
local contactPhase = table.clone(phase)
contactPhase.driver = { kind = "character_reach_part", targetPath = "game.Workspace.CheckpointA", timeoutMs = 1000 }
contactPhase.facts = {}
assert(validator.validate(plan({ contactPhase })), "Part contact can drive a capture without candidate state")
local invalidContact = table.clone(contactPhase)
invalidContact.driver = table.clone(contactPhase.driver)
invalidContact.driver.callback = "return true"
assert(not validator.validate(plan({ invalidContact })))
local scenePresencePhase = table.clone(phase)
scenePresencePhase.facts = {{ id = "checkpoint-present", kind = "instance", path = "game.Workspace.CheckpointA" }}
scenePresencePhase.driver = { kind = "wait_for_exists", readyFactId = "checkpoint-present", timeoutMs = 1000 }
assert(validator.validate(plan({ scenePresencePhase })), "A supplied scene instance can drive presence")
local namedInstancePhase = table.clone(phase)
namedInstancePhase.facts = {{ id = "actual-name", kind = "instance_name", path = "game.Workspace.CheckpointA" }}
namedInstancePhase.driver = { kind = "wait_for_session", timeoutMs = 1000 }
assert(validator.validate(plan({ namedInstancePhase })), "Fixed plans can observe an instance's actual name")
local valuePhase = table.clone(namedInstancePhase)
valuePhase.facts = {{ id = "wins", kind = "instance_value", path = "game.Players.LocalPlayer.leaderstats.Wins" }}
assert(validator.validate(plan({ valuePhase })), "Fixed plans can observe the Value of a ValueBase")
valuePhase.facts = {{ id = "wins", kind = "instance_value", path = "game.Players.LocalPlayer.leaderstats.Wins",
	property = "MaxValue" }}
assert(not validator.validate(plan({ valuePhase })), "An instance value observation names no property")
invalidDriver.driver = table.clone(phase.driver)
invalidDriver.driver.callback = "return true"
assert(not validator.validate(plan({ invalidDriver })))

local scenario = {
	id = "pass",
	label = "Pass",
	durationMs = 3000,
	reportContexts = { "server", "primary" },
	steps = {
		{ id = "move", at = { startMs = 500 }, horizonMs = 1000, holdMs = 0,
			action = { kind = "move_to", actor = "primary", targetPath = "game.Workspace.Marker" },
			observations = {} },
		{ id = "inspect", at = { after = { fact = { kind = "character_on_part", actor = "primary",
			path = "game.Workspace.Marker" }, scope = "primary" }, offsetMs = 0 }, horizonMs = 2000, holdMs = 100,
			action = { kind = "wait" }, observations = {
			{ context = "server", fact = { id = "health", kind = "actor_health", actor = "primary" } },
			{ context = "primary", fact = { id = "players", kind = "player_count" } },
		} },
	},
}
assert(validator.validate(plan({ phase }, { scenario })))
local valueScenario = table.clone(scenario)
valueScenario.steps = table.clone(scenario.steps)
valueScenario.steps[2] = table.clone(scenario.steps[2])
valueScenario.steps[2].observations = {{ context = "primary", fact = { id = "wins", kind = "instance_value",
	path = "game.Players.LocalPlayer.leaderstats.Wins" } }}
assert(validator.validate(plan({ phase }, { valueScenario })), "An actor client can observe the Value of its leaderstats")
local function deepClone(value: any): any
	if type(value) ~= "table" then return value end
	local copy = {}
	for key, item in value do copy[key] = deepClone(item) end
	return copy
end
local function timingVariant(index: number, change: (any) -> ()): boolean
	local variant = deepClone(scenario)
	change(variant.steps[index])
	return (validator.validate(plan({ phase }, { variant })))
end
assert(timingVariant(2, function(step) step.at = { after = { step = "move" }, offsetMs = 250 }; step.holdMs = 0 end),
	"A step can anchor on the completion of an earlier step")
assert(not timingVariant(2, function(step) step.at = { after = { step = "inspect" }, offsetMs = 0 }; step.holdMs = 0 end),
	"A step cannot anchor on itself or a later step")
assert(not timingVariant(1, function(step) step.atMs = 500 end), "A step rejects the atMs field")
assert(not timingVariant(1, function(step) step.horizonMs = 60001 end), "A horizon is at most 60 seconds")
assert(not timingVariant(1, function(step) step.holdMs = 10 end), "A hold applies only to a fact anchor")
assert(not timingVariant(2, function(step) step.holdMs = 2000 end), "A hold is shorter than its horizon")
assert(not timingVariant(2, function(step) step.at.after = { fact = { kind = "replication_probe",
	path = "game.Workspace.Marker", attribute = "Ready" }, scope = "server" } end),
	"A candidate attribute cannot be an anchor")
assert(not timingVariant(2, function(step) step.at.after = { fact = step.at.after.fact, scope = "other" } end),
	"An anchor scope must report")
assert(timingVariant(2, function(step) step.at.after = { fact = { kind = "humanoid_state", actor = "primary",
	state = "Landed" }, scope = "primary" } end), "Humanoid state is a fixed anchor")
assert(not timingVariant(2, function(step) step.at.after = { fact = { kind = "humanoid_state", actor = "primary",
	state = "Teleported" }, scope = "primary" } end), "Humanoid states come from the fixed list")
assert(not timingVariant(2, function(step) step.at.after = { fact = { kind = "gui_visible",
	path = "game.Players.LocalPlayer.PlayerGui.Banner", visible = true }, scope = "server" } end),
	"A GUI anchor needs a client scope")
assert(not timingVariant(2, function(step) step.at.after = { fact = { kind = "gui_visible",
	path = "game.Players.LocalPlayer.PlayerGui.Banner", visible = true }, scope = "primary" } end),
	"A GUI anchor cannot anchor the observations of another context")
assert(timingVariant(2, function(step) step.requirement = { withinMs = 1500, quote = "opens within 1.5 seconds" } end),
	"A human requirement can bound a fact anchor")
assert(not timingVariant(2, function(step) step.requirement = { withinMs = 2500, quote = "within 2.5 seconds" } end),
	"A requirement cannot exceed the horizon")
assert(not timingVariant(1, function(step) step.requirement = { withinMs = 500, quote = "within 500 ms" } end),
	"A requirement needs a fact anchor and a previous step")
local placedScenario = table.clone(scenario)
placedScenario.steps = table.clone(scenario.steps)
placedScenario.steps[1] = table.clone(scenario.steps[1])
placedScenario.steps[1].action = { kind = "place_on_part", actor = "primary",
	targetPath = "game.Workspace.Platform" }
assert(validator.validate(plan({ phase }, { placedScenario })), "Actor placement is a fixed test action")
placedScenario.steps[1].action.callback = "return true"
assert(not validator.validate(plan({ phase }, { placedScenario })), "Actor placement rejects callbacks")
local pairedScenario = table.clone(scenario)
pairedScenario.steps = table.clone(scenario.steps)
pairedScenario.steps[2] = table.clone(scenario.steps[2])
pairedScenario.steps[2].observations = table.clone(scenario.steps[2].observations)
table.insert(pairedScenario.steps[2].observations,
	{ context = "server", fact = { id = "carry", kind = "actor_part_motion", actor = "primary",
		path = "game.Workspace.Platform", sampleCount = 2, intervalMs = 250 } })
assert(validator.validate(plan({ phase }, { pairedScenario })))
local supportScenario = table.clone(pairedScenario)
supportScenario.steps = table.clone(pairedScenario.steps)
supportScenario.steps[2] = table.clone(pairedScenario.steps[2])
supportScenario.steps[2].observations = table.clone(pairedScenario.steps[2].observations)
table.insert(supportScenario.steps[2].observations,
	{ context = "primary", fact = { id = "support", kind = "actor_part_support", actor = "primary",
		path = "game.Workspace.Platform" } })
assert(validator.validate(plan({ phase }, { supportScenario })), "Support probes bind a scenario actor")
local physicsScenario = table.clone(pairedScenario)
physicsScenario.steps = table.clone(pairedScenario.steps)
physicsScenario.steps[2] = table.clone(pairedScenario.steps[2])
physicsScenario.steps[2].observations = table.clone(pairedScenario.steps[2].observations)
table.insert(physicsScenario.steps[2].observations,
	{ context = "server", fact = { id = "anchoring", kind = "part_physics_trace",
		path = "game.Workspace.Platform", durationMs = 1200 } })
assert(validator.validate(plan({ phase }, { physicsScenario })), "Event-based physics fits its scenario window")
physicsScenario.steps[2].observations[4].fact.durationMs = 3001
assert(not validator.validate(plan({ phase }, { physicsScenario })), "Physics watch cannot exceed the scenario budget")
local routeScenario = table.clone(pairedScenario)
routeScenario.steps = table.clone(pairedScenario.steps)
routeScenario.steps[2] = table.clone(pairedScenario.steps[2])
routeScenario.steps[2].observations = table.clone(pairedScenario.steps[2].observations)
table.insert(routeScenario.steps[2].observations, { context = "server", fact = {
	id = "route", kind = "part_route_trace", path = "game.Workspace.Platform",
	startPath = "game.Workspace.StartMarker", endPath = "game.Workspace.EndMarker",
	durationMs = 1000, proximityStuds = 2 } })
assert(validator.validate(plan({ phase }, { routeScenario })), "Frame-level route trace is fixed plan data")
routeScenario.steps[2].observations[4].fact.proximityStuds = 0
assert(not validator.validate(plan({ phase }, { routeScenario })), "Route observation radius must be bounded")
local function observationVariant(observation: any, roles: { any }?): boolean
	local variant = deepClone(scenario)
	variant.steps[2].holdMs = 0
	variant.steps[2].at = { after = { step = "move" }, offsetMs = 0 }
	variant.steps[2].observations = { observation }
	local value = plan({ phase }, { variant })
	value.roles = roles or {}
	return (validator.validate(value))
end
local performance = { id = "load", kind = "performance_trace", sampleCount = 12, intervalMs = 250 }
assert(observationVariant({ context = "server", fact = performance }), "The server can trace performance")
assert(not observationVariant({ context = "primary", fact = performance }), "A performance trace is server only")
assert(not observationVariant({ context = "server", fact = { id = "load", kind = "performance_trace",
	sampleCount = 12, intervalMs = 249 } }), "A performance interval is at least 250 ms")
assert(not observationVariant({ context = "server", fact = { id = "load", kind = "performance_trace",
	sampleCount = 13, intervalMs = 250 } }), "Every performance interval fits the scenario budget")
assert(not observationVariant({ context = "server", fact = { id = "load", kind = "performance_trace",
	sampleCount = 2, intervalMs = 250, path = "game.Workspace.Marker" } }), "A performance trace reads no path")
local performancePhase = table.clone(phase)
performancePhase.facts = { performance }
performancePhase.driver = { kind = "wait_for_session", timeoutMs = 1000 }
assert(not validator.validate(plan({ performancePhase })), "A performance trace is scenario-only")
local hudRole = { id = "hud", className = "ScreenGui", scope = "local_player_gui", cardinality = "exactly_one" }
local layout = { id = "layout", kind = "gui_layout", path = "role.hud" }
assert(observationVariant({ context = "primary", fact = layout }, { hudRole }), "A client can record a GUI layout")
assert(not observationVariant({ context = "server", fact = layout }, { hudRole }), "The server has no GUI layout")
assert(observationVariant({ context = "primary", fact = { id = "layout", kind = "gui_layout",
	path = "game.Players.LocalPlayer.PlayerGui.Hud" } }), "A literal PlayerGui path names a ScreenGui")
assert(not observationVariant({ context = "primary", fact = { id = "layout", kind = "gui_layout",
	path = "game.Workspace.Marker" } }), "A GUI layout reads only the local PlayerGui")
local frameRole = { id = "hud", className = "GuiObject", scope = "local_player_gui", cardinality = "exactly_one" }
assert(not observationVariant({ context = "primary", fact = layout }, { frameRole }), "A GUI layout role is a ScreenGui")
local workspaceScreen = table.clone(hudRole)
workspaceScreen.scope = "workspace"
assert(not observationVariant({ context = "server", fact = { id = "health", kind = "actor_health", actor = "primary" } },
	{ workspaceScreen }), "A ScreenGui role needs the local_player_gui scope")
local layoutPhase = table.clone(phase)
layoutPhase.facts = { layout }
layoutPhase.driver = { kind = "wait_for_session", timeoutMs = 1000 }
local layoutPlan = plan({ layoutPhase })
layoutPlan.roles = { hudRole }
assert(validator.validate(layoutPlan), "A presentation phase can record a GUI layout")
assert(observationVariant({ context = "primary", fact = { id = "health", kind = "actor_health", actor = "primary" } },
	{ hudRole }), "A ScreenGui role is a valid declaration")
local screenAnchor = deepClone(scenario)
screenAnchor.steps[2].at.after = { fact = { kind = "gui_visible", path = "role.hud", visible = true }, scope = "primary" }
screenAnchor.steps[2].observations = {}
local screenAnchorPlan = plan({ phase }, { screenAnchor })
screenAnchorPlan.roles = { hudRole }
assert(not validator.validate(screenAnchorPlan), "A gui_visible anchor reads a GuiObject, not a ScreenGui")
screenAnchorPlan.roles = { frameRole }
assert(validator.validate(screenAnchorPlan), "A gui_visible anchor accepts a GuiObject role")
local longScenario = table.clone(pairedScenario)
longScenario.durationMs = 125000
longScenario.steps = table.clone(pairedScenario.steps)
longScenario.steps[2] = table.clone(pairedScenario.steps[2])
longScenario.steps[2].observations = table.clone(pairedScenario.steps[2].observations)
longScenario.steps[2].observations[3] = table.clone(pairedScenario.steps[2].observations[3])
longScenario.steps[2].observations[3].fact = table.clone(pairedScenario.steps[2].observations[3].fact)
longScenario.steps[2].observations[3].fact.sampleCount = 240
longScenario.steps[2].observations[3].fact.intervalMs = 500
assert(validator.validate(plan({ phase }, { longScenario })), "Long route evidence must fit its declared window")
longScenario.durationMs = 1800001
assert(not validator.validate(plan({ phase }, { longScenario })), "Scenario work remains bounded")
local invalidPairedPhase = table.clone(phase)
invalidPairedPhase.facts = table.clone(phase.facts)
table.insert(invalidPairedPhase.facts, { id = "carry", kind = "actor_part_motion", actor = "primary",
	path = "game.Workspace.Platform", sampleCount = 2, intervalMs = 250 })
assert(not validator.validate(plan({ invalidPairedPhase }, { scenario })),
	"Phase facts cannot bind a scenario actor")
local invalidScenario = table.clone(scenario)
invalidScenario.steps = table.clone(scenario.steps)
invalidScenario.steps[1] = table.clone(scenario.steps[1])
invalidScenario.steps[1].action = { kind = "move_to", actor = "other", targetPath = "game.Workspace.Marker" }
assert(not validator.validate(plan({ phase }, { invalidScenario })), "Scenario actions bind to declared actors")
invalidScenario = table.clone(scenario)
invalidScenario.reportContexts = { "primary" }
assert(not validator.validate(plan({ phase }, { invalidScenario })), "Every scenario retains server evidence")

local function fixture()
	local test = { now = 0, active = true, clicks = 0, images = 0, marker = "loading", onPart = false, events = {} }
	local io = {
		now = function() return test.now end,
		wait = function(seconds) test.now += seconds end,
		active = function() return test.active end,
		click = function()
			test.clicks += 1
			if test.clicks < 2 then return false end
			test.marker = "held"
			return true
		end,
		moveCharacter = function()
			test.marker = "held"
			return true
		end,
		characterOnPart = function() return test.onPart end,
		collect = function() return { exists = true, value = test.marker } end,
		trace = function(stage, data) table.insert(test.events, { stage = stage, data = data }) end,
		capture = function()
			test.images += 1
			return { captureId = "frame", hash = string.rep("a", 64) }
		end,
	}
	return test, io
end
local success, io = fixture()
local longRun, longIO = fixture()
local longPhase = table.clone(phase)
longPhase.driver = { kind = "wait_for_session", timeoutMs = 1000 }
longPhase.facts = { { id = "motion", kind = "part_motion", path = "game.Workspace.Part", sampleCount = 121, intervalMs = 1000 } }
longIO.collect = function()
	longRun.now += 120
	return { factId = "motion", kind = "part_motion", samples = {}, delta = 0 }
end
assert(validator.validate(plan({ longPhase })), "Long observation is a supported plan")
local _, longCaptures = PhaseCapture.collect(longPhase, longIO)
assert(#longCaptures == 1 and longRun.now >= 120, "Acquisition must include the declared sampling workload")
local observations, receipts = PhaseCapture.collect(phase, io)
assert(success.clicks == 2 and success.images == 1)
assert(observations[1].value == "held" and receipts[1].captureId == "frame")
assert(success.events[1].stage == "phase.started" and success.events[#success.events].stage == "phase.completed")

local moved, moving = fixture()
local movedObservations = PhaseCapture.collect(movementPhase, moving)
assert(moved.marker == "held" and movedObservations[1].value == "held")
local function hasEvent(events, stage)
	for _, event in events do if event.stage == stage then return true end end
	return false
end
assert(hasEvent(moved.events, "input.waiting") and hasEvent(moved.events, "phase.readiness")
	and hasEvent(moved.events, "input.move_requested"))

local reached, reaching = fixture()
local contactWaits = 0
reaching.wait = function(seconds)
	reached.now += seconds
	contactWaits += 1
	if contactWaits == 2 then reached.onPart = true end
end
local _, contactCaptures = PhaseCapture.collect(contactPhase, reaching)
assert(reached.images == 1 and contactCaptures[1].captureId == "frame" and contactWaits >= 2)
assert(hasEvent(reached.events, "input.move_requested") and hasEvent(reached.events, "phase.ready"),
	"The presentation capture waits for physical contact, not a candidate success attribute")

local alreadyReady, invalidMovementIO = fixture()
alreadyReady.marker = "held"
local prematurelyReady = PhaseCapture.collect(movementPhase, invalidMovementIO)
assert(prematurelyReady[1].value == "held" and alreadyReady.images == 1,
	"An already-matching state must remain visible as bounded evidence")
assert(hasEvent(alreadyReady.events, "phase.preexisting_state"),
	"The trace must identify a state already matching before input")

local waitingPhase = table.clone(phase)
waitingPhase.driver = { kind = "wait_for_fact", readyFactId = "marker", readyValue = "held", timeoutMs = 1000 }
assert(validator.validate(plan({ waitingPhase })))
local waited, passive = fixture()
local waits = 0
passive.wait = function(seconds)
	waited.now += seconds
	waits += 1
	if waits == 2 then waited.marker = "held" end
end
local waitedObservations = PhaseCapture.collect(waitingPhase, passive)
assert(waited.clicks == 0 and waitedObservations[1].value == "held")
assert(hasEvent(waited.events, "phase.waiting") and hasEvent(waited.events, "phase.readiness"))

local presencePhase = table.clone(phase)
presencePhase.driver = { kind = "wait_for_exists", readyFactId = "marker", timeoutMs = 1000 }
assert(validator.validate(plan({ presencePhase })))
local invalidPresence = table.clone(presencePhase)
invalidPresence.driver = { kind = "wait_for_exists", readyFactId = "marker", readyValue = "held", timeoutMs = 1000 }
assert(not validator.validate(plan({ invalidPresence })), "Presence cannot impose an undisclosed spelling")
local present, presenceIO = fixture()
local presenceWaits = 0
presenceIO.collect = function()
	return { exists = presenceWaits >= 2, value = "Closed" }
end
presenceIO.wait = function(seconds)
	present.now += seconds
	presenceWaits += 1
end
local presentObservations = PhaseCapture.collect(presencePhase, presenceIO)
assert(presenceWaits >= 2 and presentObservations[1].value == "Closed" and present.images == 1)

local timeout, waiting = fixture()
local actorViewPhase = table.clone(scenePresencePhase)
actorViewPhase.driver = { kind = "observe_from_actor", targetPath = "game.Workspace.CheckpointA", timeoutMs = 1000 }
assert(validator.validate(plan({ actorViewPhase })))
local actorViewState, actorViewIO = fixture()
actorViewIO.actorReady = function() return true end
actorViewIO.collect = function() return { exists = false, availability = "observed_absence" } end
actorViewIO.capture = function(_, targetPath)
	assert(targetPath == "game.Workspace.CheckpointA", "Capture receives the declared semantic target")
	actorViewState.images += 1
	return { captureId = "frame", hash = string.rep("a", 64) }
end
local actorViewObservations = PhaseCapture.collect(actorViewPhase, actorViewIO)
assert(actorViewState.images == 1 and actorViewObservations[1].exists == false and actorViewState.clicks == 0,
	"An absent target still produces original evidence without gameplay input")
assert(hasEvent(actorViewState.events, "phase.readiness_unmet"))
local missingActorState, missingActorIO = fixture()
missingActorIO.actorReady = function() return false end
local actorReadyOk, actorReadyError = pcall(PhaseCapture.collect, actorViewPhase, missingActorIO)
assert(not actorReadyOk and string.find(tostring(actorReadyError), "no live local avatar", 1, true) and missingActorState.images == 0,
	"Missing acquisition machinery cannot manufacture candidate failure evidence")
waiting.click = function() return false end
local failedInputObservations = PhaseCapture.collect(phase, waiting)
assert(failedInputObservations[1].value == "loading" and timeout.images == 1,
	"An unavailable input must still produce a bounded final capture")
assert(hasEvent(timeout.events, "input.unavailable") and hasEvent(timeout.events, "phase.readiness_unmet"))

local cancelled, stopping = fixture()
stopping.capture = function() cancelled.active = false; return { captureId = "frame", hash = string.rep("a", 64) } end
assert(not pcall(PhaseCapture.collect, phase, stopping), "A late receipt cannot enter a cancelled attempt")

local changed, changing = fixture()
changing.capture = function() changed.marker = "next"; return { captureId = "frame", hash = string.rep("a", 64) } end
PhaseCapture.collect(phase, changing)
assert(hasEvent(changed.events, "phase.readiness_changed"),
	"A state change during capture must be explicit, while retaining the captured evidence")

local _, failing = fixture()
failing.capture = function() error("Screen recording permission denied") end
local captured, failure = pcall(PhaseCapture.collect, phase, failing)
assert(not captured and string.find(tostring(failure), "permission denied"), "Host errors must survive the phase boundary")

local TrialTrace = require("../plugin/src/TrialTrace")
local secret = string.rep("f", 64)
local traceState = TrialTrace.new(secret)
traceState.trialId = "trial-" .. string.rep("a", 24)
local first = TrialTrace.record(traceState, "trial.failed", { error = "Bearer " .. secret .. "\nstack frame" }, "2026-09-18T00:00:00.000Z")
assert(not string.find(first.data.error, secret, 1, true))
assert(string.find(first.data.error, "stack frame", 1, true))
assert(first.data.droppedEvents == 0, "Empty data must serialize as an object, not an array")
local batch = TrialTrace.batch(traceState)
TrialTrace.record(traceState, "play.state", { state = "Stopped" }, "2026-09-18T00:00:00.000Z")
assert(#TrialTrace.batch(traceState) == 2, "A failed delivery retains the batch for retry")
TrialTrace.acknowledge(traceState, batch[#batch].sequence)
assert(#traceState.events == 1 and traceState.events[1].stage == "play.state", "Ack cannot erase events added while HTTP yielded")
for _ = 1, 200 do TrialTrace.record(traceState, "play.state", {}, "2026-09-18T00:00:00.000Z") end
assert(#traceState.events == 128 and traceState.dropped == 73)
assert(#TrialTrace.batch(traceState) == 16)
assert(traceState.events[#traceState.events].data.droppedEvents == 73)
local function executePlay(args)
	assert(type(args) == "table", "Studio rejects nil test arguments")
	assert(args.basaltTrialId == traceState.trialId)
	assert(args.token == nil and args.secret == nil, "No capability may enter test arguments")
end
executePlay(TrialTrace.playArguments(traceState.trialId))
assert(not pcall(TrialTrace.playArguments, ""))

local ObservationBatch = require("../plugin/src/ObservationBatch")
local luneTask = require("@lune/task")
local started = {}
local observations = ObservationBatch.collect({
	{ context = "server", fact = { id = "first" } },
	{ context = "client", fact = { id = "ignored" } },
	{ context = "server", fact = { id = "second" } },
}, "server", {}, {
	collect = function(fact)
		started[fact.id] = true
		local deadline = os.clock() + 0.5
		while not (started.first and started.second) do
			assert(os.clock() < deadline, "Scenario observations did not start together")
			luneTask.wait(0.001)
		end
		return { factId = fact.id }
	end,
	wait = luneTask.wait,
	spawn = luneTask.spawn,
})
assert(#observations == 2 and observations[1].factId == "first" and observations[2].factId == "second")
assert(not pcall(ObservationBatch.collect, {
	{ context = "server", fact = { id = "bad" } },
}, "server", {}, { collect = function() error("capture failed") end, wait = luneTask.wait,
	spawn = luneTask.spawn }))

print("Basalt connector module tests passed (plan validation, private Edit HTTP relay, capture lifecycle, automated phase sequencing, trace retries and Play arguments)")
