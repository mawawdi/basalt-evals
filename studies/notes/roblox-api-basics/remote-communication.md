# Replication and remotes

- The server owns the game state. Changes that the server makes to replicated instances reach
  each client. Changes that a client makes to most instances stay on that client.
- Put a `RemoteEvent` or `RemoteFunction` in `ReplicatedStorage` so that both sides can find it.
- Client to server: `remote:FireServer(...)`. The server gets
  `remote.OnServerEvent:Connect(function(player, ...) end)`. The first argument is always the
  sending player.
- Server to client: `remote:FireClient(player, ...)` or `remote:FireAllClients(...)`. The client
  gets `remote.OnClientEvent:Connect(function(...) end)`.
- `RemoteFunction`: the client calls `remote:InvokeServer(...)` and the server sets
  `remote.OnServerInvoke = function(player, ...) return value end`.
- `UnreliableRemoteEvent` can drop or reorder events. Use it only for frequent updates that a
  later update replaces.
- Treat each value from a client as untrusted. On the server, check its type, its range, the
  distance and the current state before you change the game.
- Instances, tables, numbers, strings and booleans can cross a remote. Functions cannot. A table
  with mixed keys or with instances that the receiver cannot see can lose data.
