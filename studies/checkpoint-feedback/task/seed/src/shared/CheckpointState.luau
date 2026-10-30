--!strict
-- Only the server invokes this reducer in Studio. Repeated limb contacts must
-- not grant multiple activations; leaving the pad does not erase progress.
local CheckpointState = {}
export type State = { checkpoint: string, activations: number }
function CheckpointState.initial(): State
	return { checkpoint = "", activations = 0 }
end
function CheckpointState.touch(state: State, checkpoint: string): State
	assert(checkpoint ~= "", "Checkpoint identity must be server-derived and nonempty")
	if state.checkpoint == checkpoint then return state end
	return { checkpoint = checkpoint, activations = state.activations + 1 }
end
return table.freeze(CheckpointState)
