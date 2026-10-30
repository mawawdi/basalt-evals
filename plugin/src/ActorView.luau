--!strict

-- A declared acquisition view, not a success oracle. It changes only the local
-- camera and the local avatar's first-person transparency, and restores both.
local ActorView = {}

function ActorView.capture(camera: Camera?, character: Model?, target: Instance?,
	capture: () -> any, trace: (string, { [string]: any }) -> ()): any

	assert(camera ~= nil, "Actor view acquisition has no camera")
	local head = if character then character:FindFirstChild("Head") else nil
	local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
	local humanoid = if character then character:FindFirstChildOfClass("Humanoid") else nil
	assert(character ~= nil and head ~= nil and head:IsA("BasePart")
		and root ~= nil and root:IsA("BasePart") and humanoid ~= nil and humanoid.Health > 0,
		"Actor view acquisition has no live local avatar")
	local origin = head.Position
	local destination: Vector3? = nil
	if target and target:IsA("BasePart") then
		destination = target.Position
	elseif target and target:IsA("Model") and target:FindFirstChildWhichIsA("BasePart", true) then
		local bounds = target:GetBoundingBox()
		destination = bounds.Position
	end
	local frame, focus, cameraType, subject, fov = camera.CFrame, camera.Focus, camera.CameraType, camera.CameraSubject, camera.FieldOfView
	local direction = if destination then destination - origin else frame.LookVector
	local aimed = destination ~= nil and direction.Magnitude > 0.0001
	if not aimed then direction = frame.LookVector end
	-- Keep even absent-target evidence at the measured actor origin. Looking
	-- straight up/down needs an independent up vector to avoid a degenerate frame.
	local up = if math.abs(direction.Unit:Dot(Vector3.yAxis)) > 0.999 then Vector3.xAxis else Vector3.yAxis
	local forward = direction.Unit
	local right = forward:Cross(up).Unit
	local view = CFrame.fromMatrix(origin, right, right:Cross(forward).Unit, -forward)
	local transparencies: { [BasePart]: number } = {}
	for _, descendant in character:GetDescendants() do
		if descendant:IsA("BasePart") then
			transparencies[descendant] = descendant.LocalTransparencyModifier
		end
	end
	trace("capture.actor_view", {
		originX = origin.X, originY = origin.Y, originZ = origin.Z,
		actorX = root.Position.X, actorY = root.Position.Y, actorZ = root.Position.Z,
		lookX = view.LookVector.X, lookY = view.LookVector.Y, lookZ = view.LookVector.Z,
		fieldOfView = fov,
	})
	-- Each trace payload must leave room for phaseId/captureId under the fixed
	-- fifteen-field transport bound. Keep target geometry in its own bound event.
	trace("capture.actor_target", {
		targetPresent = target ~= nil, aimed = aimed,
		targetX = if destination then destination.X else nil,
		targetY = if destination then destination.Y else nil,
		targetZ = if destination then destination.Z else nil,
	})
	local ok, result = pcall(function()
		for part in transparencies do part.LocalTransparencyModifier = 1 end
		camera.CameraType = Enum.CameraType.Scriptable
		camera.CFrame, camera.Focus = view, CFrame.new(origin + direction)
		return capture()
	end)
	camera.CFrame, camera.Focus, camera.CameraSubject, camera.CameraType, camera.FieldOfView = frame, focus, subject, cameraType, fov
	for part, transparency in transparencies do part.LocalTransparencyModifier = transparency end
	trace("capture.actor_view_restored", { completed = ok })
	if not ok then error(result) end
	return result
end

return table.freeze(ActorView)
