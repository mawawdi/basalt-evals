import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import type { RunOperationStatus } from "../packages/contracts/src/execution.js";
import { runOutcomeCauses } from "../packages/operator/src/run-report.js";
import { stagedRun } from "./staged-fixture.js";

test("the causes of a run replay its events and refuse a changed event", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-run-causes-"));
  try {
    const { manifest, operation, subjects } = await stagedRun(root, { stages: 1 });
    const unitId = subjects[0]!.id;
    const at = new Date().toISOString();
    await operation.append({
      kind: "started",
      stage: "builder",
      unitId,
      artifactHashes: [],
      reason: null,
      at,
    });
    await operation.append({
      kind: "failed",
      stage: "builder",
      unitId,
      artifactHashes: [],
      reason: "Synthetic builder failure.",
      at,
    });
    const causes = await runOutcomeCauses(root, manifest.id);
    assert.deepEqual(
      causes.causes.flatMap((cause) => cause.units.map((unit) => unit.subjectId)),
      [unitId],
    );
    assert.deepEqual(Object.keys(causes.buildTitles), [unitId]);

    // The read verifies no receipt, but it still replays the chain of events that it shows.
    const journal = await OperationJournal.open(root);
    try {
      const stored = journal.read<RunOperationStatus>("operations", manifest.id)!;
      stored.events.at(-1)!.reason = "A changed reason.";
      journal.transaction(() => journal.put("operations", manifest.id, stored));
    } finally {
      journal.close();
    }
    await assert.rejects(
      runOutcomeCauses(root, manifest.id),
      /Run operation event chain is invalid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
