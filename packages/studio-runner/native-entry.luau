--!strict
-- Trusted command-bar entry point. No evaluated source is inserted here. The
-- session capability is read from protected Source, never printed or replicated.
local HttpService = game:GetService("HttpService")
local StudioTestService = game:GetService("StudioTestService")
-- Command-bar HTTP obeys the place setting; plugin HTTP does not. Enable it only
-- for Edit control requests, then restore the candidate's setting before Play.
local originalHttpEnabled = HttpService.HttpEnabled
HttpService.HttpEnabled = true
local root = game:FindFirstChild("BasaltEvalBootstrap")
assert(root and root:IsA("Script"), "Native worker requires a prepared place")
local encoded = string.match(root.Source, "^%-%-%[%[\nbasalt%-evals/studio%-bootstrap\n([^\n]+)\n%]%]%s*$")
assert(encoded, "Invalid prepared bootstrap")
local bootstrap = HttpService:JSONDecode(encoded)
assert(type(bootstrap.token) == "string" and #bootstrap.token == 64
	and string.match(bootstrap.token, "^[a-f0-9]+$"), "Invalid session capability")
assert(type(bootstrap.connectorUrl) == "string"
	and string.match(bootstrap.connectorUrl, "^http://127%.0%.0%.1:%d+$"), "Worker requires loopback")
local jobId = "__BASALT_JOB_ID__"
local stepId = "__BASALT_STEP_ID__"
local trialId: string? = nil
local function request(method: string, path: string, body: any?): any
	local response = HttpService:RequestAsync({
		Url = bootstrap.connectorUrl .. path,
		Method = method,
		Headers = {
			Authorization = "Bearer " .. bootstrap.token,
			["Content-Type"] = "application/json",
			["X-Basalt-Trial"] = trialId,
		},
		Body = if body then HttpService:JSONEncode(body) else nil,
	})
	assert(response.Success, "Native worker request failed: " .. tostring(response.StatusCode) .. " " .. response.Body)
	return HttpService:JSONDecode(response.Body)
end
local deadline = os.clock() + 30
repeat
	local ready = request("GET", "/worker-ready", nil)
	assert(ready.jobId == jobId, "Native job identity mismatch")
	if ready.ready then break end
	assert(os.clock() < deadline, "Edit plugin did not become ready within 30 seconds")
	task.wait(0.1)
until false
local session = request("GET", "/session", nil)
assert(session.candidateHash == bootstrap.candidateHash and session.collectionPlanHash == bootstrap.collectionPlanHash,
	"Native candidate binding mismatch")
assert(type(session.plan.clients) == "number" and session.plan.clients >= 1 and session.plan.clients <= 8,
	"Native worker received an invalid client count")
assert(type(session.plan.scenarios) == "table", "Native worker received an invalid scenario plan")
for _, phase in session.plan.phases do
	assert(phase.driver.kind ~= "manual", "Native worker requires an entirely driven plan")
end
trialId = request("POST", "/trial", {clientId = jobId, mode = "launch"}).trialId
assert(type(trialId) == "string" and #trialId == 30 and string.match(trialId, "^trial%-[a-f0-9]+$"), "Invalid trial ID")
print("[Basalt native] Step " .. stepId .. " started: " .. trialId)
HttpService.HttpEnabled = originalHttpEnabled
local testService = StudioTestService :: any
if stepId ~= "presentation" then
	local scenario = nil
	for _, candidate in session.plan.scenarios do
		if candidate.id == stepId then scenario = candidate; break end
	end
	assert(scenario ~= nil, "Native worker step is not in the frozen plan")
	-- Start one client first; the server plugin adds the remaining declared
	-- clients after that first player joins. This avoids launching them together.
	local runtime = testService:ExecuteMultiplayerTestAsync(1, {
		basaltTrialId = trialId,
		basaltScenarioId = stepId,
	})
	assert(type(runtime) == "table" and runtime.basaltScenarioId == stepId
		and type(runtime.runtimeHash) == "string" and #runtime.runtimeHash == 64,
		"Multiplayer scenario ended without bound runtime evidence")
	print("[Basalt native] Step complete: " .. stepId .. " " .. runtime.runtimeHash)
	return
end
HttpService.HttpEnabled = true
assert(request("POST", "/capture-ready", {}).ready == true, "Capture backend is not ready")
HttpService.HttpEnabled = originalHttpEnabled
local result = StudioTestService:ExecutePlayModeAsync({basaltTrialId = trialId, basaltPresentation = true})
assert(type(result) == "table" and result.basaltTrialId == trialId and type(result.submissionHash) == "string",
	"Play ended without the bound submission receipt")
HttpService.HttpEnabled = true
assert(request("POST", "/worker-complete", {jobId = jobId, submissionHash = result.submissionHash}).accepted,
	"Worker completion was not accepted")
HttpService.HttpEnabled = originalHttpEnabled
print("[Basalt native] Complete: " .. trialId)
