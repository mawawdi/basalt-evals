--!strict
--!nolint DeprecatedApi

-- Rojo maps the .plugin.luau suffix to a Script with RunContext.Plugin.

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local StudioTestService = game:GetService("StudioTestService")

local Collector = require(script.Collector)
local PlanValidator = require(script.PlanValidator)
local CaptureState = require(script.CaptureState)
local PhaseCapture = require(script.PhaseCapture)
local SceneText = require(script.SceneText)
local ScenarioRunner = require(script.ScenarioRunner)
local AnchorFact = require(script.AnchorFact)
local BarrierProbe = require(script.BarrierProbe)
local StudioCapture = require(script.StudioCapture)
local StudioDeviceView = require(script.StudioDeviceView)
local TrialTrace = require(script.TrialTrace)
local PlayRelay = require(script.PlayRelay)
local Timestamp = require(script.Timestamp)

local BOOTSTRAP_NAME = "BasaltEvalBootstrap"
local RUN_IDENTITY_NAME = "BasaltEvalRunIdentity"
local runIdentity: StringValue? = nil

-- The fixed identity marker lets the external recorder distinguish this
-- prepared Play client from unrelated Studio windows whose MCP names are nil.
local function publishRunIdentity(sessionId: string)
	local existing = ReplicatedStorage:FindFirstChild(RUN_IDENTITY_NAME)
	if existing ~= nil and existing ~= runIdentity then
		error("Prepared place reserves " .. RUN_IDENTITY_NAME .. " for actor binding")
	end
	if runIdentity == nil then
		local created = Instance.new("StringValue")
		created.Name = RUN_IDENTITY_NAME
		created.Parent = ReplicatedStorage
		runIdentity = created
	end
	local marker = assert(runIdentity)
	marker.Value = sessionId
end
-- This PluginSecurity API is newer than our pinned Luau definition snapshot.
-- Keep its dynamic boundary here; the relay protocol has offline module tests.
local relayAvailable, relaySetup = pcall(function()
	local service = (game :: any):GetService("PluginConnectionService")
	local targets = (Enum :: any).PluginConnectionTargetType
	local editing = service:CanHaveConnectionType(targets.Test)
	local target = if editing then targets.Test else targets.Edit
	assert(service:CanHaveConnectionType(target), "No Edit/Play plugin connection is available")
	return { service = service, target = target, editing = editing }
end)
local isEdit = if relayAvailable then relaySetup.editing else RunService:IsEdit()
local isServer = not isEdit and RunService:IsServer()

local toolbar = plugin:CreateToolbar("Basalt Eval Studio")
local openButton = toolbar:CreateButton("Evidence", "Open the Basalt Eval Studio evidence collector", "rbxassetid://4458901886")
local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right,
	false,
	false,
	360,
	440,
	300,
	300
)
local widget = plugin:CreateDockWidgetPluginGuiAsync("BasaltEvalStudioEvidence", widgetInfo)
widget.Title = "Basalt Eval Studio Evidence"

local container = Instance.new("ScrollingFrame")
container.Size = UDim2.fromScale(1, 1)
container.BackgroundColor3 = Color3.fromRGB(28, 30, 35)
container.AutomaticCanvasSize = Enum.AutomaticSize.Y
container.CanvasSize = UDim2.fromOffset(0, 0)
container.ScrollingDirection = Enum.ScrollingDirection.Y
container.ScrollBarThickness = 6
container.BorderSizePixel = 0
container.Parent = widget

local layout = Instance.new("UIListLayout")
layout.Padding = UDim.new(0, 8)
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Parent = container

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 12)
padding.PaddingBottom = UDim.new(0, 12)
padding.PaddingLeft = UDim.new(0, 12)
padding.PaddingRight = UDim.new(0, 12)
padding.Parent = container

local function button(label: string): TextButton
	local item = Instance.new("TextButton")
	item.Size = UDim2.new(1, 0, 0, 36)
	item.BackgroundColor3 = Color3.fromRGB(82, 100, 226)
	item.TextColor3 = Color3.fromRGB(255, 255, 255)
	item.Text = label
	item.TextSize = 14
	item.Selectable = true
	item.Parent = container
	return item
end

local reconnectButton = button("Reconnect")
local captureButton = button("Run capture")
local submitButton = button("Retry submission")
local status = Instance.new("TextLabel")
status.Size = UDim2.new(1, -8, 0, 0)
status.AutomaticSize = Enum.AutomaticSize.Y
status.TextSize = 14
status.BackgroundTransparency = 1
status.TextColor3 = Color3.fromRGB(220, 222, 228)
status.TextWrapped = true
status.TextXAlignment = Enum.TextXAlignment.Left
status.TextYAlignment = Enum.TextYAlignment.Top
status.Text = "Waiting for a prepared Basalt Studio session."
status.Parent = container

local traceLabel = Instance.new("TextLabel")
traceLabel.Size = UDim2.new(1, -8, 0, 0)
traceLabel.AutomaticSize = Enum.AutomaticSize.Y
traceLabel.BackgroundTransparency = 1
traceLabel.TextColor3 = Color3.fromRGB(180, 185, 195)
traceLabel.TextWrapped = true
traceLabel.TextSize = 12
traceLabel.Text = "Diagnostics: Studio Output and the server's traces folder"
traceLabel.Parent = container

local session: any = nil
-- The frozen sequence view of the session. Edit reads it over HTTP, and a Play
-- client reads it from Edit over the private relay.
local sessionView: any = nil
local sessionToken = ""
local sessionEndpoint = ""
local captureState = CaptureState.new()
local busy = false
local connectedBootstrap: Instance? = nil
local connectedBootstrapSource = ""
local running = true
local attemptedGeneration = -1
local startingPlay = false
local traceState = TrialTrace.new("")
local traceClient = string.lower((string.gsub(HttpService:GenerateGUID(false), "-", "")))
local traceEndpoint = ""
local traceToken = ""
local traceSessionId = ""
local traceDeliveryError = ""
local connectionError = ""
local captureTrialGeneration = -1
local scenarioGeneration = -1
local lastRunState = ""
local relayClient: any = nil
local serverControl: any = nil
local relayBindings: { [any]: PlayRelay.Binding } = {}
local relayListener: RBXScriptConnection? = nil
local relayCodec = {
	encode = function(value: any): string return HttpService:JSONEncode(value) end,
	decode = function(value: string): any return HttpService:JSONDecode(value) end,
}

local function trace(stage: string, data: { [string]: any }, trialId: string?)
	local event = TrialTrace.record(traceState, stage, data, Timestamp(DateTime.now().UnixTimestampMillis), trialId)
	-- Info output does not contaminate the collector's engine-error observations.
	print("[Basalt trace] " .. HttpService:JSONEncode(event))
end

local function traceback(reason: any): string
	return debug.traceback(tostring(reason), 2)
end

local function errorSummary(reason: any): string
	return string.match(tostring(reason), "^[^\n]+") or tostring(reason)
end

local function automated(): boolean
	if session == nil then return false end
	for _, phase in session.plan.phases do
		if phase.driver.kind == "manual" then return false end
	end
	return true
end

-- Heartbeat evaluates availability every frame; only actual changes write button properties.
local controlEnabled: { [GuiButton]: boolean } = {}
local function updateControls()
	local playing = RunService.RunState == Enum.RunState.Running
	local available = {
		[reconnectButton] = not busy and (isEdit or Players.LocalPlayer ~= nil),
		[captureButton] = not busy and session ~= nil and captureState.submission == nil
			and not startingPlay and (if isEdit then automated() else playing and Players.LocalPlayer ~= nil),
		[submitButton] = not busy and session ~= nil and captureState.submission ~= nil,
	}
	for control, enabled in available do
		if controlEnabled[control] == enabled then continue end
		controlEnabled[control] = enabled
		control.Active = enabled
		control.Selectable = enabled
		control.AutoButtonColor = enabled
		control.BackgroundColor3 = if enabled then Color3.fromRGB(82, 100, 226) else Color3.fromRGB(65, 69, 80)
		control.TextColor3 = if enabled then Color3.fromRGB(255, 255, 255) else Color3.fromRGB(170, 174, 184)
	end
end

status:GetPropertyChangedSignal("Text"):Connect(updateControls)
RunService:GetPropertyChangedSignal("RunState"):Connect(updateControls)
updateControls()

local function clearConnection()
	session = nil
	sessionView = nil
	sessionToken = ""
	sessionEndpoint = ""
	connectedBootstrap = nil
	connectedBootstrapSource = ""
	serverControl = nil
	CaptureState.reset(captureState)
end

local function phaseText(phase: any): string
	local lines = { "Phase: " .. phase.label, phase.instruction }
	for _, capture in phase.captures do
		table.insert(
			lines,
			"Screenshot "
				.. capture.id
				.. ": "
				.. capture.instruction
		)
	end
	return table.concat(lines, "\n")
end

local function updateRunState()
	local playing = RunService.RunState ~= Enum.RunState.Stopped
	-- Include Pause/Resume, which intentionally do not advance the capture generation.
	local stateName = RunService.RunState.Name
	if stateName ~= lastRunState then
		lastRunState = stateName
		trace("play.state", { state = stateName, hasClient = Players.LocalPlayer ~= nil, generation = captureState.generation })
	end
	if not CaptureState.setPlaying(captureState, playing, Timestamp(DateTime.now().UnixTimestampMillis)) then return end
	if not playing then
		-- Arm diagnostics in Edit so startup errors are included in the next attempt.
		if isEdit then Collector.resetDiagnostics() end
	end
	if session == nil then
		status.Text = "Stop Play and wait for automatic connection before pressing F5 again."
	elseif captureState.submission ~= nil then
		status.Text = "Submission is sealed. Retry submission to resend the same evidence."
	elseif playing then
		status.Text = if automated() then "Play session active. Waiting for the client capture…" else "Perform this phase, then click Capture phase.\n\n" .. phaseText(session.plan.phases[1])
	else
		status.Text = if automated() then "Connected. Click Run capture to start Play and collect every phase." else "Connected. Start F5, perform this phase, then click Capture phase.\n\n" .. phaseText(session.plan.phases[1])
	end
end

local function normalizedEndpoint(value: string): string
	local portText = string.match(value, "^http://127%.0%.0%.1:(%d+)$")
	local port = if portText then tonumber(portText) else nil
	if port == nil or port < 1 or port > 65535 or port ~= math.floor(port) then
		error("Server URL must be an exact loopback URL such as http://127.0.0.1:43123")
	end
	return value
end

local function validToken(value: string): boolean
	return #value == 64 and string.match(value, "^[a-f0-9]+$") ~= nil
end

local function readBootstrap(): (Instance, any, string)
	assert(isEdit or isServer, "Only the Edit or test-server plugin may read the prepared capability")
	local root = game:FindFirstChild(BOOTSTRAP_NAME)
	if root == nil or not root:IsA("Script") then error("Open the exact prepared Place printed by the server") end
	local source = root.Source
	local encoded = string.match(source, "^%-%-%[%[\nbasalt%-evals/studio%-bootstrap\n([^\n]+)\n%]%]%s*$")
	assert(encoded, "Prepared Studio bootstrap source is invalid; prepare a place with the current connector")
	local bootstrap = HttpService:JSONDecode(encoded)
	local valid, reason = PlanValidator.validateBootstrap(bootstrap)
	assert(valid, "Prepared Studio bootstrap rejected: " .. tostring(reason))
	return root, bootstrap, source
end

local function httpRequest(method: string, path: string, body: any?, authorization: string?, baseUrl: string?, trialId: string?): any
	assert(isEdit or isServer, "HTTP belongs to Edit or the test server; Play clients use the private relay")
	local bearer = authorization or sessionToken
	if not validToken(bearer) then
		error("Prepared session token is invalid")
	end
	local target = baseUrl or sessionEndpoint
	if target == "" then
		error("Connect to a prepared session first")
	end
	local response = HttpService:RequestAsync({
		Url = normalizedEndpoint(target) .. path,
		Method = method,
		Headers = {
			["Authorization"] = "Bearer " .. bearer,
			["Content-Type"] = "application/json",
			["X-Basalt-Trial"] = if trialId ~= nil and trialId ~= "" then trialId else nil,
		},
		Compress = Enum.HttpCompression.None,
		Body = if body then HttpService:JSONEncode(body) else nil,
	})
	local responseBody = response.Body or ""
	if response.StatusCode == 401 then
		error("Server rejected this place's session token (HTTP 401). HTTP access works. Stop Play and open the exact Place path printed by the server, then reconnect.", 0)
	end
	if not response.Success then error("HTTP " .. tostring(response.StatusCode) .. ": " .. responseBody) end
	return HttpService:JSONDecode(responseBody)
end

local function request(method: string, path: string, body: any?, authorization: string?, baseUrl: string?, binding: string?): any
	if isEdit or isServer then return httpRequest(method, path, body, authorization, baseUrl, traceState.trialId) end
	assert(relayClient ~= nil, "No private connection to the Edit plugin; stop Play and reconnect")
	local publicGet = method == "GET" and (path == "/session" or path == "/sequence-view")
	return relayClient.request(method, path, body,
		if publicGet then "" else binding or (if session then session.sessionId else ""),
		if publicGet then "" else traceState.trialId)
end

local function attachRelay(peer: any)
	if not running or not peer.Connected or peer.Type ~= relaySetup.target or relayBindings[peer] ~= nil then return end
	if isEdit then
		if session == nil then return end -- buffered messages wait until Edit has authenticated
		local prepared, view, token, endpoint = session, sessionView, sessionToken, sessionEndpoint
		local root, source = connectedBootstrap, connectedBootstrapSource
		relayBindings[peer] = PlayRelay.bindEdit(peer, prepared, relayCodec, {
			active = function()
				local current = game:FindFirstChild(BOOTSTRAP_NAME)
				return running and session == prepared and current == root and current ~= nil
					and current:IsA("Script") and current.Source == source
			end,
			http = function(method, path, body, trialId)
				if path == "/submission" and captureState.submission == nil then
					-- Edit survives Stop. Retain the first sealed JSON payload before
					-- HTTP yields, so a lost client/response still permits an exact retry.
					captureState.submission = body
					traceState.trialId = trialId
					traceLabel.Text = "Trace: " .. trialId
					status.Text = "Submission pending. Retry submission if acceptance is not confirmed."
				end
				local receipt = httpRequest(method, path, body, token, endpoint, trialId)
				if session == prepared and path == "/submission" and type(receipt) == "table"
					and receipt.accepted == true and type(receipt.submissionHash) == "string" and validToken(receipt.submissionHash) then
					status.Text = "Evidence accepted: " .. receipt.submissionHash .. "\nReview the saved images next."
				end
				return receipt
			end,
			redact = function(message) return TrialTrace.redact(message, token) end,
			failure = function(message)
				trace("relay.request_failed", { error = message, targetId = peer.TargetId })
				status.Text = "Play request failed: " .. errorSummary(message)
			end,
			serverReady = function(endTest)
				serverControl = { session = prepared, peer = peer, endTest = endTest }
				trace("play.server_ready", { targetId = peer.TargetId })
			end,
			endTest = function(trialId, hash)
				assert(serverControl ~= nil and serverControl.session == prepared and serverControl.peer.Connected,
					"Evidence saved, but no Studio server control is available; stop Play manually")
				trace("play.end_test_requested", { submissionHash = hash }, trialId)
				serverControl.endTest(trialId, hash)
			end,
			view = function() return view end,
		})
	elseif isServer then
		relayBindings[peer] = PlayRelay.bindServer(peer, relayCodec, function(result) StudioTestService:EndTest(result) end)
	elseif Players.LocalPlayer ~= nil and relayClient == nil then
		relayClient = PlayRelay.client(peer, relayCodec, { now = os.clock, wait = function() task.wait(0.05) end })
		relayBindings[peer] = { Disconnect = function() relayClient.close() end }
	else return end
	trace("relay.connected", { role = if isEdit then "edit" else if isServer then "server" else "client", targetId = peer.TargetId })
end

local function pruneRelays()
	for peer, binding in relayBindings do
		if not peer.Connected then binding:Disconnect(); relayBindings[peer] = nil end
	end
end

local function refreshRelays()
	assert(relayAvailable, "Private Edit/Play relay unavailable: " .. tostring(if relayAvailable then "" else relaySetup))
	pruneRelays()
	for _, peer in relaySetup.service:GetPluginConnectionsOfType(relaySetup.target) do attachRelay(peer) end
end

local function flushTrace()
	if (if isEdit then traceToken == "" else traceSessionId == "") or #traceState.events == 0 then return end
	-- Concurrent callers can resend a batch: the server deduplicates sequences.
	-- A transition must wait for its events instead of skipping an active flush.
	local pending = traceState
	local client, token, endpoint, binding = traceClient, traceToken, traceEndpoint, traceSessionId
	for _ = 1, 8 do
		local batch = TrialTrace.batch(pending)
		if #batch == 0 then break end
		local ok, result = pcall(function()
			return request("POST", "/trace", { clientId = client, events = batch }, token, endpoint, binding)
		end)
		if ok and type(result) == "table" and result.accepted == true then
			TrialTrace.acknowledge(pending, batch[#batch].sequence)
			if traceDeliveryError ~= "" then traceDeliveryError = ""; trace("trace.delivery_resumed", {}) end
		else
			local message = TrialTrace.redact(tostring(result), pending.secret)
			if message ~= traceDeliveryError then
				traceDeliveryError = message
				print("[Basalt trace] Local file delivery failed; events retained in Studio Output: " .. message)
			end
			break
		end
	end
end

local function beginTrial(mode: string)
	local pending, prepared = traceState, session
	local response = request("POST", "/trial", { clientId = traceClient, mode = mode })
	if pending ~= traceState or prepared ~= session or not running then error("Session changed while starting trace trial") end
	if type(response) ~= "table" or type(response.trialId) ~= "string" then error("Invalid trial receipt") end
	TrialTrace.playArguments(response.trialId) -- validates the identifier before putting it in headers
	traceState.trialId = response.trialId
	traceLabel.Text = "Trace: " .. response.trialId
	local camera = workspace.CurrentCamera
	trace("trial.bound", { mode = mode, studioVersion = version(), runState = RunService.RunState.Name,
		hasClient = Players.LocalPlayer ~= nil, generation = captureState.generation,
		viewportWidth = if camera then camera.ViewportSize.X else 0,
		viewportHeight = if camera then camera.ViewportSize.Y else 0 })
	-- Read fixed environment settings for reproducibility; diagnostics must not
	-- prevent collection if this Studio context denies access to a setting.
	local measured, rendering = pcall(function()
		local renderingSettings = settings().Rendering
		return { graphicsMode = renderingSettings.GraphicsMode.Name, editQualityLevel = renderingSettings.EditQualityLevel.Name,
			qualityLevel = renderingSettings.QualityLevel.Name }
	end)
	trace("render.settings", if measured then rendering else { error = tostring(rendering) })
end

local function checkCaptureBackend()
	local result = request("POST", "/capture-ready", {})
	if type(result) ~= "table" or result.ready ~= true then error("Studio MCP readiness check failed") end
	return true
end

local function connectPreparedSession()
	if busy then return end
	if not isEdit and not isServer and Players.LocalPlayer == nil then
		status.Text = "Waiting for the Play client."
		return
	end
	busy = true
	local generation = captureState.generation
	status.Text = "Connecting to the prepared local session…"
	local ok, outcome: any = xpcall(function(): any
		if isServer then
			local bootstrapInstance, bootstrap, bootstrapSource = readBootstrap()
			if traceToken ~= bootstrap.token then
				traceToken = bootstrap.token
				traceEndpoint = bootstrap.connectorUrl
				traceState = TrialTrace.new(bootstrap.token)
				traceClient = string.lower((string.gsub(HttpService:GenerateGUID(false), "-", "")))
			end
			local result = httpRequest("GET", "/session", nil, bootstrap.token, bootstrap.connectorUrl)
			return { bootstrap = bootstrap, bootstrapInstance = bootstrapInstance,
				bootstrapSource = bootstrapSource, session = result }
		elseif not isEdit then
			refreshRelays()
			local deadline = os.clock() + 10
			while relayClient == nil and running and generation == captureState.generation and os.clock() < deadline do
				task.wait(0.1)
				refreshRelays()
			end
			local result = request("GET", "/session")
			return { session = result, view = request("GET", "/sequence-view"), relay = relayClient }
		end
		local bootstrapInstance, bootstrap, bootstrapSource = readBootstrap()
		if traceToken ~= bootstrap.token then
			traceToken = bootstrap.token
			traceEndpoint = bootstrap.connectorUrl
			traceState = TrialTrace.new(bootstrap.token)
			traceClient = string.lower((string.gsub(HttpService:GenerateGUID(false), "-", "")))
			captureTrialGeneration = -1
			-- This stays in Output even when the server rejects the place's token.
			trace("connection.prepared", { treatmentId = bootstrap.treatmentId,
				candidateHash = bootstrap.candidateHash, collectionPlanHash = bootstrap.collectionPlanHash,
				connectorUrl = bootstrap.connectorUrl, studioVersion = version() })
		end
		refreshRelays()
		local result = request("GET", "/session", nil, bootstrap.token, bootstrap.connectorUrl)
		local valid, reason = PlanValidator.validateSession(result)
		if not valid then
			error("Rejected session: " .. tostring(reason))
		end
		if result.treatmentId ~= bootstrap.treatmentId
			or result.candidateHash ~= bootstrap.candidateHash
			or result.collectionPlanHash ~= bootstrap.collectionPlanHash
			or result.connectorUrl ~= bootstrap.connectorUrl
		then
			error("Session response does not match the prepared place bootstrap")
		end
		local view = if isEdit then request("GET", "/sequence-view", nil, bootstrap.token, bootstrap.connectorUrl) else nil
		return {
			bootstrap = bootstrap,
			bootstrapInstance = bootstrapInstance,
			bootstrapSource = bootstrapSource,
			session = result,
			view = view,
		}
	end, traceback)
	busy = false
	if ok then
		local valid, reason = PlanValidator.validateSession(outcome.session)
		if not valid then ok = false; outcome = "Rejected session: " .. tostring(reason)
		end
	end
	-- RequestAsync yields: neither a Play transition nor a place change may install a stale response.
	if not running or generation ~= captureState.generation then return end
	if not ok then
		if tostring(outcome) ~= connectionError then
			connectionError = tostring(outcome)
			trace("connection.failed", { error = connectionError })
		end
		status.Text = "Automatic connection failed: " .. errorSummary(outcome)
		flushTrace()
		return
	end
	local connection = outcome :: any
	-- Revalidation must not wait across another Play/place transition.
	if isEdit or isServer then
		local currentReady, currentInstance, _, currentSource = pcall(readBootstrap)
		if not currentReady or currentInstance ~= connection.bootstrapInstance or currentSource ~= connection.bootstrapSource then
			clearConnection()
			status.Text = "Prepared place changed while connecting. Waiting to reconnect."
			return
		end
	elseif connection.relay ~= relayClient or not relayClient.connected() then
		clearConnection()
		status.Text = "Edit connection ended. Stop Play and reconnect."
		return
	end
	if isEdit then
		local configured, configureError = xpcall(function()
			StudioDeviceView.configure(connection.view, function(stage, data) trace(stage, data) end)
			publishRunIdentity(connection.session.sessionId)
		end, traceback)
		if not configured then
			clearConnection()
			connectionError = tostring(configureError)
			trace("connection.failed", { error = connectionError })
			status.Text = "Native viewport setup failed: " .. errorSummary(configureError)
			flushTrace()
			return
		end
		if not running or generation ~= captureState.generation then return end
		trace("connection.instrumented", { actorBinding = RUN_IDENTITY_NAME })
	end
	if session == nil or session.sessionId ~= connection.session.sessionId then
		CaptureState.reset(captureState)
		if isEdit then Collector.resetDiagnostics() end
	end
	sessionView = connection.view
	session = connection.session
	Collector.configureRoles(session.plan.roles)
	if isEdit or isServer then
		sessionToken = connection.bootstrap.token
		sessionEndpoint = normalizedEndpoint(connection.bootstrap.connectorUrl)
		connectedBootstrap = connection.bootstrapInstance
		connectedBootstrapSource = connection.bootstrapSource
		refreshRelays()
	elseif traceSessionId ~= session.sessionId then
		captureTrialGeneration = -1
		trace("connection.prepared", { treatmentId = session.treatmentId, candidateHash = session.candidateHash,
			collectionPlanHash = session.collectionPlanHash, studioVersion = version(), transport = "edit-plugin-relay" })
	end
	traceSessionId = session.sessionId
	connectionError = ""
	trace("connection.ready", { sessionId = session.sessionId, candidateHash = session.candidateHash,
		runState = RunService.RunState.Name, transport = if isEdit or isServer then "http" else "edit-plugin-relay" })
	updateRunState()
	captureButton.Text = if automated() then "Run capture" else "Capture phase"
	status.Text = "Connected to " .. session.treatmentId .. "\nCandidate " .. session.candidateHash .. "\n\n"
		.. (if captureState.submission then "Submission is sealed. Retry submission to resend."
			else if automated() then "Click Run capture, or start F5. Collection is automatic in the Play client."
			else phaseText(session.plan.phases[1]))
	widget.Enabled = true
	flushTrace()
end

reconnectButton.Activated:Connect(connectPreparedSession)

local function submit(): any
	local payload = CaptureState.seal(captureState, session.sessionId, version(), #session.plan.phases, Timestamp(DateTime.now().UnixTimestampMillis))
	trace("submission.started", { phases = #payload.phases })
	local receipt = request("POST", "/submission", payload)
	if type(receipt) ~= "table" or receipt.accepted ~= true or type(receipt.submissionHash) ~= "string" or not validToken(receipt.submissionHash) then
		error("Invalid submission receipt; retry the sealed submission")
	end
	trace("submission.accepted", { hash = receipt.submissionHash })
	return receipt
end

local function testArguments(): any
	if isEdit or RunService.RunState ~= Enum.RunState.Running then return nil end
	local ok, value = pcall(function() return StudioTestService:GetTestArgs() end)
	return if ok and type(value) == "table" then value else nil
end

local function localActor(plan: any): string
	local player = Players.LocalPlayer
	assert(player ~= nil, "Scenario client has no LocalPlayer")
	local deadline = os.clock() + 30
	repeat
		local players = Players:GetPlayers()
		if #players == plan.clients then
			table.sort(players, function(left, right)
				return if left.UserId == right.UserId then left.Name < right.Name else left.UserId < right.UserId
			end)
			for index, candidate in players do
				if candidate == player then return plan.actors[index] end
			end
		end
		assert(#players <= plan.clients, "Scenario received more players than the frozen plan")
		task.wait(0.05)
	until os.clock() >= deadline
	error("Scenario actor assignment timed out")
end

local function runScenario()
	if busy or session == nil or RunService.RunState ~= Enum.RunState.Running then return end
	local arguments = testArguments()
	if arguments == nil or type(arguments.basaltScenarioId) ~= "string"
		or type(arguments.basaltTrialId) ~= "string" then return end
	if scenarioGeneration == captureState.generation then return end
	local scenario = nil
	for _, candidate in session.plan.scenarios do
		if candidate.id == arguments.basaltScenarioId then scenario = candidate; break end
	end
	assert(scenario ~= nil, "Studio test arguments reference an unknown scenario")
	TrialTrace.playArguments(arguments.basaltTrialId)
	traceState.trialId = arguments.basaltTrialId
	local generation = captureState.generation
	scenarioGeneration = generation
	busy = true
	local context = if isServer then "server" else localActor(session.plan)
	local function active(): boolean
		return running and session ~= nil and generation == captureState.generation
			and RunService.RunState == Enum.RunState.Running
	end
	local ok, failure = xpcall(function()
		if isServer and session.plan.clients > 1 then
			local joinDeadline = os.clock() + 30
			repeat
				if #Players:GetPlayers() == 1 then break end
				assert(#Players:GetPlayers() < 2, "More clients joined than the staged launch requested")
				task.wait(0.05)
			until os.clock() >= joinDeadline
			assert(#Players:GetPlayers() == 1, "The first planned client did not join before staging")
			StudioTestService:AddPlayers(session.plan.clients - 1)
			trace("play.clients_added", { count = session.plan.clients - 1 }, arguments.basaltTrialId)
		end
		ScenarioRunner.run(session, scenario, context, isServer, {
			active = active,
			sequenceReady = function()
				assert(isServer, "Only the test server may release the scenario clock")
				local response = request("GET", "/runtime/" .. scenario.id .. "/sequence-ready")
				assert(type(response) == "table" and type(response.ready) == "boolean", "Invalid sequence readiness receipt")
				return response.ready
			end,
			-- Every scenario time uses the Studio server clock in this context. The
			-- sequence recorder aligns it to the host clock with bracketed probes.
			now = function() return workspace:GetServerTimeNow() end,
			wait = function(seconds) task.wait(seconds) end,
			spawn = function(callback) task.spawn(callback) end,
			collect = Collector.collectScenario,
			anchor = AnchorFact.evaluate,
			moveCharacter = function(path)
				return StudioCapture.moveCharacter(path, active, function(stage, data)
					data.scenarioId = scenario.id; data.context = context; trace(stage, data, arguments.basaltTrialId)
				end)
			end,
			placeOnPart = function(path)
				return StudioCapture.placeOnPart(path, active, function(stage, data)
					data.scenarioId = scenario.id; data.context = context; trace(stage, data, arguments.basaltTrialId)
				end)
			end,
			placeRelativeToPart = function(path, offset)
				return StudioCapture.placeRelativeToPart(path, offset, active, function(stage, data)
					data.scenarioId = scenario.id; data.context = context; trace(stage, data, arguments.basaltTrialId)
				end)
			end,
			moveRelativeToPart = function(path, offset)
				return StudioCapture.moveRelativeToPart(path, offset, active, function(stage, data)
					data.scenarioId = scenario.id; data.context = context; trace(stage, data, arguments.basaltTrialId)
				end)
			end,
			probeBarrier = function(path)
				return BarrierProbe.run(path, active, function(stage, data)
					data.scenarioId = scenario.id; data.context = context; trace(stage, data, arguments.basaltTrialId)
				end)
			end,
			pressKey = function(key)
				return StudioCapture.pressKey(key, active, function(stage, data)
					data.scenarioId = scenario.id; data.context = context; trace(stage, data, arguments.basaltTrialId)
				end)
			end,
			holdKey = function(key, durationMs)
				return StudioCapture.holdKey(key, durationMs, active, function(stage, data)
					data.scenarioId = scenario.id; data.context = context; trace(stage, data, arguments.basaltTrialId)
				end)
			end,
			activateGui = function(path)
				return StudioCapture.click(path, active, function(stage, data)
					data.scenarioId = scenario.id; data.context = context; trace(stage, data, arguments.basaltTrialId)
				end)
			end,
			enterText = function(path, text)
				return StudioCapture.enterText(path, text, active, function(stage, data)
					data.scenarioId = scenario.id; data.context = context; trace(stage, data, arguments.basaltTrialId)
				end)
			end,
			fireRemote = function(path, values)
				return StudioCapture.fireRemote(path, values, active, function(stage, data)
					data.scenarioId = scenario.id; data.context = context; trace(stage, data, arguments.basaltTrialId)
				end)
			end,
			disconnect = function()
				assert(not isServer and Players.LocalPlayer ~= nil, "Only a named client may disconnect")
				local service = StudioTestService :: any
				assert(service:CanLeaveTest(), "Studio refused the planned client disconnect")
				service:LeaveTest()
			end,
			post = function(body) return request("POST", "/runtime/" .. scenario.id, body) end,
			status = function() return request("GET", "/runtime/" .. scenario.id) end,
			endTest = function(value) StudioTestService:EndTest(value) end,
			trace = function(stage, data) trace(stage, data, arguments.basaltTrialId) end,
			-- The simulator setters error on the Play server, so only a client calls this.
			configureView = function()
				assert(not isServer, "Only a Play client may set its viewport")
				StudioDeviceView.configure(sessionView, function(stage, data)
					data.scenarioId = scenario.id; data.context = context; trace(stage, data, arguments.basaltTrialId)
				end)
			end,
		})
	end, traceback)
	if not ok then
		trace("trial.failed", { stage = "scenario", scenarioId = scenario.id,
			context = context, error = tostring(failure) }, arguments.basaltTrialId)
		flushTrace()
		if isServer then
			StudioTestService:EndTest({ basaltScenarioId = scenario.id, error = errorSummary(failure) })
		end
	end
	busy = false
end

local function capturePhases()
	if busy then return end
	if session == nil then status.Text = "Connect first."; return end
	if Players.LocalPlayer == nil or RunService.RunState ~= Enum.RunState.Running then
		status.Text = "Capture needs the running Play client. Resume Play or switch to Client view."; return
	end
	updateRunState()
	if captureState.submission then status.Text = "Submission is sealed. Prepare a new session to collect different evidence."; return end
	local generation = captureState.generation
	local capturedSession = session
	attemptedGeneration = generation
	busy = true
	local function active(): boolean
		return running and session == capturedSession and generation == captureState.generation
			and RunService.RunState == Enum.RunState.Running
	end
	local trialId = traceState.trialId
	local ok, result = xpcall(function()
		if captureTrialGeneration ~= generation then
			beginTrial("capture")
			captureTrialGeneration = generation
		end
		trialId = traceState.trialId
		if not active() then error("Capture cancelled while starting trace trial") end
		trace("collection.started", { phaseIndex = captureState.phaseIndex }, trialId)
		checkCaptureBackend()
		status.Text = "Studio capture backend ready. Collecting the planned phases…"
		repeat
			local phase = capturedSession.plan.phases[captureState.phaseIndex]
			if phase == nil then break end
			status.Text = "Collecting " .. phase.label .. ": input → readiness → observations → viewport capture"
			local observations, captures = PhaseCapture.collect(phase, {
				now = os.clock,
				wait = function(seconds) task.wait(seconds) end,
				active = active,
				actorReady = function()
					local player = Players.LocalPlayer
					local character = if player then player.Character else nil
					local humanoid = if character then character:FindFirstChildOfClass("Humanoid") else nil
					local head = if character then character:FindFirstChild("Head") else nil
					local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
					return workspace.CurrentCamera ~= nil and character ~= nil and character:IsDescendantOf(workspace)
						and humanoid ~= nil and humanoid.Health > 0 and head ~= nil and head:IsA("BasePart")
						and root ~= nil and root:IsA("BasePart")
				end,
				click = function(path)
					return StudioCapture.click(path, active, function(stage, data)
						data.phaseId = phase.id; trace(stage, data, trialId)
					end)
				end,
				moveCharacter = function(path)
					return StudioCapture.moveCharacter(path, active, function(stage, data)
						data.phaseId = phase.id; trace(stage, data, trialId)
					end)
				end,
				characterOnPart = function(path)
					local observed = Collector.collectScenario(
						{ id = "phase-target-support", kind = "actor_part_support", actor = "capture-actor", path = path },
						{ ["capture-actor"] = Players.LocalPlayer }
					)
					return observed.hitTarget == true
				end,
				collect = Collector.collect,
				trace = function(stage, data)
					if data.observations then data.observations = HttpService:JSONEncode(data.observations) end
					data.phaseId = phase.id
					trace(stage, data, trialId)
				end,
				capture = function(capture, targetPath)
					-- Take the inventory just before the frame; candidate text can instruct a judge.
					local roots: { Instance } = { workspace }
					local player = Players.LocalPlayer
					local playerGui = if player then player:FindFirstChildOfClass("PlayerGui") else nil
					local evaluatorLayer: Instance? = nil
					if playerGui then
						table.insert(roots, playerGui)
						if SceneText.declaresEvaluatorLayer(capturedSession.plan) then
							evaluatorLayer = SceneText.evaluatorLayer(playerGui)
						end
					end
					local sceneText = SceneText.inventory(roots, evaluatorLayer)
					local receipt = StudioCapture.capture(active, function()
                        return request("POST", "/captures/" .. phase.id .. "/" .. capture.id, { source = "studio-mcp" })
					end, function(stage, data)
						data.phaseId = phase.id; data.captureId = capture.id
						trace(stage, data, trialId)
					end, targetPath)
					if type(receipt) ~= "table" or receipt.captureId ~= capture.id or type(receipt.hash) ~= "string"
						or #receipt.hash ~= 64 or not string.match(receipt.hash, "^[a-f0-9]+$") then
						error("Invalid viewport capture receipt")
					end
					return { captureId = receipt.captureId, hash = receipt.hash, sceneText = sceneText }
				end,
			})
			if not CaptureState.record(captureState, generation, phase.id, observations, captures) then
				error("Capture attempt was cancelled")
			end
			flushTrace()
			if not active() then error("Capture cancelled during trace delivery") end
		until not automated()
		if capturedSession.plan.phases[captureState.phaseIndex] == nil then return submit() end
		return nil
	end, traceback)
	if not ok then trace("trial.failed", { error = tostring(result), phaseIndex = captureState.phaseIndex }, trialId) end
	flushTrace()
	if not running or session ~= capturedSession or generation ~= captureState.generation then busy = false; return end
	if not ok then busy = false; status.Text = "Capture incomplete: " .. errorSummary(result); return end
	if result then
		-- Stop only after the server confirms durable images and submission.
		trace("play.stop_requested", {}, trialId)
		flushTrace()
		if not active() then busy = false; return end
		local stopped, stopError = xpcall(function() relayClient.endTest(capturedSession.sessionId, trialId, result.submissionHash) end, traceback)
		if not stopped then trace("play.stop_failed", { error = tostring(stopError) }, trialId); flushTrace() end
		status.Text = "Evidence accepted: " .. tostring(result.submissionHash)
			.. (if stopped then "\nEndTest requested. Review the saved images next." else "\nStop Play: " .. tostring(stopError))
	else
		status.Text = phaseText(capturedSession.plan.phases[captureState.phaseIndex])
	end
	busy = false
end

captureButton.Activated:Connect(function()
	if busy then return end
	if session == nil then status.Text = "Connect first."; return end
	if captureState.submission then status.Text = "Submission is sealed. Use Retry submission."; return end
	if not isEdit then capturePhases(); return end
	if startingPlay then return end
	if not automated() then status.Text = "Start F5, perform the displayed phase, then click Capture phase."; return end
	startingPlay = true
	busy = true
	local generation = captureState.generation
	local preparedSession = session
	status.Text = "Checking the Studio MCP capture connection…"
	local permission, reason = xpcall(function()
		beginTrial("launch")
		checkCaptureBackend()
		return true
	end, traceback)
	busy = false
	if not running or generation ~= captureState.generation or preparedSession ~= session then startingPlay = false; return end
	if not permission then
		trace("trial.failed", { error = tostring(reason), stage = "preflight" })
		flushTrace()
		startingPlay = false
		if running and preparedSession == session then status.Text = "Capture cannot start: " .. errorSummary(reason) end
		return
	end
	status.Text = "Starting Play. Capture will begin when the client is ready."
	local trialId = traceState.trialId
	trace("play.requested", { method = "ExecutePlayModeAsync", argument = "table" }, trialId)
	flushTrace()
	if not running or preparedSession ~= session or generation ~= captureState.generation then startingPlay = false; return end
	local ok, failure = xpcall(function() return StudioTestService:ExecutePlayModeAsync(TrialTrace.playArguments(trialId)) end, traceback)
	-- ExecutePlayModeAsync yields until the test ends, not just until it starts.
	trace(if ok then "play.finished" else "trial.failed", { stage = "play", error = if ok then "" else tostring(failure),
		submissionHash = if ok and type(failure) == "table" and type(failure.submissionHash) == "string"
			and validToken(failure.submissionHash) then failure.submissionHash else "" }, trialId)
	flushTrace()
	startingPlay = false
	if not ok and running and preparedSession == session then status.Text = "Play could not start: " .. errorSummary(failure) end
end)

submitButton.Activated:Connect(function()
	if busy then return end
	if session == nil or captureState.submission == nil then status.Text = "No sealed submission to retry."; return end
	local submittedSession = session
	busy = true
	trace("submission.retry", {})
	local ok, result = xpcall(submit, traceback)
	busy = false
	if not ok then trace("trial.failed", { stage = "submission", error = tostring(result) }) end
	flushTrace()
	if not running or session ~= submittedSession then return end
	status.Text = if ok then "Evidence accepted: " .. tostring(result.submissionHash) else "Submission failed: " .. tostring(result)
end)

-- Property notifications catch Stop → F5 even between discovery polls; Pause keeps the same attempt.
local runStateConnection = RunService:GetPropertyChangedSignal("RunState"):Connect(updateRunState)
local controlsConnection = RunService.Heartbeat:Connect(updateControls)
updateRunState()

if relayAvailable then
	-- Subscribe before querying, so a connection created during startup is not lost.
	relayListener = relaySetup.service.Connected:Connect(attachRelay)
end

plugin.Unloading:Connect(function()
	trace("plugin.unloading", {})
	running = false
	runStateConnection:Disconnect()
	controlsConnection:Disconnect()
	if relayListener then relayListener:Disconnect() end
	for _, binding in relayBindings do binding:Disconnect() end
	Collector.disconnect()
	clearConnection()
end)

task.spawn(function()
	while running do
		updateControls()
		updateRunState()
		pruneRelays()
		if isServer then
			local ready, reason = pcall(function() refreshRelays(); return true end)
			if not ready and tostring(reason) ~= connectionError then
				connectionError = tostring(reason); trace("connection.failed", { error = connectionError })
			end
			if session == nil and not busy then connectPreparedSession() end
			local arguments = testArguments()
			if session ~= nil and arguments ~= nil and type(arguments.basaltScenarioId) == "string"
				and scenarioGeneration ~= captureState.generation and not busy then task.spawn(runScenario) end
		elseif not isEdit then
			if session == nil and Players.LocalPlayer ~= nil then connectPreparedSession() end
			local arguments = testArguments()
			if arguments ~= nil and type(arguments.basaltScenarioId) == "string" then
				if session ~= nil and scenarioGeneration ~= captureState.generation and not busy then task.spawn(runScenario) end
			elseif automated() and captureState.submission == nil and attemptedGeneration ~= captureState.generation
				and Players.LocalPlayer ~= nil and RunService.RunState == Enum.RunState.Running and not busy then
				task.spawn(capturePhases)
			end
		else
			local instance = game:FindFirstChild(BOOTSTRAP_NAME)
			if instance == nil then
				if connectedBootstrap ~= nil then
					clearConnection()
					status.Text = "Waiting for a prepared Basalt Studio session."
				end
			elseif instance:IsA("Script") then
				local sourceReady, source = pcall(function() return instance.Source end)
				local changed = instance ~= connectedBootstrap
					or not sourceReady
					or source ~= connectedBootstrapSource
				if session == nil or changed then
					if changed then clearConnection() end
					connectPreparedSession()
				end
			else
				clearConnection()
				status.Text = "Prepared Studio bootstrap has the wrong instance class."
			end
		end
		flushTrace()
		task.wait(2)
	end
end)

openButton.Click:Connect(function() widget.Enabled = not widget.Enabled end)
