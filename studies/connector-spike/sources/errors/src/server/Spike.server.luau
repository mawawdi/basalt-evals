--!strict
-- Error control of the connector spike: deliberate server errors. Each error text starts with
-- a unique tag, so a reader can match each recorded error to its origin:
--   SPIKE-S-SPAWN        a task.spawn thread of this Script
--   SPIKE-S-MODULE-CALL  a function of a required ModuleScript (Shared.Failing)
--   SPIKE-MODULE-LOAD    a ModuleScript that fails while it loads (Shared.Broken)
--   SPIKE-S-REMOTE       the OnServerEvent handler of a RemoteEvent
--   SPIKE-S-SCRIPT       the main thread of this Script, after a yield
-- The Script in StarterCharacterScripts adds SPIKE-S-CHARACTER.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")

local remote = Instance.new("RemoteEvent")
remote.Name = "SpikeErrorRemote"
remote.OnServerEvent:Connect(function(_player: Player, label: unknown)
	error("SPIKE-S-REMOTE error in a RemoteEvent handler, label " .. tostring(label))
end)
remote.Parent = ReplicatedStorage

task.spawn(function()
	error("SPIKE-S-SPAWN error in a task.spawn thread on the server")
end)

task.delay(1, function()
	local Failing = require(Shared:WaitForChild("Failing")) :: any
	Failing.fail("SPIKE-S-MODULE-CALL")
end)

task.delay(1.5, function()
	local _ = require(Shared:WaitForChild("Broken")) :: any
end)

task.wait(2)
error("SPIKE-S-SCRIPT error in the main thread of a server Script")
