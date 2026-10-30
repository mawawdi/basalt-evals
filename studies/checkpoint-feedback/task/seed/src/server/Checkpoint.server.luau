--!strict
-- Studio-only authored fixture. Controls move the character; activation still
-- requires a physical server-owned contact with the server-created checkpoint.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Rules = require(ReplicatedStorage:WaitForChild("CheckpointState"))
assert(RunService:IsStudio(), "This development fixture runs only in Studio")

local function part(name: string, size: Vector3, position: Vector3, color: Color3): Part
	local item = Instance.new("Part")
	item.Name, item.Size, item.Position, item.Color = name, size, position, color
	item.Anchored = true
	item.Material = Enum.Material.SmoothPlastic
	item.TopSurface, item.BottomSurface = Enum.SurfaceType.Smooth, Enum.SurfaceType.Smooth
	item.Parent = workspace
	return item
end
local pad = part("CheckpointA", Vector3.new(9, 0.6, 9), Vector3.new(0, 0.3, 0), Color3.fromRGB(69, 83, 90))
part("Approach", Vector3.new(3, 0.05, 12), Vector3.new(0, 0.025, 10), Color3.fromRGB(99, 117, 116))
part("BeaconPost", Vector3.new(0.5, 5.5, 0.5), Vector3.new(-5.4, 2.75, -2), Color3.fromRGB(52, 65, 74))
part("Beacon", Vector3.new(0.8, 0.8, 0.8), Vector3.new(-5.4, 5.8, -2), Color3.fromRGB(106, 127, 132))
for index = 1, 5 do
	for _, side in { -1, 1 } do
		local block = part("CoursePylon", Vector3.new(2, 1 + index * 0.5, 2), Vector3.new(side * 11, (1 + index * 0.5) / 2, 12 - index * 7), Color3.fromRGB(43 + index * 6, 65 + index * 4, 74 + index * 3))
		block.CanTouch = false
	end
end
local control = Instance.new("RemoteEvent")
control.Name = "CaptureAction"
control.Parent = ReplicatedStorage
type Record = { state: Rules.State, folder: Folder, generation: number, busy: boolean }
local records: { [Player]: Record } = {}

local function publish(record: Record, phase: string)
	record.folder:SetAttribute("LastCheckpoint", record.state.checkpoint)
	record.folder:SetAttribute("Activations", record.state.activations)
	record.folder:SetAttribute("Phase", phase)
end

local function move(player: Player, record: Record, position: Vector3, phase: string)
	local character = player.Character
	if not character or not character:IsDescendantOf(workspace) then return end
	local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
	local humanoid = if character then character:FindFirstChildOfClass("Humanoid") else nil
	if not root or not root:IsA("BasePart") or not humanoid or humanoid.Health <= 0 then return end
	record.generation += 1
	local generation = record.generation
	record.busy = true
	publish(record, if phase == "active" then "approaching" else "settling")
	-- Falling onto the pad produces physical movement. CFrame overlap alone
	-- does not guarantee a Touched event. Keep ownership on the server.
	root.Anchored = false
	root:SetNetworkOwner(nil)
	root.CFrame = CFrame.lookAt(position, position + Vector3.new(0, 0, -1))
	root.AssemblyLinearVelocity, root.AssemblyAngularVelocity = Vector3.zero, Vector3.zero
	humanoid.WalkSpeed, humanoid.JumpPower, humanoid.AutoRotate = 0, 0, false
	task.spawn(function()
		local deadline, stable = os.clock() + 10, 0
		while records[player] == record and generation == record.generation do
			RunService.Heartbeat:Wait()
			if humanoid.Health <= 0 or not root.Parent then return end
			local grounded = humanoid.FloorMaterial ~= Enum.Material.Air and math.abs(root.AssemblyLinearVelocity.Y) < 1
			stable = if grounded then stable + 1 else 0
			if stable >= 5 and (phase ~= "active" or record.state.checkpoint == pad.Name) then
				record.busy = false
				publish(record, phase)
				return
			end
			if os.clock() > deadline then
				record.busy = false
				publish(record, "failed")
				error("Checkpoint fixture did not settle with the required physical contact")
			end
		end
	end)
end

pad.Touched:Connect(function(hit: BasePart)
	local character = hit:FindFirstAncestorOfClass("Model")
	local player = if character then Players:GetPlayerFromCharacter(character) else nil
	local record = if player then records[player] else nil
	if not record or record.folder:GetAttribute("Phase") ~= "approaching" then return end
	local root = character and character:FindFirstChild("HumanoidRootPart")
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	if not root or not root:IsA("BasePart") or not humanoid or humanoid.Health <= 0 then return end
	local offset = pad.CFrame:PointToObjectSpace(root.Position)
	-- Reject delayed contacts after a reset/teleport away from the pad.
	if math.abs(offset.X) > 6 or math.abs(offset.Z) > 6 or math.abs(offset.Y) > 8 then return end
	record.state = Rules.touch(record.state, pad.Name)
	-- Readiness is published by move only after the avatar settles.
end)

local function joined(player: Player)
	if records[player] then return end
	local folder = Instance.new("Folder")
	folder.Name = "CheckpointState"
	folder.Parent = player
	local record: Record = { state = Rules.initial(), folder = folder, generation = 0, busy = true }
	records[player] = record
	publish(record, "loading")
	local function spawned(character: Model)
		-- CharacterAdded can fire before Roblox parents the assembled character to
		-- Workspace. Network ownership requires a live Workspace descendant.
		local deadline = os.clock() + 10
		while records[player] == record and player.Character == character do
			local root = character:FindFirstChild("HumanoidRootPart")
			local humanoid = character:FindFirstChildOfClass("Humanoid")
			if character:IsDescendantOf(workspace) and root and root:IsA("BasePart") and humanoid then break end
			if os.clock() >= deadline then
				record.busy = false
				publish(record, "failed")
				error("Checkpoint character did not enter Workspace with its required parts")
			end
			RunService.Heartbeat:Wait()
		end
		if records[player] ~= record or player.Character ~= character then return end
		record.state = Rules.initial()
		move(player, record, Vector3.new(0, 5, 11), "idle")
	end
	player.CharacterAdded:Connect(spawned)
	if player.Character then task.spawn(spawned, player.Character) end
end
control.OnServerEvent:Connect(function(player: Player, action: unknown)
	local record = records[player]
	if not record or record.busy then return end
	if action == "reset" then
		record.state = Rules.initial()
		move(player, record, Vector3.new(0, 5, 11), "ready")
	elseif action == "approach" then
		move(player, record, Vector3.new(0, 6, 0), "active")
	elseif action == "leave" then
		move(player, record, Vector3.new(0, 5, 11), "departed")
	end
	-- No client-supplied checkpoint identity, position or state is accepted.
end)
Players.PlayerAdded:Connect(joined)
Players.PlayerRemoving:Connect(function(player) records[player] = nil end)
for _, player in Players:GetPlayers() do joined(player) end
