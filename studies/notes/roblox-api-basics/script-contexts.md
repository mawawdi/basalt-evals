# Scripts, contexts and services

- A `Script` runs on the server. It runs in `ServerScriptService` or in `Workspace`.
- A `LocalScript` runs on one client. It runs in `StarterPlayerScripts`, `StarterCharacterScripts`,
  `StarterGui`, `StarterPack`, or in the `PlayerGui`, `Backpack` or character of its player.
- A `ModuleScript` returns one value. `require(module)` runs the module one time in each
  environment and returns the same value to each later caller in that environment.
- Rojo maps file names to classes: `Name.server.luau` is a `Script`, `Name.client.luau` is a
  `LocalScript`, and `Name.luau` is a `ModuleScript`. A `default.project.json` maps folders to
  locations in the data model.
- Get a service with `game:GetService("Players")`. Common services: `Players`,
  `ReplicatedStorage`, `ServerScriptService`, `ServerStorage`, `RunService`, `TweenService`,
  `CollectionService`, `UserInputService` (client only).
- `ServerStorage` and `ServerScriptService` do not replicate to clients. `ReplicatedStorage`
  replicates to each client.
- `RunService:IsServer()` and `RunService:IsClient()` tell the current context.
