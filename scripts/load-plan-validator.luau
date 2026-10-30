local fs = require("@lune/fs")
local luau = require("@lune/luau")
local catalog = require("../plugin/src/CapabilityCatalog")
return luau.load(fs.readFile("plugin/src/PlanValidator.luau"), {
	environment = {
		script = { Parent = { CapabilityCatalog = "CapabilityCatalog" } },
		require = function(name) assert(name == "CapabilityCatalog"); return catalog end,
	},
	injectGlobals = true,
})()
