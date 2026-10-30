--!strict

-- Private PluginConnection messages only: never expose this transport through a
-- game RemoteEvent. Edit owns HTTP; Play owns input, observations and markers.
local PlayRelay = {}
local MAX_BYTES = 1024 * 1024
local MAX_PENDING = 8
local TIMEOUT_SECONDS = 120

export type Binding = { Disconnect: (any) -> () }
export type Peer = {
	Connected: boolean,
	BindToMessage: (any, (any) -> ()) -> Binding,
	SendMessage: (any, string) -> (),
}
export type Codec = { encode: (any) -> string, decode: (string) -> any }

local function encode(codec: Codec, value: any): string
	local encoded = codec.encode(value)
	assert(#encoded <= MAX_BYTES, "Play relay message exceeds 1 MiB")
	return encoded
end

local function decode(codec: Codec, message: any): any
	assert(type(message) == "string" and #message <= MAX_BYTES, "Invalid Play relay message size or type")
	local value = codec.decode(message)
	assert(type(value) == "table", "Invalid Play relay envelope")
	return value
end

local function validId(id: any): boolean
	return type(id) == "number" and id >= 1 and id <= 2147483647 and id == math.floor(id)
end

local function validHash(value: any): boolean
	return type(value) == "string" and #value == 64 and string.match(value, "^[a-f0-9]+$") ~= nil
end

local function validTrial(value: any): boolean
	return type(value) == "string" and #value == 30 and string.match(value, "^trial%-[a-f0-9]+$") ~= nil
end

local function allowed(request: any, session: any): boolean
	for key in request do
		if key ~= "id" and key ~= "sessionId" and key ~= "method" and key ~= "path"
			and key ~= "body" and key ~= "trialId" then return false end
	end
	if type(request.trialId) ~= "string" or (request.trialId ~= ""
		and (#request.trialId ~= 30 or string.match(request.trialId, "^trial%-[a-f0-9]+$") == nil)) then return false end
	if request.method == "GET" then
		-- The session and the frozen sequence view are public and hold no token.
		if request.path == "/session" or request.path == "/sequence-view" then
			return request.body == nil and request.sessionId == "" and request.trialId == ""
		end
		return string.match(request.path, "^/runtime/[%w%._:%-]+$") ~= nil
			and request.body == nil and request.sessionId == session.sessionId and validTrial(request.trialId)
	end
	if request.method ~= "POST" or request.sessionId ~= session.sessionId or type(request.body) ~= "table" then return false end
	if request.path == "/control/end-test" then
		for key in request.body do if key ~= "submissionHash" then return false end end
		return validTrial(request.trialId) and validHash(request.body.submissionHash)
	end
	if request.path == "/trial" or request.path == "/trace" or request.path == "/capture-ready"
		or request.path == "/submission" or string.match(request.path, "^/runtime/[%w%._:%-]+$") ~= nil then return true end
	for _, phase in session.plan.phases do
		for _, capture in phase.captures do
			if request.path == "/captures/" .. phase.id .. "/" .. capture.id then return true end
		end
	end
	return false
end

function PlayRelay.bindEdit(peer: Peer, session: any, codec: Codec, io: {
	active: () -> boolean,
	http: (string, string, any, string) -> any,
	redact: (string) -> string,
	failure: (string) -> (),
	serverReady: ((string, string) -> ()) -> (),
	endTest: (string, string) -> (),
	view: () -> any,
}): Binding
	local lastId, pending = 0, 0
	local serverPeer = false
	local acceptedHash, acceptedTrial = "", ""
	return peer:BindToMessage(function(message)
		local parsed, request = pcall(decode, codec, message)
		local serverHello = parsed and request.control == "server-ready"
		if serverHello then
			for key in request do if key ~= "control" then serverHello = false end end
		end
		if serverHello and lastId == 0 and not serverPeer and peer.Connected and io.active() then
			serverPeer = true
			io.serverReady(function(trialId, hash)
				assert(peer.Connected and io.active(), "Studio test server disconnected")
				assert(validTrial(trialId) and validHash(hash), "Invalid EndTest binding")
				peer:SendMessage(encode(codec, { control = "end-test", trialId = trialId, submissionHash = hash }))
			end)
			return
		end
		if parsed and serverPeer and request.control == "server-failed" then
			io.failure("Studio EndTest failed: " .. io.redact(tostring(request.error))); return
		end
		if not parsed or not validId(request.id) then io.failure("Invalid Play relay request"); return end
		local ok, result = pcall(function()
			assert(not serverPeer, "Test server cannot issue client evidence requests")
			assert(request.id > lastId, "Duplicate or out-of-order Play relay request")
			lastId = request.id
			assert(peer.Connected and io.active(), "Prepared Edit session changed or disconnected; stop Play and reconnect")
			assert(allowed(request, session), "Play relay route or session binding rejected")
			assert(pending < MAX_PENDING, "Too many pending Play relay requests")
			pending += 1
			local succeeded, response = pcall(function()
				if request.method == "GET" and request.path == "/sequence-view" then return io.view() end
				if request.method == "GET" then return session end -- public, already validated; contains no token
				if request.path == "/control/end-test" then
					assert(request.body.submissionHash == acceptedHash and request.trialId == acceptedTrial,
						"EndTest requires this client's accepted submission receipt")
					io.endTest(acceptedTrial, acceptedHash)
					return { requested = true }
				end
				return io.http(request.method, request.path, request.body, request.trialId)
			end)
			pending -= 1
			assert(peer.Connected and io.active(), "Prepared Edit session changed during the request")
			if not succeeded then error(response, 0) end
			if request.path == "/submission" and type(response) == "table" and response.accepted == true
				and validHash(response.submissionHash) then
				acceptedHash, acceptedTrial = response.submissionHash, request.trialId
			end
			return response
		end)
		local response = if ok then { id = request.id, ok = true, value = result }
			else { id = request.id, ok = false, error = io.redact(tostring(result)) }
		if not ok then io.failure(io.redact(tostring(result))) end
		local serialized, encoded = pcall(encode, codec, response)
		if not serialized then
			local failureMessage = io.redact(tostring(encoded))
			io.failure(failureMessage)
			encoded = codec.encode({ id = request.id, ok = false, error = failureMessage })
		end
		local sent, failure = pcall(function()
			if peer.Connected then peer:SendMessage(encoded) end
		end)
		if not sent then io.failure(io.redact(tostring(failure))) end
	end)
end

-- The server receives only a fixed EndTest command from its originating Edit
-- plugin. No game remotes, token handoff, or server-side HTTP are needed.
function PlayRelay.bindServer(peer: Peer, codec: Codec, endTest: (any) -> ()): Binding
	local binding = peer:BindToMessage(function(message)
		local ok, reason = pcall(function()
			local command = decode(codec, message)
			for key in command do
				assert(key == "control" or key == "trialId" or key == "submissionHash", "Invalid EndTest command")
			end
			assert(command.control == "end-test" and validTrial(command.trialId) and validHash(command.submissionHash), "Invalid EndTest binding")
			endTest({ basaltTrialId = command.trialId, submissionHash = command.submissionHash })
		end)
		if not ok and peer.Connected then
			peer:SendMessage(encode(codec, { control = "server-failed", error = string.sub(tostring(reason), 1, 4096) }))
		end
	end)
	peer:SendMessage(encode(codec, { control = "server-ready" }))
	return binding
end

function PlayRelay.client(peer: Peer, codec: Codec, io: { now: () -> number, wait: () -> () })
	local nextId, count = 0, 0
	local closed = false
	local pending: { [number]: any } = {}
	local binding = peer:BindToMessage(function(message)
		local ok, response = pcall(decode, codec, message)
		if not ok or not validId(response.id) or type(response.ok) ~= "boolean" then return end
		local slot = pending[response.id]
		if slot ~= nil and slot.response == nil then slot.response = response end
	end)
	return {
		connected = function(): boolean return not closed and peer.Connected end,
		close = function() closed = true; binding:Disconnect() end,
		endTest = function(sessionId: string, trialId: string, hash: string)
			assert(not closed and peer.Connected, "Play relay disconnected before EndTest")
			nextId += 1
			-- Ending the test destroys this client. Edit reports any failure and the
			-- launch coroutine records EndTest's return value; do not await teardown.
			peer:SendMessage(encode(codec, { id = nextId, method = "POST", path = "/control/end-test",
				sessionId = sessionId, trialId = trialId, body = { submissionHash = hash } }))
		end,
		request = function(method: string, path: string, body: any?, sessionId: string, trialId: string): any
			assert(not closed and peer.Connected, "Play relay disconnected; stop Play and reconnect")
			assert(count < MAX_PENDING, "Too many pending Play relay requests")
			nextId += 1
			local id = nextId
			local message = encode(codec, { id = id, method = method, path = path, body = body, sessionId = sessionId, trialId = trialId })
			local slot: any = {}
			pending[id] = slot
			count += 1
			local ok, result = pcall(function()
				peer:SendMessage(message)
				local deadline = io.now() + TIMEOUT_SECONDS
				while slot.response == nil do
					assert(not closed and peer.Connected, "Play relay disconnected during request; check the trial trace before retrying")
					assert(io.now() < deadline, "Play relay request timed out; outcome unknown, check the trial trace before retrying")
					io.wait()
				end
				assert(not closed and peer.Connected, "Play relay disconnected before receipt")
				if not slot.response.ok then error(tostring(slot.response.error), 0) end
				return slot.response.value
			end)
			pending[id] = nil
			count -= 1
			if not ok then error(result, 0) end
			return result
		end,
	}
end

return table.freeze(PlayRelay)
