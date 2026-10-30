import assert from "node:assert/strict";
import test from "node:test";
import { analyzeExperiment } from "../packages/experiments/src/analysis.js";
import { hashJson } from "../packages/contracts/src/index.js";
import {
  nextProtocolDecision,
  type ProtocolEvidence,
} from "../packages/experiments/src/controller.js";
import {
  planDetectorCalibration,
  planHarnessComparison,
  planMatchedRepair,
  planRepairDiscovery,
  type ExperimentPlan,
  type StudySource,
} from "../packages/experiments/src/protocols.js";

/** The bounds of the two registered harnesses that a protocol plan binds. */
const PLANNED_HARNESSES = {
  baseline: { id: "thin", maxTurns: 32, developmentRuns: 0 },
  treatment: { id: "production", maxTurns: 32, developmentRuns: 3 },
};

const views = ["development", "withheld"].flatMap((partition) =>
  [1, 2].map((view) => ({
    id: `${partition}-${view}`,
    partition: partition as "development" | "withheld",
  })),
);
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
function fixtures(plan: ExperimentPlan): ProtocolEvidence {
  const captures = plan.captures.filter((capture) => capture.partition === "development");
  const verdict = (id: string) => {
    const capture = captures.find((capture) => capture.id === id)!;
    return plan.sources.find((source) => source.id === capture.subjectId)?.kind === "negative"
      ? ("violated" as const)
      : ("satisfied" as const);
  };
  return {
    requiredCriteria: { gate: ["required"], shutter: ["required"] },
    requiredPresentationCriteria: { gate: ["required"], shutter: ["required"] },
    completedGates: [],
    captures: captures.map((capture) => ({
      id: capture.id,
      state: "completed",
      proofHash: hashJson(["synthetic-capture", capture.id]),
    })),
    reviews: captures.map((capture) => ({
      captureId: capture.id,
      proofHash: hashJson(["synthetic-expert", capture.id]),
      decisions: { required: verdict(capture.id) },
      blindingIssue: null,
    })),
    builders: plan.builders.map((builder) => ({
      id: builder.id,
      state: "runnable",
      proofHash: hashJson(["synthetic-builder", builder.id]),
      sourceHash: hashJson(builder.id),
      costUsd: 1,
    })),
    judgments: plan.judgments
      .filter((unit) => captures.some((capture) => capture.id === unit.captureId))
      .map((unit) => ({
        id: unit.id,
        state: "completed",
        proofHash: hashJson(["synthetic-judgment", unit.id]),
        decisions: { required: unit.substitution ? "insufficient" : verdict(unit.captureId) },
        integrityIssue: false,
        costUsd: unit.presentation === "sequence" ? 0.1 : 0.2,
      })),
  };
}

test("presentation substitutions require abstention only for claims depending on replaced pixels", () => {
  const plan = planDetectorCalibration({ sources, views, baselines, exemplarComparison: null });
  const evidence = fixtures(plan);
  for (const required of Object.values(evidence.requiredCriteria)) required.push("source-valid");
  for (const record of [...evidence.reviews, ...evidence.judgments])
    record.decisions["source-valid"] = "satisfied";
  evidence.completedGates.push("development-review");
  const selection = nextProtocolDecision(plan, evidence)!;
  assert.deepEqual((selection.decision as { selection: unknown }).selection, {
    id: "sequence",
    calibration: "eligible",
  });
  evidence.requiredPresentationCriteria.gate = [];
  const unsupported = nextProtocolDecision(plan, evidence)!;
  assert.notEqual(
    (unsupported.decision as { selection: { calibration: string } }).selection.calibration,
    "eligible",
  );
});

test("calibration controller waits for exact pass labels, seals development selection, and rejects withheld inputs", () => {
  const plan = planDetectorCalibration({ sources, views, baselines, exemplarComparison: null });
  const evidence = fixtures(plan);
  assert.equal(
    nextProtocolDecision(plan, { ...evidence, reviews: evidence.reviews.slice(1) }),
    null,
  );
  const review = nextProtocolDecision(plan, evidence)!;
  assert.equal(review.gateId, "development-review");
  evidence.completedGates.push(review.gateId);
  const selection = nextProtocolDecision(plan, evidence)!;
  assert.equal(selection.gateId, "presentation-selection");
  assert.deepEqual((selection.decision as { selection: unknown }).selection, {
    id: "sequence",
    calibration: "eligible",
  });
  assert.ok(selection.evidenceHashes.includes(evidence.reviews[0]!.proofHash));
  assert.equal(
    nextProtocolDecision(plan, {
      ...evidence,
      completedGates: [...evidence.completedGates, selection.gateId],
    }),
    null,
  );
  assert.throws(
    () =>
      nextProtocolDecision(plan, {
        ...evidence,
        captures: [
          ...evidence.captures,
          {
            id: plan.captures.find((capture) => capture.partition === "withheld")!.id,
            state: "completed",
            proofHash: hashJson("holdout"),
          },
        ],
      }),
    /withheld/,
  );
});

test("missing evidence controls and failed native controls produce an honest provisional presentation", () => {
  const plan = planDetectorCalibration({ sources, views, baselines, exemplarComparison: null });
  const evidence = fixtures(plan);
  evidence.completedGates.push("development-review");
  const syntheticIds = new Set(
    plan.judgments.filter((unit) => unit.substitution).map((unit) => unit.id),
  );
  for (const result of evidence.judgments)
    if (syntheticIds.has(result.id)) result.decisions.required = "satisfied";
  assert.deepEqual(
    (nextProtocolDecision(plan, evidence)!.decision as { selection: unknown }).selection,
    { id: "sequence", calibration: "provisional" },
  );
  const fresh = fixtures(plan);
  fresh.completedGates.push("development-review");
  const failed = plan.captures.find(
    (capture) => capture.subjectId === "gate-3" && capture.partition === "development",
  )!;
  fresh.captures.find((capture) => capture.id === failed.id)!.state = "failed";
  fresh.judgments = fresh.judgments.filter(
    (result) => plan.judgments.find((unit) => unit.id === result.id)!.captureId !== failed.id,
  );
  fresh.reviews = fresh.reviews.filter((review) => review.captureId !== failed.id);
  assert.deepEqual(
    (nextProtocolDecision(plan, fresh)!.decision as { selection: unknown }).selection,
    { id: "sequence", calibration: "provisional" },
  );
});

test("matched repair seals every outcome and source, keeps unrunnable attempts, and uses frozen selection authority", () => {
  const parents = sources.filter((source) => source.id.endsWith("-0"));
  for (const selectionAuthority of ["model", "expert"] as const) {
    const plan = planMatchedRepair({
      harness: PLANNED_HARNESSES.treatment,
      builderModelId: "openai/gpt-6-luna",
      parents,
      views,
      presentation: "sequence",
      seed: 31,
      selectionAuthority,
      presentationSelectionHash: hashJson("selection"),
    });
    const evidence = fixtures(plan);
    const failed = plan.builders[0]!;
    evidence.builders[0] = { ...evidence.builders[0]!, state: "unrunnable", sourceHash: null };
    const failedCaptures = new Set(
      plan.captures
        .filter((capture) => capture.subjectId === failed.id)
        .map((capture) => capture.id),
    );
    evidence.captures = evidence.captures.filter((capture) => !failedCaptures.has(capture.id));
    evidence.reviews = evidence.reviews.filter((review) => !failedCaptures.has(review.captureId));
    evidence.judgments = evidence.judgments.filter(
      (judgment) =>
        !failedCaptures.has(plan.judgments.find((unit) => unit.id === judgment.id)!.captureId),
    );
    if (selectionAuthority === "expert")
      evidence.completedGates.push(nextProtocolDecision(plan, evidence)!.gateId);
    else evidence.reviews = [];
    const selection = nextProtocolDecision(plan, evidence)!;
    const decision = selection.decision as {
      authority: string;
      groups: Array<{
        selectedId: string | null;
        attempts: Array<{ id: string; runnable: boolean; sourceHash: string | null }>;
      }>;
    };
    assert.equal(decision.authority, selectionAuthority);
    assert.equal(decision.groups.flatMap((group) => group.attempts).length, 12);
    assert.ok(decision.groups.every((group) => group.selectedId !== failed.id));
    assert.ok(selection.evidenceHashes.includes(evidence.builders[0]!.proofHash));
    assert.equal(
      nextProtocolDecision(plan, { ...evidence, builders: evidence.builders.slice(1) }),
      null,
    );
  }
});

test("one discovery block selects the first expert-confirmed defect and retains inconclusive task outcomes", () => {
  const plan = planRepairDiscovery({
    harness: PLANNED_HARNESSES.treatment,
    builderModelIds: ["openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash"],
    evalIds: ["gate", "shutter"],
    views: views.filter((view) => view.partition === "development"),
    presentation: "sequence",
    presentationSelectionHash: hashJson("presentation"),
    seed: 81,
  });
  assert.equal(plan.builders.length, 4);
  assert.equal(plan.captures.length, 24);
  assert.equal(plan.reviewGroups.length, 8);
  assert.equal(
    plan.captures.some((capture) => capture.partition === "withheld"),
    false,
  );
  const evidence = fixtures(plan);
  const unreviewed = structuredClone(evidence);
  unreviewed.reviews = [];
  assert.equal(nextProtocolDecision(plan, unreviewed), null);
  const first = plan.builders[0]!;
  const pass = plan.captures.find((capture) => capture.subjectId === first.id)!;
  evidence.reviews.find((review) => review.captureId === pass.id)!.decisions.required = "violated";
  evidence.completedGates.push(nextProtocolDecision(plan, evidence)!.gateId);
  const selected = nextProtocolDecision(plan, evidence)!;
  const tasks = (
    selected.decision as {
      tasks: Array<{
        evalId: string;
        outcome: string;
        selectedBuilderId: string | null;
        attempts: unknown[];
      }>;
    }
  ).tasks;
  assert.deepEqual(
    tasks.map((task) => [task.evalId, task.outcome, task.selectedBuilderId]),
    [
      ["gate", "eligible", first.id],
      ["shutter", "inconclusive", null],
    ],
  );
  assert.equal(tasks[1]!.attempts.length, 2);
  evidence.reviews.find((review) => review.captureId === pass.id)!.blindingIssue =
    "Synthetic unblinded pass";
  const blinded = (
    nextProtocolDecision(plan, evidence)!.decision as { tasks: Array<{ outcome: string }> }
  ).tasks;
  assert.ok(blinded.every((task) => task.outcome === "inconclusive"));
  assert.equal(analyzeExperiment(plan, evidence, [], []).units.builder.intended, 4);
});

const counts = (share: { numerator: number; denominator: number; unresolved: number }) => [
  share.numerator,
  share.denominator,
  share.unresolved,
];

test("experiment reports give exact build cells, selective outcomes and separate disagreement sources", () => {
  const plan = planDetectorCalibration({ sources, views, baselines, exemplarComparison: null });
  const evidence = fixtures(plan);
  const report = analyzeExperiment(plan, evidence, [], []);
  assert.equal(report.units.capture.intended, 144);
  assert.equal(report.units.capture.completed, 72);
  assert.equal(report.units.capture.unattempted, 72);
  assert.equal(report.claimStatus, "incomplete");
  assert.ok("treatments" in report);
  const held = report.treatments.find(
    (row) => row.presentation === "sequence" && row.partition === "withheld",
  )!;
  assert.equal(held.completed, 0);
  assert.deepEqual(counts(held.escalationShare), [12, 12, 0]);
  assert.ok(
    held.builds.every(
      (build) =>
        build.outcome === "escalate" && build.criteria[0]!.reasons.includes("missing_samples"),
    ),
  );
  assert.deepEqual([held.missRate.unresolved, held.missRate.estimate], [12, null]);
  assert.deepEqual([held.missRate.interval!.lower, held.missRate.interval!.upper], [0, 1]);
  const dev = report.treatments.find(
    (row) => row.presentation === "sequence" && row.partition === "development",
  )!;
  assert.equal(dev.rule.captures, 6);
  assert.equal(dev.presentationControls.length, 24);
  assert.ok(dev.presentationControls.every((item) => item.abstained));
  assert.deepEqual(counts(dev.missRate), [0, 4, 0]);
  assert.deepEqual(counts(dev.falseRejectionRate), [0, 8, 0]);
  assert.equal(dev.removalShare.estimate, 1);
  assert.ok(dev.missRate.interval!.upper > 0.5, "Four failing builds give a wide exact interval");
  assert.equal(dev.missRateBound.failingBuilds, 4);
  assert.ok(Math.abs(dev.missRateBound.upperBound - (1 - 0.05 ** (1 / 4))) < 1e-12);
  assert.deepEqual(dev.crossCaptureDisagreement, {
    numerator: 0,
    denominator: 24,
    unresolved: 0,
    estimate: 0,
  });
  assert.deepEqual(dev.identicalRequestFlips, {
    numerator: 0,
    denominator: 0,
    unresolved: 0,
    estimate: null,
  });
  assert.throws(
    () =>
      analyzeExperiment(
        plan,
        {
          ...evidence,
          reviews: [...evidence.reviews, evidence.reviews[0]!],
        },
        [],
        [],
      ),
    /duplicated/,
  );
});

test("a failed control, a capture disagreement and an accepted negative change selective outcomes", () => {
  const plan = planDetectorCalibration({ sources, views, baselines, exemplarComparison: null });
  const evidence = fixtures(plan);
  const capture = (id: string) => plan.captures.find((item) => item.id === id)!;
  const record = (id: string) => evidence.judgments.find((item) => item.id === id)!;
  const native = (sourceId: string) =>
    plan.judgments.filter(
      (unit) =>
        unit.presentation === "sequence" &&
        !unit.substitution &&
        capture(unit.captureId).subjectId === sourceId &&
        capture(unit.captureId).partition === "development",
    );
  const control = plan.judgments.find(
    (unit) =>
      unit.presentation === "sequence" &&
      unit.substitution &&
      capture(unit.captureId).evalId === "gate",
  )!;
  record(control.id).decisions.required = "satisfied";
  const generated = sources.find((item) => item.evalId === "shutter" && item.kind === "generated")!;
  record(native(generated.id)[0]!.id).decisions.required = "violated";
  const negative = sources.find((item) => item.evalId === "shutter" && item.kind === "negative")!;
  for (const unit of native(negative.id)) record(unit.id).decisions.required = "satisfied";
  const report = analyzeExperiment(plan, evidence, [], []);
  assert.ok("treatments" in report);
  const row = (presentation: string) =>
    report.treatments.find(
      (item) => item.presentation === presentation && item.partition === "development",
    )!;
  const dev = row("sequence");
  const build = (id: string) => dev.builds.find((item) => item.sourceId === id)!;
  assert.ok(
    dev.builds
      .filter((item) => item.taskId === "gate")
      .every(
        (item) =>
          item.outcome === "escalate" && item.criteria[0]!.reasons.includes("evidence_use_failed"),
      ),
  );
  assert.deepEqual(build(generated.id).criteria[0]!.reasons, ["capture_disagreement"]);
  assert.equal(build(negative.id).outcome, "auto_accept");
  assert.deepEqual(counts(dev.missRate), [1, 4, 0]);
  assert.equal(dev.missRateBound.misses, 1);
  assert.equal(dev.crossCaptureDisagreement.numerator, 1);
  assert.equal(row("still").removalShare.estimate, 1, "Other presentations keep their outcomes");
});

test("harness reports compare arms inside task × model blocks and never pair by repetition", () => {
  const evalIds = ["checkpoint", "xp", "shutter", "gate"];
  const plan = planHarnessComparison({
    harnesses: PLANNED_HARNESSES,
    builderModelIds: ["openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash"],
    evalIds,
    orderSeed: 37,
    presentation: "sequence",
    presentationSelectionHash: hashJson("selection"),
  });
  const reversed = (builder: ExperimentPlan["builders"][number]) =>
    builder.evalId === "gate" && builder.modelId === "deepseek/deepseek-v4.1-flash";
  const evidenceFor = (
    accepted: (builder: ExperimentPlan["builders"][number]) => boolean,
  ): ProtocolEvidence => ({
    requiredCriteria: Object.fromEntries(evalIds.map((id) => [id, ["required"]])),
    requiredPresentationCriteria: Object.fromEntries(evalIds.map((id) => [id, ["required"]])),
    completedGates: [],
    captures: plan.captures.map((item) => ({
      id: item.id,
      state: "completed",
      proofHash: hashJson(["capture", item.id]),
    })),
    reviews: plan.captures.map((item) => ({
      captureId: item.id,
      proofHash: hashJson(["review", item.id]),
      decisions: {
        required: accepted(plan.builders.find((builder) => builder.id === item.subjectId)!)
          ? "satisfied"
          : "violated",
      },
      blindingIssue: null,
    })),
    builders: plan.builders.map((builder) => ({
      id: builder.id,
      state: "runnable",
      proofHash: hashJson(["builder", builder.id]),
      sourceHash: hashJson(builder.id),
      costUsd: 1,
    })),
    judgments: [],
  });
  const report = analyzeExperiment(
    plan,
    evidenceFor((builder) =>
      builder.harness === "production"
        ? !reversed(builder) || builder.repetition === 1
        : reversed(builder)
          ? builder.repetition <= 2
          : builder.repetition === 1,
    ),
    [],
    [],
  );
  assert.ok("comparison" in report);
  assert.equal(report.comparison.blocks.length, 8);
  assert.deepEqual(
    [report.comparison.signTest.treatmentBetter, report.comparison.signTest.baselineBetter],
    [7, 1],
  );
  assert.ok(Math.abs(report.comparison.signTest.treatmentBetterP - 9 / 256) < 1e-12);
  const relabelled = analyzeExperiment(
    plan,
    evidenceFor((builder) =>
      builder.harness === "production"
        ? !reversed(builder) || builder.repetition === 3
        : reversed(builder)
          ? builder.repetition >= 2
          : builder.repetition === 2,
    ),
    [],
    [],
  );
  assert.ok("comparison" in relabelled);
  assert.deepEqual(relabelled.comparison, report.comparison);
});
