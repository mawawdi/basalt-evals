-- Pure mechanic checks run without Studio, rendering, network or model calls.
local Progression = require("../studies/xp-ui/task/seed/src/shared/Progression")
local Checkpoint = require("../studies/checkpoint-feedback/task/seed/src/shared/CheckpointState")
local checks = 0
local function check(condition: boolean, reason: string)
	assert(condition, reason)
	checks += 1
end
local initial = Progression.initial()
local leveled = Progression.grant(initial, Progression.reward)
check(leveled.level == 2 and leveled.xp == 15 and leveled.actions == 1, "Threshold carry")
check(initial.level == 1 and initial.xp == 80 and initial.actions == 0, "No mutation of previous state")
local progress = Progression.grant(leveled, Progression.reward)
check(progress.level == 2 and progress.xp == 50 and progress.actions == 2, "Progress after leveling")
local exact = Progression.grant(initial, 20)
check(exact.level == 2 and exact.xp == 0, "Exact threshold")
local multiple = Progression.grant(initial, 250)
check(multiple.level == 4 and multiple.xp == 30, "Multiple levels in one grant")
for _, amount in { -1, 0.5, math.huge, 0/0, 9007199254740992 } do
	check(not pcall(Progression.grant, initial, amount), "Invalid grant must fail")
end
local before = Checkpoint.initial()
local active = Checkpoint.touch(before, "CheckpointA")
check(active.checkpoint == "CheckpointA" and active.activations == 1, "Records the touched checkpoint")
check(before.checkpoint == "" and before.activations == 0, "Per-player state is not shared")
for _ = 1, 12 do active = Checkpoint.touch(active, "CheckpointA") end
check(active.activations == 1, "Repeated limb contacts remain idempotent")
local other = Checkpoint.touch(active, "CheckpointB")
check(other.activations == 2 and other.checkpoint == "CheckpointB", "A distinct checkpoint advances state")
check(active.checkpoint == "CheckpointA", "Later transitions preserve earlier snapshots")
check(Checkpoint.initial().checkpoint == "" and active.checkpoint == "CheckpointA", "Reset creates fresh state")
check(not pcall(Checkpoint.touch, active, ""), "Empty checkpoint identities rejected")
print(string.format("Study fixture rules passed: %d checks", checks))
