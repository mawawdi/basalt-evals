--!strict

-- Diagnostics never enter observations or verdicts. Keep a bounded retry queue;
-- acknowledging one batch must not erase events produced while HTTP yielded.
local TrialTrace = {}
export type State = { sequence: number, trialId: string, secret: string, events: { any }, dropped: number }

function TrialTrace.new(secret: string): State
	return { sequence = 0, trialId = "", secret = secret, events = {}, dropped = 0 }
end

function TrialTrace.redact(value: string, secret: string): string
	local result = value
	if secret ~= "" then result = string.gsub(result, secret, "[REDACTED]") end
	result = string.gsub(result, "[Bb]earer%s+[%w%._~%+/%-]+=*", "Bearer [REDACTED]")
	result = string.gsub(result, "sk%-[%w_%-]+", "[REDACTED]")
	result = string.sub(result, 1, 4096)
	-- Do not split a UTF-8 code point at the bounded string boundary.
	while #result > 0 and utf8.len(result) == nil do result = string.sub(result, 1, #result - 1) end
	return result
end

function TrialTrace.record(state: State, stage: string, data: { [string]: any }, at: string, trialId: string?): any
	state.sequence += 1
	if #state.events >= 128 then table.remove(state.events, 1); state.dropped += 1 end
	local safe: { [string]: any } = { droppedEvents = state.dropped }
	local count = 0
	for key, value in data do
		if count >= 15 then break end
		local kind = type(value)
		if kind == "string" then safe[key] = TrialTrace.redact(value, state.secret)
		elseif kind == "boolean" or (kind == "number" and value == value and math.abs(value) < math.huge) then safe[key] = value end
		count += 1
	end
	if state.dropped > 0 then safe.droppedEvents = state.dropped end
	local event = { sequence = state.sequence, at = at, stage = stage, trialId = trialId or state.trialId, data = safe }
	table.insert(state.events, event)
	return event
end

function TrialTrace.batch(state: State): { any }
	local batch = {}
	for index = 1, math.min(#state.events, 16) do table.insert(batch, state.events[index]) end
	return batch
end

function TrialTrace.acknowledge(state: State, sequence: number)
	while #state.events > 0 and state.events[1].sequence <= sequence do table.remove(state.events, 1) end
end

function TrialTrace.playArguments(trialId: string): { basaltTrialId: string }
	assert(#trialId == 30 and string.match(trialId, "^trial%-[a-f0-9]+$"), "Start a trace trial before Play")
	-- nil is documented but is rejected by the installed Studio build. Always
	-- supply a concrete serializable argument table, containing no capability.
	return { basaltTrialId = trialId }
end

return table.freeze(TrialTrace)
