import assert from "node:assert/strict";
import test from "node:test";
import { hashJson } from "../packages/contracts/src/index.js";
import { analyzeExperiment } from "../packages/experiments/src/analysis.js";
import type { ProtocolEvidence } from "../packages/experiments/src/controller.js";
import type { ExemplarComparisonRecord } from "../packages/experiments/src/exemplar-comparison.js";
import {
  planDetectorCalibration,
  plannedCounts,
  type ExperimentPlan,
  type StudySource,
} from "../packages/experiments/src/protocols.js";

const views = [
  { id: "standard", partition: "development" as const },
  { id: "distant", partition: "development" as const },
  { id: "side", partition: "withheld" as const },
  { id: "compact", partition: "withheld" as const },
];
const sources: StudySource[] = ["gate", "shutter"].flatMap((evalId) =>
  (["generated", "generated", "generated", "working", "negative", "negative"] as const).map(
    (kind, index) => ({
      id: `${evalId}-${index}`,
      evalId,
      kind,
      sourceHash: hashJson([evalId, index]),
      targetCriterionIds: kind === "negative" ? ["required"] : [],
    }),
  ),
);
const baselines = {
  measurement: { changeThreshold: 16, onsetPixels: 1, regions: [], excluded: [], timing: [] },
  reference: null,
  rules: [],
  judgeControls: [],
  secondJudgeFamily: null,
};
const negative = (sourceId: string) =>
  sources.find((source) => source.id === sourceId)!.kind === "negative";
const stream = (maxMissRate: number) => ({
  criteria: [
    {
      evalId: "gate",
      criterionId: "required",
      choiceId: hashJson("gate-choice"),
      exemplarSourceHashes: [hashJson("gate-exemplar-1"), hashJson("gate-exemplar-2")],
    },
    {
      evalId: "shutter",
      criterionId: "required",
      choiceId: hashJson("shutter-choice"),
      exemplarSourceHashes: [hashJson("shutter-exemplar")],
    },
  ],
  maxMissRate,
});

/** The absolute judge is right on each build; the experts reject only the negatives. */
function evidenceFor(plan: ExperimentPlan): ProtocolEvidence {
  const subject = (captureId: string) =>
    plan.captures.find((capture) => capture.id === captureId)!.subjectId;
  return {
    requiredCriteria: { gate: ["required"], shutter: ["required"] },
    requiredPresentationCriteria: { gate: ["required"], shutter: ["required"] },
    completedGates: ["development-review", "presentation-selection"],
    builders: [],
    captures: plan.captures.map((capture) => ({
      id: capture.id,
      state: "completed",
      proofHash: hashJson(["capture", capture.id]),
    })),
    reviews: plan.captures.map((capture) => ({
      captureId: capture.id,
      proofHash: hashJson(["expert", capture.id]),
      decisions: { required: negative(capture.subjectId) ? "violated" : "satisfied" },
      blindingIssue: null,
    })),
    judgments: plan.judgments.map((unit) => ({
      id: unit.id,
      state: "completed",
      proofHash: hashJson(["judgment", unit.id]),
      decisions: {
        required: unit.substitution
          ? "insufficient"
          : negative(subject(unit.captureId))
            ? "violated"
            : "satisfied",
      },
      integrityIssue: false,
      costUsd: 0.1,
    })),
  };
}

/** Each answer prefers the build that the experts accept, in both orders. */
function recordsFor(plan: ExperimentPlan): ExemplarComparisonRecord[] {
  const comparison = plan.exemplarComparison!;
  return plan.captures.flatMap((capture) => {
    const item = comparison.criteria.find((entry) => entry.evalId === capture.evalId)!;
    return item.exemplarSourceHashes.flatMap((_, exemplar) =>
      comparison.orders.map((order) => ({
        captureId: capture.id,
        criterionId: item.criterionId,
        exemplar,
        order,
        preference: negative(capture.subjectId) ? ("exemplar" as const) : ("candidate" as const),
        integrityIssue: false,
      })),
    );
  });
}

test("a judge calibration preregisters the exemplar stream and its planned calls", () => {
  const plan = planDetectorCalibration({
    sources,
    views,
    baselines,
    exemplarComparison: stream(0.1),
  });
  assert.deepEqual(plan.exemplarComparison!.orders, ["candidate_first", "exemplar_first"]);
  // 72 gate observations × 2 exemplars × 2 orders + 72 shutter observations × 1 × 2.
  assert.equal(plannedCounts(plan).exemplarComparisonCalls, 432);
  assert.equal(plannedCounts(plan).judgmentBatches, 504, "The absolute stream is unchanged");
  assert.notEqual(
    plan.id,
    planDetectorCalibration({ sources, views, baselines, exemplarComparison: null }).id,
  );
  const refused = (change: Partial<ReturnType<typeof stream>>, text: RegExp) =>
    assert.throws(
      () =>
        planDetectorCalibration({
          sources,
          views,
          baselines,
          exemplarComparison: { ...stream(0.1), ...change },
        }),
      text,
    );
  refused(
    {
      criteria: [{ ...stream(0.1).criteria[0]!, exemplarSourceHashes: [sources[0]!.sourceHash] }],
    },
    /not planned builds/,
  );
  refused({ criteria: [{ ...stream(0.1).criteria[0]!, evalId: "beacon" }] }, /planned task/);
  refused({ criteria: [stream(0.1).criteria[0]!, stream(0.1).criteria[0]!] }, /unique/);
  refused({ maxMissRate: 1 }, /between 0 and 1/);
});

test("the exemplar stream meets the absolute stream on one bounded metric", () => {
  const plan = planDetectorCalibration({
    sources,
    views,
    baselines,
    exemplarComparison: stream(0.6),
  });
  const evidence = evidenceFor(plan);
  const records = recordsFor(plan);
  const flipped = plan.captures.find(
    (capture) => capture.subjectId === "gate-0" && capture.partition === "development",
  )!;
  const missing = plan.captures.find(
    (capture) => capture.subjectId === "shutter-1" && capture.partition === "withheld",
  )!;
  const changed = records.map((record) =>
    record.captureId === flipped.id && record.exemplar === 0 && record.order === "exemplar_first"
      ? { ...record, preference: "exemplar" as const }
      : record.captureId === missing.id
        ? { ...record, preference: null }
        : record,
  );
  const report = analyzeExperiment(plan, evidence, [], changed);
  assert.ok("exemplarComparison" in report && report.exemplarComparison);
  const analysis = report.exemplarComparison;
  const [development, withheld] = analysis.partitions;
  assert.deepEqual(
    [development!.intendedCalls, development!.answeredCalls],
    [216, 216],
    "36 gate observations × 4 calls + 36 shutter observations × 2 calls",
  );
  assert.deepEqual([withheld!.intendedCalls, withheld!.answeredCalls], [216, 214]);
  const gateFlips = development!.positionFlips.find((item) => item.taskId === "gate")!;
  assert.deepEqual([gateFlips.flips.numerator, gateFlips.flips.denominator], [1, 72]);
  const shutterFlips = withheld!.positionFlips.find((item) => item.taskId === "shutter")!;
  assert.deepEqual(
    [shutterFlips.flips.numerator, shutterFlips.flips.denominator, shutterFlips.flips.unresolved],
    [0, 35, 1],
  );
  const outcome = (rows: typeof development, sourceId: string) =>
    rows!.builds.find((build) => build.sourceId === sourceId)!.outcome;
  assert.equal(outcome(development, "gate-0"), "escalate", "A flip escalates the build");
  assert.equal(outcome(development, "gate-4"), "auto_reject");
  assert.equal(outcome(withheld, "shutter-1"), "escalate", "A missing answer escalates");
  assert.equal(outcome(withheld, "shutter-0"), "auto_accept");
  assert.deepEqual(
    analysis.boundedAutoDecision.map((row) => [
      row.stream,
      row.certification.certifiedRuleId,
      row.autoDecided.numerator,
      row.autoDecided.denominator,
    ]),
    [
      ["still", "unanimous-planned-captures", 12, 12],
      ["sequence", "unanimous-planned-captures", 12, 12],
      ["grounded-sequence", "unanimous-planned-captures", 12, 12],
      ["exemplar_comparison", "unanimous-planned-captures", 11, 12],
    ],
  );
  // Four failing withheld builds cannot certify a 10% miss rate, so each stream escalates all.
  const strict = planDetectorCalibration({
    sources,
    views,
    baselines,
    exemplarComparison: stream(0.1),
  });
  const bounded = analyzeExperiment(strict, evidenceFor(strict), [], recordsFor(strict));
  assert.ok("exemplarComparison" in bounded && bounded.exemplarComparison);
  assert.ok(
    bounded.exemplarComparison.boundedAutoDecision.every(
      (row) => row.certification.certifiedRuleId === null && row.autoDecided.numerator === 0,
    ),
  );
  // Without answers, the stream decides no build.
  const empty = analyzeExperiment(plan, evidence, [], []);
  assert.ok("exemplarComparison" in empty && empty.exemplarComparison);
  assert.equal(empty.exemplarComparison.boundedAutoDecision[3]!.autoDecided.numerator, 0);
  assert.throws(
    () => analyzeExperiment(plan, evidence, [], [records[0]!, records[0]!]),
    /more than once/,
  );
  assert.throws(
    () => analyzeExperiment(plan, evidence, [], [{ ...records[0]!, exemplar: 5 }]),
    /not planned/,
  );
  const plain = planDetectorCalibration({ sources, views, baselines, exemplarComparison: null });
  assert.throws(
    () => analyzeExperiment(plain, evidenceFor(plain), [], records),
    /exemplar comparison stream/,
  );
});
