import { writeFile } from "node:fs/promises";
import { measureBuildIdentity } from "../dist/packages/operator/src/execution-guard.js";

await writeFile(
  "dist/build-identity.json",
  JSON.stringify(await measureBuildIdentity(process.cwd())) + "\n",
  { flag: "wx", mode: 0o600, flush: true },
);
