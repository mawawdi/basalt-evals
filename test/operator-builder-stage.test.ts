import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import { publishSealedSource } from "../packages/artifact-store/src/sealed-source.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { hashJson, type CandidateManifest } from "../packages/contracts/src/index.js";
import { recoverEvalBuilderUnit } from "../packages/operator/src/builder-stage.js";
import { RunOperationStore } from "../packages/operator/src/operation.js";

import { implementationFixture } from "./implementation-fixture.js";

test("builder sealing copies only the exact candidate and preserves it after workspace edits", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-builder-seal-"));
  try {
    const workspace = resolve(root, "workspace");
    const source = resolve(workspace, "src/server/Mechanic.server.luau");
    await mkdir(resolve(workspace, "src/server"), { recursive: true });
    await writeFile(resolve(workspace, "default.project.json"), '{"tree":{}}\n');
    await writeFile(source, '--!strict\nprint("candidate")\n');
    const files = await inventoryTree(workspace);
    const candidate: CandidateManifest = {
      rootHash: hashJson(files),
      projectFile: "default.project.json",
      files,
    };
    await writeFile(source, '--!strict\nprint("changed")\n');
    const sealed = resolve(root, "sealed");
    await assert.rejects(publishSealedSource(workspace, sealed, candidate), /changed/);
    await writeFile(source, '--!strict\nprint("candidate")\n');
    await publishSealedSource(workspace, sealed, candidate);
    await publishSealedSource(workspace, sealed, candidate);
    await writeFile(source, '--!strict\nprint("later edit")\n');
    assert.equal(
      await readFile(resolve(sealed, "src/server/Mechanic.server.luau"), "utf8"),
      '--!strict\nprint("candidate")\n',
    );
    assert.equal(hashJson(await inventoryTree(sealed)), candidate.rootHash);
    await assert.rejects(publishSealedSource(workspace, sealed, candidate), /changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted builder reconciliation records incompleteness without another model call", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-builder-recover-"));
  try {
    const implementation = await implementationFixture(root);
    let pendingBilling = true;
    const events: Array<{ kind: string; reason: string | null; at: string }> = [];
    const operation = {
      read: async () => ({
        manifest: {
          id: "recover-test",
          subjects: [{ id: "tr-123", kind: "generated", builder: { id: "tr-123" } }],
          ...implementation,
        },
        completedUnits: [],
        inFlightUnits: [{ stage: "builder", unitId: "tr-123" }],
        events: [],
      }),
      // A pending charge without a live holder makes the interrupted build uncertain.
      ledger: {
        unownedPending: async () => (pendingBilling ? [{ status: "pending" }] : []),
      },
      append: async (event: { kind: string; reason: string | null; at: string }) => {
        events.push(event);
      },
    } as unknown as RunOperationStore;
    assert.equal(
      await recoverEvalBuilderUnit({ root, operation, unitId: "tr-123" }),
      "uncertain_billing",
    );
    assert.equal(events.length, 0);
    pendingBilling = false;
    assert.equal(await recoverEvalBuilderUnit({ root, operation, unitId: "tr-123" }), "incomplete");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "incomplete");
    assert.equal(events[0]?.reason, "The build stopped before Basalt saved it.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
