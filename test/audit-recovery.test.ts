import assert from "node:assert/strict";
import test from "node:test";
import {
  assessmentOutcomeCounts,
  type AssessmentProgress,
} from "../packages/contracts/src/assessments.js";

const progress: AssessmentProgress = {
  operationId: "assessment",
  previewId: "a".repeat(64),
  sourceOperationId: "source",
  subjectIds: ["subject"],
  title: "Retained assessment",
  startedAt: "2026-09-25T12:00:00.000Z",
  planned: 3,
  completed: 0,
  incomplete: 0,
  inFlight: "unit-1",
  finished: false,
  stopped: true,
  error: null,
};

test("stopped, partial and pending assessment outcomes retain the complete planned denominator", () => {
  assert.deepEqual(assessmentOutcomeCounts(progress), {
    available: 0,
    incomplete: 0,
    remaining: 3,
    unavailable: 3,
    stoppedRemaining: 3,
  });
  const partial = assessmentOutcomeCounts({ ...progress, planned: 9, completed: 6, incomplete: 1 });
  assert.equal(partial.unavailable, 3);
  assert.equal(partial.remaining, 2);
  assert.equal(partial.available + partial.unavailable, 9);
  const pending = assessmentOutcomeCounts({ ...progress, stopped: false });
  assert.equal(pending.remaining, 3);
  assert.equal(pending.stoppedRemaining, 0);
  assert.throws(() => assessmentOutcomeCounts({ ...progress, completed: 4 }), /exceeds/);
});
