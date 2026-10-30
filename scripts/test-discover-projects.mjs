import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { discoverFixtureSets, discoverProjectFiles } from "./discover-projects.mjs";

const execFile = promisify(callback);

test("new authored controls enter fixture and project discovery", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-discovery-"));
  try {
    const seed = resolve(root, "tasks/pilot/new-mechanic/seed");
    const control = resolve(root, "studies/new-mechanic/controls/working/Control.server.luau");
    await mkdir(seed, { recursive: true });
    await mkdir(resolve(control, ".."), { recursive: true });
    await mkdir(resolve(root, "plugin"));
    await writeFile(resolve(root, "plugin/default.project.json"), '{"tree":{}}\n');
    await writeFile(resolve(seed, "default.project.json"), '{"tree":{}}\n');
    await writeFile(control, "function (\n");
    const sets = await discoverFixtureSets(root);
    assert.ok(sets.some((set) => set.name === "new-mechanic" && set.files.includes(control)));
    assert.ok(
      (await discoverProjectFiles(root)).includes(
        "tasks/pilot/new-mechanic/seed/default.project.json",
      ),
    );
    await assert.rejects(execFile("luau-compile", ["--only-parse", control]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
