# Timing, motion and tweens

- `task.wait(seconds)` yields and returns the elapsed time. `task.spawn(fn, ...)` runs a function
  at once. `task.delay(seconds, fn, ...)` runs it later. `task.defer(fn, ...)` runs it at the end
  of the current resumption cycle. `task.cancel(thread)` stops a scheduled thread.
- `RunService.Heartbeat:Connect(function(deltaTime) end)` runs after each physics step, on the
  server and on clients. `RunService.RenderStepped` runs only on clients, before each frame.
- `os.clock()` gives a precise time for intervals. `workspace:GetServerTimeNow()` gives a time
  that the server and the clients share.
- `CFrame` holds a position and a rotation. `CFrame.new(position)`,
  `CFrame.lookAt(position, target)` and `cframe * CFrame.Angles(x, y, z)` (radians).
- Set `BasePart.Anchored = true` for a part that scripts move and that physics must not move.
  `model:PivotTo(cframe)` moves a whole model.
- `TweenService:Create(instance, info, { Position = target })` returns a tween, with
  `info = TweenInfo.new(seconds, Enum.EasingStyle.Linear, Enum.EasingDirection.Out)`. Call
  `tween:Play()`. `tween.Completed` fires when it ends.
- A tween on the server replicates the property changes to clients at the network rate. A tween
  on a client is smooth but only that client sees it.
