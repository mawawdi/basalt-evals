# Player interface

- A `ScreenGui` in `StarterGui` is copied into the `PlayerGui` of each player when the character
  spawns. Set `ScreenGui.ResetOnSpawn = false` to keep one copy across respawns.
- Change the interface of a player from a `LocalScript`. The server can create a `ScreenGui` in
  `player.PlayerGui`, but changes that the client makes later are not seen by the server.
- `TextLabel.Text` sets the text. `GuiObject.Visible` shows or hides an element.
- Size and position use `UDim2`: `UDim2.fromScale(0.5, 0.1)` is relative to the parent, and
  `UDim2.fromOffset(200, 50)` is in pixels. `AnchorPoint = Vector2.new(0.5, 0.5)` centers the
  element on its position.
- `TextButton.Activated` fires for a mouse click, a touch tap and a gamepad press.
- `Players.LocalPlayer` is the player of the current client. It is nil on the server.
