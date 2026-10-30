--!strict

-- Configure only the declared native game viewport. The Edit plugin does this
-- before StudioTestService starts Play. Each Play client is a separate Studio
-- session, so it does this again before it reports ready. The Play server never
-- does this, because the simulator setters error there. Desktop simulation never
-- sets orientation.
local StudioDeviceView = {}

local function validDimension(value: any, minimum: number): boolean
	return type(value) == "number" and value % 1 == 0 and value >= minimum and value <= 4096
end

function StudioDeviceView.configure(view: any, trace: (string, { [string]: any }) -> ()): ()
	assert(type(view) == "table" and view.schema == "basalt-evals/sequence-view", "Invalid sequence view")
	local fields = 0
	for key in view do
		assert(key == "schema" or key == "viewport", "Unexpected sequence view field")
		fields += 1
	end
	local simulator = (game :: any):GetService("StudioDeviceSimulatorService")
	local viewport = view.viewport
	if viewport == nil then
		assert(fields == 1, "Invalid native sequence view")
		if simulator:GetDeviceAsync() ~= "default" then simulator:StopSimulationAsync() end
		trace("viewport.native", { activeDevice = simulator:GetDeviceAsync() })
		return
	end
	assert(fields == 2, "Incomplete sequence view")
	assert(type(viewport) == "table" and validDimension(viewport.width, 320)
		and validDimension(viewport.height, 240), "Invalid native viewport request")
	local devices = simulator:GetDeviceListAsync()
	assert(type(devices) == "table", "Device Simulator returned no device list")
	for _, deviceId in devices do assert(type(deviceId) == "string", "Invalid Device Simulator preset") end
	table.sort(devices)
	local desktop = nil
	for _, deviceId in devices do
		if type(deviceId) == "string" and deviceId ~= "default" then
			local info = simulator:GetDeviceInfoAsync(deviceId)
			if type(info) == "table" and info.DeviceForm == Enum.DeviceForm.Desktop then
				desktop = deviceId
				break
			end
		end
	end
	assert(desktop ~= nil, "No Desktop preset is available in Studio Device Simulator")
	simulator:SetDeviceAsync(desktop)
	simulator:SetResolutionAsync(viewport.width, viewport.height)
	-- The pinned Luau definitions predate the new Device Simulator enum.
	simulator:SetScalingModeAsync((Enum :: any).DeviceSimulatorScalingMode.ActualResolution)
	local actual = simulator:GetResolutionAsync()
	assert(actual.X == viewport.width and actual.Y == viewport.height,
		"Native viewport setup did not retain the declared resolution")
	trace("viewport.configured", { device = desktop, width = actual.X, height = actual.Y,
		scaling = "ActualResolution", activeDevice = simulator:GetDeviceAsync() })
end

return StudioDeviceView
