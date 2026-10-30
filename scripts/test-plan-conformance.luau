local fs = require("@lune/fs")
local serde = require("@lune/serde")
local process = require("@lune/process")
local validator = require("./load-plan-validator")
local cases = serde.decode("json", fs.readFile(process.args[1]))
for _, case in cases do
	local accepted, reason = validator.validate(case.plan)
	assert(accepted == case.accepted, case.name .. ": TypeScript/Luau disagreement: " .. tostring(reason))
end
print("Cross-language conformance: " .. #cases .. " plans")
