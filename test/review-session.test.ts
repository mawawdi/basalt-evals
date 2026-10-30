import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import type { ReviewAssignment, ReviewBatch } from "../packages/contracts/src/review.js";
import { reviewActivity } from "../packages/operator/src/review-session.js";
import { createReviewer } from "../packages/operator/src/reviewers.js";

test("each activity tick credits at most 30 seconds, and a session stops at 20 active minutes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-review-session-"));
  try {
    const reviewer = (await createReviewer(root, "Timed reviewer")).id;
    const batchId = "a".repeat(64);
    const assignmentId = "b".repeat(64);
    const tab = "timed-session-tab";
    const clock = Date.parse("2026-10-02T12:00:00.000Z");
    const batch: ReviewBatch = {
      id: batchId,
      previewId: "c".repeat(64),
      populationId: "d".repeat(64),
      purpose: "diagnostic",
      reviewer,
      orderSeed: "e".repeat(64),
      assignmentIds: [assignmentId],
      state: "active",
      sessions: [
        {
          number: 1,
          state: "open",
          startedAt: new Date(clock).toISOString(),
          activeMs: 0,
          answered: 0,
        },
      ],
      expert: null,
      createdAt: new Date(clock).toISOString(),
      operationIds: [],
    };
    const assignment: ReviewAssignment = {
      id: assignmentId,
      batchId,
      unitId: "unit",
      reviewer,
      ordinal: 0,
      releaseHash: "f".repeat(64),
      acknowledged: false,
      claim: { sessionId: tab, expiresAt: clock + 45_000 },
      draft: { revision: 0, decision: null, reason: null, blindingIssue: null },
      answerId: null,
      submittedVerdict: null,
      reusedFrom: null,
      repeatOf: null,
      peerAnswerId: null,
      sessionNumber: null,
    };
    // These are the records after the reviewer opened the first question in this tab.
    const journal = await OperationJournal.open(root);
    try {
      journal.transaction(() => {
        journal.put("review_batches", batchId, batch);
        journal.put("review_assignments", assignmentId, assignment);
        journal.put("review_lease", batchId, {
          reviewer,
          sessionId: tab,
          assignmentId,
          at: clock,
          active: false,
          sequence: -1,
        });
      });
    } finally {
      journal.close();
    }
    let sequence = 0;
    let now = clock;
    const tick = async (afterMs: number) => {
      now += afterMs;
      return (
        await reviewActivity(
          root,
          batchId,
          { reviewer, sessionId: tab, sequence: ++sequence, visible: true, focused: true },
          now,
        )
      ).session!;
    };
    // The first tick makes the tab active. Only the time after an active tick counts.
    assert.equal((await tick(30_000)).activeMs, 0);
    assert.equal((await tick(30_000)).activeMs, 30_000);
    // A long gap without ticks still counts as 30 seconds only.
    assert.equal((await tick(5 * 60_000)).activeMs, 60_000);
    for (let activeMs = 90_000; activeMs < 20 * 60_000; activeMs += 30_000)
      assert.deepEqual(await tick(30_000), { ...batch.sessions[0], activeMs });
    assert.deepEqual(await tick(30_000), {
      ...batch.sessions[0],
      state: "time_limit",
      activeMs: 20 * 60_000,
    });
    // After the limit, active time does not grow.
    assert.deepEqual(await tick(30_000), {
      ...batch.sessions[0],
      state: "time_limit",
      activeMs: 20 * 60_000,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
