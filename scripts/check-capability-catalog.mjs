import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { STUDIO_CAPABILITY_CATALOG } from "../dist/packages/contracts/src/capabilities.js";

const root = resolve(import.meta.dirname, "..");
const fields = [
  "roleClasses",
  "guiInputRoleClasses",
  "phaseDrivers",
  "scenarioActions",
  "observations",
  "anchorFacts",
  "humanoidStates",
];
const generated = `--!strict\n-- Derived from packages/contracts/src/capabilities.ts. Check with npm run plugin:test.\nreturn table.freeze({\n${fields.map((field) => `\t${field} = table.freeze({\n${STUDIO_CAPABILITY_CATALOG[field].map((name) => `\t\t${name} = true,`).join("\n")}\n\t}),`).join("\n")}\n})\n`;
if (process.argv.includes("--print")) process.stdout.write(generated);
else {
  const installed = await readFile(resolve(root, "plugin/src/CapabilityCatalog.luau"), "utf8");
  if (installed !== generated)
    throw new Error("Connector vocabulary differs from the authoritative capability catalog");
  process.stdout.write("Capability catalog agrees with the fixed connector vocabulary\n");
}
