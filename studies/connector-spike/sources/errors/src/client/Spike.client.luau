--!strict
-- Error control of the connector spike: deliberate client errors in a LocalScript of
-- StarterPlayerScripts. Each error text starts with a unique tag:
--   SPIKE-C-SPAWN        a task.spawn thread of this LocalScript
--   SPIKE-C-MODULE-CALL  a function of a required ModuleScript (Shared.Failing)
--   SPIKE-MODULE-LOAD    a ModuleScript that fails while it loads (Shared.Broken)
--   SPIKE-C-SCRIPT       the main thread of this LocalScript, after a yield
-- The LocalScript also fires the RemoteEvent, so the server handler records SPIKE-S-REMOTE.
-- The LocalScript in StarterCharacterScripts adds SPIKE-C-CHARACTER.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local remote = ReplicatedStorage:WaitForChild("SpikeErrorRemote") :: RemoteEvent

task.spawn(function()
	error("SPIKE-C-SPAWN error in a task.spawn thread on the client")
end)

task.delay(1, function()
	local Failing = require(Shared:WaitForChild("Failing")) :: any
	Failing.fail("SPIKE-C-MODULE-CALL")
end)

task.delay(1.5, function()
	local _ = require(Shared:WaitForChild("Broken")) :: any
end)

task.delay(2, function()
	remote:FireServer("from-client")
end)

task.wait(2.5)
error("SPIKE-C-SCRIPT error in the main thread of a LocalScript in StarterPlayerScripts")
