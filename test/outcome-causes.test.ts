import assert from "node:assert/strict";
import test from "node:test";
import type { RunOperationEvent } from "../packages/contracts/src/execution.js";
import type { ExecutionFailure, FailureRecord } from "../packages/contracts/src/failure.js";
import { attributeOutcomes, countCauses } from "../packages/experiments/src/outcome-causes.js";

let sequence = 0;
function event(
  kind: RunOperationEvent["kind"],
  stage: RunOperationEvent["stage"],
  unitId: string,
  at: string,
  reason: string | null = null,
): RunOperationEvent {
  sequence += 1;
  return {
    schema: "basalt-evals/run-operation-event",
    id: `event-${sequence}`,
    sequence,
    previousHash: null,
    kind,
    stage,
    unitId,
    artifactHashes: [],
    reason,
    at: `2026-10-04T10:00:${at}.000Z`,
  };
}

function record(
  stage: string,
  id: string,
  at: string,
  category: ExecutionFailure["category"],
  causeCode: string,
): FailureRecord {
  return {
    id: `record-${stage}-${id}-${at}`,
    operationId: "flow-test",
    at: `2026-10-04T10:00:${at}.000Z`,
    causeCode,
    category,
    dependency: null,
    unit: { stage, id },
    evidenceRefs: [],
    recoveryActions: ["inspect"],
    explanation: "Recorded for the test.",
  };
}

test("each unit that did not finish gets one recorded cause, or unclassified", () => {
  const events = [
    event("started", "builder", "tr-tools", "01"),
    event("incomplete", "builder", "tr-tools", "02", "model_tool_use_failure"),
    event("started", "builder", "tr-gate", "01"),
    event("failed", "builder", "tr-gate", "03", "local_gate_rejected"),
    event("started", "final_capture", "capture-a", "04"),
    event(
      "incomplete",
      "final_capture",
      "capture-a",
      "06",
      "Studio did not finish the observation.",
    ),
    event("started", "judgment", "batch-a", "07"),
    event("incomplete", "judgment", "batch-a", "08", "judge_refusal"),
    event("started", "judgment", "batch-b", "07"),
    event("incomplete", "judgment", "batch-b", "09", "Error: socket hang up"),
    event("not_dispatched", "builder", "tr-later", "10", "stage_not_reached"),
    event("started", "builder", "tr-done", "01"),
    event("completed", "builder", "tr-done", "11"),
  ];
  // Studio could not record a step. The record has no cause code, but its category names the
  // missing evidence. The reason text is prose, so it admits no cause. The capture writer saves
  // the record just after its terminal event, as in a saved run of October 4.
  const records = [record("final_capture", "capture-a", "07", "acquisition", "unclassified")];
  const attributions = attributeOutcomes(events, records);
  assert.deepEqual(
    attributions.map(({ stage, unitId, kind, cause, source }) => ({
      stage,
      unitId,
      kind,
      cause,
      source,
    })),
    [
      {
        stage: "builder",
        unitId: "tr-tools",
        kind: "incomplete",
        cause: "model_tool_use_failure",
        source: "event_reason",
      },
      {
        stage: "builder",
        unitId: "tr-gate",
        kind: "failed",
        cause: "static_or_luau_failure",
        source: "event_reason",
      },
      {
        stage: "final_capture",
        unitId: "capture-a",
        kind: "incomplete",
        cause: "evidence_incomplete",
        source: "failure_record",
      },
      {
        stage: "judgment",
        unitId: "batch-a",
        kind: "incomplete",
        cause: "grader_failure",
        source: "event_reason",
      },
      {
        stage: "judgment",
        unitId: "batch-b",
        kind: "incomplete",
        cause: "unclassified",
        source: null,
      },
    ],
  );
  assert.deepEqual(countCauses(attributions), [
    { cause: "grader_failure", units: [{ stage: "judgment", unitId: "batch-a", subjectId: null }] },
    {
      cause: "evidence_incomplete",
      units: [{ stage: "final_capture", unitId: "capture-a", subjectId: null }],
    },
    {
      cause: "model_tool_use_failure",
      units: [{ stage: "builder", unitId: "tr-tools", subjectId: null }],
    },
    {
      cause: "static_or_luau_failure",
      units: [{ stage: "builder", unitId: "tr-gate", subjectId: null }],
    },
    { cause: "unclassified", units: [{ stage: "judgment", unitId: "batch-b", subjectId: null }] },
  ]);
});

test("a cause outside the build comes first, and only the last attempt counts", () => {
  const events = [
    // The provider failed during the last attempt, and the build then stopped on a tool call.
    event("started", "builder", "tr-provider", "01"),
    event("incomplete", "builder", "tr-provider", "03", "model_tool_use_failure"),
    // A provider failure of an earlier attempt. The resume cleared it, and the new attempt
    // stopped for its own reason.
    event("started", "builder", "tr-resumed", "01"),
    event("incomplete", "builder", "tr-resumed", "02", "provider_or_transport_failure"),
    event("started", "builder", "tr-resumed", "04"),
    event("incomplete", "builder", "tr-resumed", "06", "model_reasoning_failure"),
    // A unit that started again after its failure is in flight and has no cause.
    event("started", "final_capture", "capture-b", "01"),
    event("incomplete", "final_capture", "capture-b", "02", "Studio stopped."),
    event("started", "final_capture", "capture-b", "07"),
    // A writer that puts the unit key in the stage field.
    event("started", "judgment", "batch-c", "01"),
    event("incomplete", "judgment", "batch-c", "03", "Error: aborted"),
  ];
  const records = [
    record("builder", "tr-provider", "02", "provider", "provider_response_error_502"),
    record("builder", "tr-resumed", "02", "provider", "provider_response_error_502"),
    record("final_capture", "capture-b", "02", "startup", "studio_readiness_failed"),
    { ...record("judgment:batch-c", "flow-test", "02", "budget", "spending_ceiling") },
  ];
  assert.deepEqual(
    attributeOutcomes(events, records).map(({ unitId, cause, source }) => ({
      unitId,
      cause,
      source,
    })),
    [
      { unitId: "tr-provider", cause: "provider_or_transport_failure", source: "failure_record" },
      { unitId: "tr-resumed", cause: "model_reasoning_failure", source: "event_reason" },
      { unitId: "batch-c", cause: "budget_or_stop_failure", source: "failure_record" },
    ],
  );
});

test("a lost driver and an unknown record name no cause", () => {
  const events = [
    event("started", "builder", "tr-lost", "01"),
    event("incomplete", "builder", "tr-lost", "03", "unknown"),
  ];
  const records = [
    record("builder", "tr-lost", "02", "recovery", "unclassified"),
    record("builder", "tr-lost", "02", "unknown", "unclassified"),
  ];
  assert.deepEqual(
    attributeOutcomes(events, records).map(({ cause, source }) => ({ cause, source })),
    [{ cause: "unclassified", source: null }],
  );
});
