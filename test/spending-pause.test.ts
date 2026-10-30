import assert from "node:assert/strict";
import test from "node:test";
import type { RunOperationStatus } from "../packages/contracts/src/execution.js";
import { dispatchableUnits } from "../packages/operator/src/run-scheduler.js";
import { pausedUnits } from "../packages/operator/src/operation.js";

function status(authorizationHash: string, paused: "judgment" | "builder") {
  const event = (stage: string, unitId: string, kind: string, artifactHashes: string[] = []) => ({
    stage,
    unitId,
    kind,
    artifactHashes,
    reason: null,
    at: "2026-10-01T00:00:00.000Z",
  });
  const events = [
    event("builder", "first", "started"),
    event("builder", "first", "completed", ["a", "b"]),
    event("final_capture", "capture", "started"),
    event("final_capture", "capture", "completed", ["c", "d"]),
    ...(paused === "judgment"
      ? [event("judgment", "check", "started"), event("judgment", "check", "paused", ["limit"])]
      : [
          event("judgment", "check", "started"),
          event("judgment", "check", "completed", ["e"]),
          event("builder", "second", "started"),
          event("builder", "second", "paused", ["limit"]),
        ]),
  ];
  return {
    finished: false,
    stopped: false,
    inFlightUnits: [],
    authorizationHash,
    pauseRecords: {},
    completedUnits: [
      "builder:first",
      "final_capture:capture",
      ...(paused === "builder" ? ["judgment:check"] : []),
    ],
    events,
    manifest: {
      subjects: ["first", "second", "third"].map((id) => ({
        id,
        kind: "generated",
        stageIndex: 1,
        parentSubjectId: null,
        builder: { id, model: { id: "model" } },
        sourceId: null,
      })),
      captureCells: [{ id: "capture", treatmentId: "first", requires: [] }],
      gradingCells: [],
      judgmentBatches: [{ id: "check", captureCellId: "capture", substitution: null }],
      gates: [],
    },
  } as unknown as RunOperationStatus;
}

const idle = { running: new Set<string>(), unownedPending: false };

test("a judgment paused at the shared limit blocks new builds until the limit rises", () => {
  const unchanged = status("limit", "judgment");
  assert.deepEqual(
    pausedUnits(unchanged).map((event) => `${event.stage}:${event.unitId}`),
    ["judgment:check"],
  );
  assert.deepEqual(dispatchableUnits(unchanged, idle), [], "no new build starts behind it");
  // A new authorization resumes the judgment first; the remaining builds start beside it.
  assert.deepEqual(dispatchableUnits(status("raised", "judgment"), idle), [
    { stage: "judgment", unitId: "check" },
    { stage: "builder", unitId: "second" },
    { stage: "builder", unitId: "third" },
  ]);
});

test("a raised limit resumes a paused build before it starts another", () => {
  assert.deepEqual(dispatchableUnits(status("limit", "builder"), idle), []);
  assert.deepEqual(dispatchableUnits(status("raised", "builder"), idle), [
    { stage: "builder", unitId: "second" },
    { stage: "builder", unitId: "third" },
  ]);
});

test("a Resume does not continue work paused at the unchanged spending limit", () => {
  const paused = status("limit", "builder");
  const resumed = {
    ...paused,
    events: [
      ...paused.events,
      ...(["stop_requested", "resumed"] as const).map((kind) => ({
        stage: null,
        unitId: null,
        kind,
        artifactHashes: [],
        reason: null,
        at: "2026-10-01T00:00:00.000Z",
      })),
    ],
  } as unknown as RunOperationStatus;
  assert.deepEqual(dispatchableUnits(resumed, idle), []);
});
