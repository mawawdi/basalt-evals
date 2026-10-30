import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { inventoryLocalArtifacts } from "./artifact-health.mjs";

test("artifact inventory reports bytes, signed receipts and document mentions without deleting", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-artifact-health-"));
  try {
    assert.deepEqual(await inventoryLocalArtifacts(root), []);
    await mkdir(resolve(root, "docs"));
    await mkdir(resolve(root, ".basalt-evals/sample/studio/native"), { recursive: true });
    await writeFile(resolve(root, "docs/results.md"), "Evidence: `.basalt-evals/sample/studio`.\n");
    await writeFile(resolve(root, ".basalt-evals/sample/studio/native/manifest.json"), "receipt");
    assert.deepEqual(await inventoryLocalArtifacts(root), [
      {
        path: ".basalt-evals/sample",
        files: 1,
        bytes: 7,
        signedReceipts: 1,
        mentionedIn: ["docs/results.md"],
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
