--!strict

-- Start every fact in a scenario step on the same acquisition boundary.
-- Preserve declared order in the signed report while long samplers run together.
local ObservationBatch = {}

function ObservationBatch.collect(requests: { any }, context: string, actors: { [string]: any }, io: any): { any }
	local facts = {}
	for _, request in requests do
		if request.context == context then table.insert(facts, request.fact) end
	end
	local observations = table.create(#facts)
	local pending = #facts
	local failure: string? = nil
	local spawn = if io.spawn then io.spawn else task.spawn
	for index, fact in facts do
		spawn(function()
			local ok, result = pcall(io.collect, fact, actors)
			if ok then
				observations[index] = result
			else
				failure = tostring(result)
			end
			pending -= 1
		end)
	end
	while pending > 0 do io.wait(0.01) end
	if failure then error(failure) end
	return observations
end

return table.freeze(ObservationBatch)
