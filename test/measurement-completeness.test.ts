import assert from "node:assert/strict";
import test from "node:test";
import { hashJson } from "../packages/contracts/src/index.js";
import type {
  RunOperationEvent,
  RunOperationManifest,
  RunOperationStatus,
  SpendLedgerState,
} from "../packages/contracts/src/execution.js";
import { operationStatus } from "../packages/operator/src/operation.js";

test("fully billed numerical judgments complete measurement while unknown results or billing do not, whatever claims remain unreviewed", () => {
  const manifest = {
    id: "score-only",
    gradingMode: "all",
    subjects: [{ id: "source", sourceId: "retained", kind: "retained" }],
    gates: [],
    captureCells: [{ id: "capture", treatmentId: "source", requires: [] }],
    gradingCells: [{ id: "grade", captureCellId: "capture" }],
    judgmentBatches: [],
    unreviewedClaims: [],
    planned: { independentBuilderTrials: 0 },
  } as unknown as RunOperationManifest;
  const events: RunOperationEvent[] = [];
  for (const [stage, unitId, hashes] of [
    ["seal", "source", 1],
    ["final_capture", "capture", 2],
    ["grading", "grade", 1],
    ["report", "final", 1],
  ] as const) {
    for (const kind of ["started", "completed"] as const) {
      const body = {
        schema: "basalt-evals/run-operation-event" as const,
        sequence: events.length + 1,
        previousHash: events.at(-1)?.id ?? null,
        stage,
        unitId,
        kind,
        artifactHashes:
          kind === "completed" ? Array.from({ length: hashes }, () => "a".repeat(64)) : [],
        reason: null,
        at: "2026-09-30T00:00:00.000Z",
      };
      events.push({ ...body, id: hashJson(body) });
    }
  }
  const ledger = {
    authorizations: [{ ceilingUsd: 1 }],
    entries: [],
  } as unknown as SpendLedgerState;
  const outcomes: RunOperationStatus["criterionOutcomes"] = [
    {
      cellId: "grade",
      criterionId: "appearance",
      outcome: "scored",
      decisionAuthority: "model",
      evidence: ["a".repeat(64)],
    },
  ];
  assert.equal(operationStatus(manifest, events, ledger, outcomes).measurementComplete, true);
  assert.equal(
    operationStatus(manifest, events, ledger, [{ ...outcomes[0]!, outcome: "incomplete" }])
      .measurementComplete,
    false,
  );
  assert.equal(
    operationStatus(
      manifest,
      events,
      {
        ...ledger,
        entries: [
          {
            status: "pending",
            reservedUsd: 0.1,
            billedUsd: null,
          } as SpendLedgerState["entries"][number],
        ],
      },
      outcomes,
    ).measurementComplete,
    false,
  );
  assert.equal(
    operationStatus(
      { ...manifest, unreviewedClaims: ["unverified-authority"] },
      events,
      ledger,
      outcomes,
    ).measurementComplete,
    true,
    "Claim review is reported separately and never blocks measured completion or cost samples",
  );
});
