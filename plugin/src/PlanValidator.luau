--!strict

local PlanValidator = {}
local catalog = require(script.Parent.CapabilityCatalog)
local ALLOWED_FACTS = catalog.observations

local function isId(value: unknown): boolean
	return type(value) == "string"
		and #(value :: string) <= 128
		and string.match(value :: string, "^[%w][%w%._:%-]*$") ~= nil
end

local function hasExactKeys(value: { [any]: any }, keys: { string }): boolean
	local expected = {}
	for _, key in keys do
		expected[key] = true
	end
	local count = 0
	for key in value do
		if type(key) ~= "string" or not expected[key] then
			return false
		end
		count += 1
	end
	return count == #keys
end

-- Required keys must exist; optional keys may exist. JSON null arrives as an absent key.
local function hasKeys(value: { [any]: any }, required: { string }, optional: { string }): boolean
	local allowed = {}
	for _, key in optional do allowed[key] = true end
	for _, key in required do
		if value[key] == nil then return false end
		allowed[key] = true
	end
	for key in value do
		if type(key) ~= "string" or not allowed[key] then return false end
	end
	return true
end

local function isPath(value: unknown, roles: { [string]: boolean }): boolean
	if type(value) ~= "string" then
		return false
	end
	local parts = string.split(value :: string, ".")
	if parts[1] == "role" then
		return #parts == 2 and roles[parts[2]] == true
	end
	if parts[1] ~= "game" or #parts < 2 then
		return false
	end
	for index = 2, #parts do
		if string.match(parts[index], "^[%a_][%w_]*$") == nil then
			return false
		end
	end
	return true
end

local function positiveInteger(value: unknown): boolean
	return type(value) == "number" and value > 0 and value == math.floor(value)
end

local function nonEmptyString(value: unknown): boolean
	return type(value) == "string" and string.match(value :: string, "%S") ~= nil
end

local function jsonPrimitive(value: unknown): boolean
	return value == nil or type(value) == "string" or type(value) == "boolean"
		or (type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge)
end

local function validateFact(fact: any, actors: { [string]: boolean }?, roles: { [string]: boolean }): boolean
	if type(fact) ~= "table" or not isId(fact.id) or not ALLOWED_FACTS[fact.kind] then return false end
	if fact.kind == "diagnostics" then return hasExactKeys(fact, { "id", "kind" }) end
	if fact.kind == "player_count" then return hasExactKeys(fact, { "id", "kind" }) end
	if fact.kind == "actor_health" then
		return actors ~= nil and hasExactKeys(fact, { "id", "kind", "actor" }) and actors[fact.actor] == true
	end
	if fact.kind == "actor_part_motion" then
		return actors ~= nil and actors[fact.actor] == true
			and hasExactKeys(fact, { "id", "kind", "actor", "path", "sampleCount", "intervalMs" })
			and isPath(fact.path, roles)
			and positiveInteger(fact.sampleCount) and fact.sampleCount <= 480
			and positiveInteger(fact.intervalMs) and fact.intervalMs <= 60000
			and (fact.sampleCount - 1) * fact.intervalMs <= 600000
	end
	if fact.kind == "actor_part_support" then
		return actors ~= nil and actors[fact.actor] == true
			and hasExactKeys(fact, { "id", "kind", "actor", "path" })
			and isPath(fact.path, roles)
	end
	if fact.kind == "part_physics_trace" then
		return actors ~= nil and hasExactKeys(fact, { "id", "kind", "path", "durationMs" })
			and isPath(fact.path, roles) and positiveInteger(fact.durationMs)
			and fact.durationMs <= 600000
	end
	if fact.kind == "part_route_trace" then
		return actors ~= nil and hasExactKeys(fact, { "id", "kind", "path", "startPath", "endPath", "durationMs", "proximityStuds" })
			and isPath(fact.path, roles) and isPath(fact.startPath, roles) and isPath(fact.endPath, roles)
			and positiveInteger(fact.durationMs) and fact.durationMs <= 600000
			and type(fact.proximityStuds) == "number" and fact.proximityStuds >= 0.1 and fact.proximityStuds <= 50
	end
	if fact.kind == "performance_trace" then
		return actors ~= nil and hasExactKeys(fact, { "id", "kind", "sampleCount", "intervalMs" })
			and positiveInteger(fact.sampleCount) and fact.sampleCount <= 480
			and positiveInteger(fact.intervalMs) and fact.intervalMs >= 250 and fact.intervalMs <= 60000
			and fact.sampleCount * fact.intervalMs <= 600000
	end
	if not isPath(fact.path, roles) then return false end
	if fact.kind == "part_motion" then
		return hasExactKeys(fact, { "id", "kind", "path", "sampleCount", "intervalMs" })
			and positiveInteger(fact.sampleCount) and fact.sampleCount <= 480
			and positiveInteger(fact.intervalMs) and fact.intervalMs <= 60000
			and (fact.sampleCount - 1) * fact.intervalMs <= 600000
	elseif fact.kind == "replication_probe" then
		return hasExactKeys(fact, { "id", "kind", "path", "attribute" }) and isId(fact.attribute)
	end
	return hasExactKeys(fact, { "id", "kind", "path" })
end

local function validateAction(action: any, actors: { [string]: boolean }, roles: { [string]: boolean }): boolean
	if type(action) ~= "table" then return false end
	if not catalog.scenarioActions[action.kind] then return false end
	if action.kind == "wait" then return hasExactKeys(action, { "kind" }) end
	if not actors[action.actor] then return false end
	if action.kind == "place_relative_to_part" or action.kind == "move_relative_to_part" then
		if not hasExactKeys(action, { "kind", "actor", "targetPath", "offsetStuds" })
			or not isPath(action.targetPath, roles) or type(action.offsetStuds) ~= "table" or #action.offsetStuds ~= 3 then return false end
		local count = 0
		for key, value in action.offsetStuds do
			if type(key) ~= "number" or key < 1 or key > 3 or key ~= math.floor(key)
				or type(value) ~= "number" or value ~= value or math.abs(value) > 10000 then return false end
			count += 1
		end
		return count == 3
	end
	if action.kind == "move_to" or action.kind == "place_on_part" then
		return hasExactKeys(action, { "kind", "actor", "targetPath" }) and isPath(action.targetPath, roles)
	elseif action.kind == "probe_barrier" then
		return hasExactKeys(action, { "kind", "actor", "barrierPath" }) and isPath(action.barrierPath, roles)
	elseif action.kind == "press_key" then
		return hasExactKeys(action, { "kind", "actor", "key" }) and action.key == "E"
	elseif action.kind == "hold_key" then
		return hasExactKeys(action, { "kind", "actor", "key", "durationMs" })
			and (action.key == "E" or action.key == "F" or action.key == "Space")
			and positiveInteger(action.durationMs) and action.durationMs >= 50 and action.durationMs <= 5000
	elseif action.kind == "gui_activate" then
		return hasExactKeys(action, { "kind", "actor", "path" }) and isPath(action.path, roles)
	elseif action.kind == "gui_text_entry" then
		return hasExactKeys(action, { "kind", "actor", "path", "text" }) and isPath(action.path, roles)
			and type(action.text) == "string" and #action.text > 0 and #action.text <= 256
			and not string.find(action.text, "\0", 1, true)
	elseif action.kind == "disconnect" then
		return hasExactKeys(action, { "kind", "actor" })
	elseif action.kind == "fire_remote" then
		if not hasExactKeys(action, { "kind", "actor", "path", "arguments" })
			or not isPath(action.path, roles) or type(action.arguments) ~= "table" or #action.arguments > 8 then return false end
		for _, argument in action.arguments do
			if type(argument) ~= "table" then return false end
			if argument.kind == "literal" then
				if not hasExactKeys(argument, { "kind", "value" }) or not jsonPrimitive(argument.value) then return false end
			elseif argument.kind == "actor_user_id" then
				if not hasExactKeys(argument, { "kind", "actor" }) or not actors[argument.actor] then return false end
			else return false end
		end
		return true
	end
	return false
end

local function validateAnchorFact(fact: any, scope: string, actors: { [string]: boolean },
	roles: { [string]: boolean }, roleDefinitions: { [string]: any }): boolean
	if type(fact) ~= "table" or not catalog.anchorFacts[fact.kind] then return false end
	if fact.kind == "humanoid_state" then
		return hasExactKeys(fact, { "kind", "actor", "state" }) and actors[fact.actor] == true
			and catalog.humanoidStates[fact.state] == true
	elseif fact.kind == "character_on_part" then
		return hasExactKeys(fact, { "kind", "actor", "path" }) and actors[fact.actor] == true
			and isPath(fact.path, roles)
	elseif fact.kind == "character_near_part" then
		return hasExactKeys(fact, { "kind", "actor", "path", "radiusStuds" }) and actors[fact.actor] == true
			and isPath(fact.path, roles) and type(fact.radiusStuds) == "number"
			and fact.radiusStuds >= 0.1 and fact.radiusStuds <= 50
	elseif fact.kind == "gui_visible" then
		if not hasExactKeys(fact, { "kind", "path", "visible" }) or not isPath(fact.path, roles)
			or type(fact.visible) ~= "boolean" or scope == "server" then return false end
		if string.sub(fact.path, 1, 5) == "role." then
			local role = roleDefinitions[string.sub(fact.path, 6)]
			-- The anchor reads the visibility of a GuiObject. A ScreenGui is not a GuiObject.
			return role ~= nil and role.scope == "local_player_gui" and role.className ~= "ScreenGui"
		end
		return string.sub(fact.path, 1, 25) == "game.Players.LocalPlayer."
	end
	local field = if fact.kind == "instance_present" then "present" else "value"
	return hasExactKeys(fact, { "kind", "path", field }) and isPath(fact.path, roles)
		and type(fact[field]) == "boolean"
end

local DURATION_UNITS: { [string]: number } = {
	ms = 1, msec = 1, msecs = 1, millisecond = 1, milliseconds = 1,
	s = 1000, sec = 1000, secs = 1000, second = 1000, seconds = 1000,
	min = 60000, mins = 60000, minute = 60000, minutes = 60000,
}

-- A requirement quote must state its bound in digits and a unit, as the contract does.
local function statesDuration(text: string, milliseconds: number): boolean
	for number, unit in string.gmatch(text, "(%d+%.?%d*)%s*(%a+)") do
		local multiplier = DURATION_UNITS[string.lower(unit :: string)]
		local value = tonumber(number)
		if multiplier ~= nil and value ~= nil and math.round(value * multiplier) == milliseconds then return true end
	end
	return false
end

-- Returns the lowest startMs that a later step may use, or nil for invalid timing.
local function validateTiming(step: any, scenario: any, earlier: { [string]: boolean }, previousStartMs: number,
	reports: { [string]: boolean }, actors: { [string]: boolean }, roles: { [string]: boolean },
	roleDefinitions: { [string]: any }): number?
	if not positiveInteger(step.horizonMs) or step.horizonMs > 60000 then return nil end
	if type(step.holdMs) ~= "number" or step.holdMs < 0 or step.holdMs ~= math.floor(step.holdMs)
		or step.holdMs >= step.horizonMs then return nil end
	local at = step.at
	if type(at) ~= "table" then return nil end
	local factAnchor = false
	if at.startMs ~= nil then
		if not hasExactKeys(at, { "startMs" }) or type(at.startMs) ~= "number" or at.startMs < previousStartMs
			or at.startMs ~= math.floor(at.startMs) or at.startMs > scenario.durationMs then return nil end
		previousStartMs = at.startMs
	else
		if not hasExactKeys(at, { "after", "offsetMs" }) or type(at.offsetMs) ~= "number" or at.offsetMs < 0
			or at.offsetMs ~= math.floor(at.offsetMs) or at.offsetMs > scenario.durationMs
			or type(at.after) ~= "table" then return nil end
		if at.after.step ~= nil then
			if not hasExactKeys(at.after, { "step" }) or earlier[at.after.step] ~= true then return nil end
		else
			if not hasExactKeys(at.after, { "fact", "scope" }) or reports[at.after.scope] ~= true
				or not validateAnchorFact(at.after.fact, at.after.scope, actors, roles, roleDefinitions) then
				return nil
			end
			factAnchor = true
		end
	end
	if not factAnchor and step.holdMs ~= 0 then return nil end
	local requirement = step.requirement
	if requirement ~= nil then
		if type(requirement) ~= "table" or not hasExactKeys(requirement, { "withinMs", "quote" })
			or not factAnchor or next(earlier) == nil or not positiveInteger(requirement.withinMs)
			or requirement.withinMs > step.horizonMs or not nonEmptyString(requirement.quote)
			or #requirement.quote > 1024 or not statesDuration(requirement.quote, requirement.withinMs) then return nil end
	end
	return previousStartMs
end

local function guiRole(path: string, textEntry: boolean, roles: { [string]: any }): boolean
	if string.sub(path, 1, 5) ~= "role." then return true end
	local role = roles[string.sub(path, 6)]
	return role ~= nil and role.scope == "local_player_gui"
		and (if textEntry then role.className == "TextBox" else catalog.guiInputRoleClasses[role.className] == true)
end

-- A gui_layout observation reads one ScreenGui of the local player.
local function guiLayoutPath(fact: any, roles: { [string]: any }): boolean
	if fact.kind ~= "gui_layout" then return true end
	if string.sub(fact.path, 1, 5) == "role." then
		local role = roles[string.sub(fact.path, 6)]
		return role ~= nil and role.scope == "local_player_gui" and role.className == "ScreenGui"
	end
	return string.sub(fact.path, 1, 35) == "game.Players.LocalPlayer.PlayerGui."
end

local function isHash(value: unknown): boolean
	return type(value) == "string"
		and #(value :: string) == 64
		and string.match(value :: string, "^[a-f0-9]+$") ~= nil
end

local function isToken(value: unknown): boolean
	return isHash(value)
end

local function isLoopbackUrl(value: unknown): boolean
	if type(value) ~= "string" then
		return false
	end
	local portText = string.match(value :: string, "^http://127%.0%.0%.1:(%d+)$")
	local port = if portText then tonumber(portText) else nil
	return port ~= nil and port >= 1 and port <= 65535 and port == math.floor(port)
end

function PlanValidator.validateBootstrap(bootstrap: unknown): (boolean, string?)
	if type(bootstrap) ~= "table" then
		return false, "bootstrap must be a table"
	end
	local value = bootstrap :: any
	if not hasExactKeys(value, {
		"schema",
		"connectorUrl",
		"token",
		"treatmentId",
		"candidateHash",
		"collectionPlanHash",
	}) then
		return false, "bootstrap contains unknown or missing fields"
	end
	if value.schema ~= "basalt-evals/studio-bootstrap" then
		return false, "bootstrap schema is invalid"
	end
	if not isLoopbackUrl(value.connectorUrl) or not isToken(value.token) then
		return false, "bootstrap connector capability is invalid"
	end
	if not isId(value.treatmentId) then
		return false, "bootstrap treatment identity is invalid"
	end
	if not isHash(value.candidateHash) or not isHash(value.collectionPlanHash) then
		return false, "bootstrap hash binding is invalid"
	end
	return true
end

function PlanValidator.validate(plan: unknown): (boolean, string?)
	if type(plan) ~= "table" then
		return false, "plan must be a table"
	end
	local value = plan :: any
	if value.schema ~= "basalt-evals/studio-plan" or type(value.phases) ~= "table" or #value.phases == 0 then
		return false, "plan schema is invalid"
	end
	if not hasExactKeys(value, { "schema", "clients", "actors", "roles", "scenarios", "phases" }) then
		return false, "plan contains unknown fields"
	end
	if not positiveInteger(value.clients) or value.clients > 8 or type(value.actors) ~= "table"
		or type(value.roles) ~= "table" or #value.roles > 64
		or #value.actors ~= value.clients or type(value.scenarios) ~= "table" or #value.scenarios > 32 then
		return false, "plan multiplayer metadata is invalid"
	end
	local actors = {}
	local contexts = { server = true }
	local roles = {}
	local roleDefinitions = {}
	local classes = catalog.roleClasses
	for _, role in value.roles do
		if type(role) ~= "table" or not hasExactKeys(role, { "id", "className", "scope", "cardinality" })
			or type(role.id) ~= "string" or string.match(role.id, "^[a-z][a-z0-9_%-]*$") == nil or #role.id > 64
			or not classes[role.className]
			or (role.scope ~= "workspace" and role.scope ~= "replicated_storage" and role.scope ~= "local_player_gui")
			or (role.cardinality ~= "exactly_one" and role.cardinality ~= "zero_or_one") or roles[role.id]
			or (role.className == "ScreenGui" and role.scope ~= "local_player_gui") then
			return false, "semantic role is invalid"
		end
		roles[role.id] = true
		roleDefinitions[role.id] = role
	end
	for _, actor in value.actors do
		if not isId(actor) or actor == "server" or actors[actor] then return false, "plan actor identity is invalid" end
		actors[actor], contexts[actor] = true, true
	end
	local scenarioIds = {}
	for _, scenario in value.scenarios do
		if type(scenario) ~= "table" or not isId(scenario.id) or scenarioIds[scenario.id]
			or not hasExactKeys(scenario, { "id", "label", "durationMs", "reportContexts", "steps" })
			or not nonEmptyString(scenario.label) or not positiveInteger(scenario.durationMs)
			or scenario.durationMs > 1800000 or type(scenario.reportContexts) ~= "table"
			or #scenario.reportContexts == 0 or type(scenario.steps) ~= "table"
			or #scenario.steps == 0 or #scenario.steps > 256 then return false, "scenario metadata is invalid" end
		scenarioIds[scenario.id] = true
		local reports = {}
		for _, context in scenario.reportContexts do
			if not contexts[context] or reports[context] then return false, "scenario report context is invalid" end
			reports[context] = true
		end
		if not reports.server then return false, "scenario must retain a server report" end
		local steps, previousStartMs = {}, 0
		for _, step in scenario.steps do
			if type(step) ~= "table" or not isId(step.id) or steps[step.id]
				or not hasKeys(step, { "id", "at", "horizonMs", "holdMs", "action", "observations" }, { "requirement" })
				or not validateAction(step.action, actors, roles) or type(step.observations) ~= "table"
				or #step.observations > 64 then return false, "scenario step is invalid" end
			local nextStartMs = validateTiming(step, scenario, steps, previousStartMs, reports, actors, roles, roleDefinitions)
			if nextStartMs == nil then return false, "scenario step timing is invalid" end
			previousStartMs = nextStartMs
			if step.action.kind == "disconnect" and reports[step.action.actor] then
				return false, "a client that leaves Play cannot report"
			end
			if step.action.kind == "probe_barrier" and 2500 > scenario.durationMs then
				return false, "barrier probe exceeds scenario duration"
			end
			if (step.action.kind == "gui_activate" or step.action.kind == "gui_text_entry")
				and not guiRole(step.action.path, step.action.kind == "gui_text_entry", roleDefinitions) then
				return false, "GUI input requires a compatible local_player_gui role"
			end
			steps[step.id] = true
			local observations = {}
			for _, observation in step.observations do
				if type(observation) ~= "table" or not hasExactKeys(observation, { "context", "fact" })
					or not reports[observation.context] or not validateFact(observation.fact, actors, roles) then
					return false, "scenario observation is invalid"
				end
				local key = observation.context .. ":" .. observation.fact.id
				if observations[key] then return false, "scenario observation is duplicated" end
				observations[key] = true
				local fact = observation.fact
				if (fact.kind == "performance_trace" and observation.context ~= "server")
					or (fact.kind == "gui_layout" and observation.context == "server") then
					return false, "scenario observation context is invalid"
				end
				if not guiLayoutPath(fact, roleDefinitions) then
					return false, "GUI layout needs a local player ScreenGui"
				end
				-- Each performance sample covers one interval. The other samplers start at zero.
				local window = if fact.kind == "performance_trace" then fact.sampleCount * fact.intervalMs
					elseif fact.sampleCount and fact.intervalMs then (fact.sampleCount - 1) * fact.intervalMs
					else fact.durationMs or 0
				if window > scenario.durationMs then
					return false, "observation window exceeds the scenario budget"
				end
				local after = step.at.after
				if after ~= nil and after.fact ~= nil and after.fact.kind == "gui_visible"
					and observation.context ~= after.scope then
					return false, "a gui_visible anchor can only anchor its own client"
				end
			end
		end
	end
	local phaseIds = {}
	local factIds = {}
	local captureIds = {}
	for _, phase in value.phases do
		if type(phase) ~= "table" or not isId(phase.id) or phaseIds[phase.id] then
			return false, "phase identity is invalid"
		end
		if not hasExactKeys(phase, { "id", "label", "instruction", "driver", "facts", "captures" }) then
			return false, "phase contains unknown fields"
		end
		phaseIds[phase.id] = true
		if not nonEmptyString(phase.label) or not nonEmptyString(phase.instruction) then
			return false, "phase instructions are invalid"
		end
		if type(phase.facts) ~= "table" or type(phase.captures) ~= "table" then
			return false, "phase contents are invalid"
		end
		for _, fact in phase.facts do
			if type(fact) ~= "table" or not isId(fact.id) or factIds[fact.id] then
				return false, "fact identity is invalid"
			end
			factIds[fact.id] = true
			if not validateFact(fact, nil, roles) then return false, "fact is invalid" end
			if not guiLayoutPath(fact, roleDefinitions) then
				return false, "GUI layout needs a local player ScreenGui"
			end
		end
		local driver = phase.driver
		if type(driver) ~= "table" then return false, "phase driver is missing" end
		if driver.kind == "manual" then
			if not hasExactKeys(driver, { "kind" }) then return false, "manual driver fields are invalid" end
		elseif driver.kind == "wait_for_session" then
			if not hasExactKeys(driver, { "kind", "timeoutMs" })
				or not positiveInteger(driver.timeoutMs) or driver.timeoutMs > 60000 then
				return false, "session driver fields are invalid"
			end
		elseif driver.kind == "character_reach_part" or driver.kind == "observe_from_actor" then
			if not hasExactKeys(driver, { "kind", "targetPath", "timeoutMs" })
				or not isPath(driver.targetPath, roles)
				or not positiveInteger(driver.timeoutMs) or driver.timeoutMs > 60000 then
				return false, "reach-part driver fields are invalid"
			end
			if driver.kind == "observe_from_actor" then
				local found = false
				for _, fact in phase.facts do
					if fact.kind == "instance" and fact.path == driver.targetPath then found = true end
				end
				if not found then return false, "actor view requires a same-phase instance observation" end
			end
		elseif driver.kind == "wait_for_fact" or driver.kind == "wait_for_exists" or driver.kind == "gui_button" or driver.kind == "character_move_to" then
			local pathField = if driver.kind == "gui_button" then "path" else "targetPath"
			local keys = if driver.kind == "wait_for_exists"
				then { "kind", "readyFactId", "timeoutMs" }
				else if driver.kind == "wait_for_fact"
					then { "kind", "readyFactId", "readyValue", "timeoutMs" }
					else { "kind", pathField, "readyFactId", "readyValue", "timeoutMs" }
			if not hasExactKeys(driver, keys)
				or (driver.kind ~= "wait_for_fact" and driver.kind ~= "wait_for_exists" and not isPath(driver[pathField], roles))
				or (driver.kind ~= "wait_for_exists" and not isId(driver.readyValue))
				or not positiveInteger(driver.timeoutMs) or driver.timeoutMs > 60000 then
				return false, "driven input fields are invalid"
			end
			if driver.kind == "gui_button" and not guiRole(driver.path, false, roleDefinitions) then
				return false, "GUI input requires a compatible local_player_gui role"
			end
			local found = false
			for _, fact in phase.facts do
				if fact.id == driver.readyFactId and (fact.kind == "replication_probe"
					or (driver.kind == "wait_for_exists" and (fact.kind == "instance" or fact.kind == "instance_name"))) then found = true end
			end
			if not found then return false, "driven input must reference a supported phase fact" end
		else
			return false, "unknown phase driver"
		end
		for _, capture in phase.captures do
			if type(capture) ~= "table" or not isId(capture.id) or captureIds[capture.id] then
				return false, "capture identity is invalid"
			end
			captureIds[capture.id] = true
			if not hasExactKeys(capture, { "id", "instruction" })
				or not nonEmptyString(capture.instruction) then
				return false, "capture is invalid"
			end
		end
	end
	return true
end

function PlanValidator.validateSession(session: unknown): (boolean, string?)
	if type(session) ~= "table" then
		return false, "session must be a table"
	end
	local value = session :: any
	if not hasExactKeys(value, {
		"sessionId",
		"treatmentId",
		"candidateHash",
		"collectionPlanHash",
		"connectorUrl",
		"expectedStudioVersion",
		"plan",
	}) then
		return false, "session contains unknown or missing fields"
	end
	if not isId(value.sessionId) or not isId(value.treatmentId) then
		return false, "session identity is invalid"
	end
	if not isHash(value.candidateHash) or not isHash(value.collectionPlanHash) then
		return false, "session hash binding is invalid"
	end
	if not isLoopbackUrl(value.connectorUrl) then
		return false, "session connector URL is invalid"
	end
	if not nonEmptyString(value.expectedStudioVersion) then
		return false, "session Studio version is invalid"
	end
	return PlanValidator.validate(value.plan)
end

return table.freeze(PlanValidator)
