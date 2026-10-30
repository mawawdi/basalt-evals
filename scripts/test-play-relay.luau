-- Separate simulated Edit and Play contexts, communicating only serialized JSON.
-- No Studio APIs, HTTP requests, native captures or model calls are made here.
local PlayRelay = require("../plugin/src/PlayRelay")
local TrialTrace = require("../plugin/src/TrialTrace")
local serde = require("@lune/serde")
local codec = {
	encode = function(value) return serde.encode("json", value) end,
	decode = function(value) return serde.decode("json", value) end,
}
local token = string.rep("e", 64)
local session = { sessionId = "studio-example", plan = { phases = {{ id = "peak", captures = {{ id = "image" }} }} } }
local trialId = "trial-" .. string.rep("a", 24)
local view = { schema = "basalt-evals/sequence-view", viewport = { width = 1280, height = 720 } }

local function fixture(manual, controls)
	local wire, transmitted, calls, failures = {}, {}, {}, {}
	local active, now = true, 0
	local edit, play = { Connected = true }, { Connected = true }
	for _, pair in {{edit, play}, {play, edit}} do
		local sender, receiver = pair[1], pair[2]
		function sender:BindToMessage(callback)
			assert(self.callback == nil, "Only one handler per connection")
			self.callback = callback
			return { Disconnect = function() self.callback = nil end }
		end
		function sender:SendMessage(message)
			assert(type(message) == "string", "Native plugin messaging requires string or buffer")
			table.insert(transmitted, message)
			table.insert(wire, { receiver = receiver, message = message })
		end
	end
	local function pump()
		now += 1
		local message = table.remove(wire, 1)
		if message and message.receiver.callback then message.receiver.callback(message.message) end
	end
	local http = function(method, path, body, trial)
		table.insert(calls, { method = method, path = path, body = body, trial = trial })
		return { accepted = true, path = path }
	end
	local binding = PlayRelay.bindEdit(edit, session, codec, {
		active = function() return active end,
		http = function(...) return http(...) end,
		redact = function(message) return TrialTrace.redact(message, token) end,
		failure = function(message) table.insert(failures, message) end,
		serverReady = function(callback) assert(controls); controls.endTest = callback end,
		endTest = function(trial, hash) assert(controls); controls.endTest(trial, hash) end,
		view = function() return view end,
	})
	local client = PlayRelay.client(play, codec, {
		now = function() return now end,
		wait = if manual then function() coroutine.yield() end else pump,
	})
	return {
		client = client, edit = edit, play = play, wire = wire, transmitted = transmitted,
		calls = calls, failures = failures, pump = pump, binding = binding,
		setHttp = function(value) http = value end,
		invalidate = function() active = false end,
		advance = function(seconds) now += seconds end,
	}
end

local passed = 0
local function test(name, run)
	local ok, reason = pcall(run)
	assert(ok, name .. ": " .. tostring(reason))
	passed += 1
end
local function reject(run, pattern)
	local ok, reason = pcall(run)
	assert(not ok and string.find(tostring(reason), pattern, 1, true), tostring(reason))
end

test("Client discovery and every evidence route use only Edit HTTP", function()
	local f = fixture()
	local public = f.client.request("GET", "/session", nil, "", "")
	assert(public.sessionId == session.sessionId and public.token == nil and #f.calls == 0)
	for _, path in {"/trial", "/trace", "/capture-ready", "/captures/peak/image", "/submission"} do
		local receipt = f.client.request("POST", path, { phase = "peak" }, session.sessionId, trialId)
		assert(receipt.accepted and receipt.path == path)
		assert(f.calls[#f.calls].path == path and f.calls[#f.calls].trial == trialId)
	end
	assert(#f.calls == 5)
	for _, message in f.transmitted do assert(not string.find(message, token, 1, true)) end
end)

test("A client reads the frozen sequence view from Edit without HTTP", function()
	local f = fixture()
	local received = f.client.request("GET", "/sequence-view", nil, "", "")
	assert(received.schema == view.schema and received.viewport.width == 1280 and received.viewport.height == 720)
	assert(#f.calls == 0 and #f.failures == 0)
	-- Like the session, the view is public: a bound form of the route is not a route.
	reject(function() f.client.request("GET", "/sequence-view", nil, session.sessionId, "") end, "binding rejected")
end)

test("Reject other sessions, undeclared captures, URLs and header injection", function()
	local f = fixture()
	for _, args in {
		{"POST", "/submission", {}, "studio-other", trialId},
		{"POST", "/captures/other/image", {}, session.sessionId, trialId},
		{"POST", "https://example.com", {}, session.sessionId, trialId},
		{"DELETE", "/session", {}, session.sessionId, trialId},
		{"POST", "/trace", {}, session.sessionId, "trial-bad\r\nInjected: yes"},
	} do reject(function() f.client.request(table.unpack(args)) end, "binding rejected") end
	assert(#f.calls == 0)
end)

test("Duplicate and malformed wire requests never repeat side effects", function()
	local f = fixture()
	f.client.request("POST", "/submission", {}, session.sessionId, trialId)
	f.edit.callback(f.transmitted[1])
	f.edit.callback("not json")
	f.edit.callback(codec.encode({ id = 2, method = "POST", path = "/submission", body = {},
		sessionId = session.sessionId, trialId = trialId, url = "https://example.com" }))
	assert(#f.calls == 1 and #f.failures == 3)
end)

test("Edit errors propagate without leaking its credential", function()
	local f = fixture()
	f.setHttp(function() error("Auth failed for " .. token) end)
	reject(function() f.client.request("POST", "/trace", {}, session.sessionId, trialId) end, "Auth failed")
	for _, message in f.transmitted do assert(not string.find(message, token, 1, true)) end
	assert(not string.find(f.failures[1], token, 1, true))
end)

test("Oversized Edit replies fail explicitly without waiting for a timeout", function()
	local f = fixture()
	f.setHttp(function() return { data = string.rep("a", 1024 * 1024) } end)
	reject(function() f.client.request("POST", "/trace", {}, session.sessionId, trialId) end, "exceeds 1 MiB")
	assert(#f.failures == 1)
end)

test("A changed Edit session cannot forward or accept an old request", function()
	local f = fixture()
	f.invalidate()
	reject(function() f.client.request("POST", "/submission", {}, session.sessionId, trialId) end, "session changed")
	assert(#f.calls == 0)
	local g = fixture()
	g.setHttp(function() g.invalidate(); return { accepted = true } end)
	reject(function() g.client.request("POST", "/submission", {}, session.sessionId, trialId) end, "session changed during")
end)

test("Out-of-order responses stay paired with their requesting coroutine", function()
	local f, results = fixture(true), {}
	local function start(path)
		local thread = coroutine.create(function() results[path] = f.client.request("POST", path, {}, session.sessionId, trialId) end)
		assert(coroutine.resume(thread)); return thread
	end
	local first, second = start("/trace"), start("/submission")
	f.pump(); f.pump() -- Edit starts requests in native message order.
	f.wire[1], f.wire[2] = f.wire[2], f.wire[1]
	f.pump(); f.pump()
	assert(coroutine.resume(first)); assert(coroutine.resume(second))
	assert(results["/trace"].path == "/trace")
	assert(results["/submission"].path == "/submission")
end)

test("Disconnect cancels a pending request and releases its slot", function()
	local f, failure = fixture(true), nil
	local thread = coroutine.create(function()
		local ok, reason = pcall(f.client.request, "POST", "/submission", {}, session.sessionId, trialId)
		assert(not ok); failure = tostring(reason)
	end)
	assert(coroutine.resume(thread))
	f.play.Connected = false
	assert(coroutine.resume(thread))
	assert(string.find(failure, "disconnected during", 1, true))
	assert(#f.calls == 0)
end)

test("Timeouts report uncertainty; a late receipt cannot complete another call", function()
	local f = fixture(true)
	local thread = coroutine.create(function()
		reject(function() f.client.request("POST", "/submission", {}, session.sessionId, trialId) end, "outcome unknown")
	end)
	assert(coroutine.resume(thread)); f.advance(121); assert(coroutine.resume(thread))
	f.pump(); f.pump() -- late response belongs to a removed slot
	local response = nil
	local second = coroutine.create(function() response = f.client.request("POST", "/trace", {}, session.sessionId, trialId) end)
	assert(coroutine.resume(second)); assert(response == nil)
	f.pump(); f.pump(); assert(coroutine.resume(second))
	assert(response.path == "/trace")
end)

test("Pending requests and payloads are bounded; unload cancels waiters", function()
	local f, threads = fixture(true), {}
	for _ = 1, 8 do
		local thread = coroutine.create(function()
			reject(function() f.client.request("POST", "/trace", {}, session.sessionId, trialId) end, "disconnected")
		end)
		assert(coroutine.resume(thread)); table.insert(threads, thread)
	end
	reject(function() f.client.request("POST", "/trace", {}, session.sessionId, trialId) end, "Too many pending")
	f.client.close()
	for _, thread in threads do assert(coroutine.resume(thread)) end
	assert(f.play.callback == nil)
	local g = fixture()
	reject(function() g.client.request("POST", "/trace", { data = string.rep("a", 1024 * 1024) }, session.sessionId, trialId) end, "exceeds 1 MiB")
	assert(#g.wire == 0)
end)

test("Only an accepted client receipt can end the test through Edit and the server", function()
	local controls, results = {}, {}
	local server = fixture(false, controls)
	server.client.close()
	PlayRelay.bindServer(server.play, codec, function(result) table.insert(results, result) end)
	server.pump() -- server-ready registers its private EndTest channel with Edit
	local client = fixture(false, controls)
	local hash = string.rep("a", 64)
	reject(function() client.client.request("POST", "/control/end-test", { submissionHash = hash }, session.sessionId, trialId) end, "accepted submission")
	assert(#results == 0 and #client.calls == 0)
	client.setHttp(function() return { accepted = true, submissionHash = hash } end)
	client.client.request("POST", "/submission", {}, session.sessionId, trialId)
	reject(function() client.client.request("POST", "/control/end-test", { submissionHash = string.rep("b", 64) }, session.sessionId, trialId) end, "accepted submission")
	client.client.endTest(session.sessionId, trialId, hash)
	client.pump(); server.pump()
	assert(#results == 1 and results[1].submissionHash == hash and results[1].basaltTrialId == trialId)
	assert(#server.calls == 0, "The server never performs HTTP")
end)

test("EndTest failures reach Edit; a server cannot submit client evidence", function()
	local controls = {}
	local server = fixture(false, controls)
	server.client.close()
	PlayRelay.bindServer(server.play, codec, function() error("EndTest unavailable") end)
	server.pump()
	controls.endTest(trialId, string.rep("a", 64))
	server.pump(); server.pump()
	assert(string.find(server.failures[1], "EndTest unavailable", 1, true))
	server.edit.callback(codec.encode({ id = 1, method = "POST", path = "/submission", body = {}, sessionId = session.sessionId, trialId = trialId }))
	assert(#server.calls == 0 and string.find(server.failures[2], "cannot issue client evidence", 1, true))
end)

print("Play relay regression tests passed: " .. tostring(passed))
return true
