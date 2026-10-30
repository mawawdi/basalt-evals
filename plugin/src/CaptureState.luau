--!strict

-- Own one Play attempt. Generation checks discard collectors that yielded across Stop.
-- A submitted payload stays sealed for exact retries, even if the response was lost.
local CaptureState = {}

export type State = {
	generation: number,
	playing: boolean,
	phaseIndex: number,
	captured: { any },
	startedAt: string,
	submission: any?,
}

function CaptureState.new(): State
	return { generation = 0, playing = false, phaseIndex = 1, captured = {}, startedAt = "", submission = nil }
end

function CaptureState.reset(state: State)
	state.generation += 1
	state.playing = false
	state.phaseIndex = 1
	state.captured = {}
	state.startedAt = ""
	state.submission = nil
end

function CaptureState.setPlaying(state: State, playing: boolean, now: string): boolean
	if state.playing == playing then return false end
	state.generation += 1
	state.playing = playing
	if state.submission == nil then
		state.phaseIndex = 1
		state.captured = {}
		state.startedAt = if playing then now else ""
	end
	return true
end

function CaptureState.record(state: State, generation: number, phaseId: string, observations: { any }, captures: { any }): boolean
	if generation ~= state.generation or not state.playing or state.submission ~= nil then return false end
	table.insert(state.captured, { phaseId = phaseId, observations = observations, captures = captures })
	state.phaseIndex += 1
	return true
end

function CaptureState.seal(state: State, sessionId: string, studioVersion: string, phaseCount: number, now: string): any
	if state.submission ~= nil then return state.submission end
	if not state.playing then error("Submit before stopping Play.") end
	if #state.captured ~= phaseCount then error("Capture every phase before submitting.") end
	local payload = {
		schema = "basalt-evals/studio-submission",
		sessionId = sessionId,
		studioVersion = studioVersion,
		startedAt = state.startedAt,
		endedAt = now,
		phases = state.captured,
	}
	state.submission = payload
	return payload
end

return table.freeze(CaptureState)
