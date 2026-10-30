--!strict
-- Pure progression rules shared by every visual treatment.
local Progression = {}
export type State = { level: number, xp: number, actions: number }
Progression.threshold = 100
Progression.reward = 35

function Progression.initial(): State
	return { level = 1, xp = 80, actions = 0 }
end

function Progression.grant(state: State, amount: number): State
	assert(amount == amount and amount >= 0 and amount < math.huge and amount % 1 == 0, "XP must be a finite nonnegative integer")
	local total = state.xp + amount
	assert(total <= 9007199254740991, "XP exceeds exact integer range")
	return {
		level = state.level + math.floor(total / Progression.threshold),
		xp = total % Progression.threshold,
		actions = state.actions + 1,
	}
end

return table.freeze(Progression)
