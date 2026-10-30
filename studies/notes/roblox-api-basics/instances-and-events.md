# Instances, attributes and events

- `Instance.new("Part")` creates an instance. Set its properties, then set `Parent` last.
- `parent:FindFirstChild("Name")` returns the child or nil. `parent:WaitForChild("Name")`
  yields until the child exists. Use `WaitForChild` on the client for replicated instances.
- `instance:GetChildren()` and `instance:GetDescendants()` return arrays.
  `instance:IsA("BasePart")` tests the class and its superclasses.
- `instance:Destroy()` removes the instance, locks its `Parent` and disconnects its events.
- Attributes: `instance:SetAttribute("Name", value)`, `instance:GetAttribute("Name")` and
  `instance:GetAttributeChangedSignal("Name")`. Server changes to attributes replicate.
- Tags: `instance:AddTag("Tag")`, `instance:HasTag("Tag")` and
  `CollectionService:GetTagged("Tag")`. `CollectionService:GetInstanceAddedSignal("Tag")` fires
  for each instance that gets the tag later.
- `signal:Connect(callback)` returns an `RBXScriptConnection`. Call `connection:Disconnect()` to
  stop it. `signal:Once(callback)` disconnects after the first call. `signal:Wait()` yields until
  the next event.
- `instance:GetPropertyChangedSignal("Property")` fires when that property changes.
- `Players.PlayerAdded` and `Players.PlayerRemoving` give the `Player`. `player.CharacterAdded`
  gives the character model. A character has a `Humanoid` and a `HumanoidRootPart`.
- `BasePart.Touched` gives the other part. `Players:GetPlayerFromCharacter(otherPart.Parent)`
  returns the player of a character, or nil. `Touched` can fire many times for one contact.
