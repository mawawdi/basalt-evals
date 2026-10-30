import type { RunOperationManifest } from "../packages/contracts/src/execution.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { hashJson } from "../packages/contracts/src/index.js";
import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import {
  registerSource,
  readRegisteredSource,
  operationSource,
  ingestSource,
} from "../packages/operator/src/sources.js";

test("retained source registration preserves immutable bytes and actual provenance without a builder run", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-source-"));
  try {
    const workspace = resolve(root, "workspace");
    await mkdir(resolve(workspace, "src"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
    await writeFile(resolve(workspace, "src/Scene.luau"), "-- retained source\n");
    const files = await inventoryTree(workspace);
    const candidate = { rootHash: hashJson(files), projectFile: "default.project.json", files };
    const provenance = {
      kind: "retained" as const,
      evidenceHashes: [hashJson("original-source-receipt")],
      originOperationId: null,
      parentSourceId: null,
    };
    const source = await registerSource({ root, workspace, candidate, provenance });
    assert.equal(
      (await ingestSource(root, { workspace, projectFile: "default.project.json", provenance })).id,
      source.id,
    );
    await assert.rejects(
      ingestSource(root, { workspace, projectFile: "default.project.json", provenance, candidate }),
      /requires a workspace/,
    );
    await assert.rejects(
      ingestSource(root, { workspace, projectFile: "../outside", provenance }),
      /Invalid candidate manifest/,
    );
    assert.equal(source.id, (await registerSource({ root, workspace, candidate, provenance })).id);
    await writeFile(resolve(workspace, "src/Scene.luau"), "-- later edit\n");
    const loaded = await readRegisteredSource(root, source.id);
    assert.equal(loaded.source.candidate.rootHash, candidate.rootHash);
    const manifest = {
      id: "study",
      subjects: [{ id: "retained", sourceId: source.id }],
    } as RunOperationManifest;
    const sealed = await operationSource(root, manifest, "retained");
    assert.equal(sealed.agentRun, null);
    assert.deepEqual(sealed.candidate, candidate);
    await writeFile(resolve(loaded.workspaceRoot, "src/Scene.luau"), "-- altered artifact\n");
    await assert.rejects(readRegisteredSource(root, source.id), /bytes changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
