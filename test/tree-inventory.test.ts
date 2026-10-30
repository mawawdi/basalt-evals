import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { inventoryTree, walkRegularTree } from "../packages/artifact-store/src/inventory.js";
import { assertCandidateManifest, hashJson } from "../packages/contracts/src/index.js";

test("tree inventories use code-unit path order that candidate manifests accept", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-inventory-"));
  try {
    await mkdir(resolve(root, "src/server"), { recursive: true });
    await mkdir(resolve(root, "src/shared/a"), { recursive: true });
    await writeFile(resolve(root, "default.project.json"), '{"tree":{}}\n');
    // Mixed case and a directory beside a same-stem file both diverge from locale order.
    await writeFile(resolve(root, "src/server/Mechanic.server.luau"), "-- mechanic\n");
    await writeFile(resolve(root, "src/server/init.server.luau"), "-- init\n");
    await writeFile(resolve(root, "src/shared/a.luau"), "return 1\n");
    await writeFile(resolve(root, "src/shared/a/x.luau"), "return 2\n");
    await writeFile(resolve(root, "src/shared/config_values.luau"), "return 3\n");
    await writeFile(resolve(root, "src/shared/config-values.luau"), "return 4\n");

    const files = await inventoryTree(root);
    assert.deepEqual(
      files.map((file) => file.path),
      [
        "default.project.json",
        "src/server/Mechanic.server.luau",
        "src/server/init.server.luau",
        "src/shared/a.luau",
        "src/shared/a/x.luau",
        "src/shared/config-values.luau",
        "src/shared/config_values.luau",
      ],
    );
    assertCandidateManifest({
      projectFile: "default.project.json",
      files,
      rootHash: hashJson(files),
    });
    assert.deepEqual(
      await walkRegularTree(root, { label: "Candidate", maxFileBytes: 1024 }),
      files,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inventory rejects unsupported files only when an allowlist is supplied", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-inventory-"));
  try {
    await writeFile(resolve(root, "notes.txt"), "free text\n");
    await assert.rejects(inventoryTree(root), /Tree contains an unsupported file: notes\.txt/);
    assert.equal(
      (await walkRegularTree(root, { label: "Candidate", maxFileBytes: 1024 })).length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
