# Luau language

- `--!strict` at the top of a file turns on strict type checks.
- Annotations: `local count: number = 0`, `local function add(a: number, b: number): number`,
  `type Point = { x: number, y: number }`, and `string?` for a value that can be nil.
- Tables: `table.insert(list, value)`, `table.remove(list, index)`, `table.find(list, value)`,
  `table.clear(t)` and `#list` for the length of an array.
- Loops: `for index = 1, 10 do end`, `for key, value in pairs(t) do end`,
  `for index, value in ipairs(list) do end`, and `for key, value in t do end`.
  `continue` skips to the next iteration.
- Operators: `..` joins strings, `~=` means not equal, `//` is floor division, and `+=`, `-=`,
  `*=`, `/=` and `..=` are compound assignments.
- `if a then elseif b then else end` is a statement. `local x = if a then 1 else 2` is an
  expression.
- `string.format("%d of %d", a, b)`, `tostring(value)`, `tonumber(text)`, `math.clamp(x, lo, hi)`,
  `math.floor(x)` and `math.random(1, 6)`.
- `pcall(fn, ...)` returns `false` and the error when `fn` fails. `error(message)` raises an
  error. `assert(condition, message)` raises an error when the condition is false.
