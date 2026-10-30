--!strict
-- Error control of the connector spike. This ModuleScript fails while it loads, so each
-- require of it fails. The server and the client each require it one time.
local function load(): { [string]: never }
	error("SPIKE-MODULE-LOAD error while a ModuleScript loads")
end

return load()
