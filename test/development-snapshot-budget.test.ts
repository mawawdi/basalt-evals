import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { hashJson } from "../packages/contracts/src/index.js";
import { snapshotCandidateTree } from "../packages/development/src/snapshot.js";
test("candidate snapshots bind source bytes and never overwrite an existing target", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-snapshot-"));
  try {
    const source = resolve(root, "source");
    await mkdir(resolve(source, "src"), { recursive: true });
    await writeFile(resolve(source, "default.project.json"), "{}\n");
    await writeFile(resolve(source, "src", "Main.luau"), "print('first')\n");
    const expectedHash = hashJson(await inventoryTree(source));
    const first = await snapshotCandidateTree({
      source,
      target: resolve(root, "snapshot"),
      expectedHash,
      projectFile: "default.project.json",
    });
    assert.equal(first.rootHash, expectedHash);
    assert.equal(
      await readFile(resolve(root, "snapshot/src/Main.luau"), "utf8"),
      "print('first')\n",
    );
    await assert.rejects(
      snapshotCandidateTree({
        source,
        target: resolve(root, "snapshot"),
        expectedHash,
        projectFile: "default.project.json",
      }),
    );
    await writeFile(resolve(source, "src", "Main.luau"), "print('changed')\n");
    await assert.rejects(
      snapshotCandidateTree({
        source,
        target: resolve(root, "second"),
        expectedHash,
        projectFile: "default.project.json",
      }),
      /changed before snapshot/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
