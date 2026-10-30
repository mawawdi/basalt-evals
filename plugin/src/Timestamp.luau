--!strict

-- DateTime:ToIsoDate() omits fractional seconds in Studio. Serialize the actual
-- Unix millisecond value in the same canonical UTC format as the host contract.
return function(unixMilliseconds: number): string
	assert(unixMilliseconds >= 0 and unixMilliseconds < 253402300800000 and unixMilliseconds % 1 == 0,
		"Timestamp must be an integer Unix millisecond value within years 1970–9999")
	return os.date("!%Y-%m-%dT%H:%M:%S", math.floor(unixMilliseconds / 1000))
		.. string.format(".%03dZ", unixMilliseconds % 1000)
end
