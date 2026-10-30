--!strict
-- Error control of the connector spike. A caller gives the tag of its side, so the stack trace
-- shows a ModuleScript frame below the frame of the caller.
local Failing = {}

function Failing.fail(tag: string)
	error(tag .. " error in a function of a required ModuleScript")
end

return Failing
