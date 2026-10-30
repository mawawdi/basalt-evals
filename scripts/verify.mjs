import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(resolve(tmpdir(), "basalt-offline-verify-"));
const fixture = resolve(temporary, "console-fixture");

async function run(args) {
  const child = spawn("npm", args, {
    cwd: root,
    env: { ...process.env, BASALT_CONSOLE_FIXTURE_ROOT: fixture },
    stdio: "inherit",
  });
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => done(status ?? (signal ? 1 : 0)));
  });
  if (code !== 0) throw new Error(`npm ${args.join(" ")} failed with exit ${code}`);
}

try {
  await run(["test"]);
  await run(["run", "build", "--workspace", "@basalt/eval-console"]);
  await run(["run", "console:test"]);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
