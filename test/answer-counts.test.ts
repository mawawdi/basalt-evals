import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import type { ResultSummary, RunSummary } from "../packages/contracts/src/catalog.js";
import type { ExecutionProgress } from "../packages/contracts/src/console.js";
import type { RunOperationStatus } from "../packages/contracts/src/execution.js";
import {
  answerCounts,
  plannedChecks,
  runAnswerCounts,
} from "../packages/operator/src/answer-counts.js";
import { projectRun } from "../packages/operator/src/catalog-projection.js";
import { projectOperationProgress } from "../packages/operator/src/operation.js";
import { STAGE_NOT_REACHED } from "../packages/operator/src/stage-reach.js";

type Outcome = RunOperationStatus["criterionOutcomes"][number]["outcome"];

/**
 * Two builds with one observation each. Each observation has one code check and one judge
 * sample group of three samples for two criteria. Thus the run plans 6 checks and 14 outcomes.
 */
function sampledRun(judged: Record<string, Array<Outcome | null>>, code: Outcome[]) {
  const builds = ["build-1", "build-2"];
  const batches = builds.flatMap((_, index) =>
    [1, 2, 3].map((sample) => ({
      id: `judgment-${index + 1}-${sample}`,
      captureCellId: `capture-${index + 1}`,
      sampleGroupId: `group-${index + 1}`,
      sample,
      criterionIds: ["blue", "bright"],
    })),
  );
  const outcome = (cellId: string, criterionId: string, value: Outcome) => ({
    cellId,
    criterionId,
    outcome: value,
    decisionAuthority: "model" as const,
    evidence: [],
  });
  return {
    manifest: {
      id: "sampled-run",
      subjects: builds.map((id) => ({ id, evalId: "evaluation", kind: "generated" })),
      evals: [
        {
          id: "evaluation",
          stage: {
            firstRevisionId: "evaluation",
            index: 1,
            count: 1,
            earlierPrompts: [],
            gateCriterionIds: [],
          },
        },
      ],
      captureCells: builds.map((treatmentId, index) => ({
        id: `capture-${index + 1}`,
        treatmentId,
        pass: 1,
      })),
      gradingCells: builds.map((_, index) => ({
        id: `grade-${index + 1}`,
        captureCellId: `capture-${index + 1}`,
        criterionId: "exists",
        method: "deterministic",
      })),
      judgmentBatches: batches,
      planned: { independentBuilderTrials: 0, criterionOutcomes: 14 },
    },
    events: [],
    inFlightUnits: [],
    completedUnits: [],
    pauseRecords: {},
    finished: true,
    stopped: false,
    criterionOutcomes: [
      ...code.map((value, index) => outcome(`grade-${index + 1}`, "exists", value)),
      ...batches.flatMap((batch) =>
        ["blue", "bright"].flatMap((criterionId) => {
          const value = judged[`${batch.sampleGroupId}:${criterionId}`]![batch.sample - 1];
          return value ? [outcome(batch.id, criterionId, value)] : [];
        }),
      ),
    ],
  } as unknown as RunOperationStatus;
}

test("A run with three judge samples counts one answer for each check.", () => {
  const status = sampledRun(
    {
      // An insufficient sample makes the check insufficient, not unavailable.
      "group-1:blue": ["insufficient", "verified", "verified"],
      // Samples that disagree make a split.
      "group-1:bright": ["verified", "rejected", "verified"],
      "group-2:blue": ["verified", "verified", "verified"],
      // A sample without an answer leaves the check unavailable.
      "group-2:bright": ["verified", "verified", null],
    },
    ["verified", "rejected"],
  );
  assert.equal(plannedChecks(status).length, 6, "Not 14, one for each sample");
  assert.deepEqual(answerCounts(plannedChecks(status)), {
    planned: 6,
    met: 2,
    rejected: 1,
    split: 1,
    scored: 0,
    insufficient: 1,
    unavailable: 1,
  });
});

test("Not enough evidence is an answer, and a check without any sample is unavailable.", () => {
  const status = sampledRun(
    {
      "group-1:blue": ["insufficient", "insufficient", "insufficient"],
      "group-1:bright": ["insufficient", "rejected", "verified"],
      "group-2:blue": [null, null, null],
      "group-2:bright": ["scored", "scored", "scored"],
    },
    ["incomplete", "verified"],
  );
  assert.deepEqual(answerCounts(plannedChecks(status)), {
    planned: 6,
    met: 1,
    rejected: 0,
    split: 0,
    scored: 1,
    insufficient: 2,
    // The code check that could not decide and the judge check without any sample.
    unavailable: 2,
  });
});

test("The answers of a run leave out the builds that the run did not reach.", () => {
  const status = sampledRun(
    {
      "group-1:blue": ["verified", "verified", "verified"],
      "group-1:bright": ["verified", "verified", "verified"],
      "group-2:blue": [null, null, null],
      "group-2:bright": [null, null, null],
    },
    ["verified"],
  );
  status.events = [
    {
      kind: "not_dispatched",
      stage: "builder",
      unitId: "build-2",
      reason: STAGE_NOT_REACHED,
    } as RunOperationStatus["events"][number],
  ];
  assert.deepEqual(runAnswerCounts(status), {
    planned: 3,
    met: 3,
    rejected: 0,
    split: 0,
    scored: 0,
    insufficient: 0,
    unavailable: 0,
  });
});

test("A finished run with not enough evidence is complete, and its progress counts it apart.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-answer-counts-"));
  const journal = await OperationJournal.open(root);
  try {
    const status = sampledRun(
      {
        "group-1:blue": ["insufficient", "insufficient", "insufficient"],
        "group-1:bright": ["verified", "verified", "verified"],
        "group-2:blue": ["verified", "rejected", "verified"],
        "group-2:bright": ["rejected", "rejected", "rejected"],
      },
      ["verified", "verified"],
    );
    journal.put("operations", status.manifest.id, status);
    projectOperationProgress(journal, status);
    projectRun(journal, status.manifest.id);
    const progress = journal.read<ExecutionProgress>("operation_progress", status.manifest.id)!;
    assert.deepEqual(progress.answers, {
      planned: 6,
      met: 3,
      rejected: 1,
      split: 1,
      scored: 0,
      insufficient: 1,
      unavailable: 0,
    });
    const run = journal.read<RunSummary>("catalog_runs", status.manifest.id)!;
    assert.equal(run.state, "complete", "Not enough evidence never makes results missing");
    const build = journal.read<ResultSummary>("catalog_results", "sampled-run:build-1")!;
    assert.equal(build.qualitative.insufficient, 1);
    assert.equal(build.qualitative.unavailable, 0);
    assert.equal(build.captures[0]!.insufficient, 1);
    // One judge sample without an answer leaves results missing.
    status.criterionOutcomes = status.criterionOutcomes.filter(
      (item) => !(item.cellId === "judgment-2-3" && item.criterionId === "bright"),
    );
    journal.put("operations", status.manifest.id, status);
    projectOperationProgress(journal, status);
    projectRun(journal, status.manifest.id);
    assert.equal(
      journal.read<ExecutionProgress>("operation_progress", status.manifest.id)!.answers
        .unavailable,
      1,
    );
    assert.equal(journal.read<RunSummary>("catalog_runs", status.manifest.id)!.state, "partial");
  } finally {
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});
