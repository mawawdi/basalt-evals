import { hashJson } from "../../contracts/src/index.js";
import { PRESENTATIONS, plannedCounts, type ExperimentPlan } from "./protocols.js";
import type { Decision, ProtocolEvidence } from "./controller.js";
import {
  acceptanceShares,
  buildOutcome,
  failingBuildOutcomes,
  selectiveOutcome,
  type AcceptanceRule,
  type ExpertLabel,
} from "./acceptance.js";
import { analyzeBaselines, type CaptureMeasurement } from "./baselines.js";
import { blockedComparison, disagreementRates, missRateBound } from "./statistics.js";
import { analyzeExemplarComparison, type ExemplarComparisonRecord } from "./exemplar-comparison.js";
import { judgeSampleGroups } from "./judge-samples.js";

type Outcome = 0 | 1 | null;
/** The expert decision of one capture over its required criteria. */
function expertCaptureDecision(
  decisions: Record<string, Decision> | undefined,
  required: string[],
): Decision {
  if (required.some((id) => decisions?.[id] === "violated")) return "violated";
  return required.length && required.every((id) => decisions?.[id] === "satisfied")
    ? "satisfied"
    : "insufficient";
}
/** Expert acceptance over all planned captures. One violation rejects; a gap stays unresolved. */
function expertAcceptance(values: Decision[], intended: number): Outcome {
  if (values.includes("violated")) return 0;
  return intended > 0 &&
    values.length === intended &&
    values.every((value) => value === "satisfied")
    ? 1
    : null;
}
function expertLabel(outcome: Outcome): ExpertLabel {
  return outcome === 1 ? "satisfied" : outcome === 0 ? "violated" : null;
}
function count(intended: number, states: string[], completed: string) {
  return {
    intended,
    attempted: states.length,
    completed: states.filter((state) => state === completed).length,
    failed: states.filter((state) => state !== completed).length,
    unattempted: intended - states.length,
  };
}

/**
 * Frozen protocol analysis only: no selection, transport, filesystem, or inferred expert labels.
 * Pixel measurements are numbers computed offline from recorded frames; only a judge
 * calibration takes them. Exemplar comparison answers come from the separate stream that the
 * plan preregisters; only a judge calibration takes them.
 */
export function analyzeExperiment(
  plan: ExperimentPlan,
  evidence: ProtocolEvidence,
  measurements: CaptureMeasurement[],
  comparisons: ExemplarComparisonRecord[],
) {
  const { id, ...body } = plan;
  if (hashJson(body) !== id) throw new Error("Analysis plan changed");
  if (plan.kind !== "detector_calibration" && measurements.length)
    throw new Error("Only a judge calibration takes pixel measurements");
  if (!plan.exemplarComparison && comparisons.length)
    throw new Error("Only a plan with an exemplar comparison stream takes its answers");
  for (const [records, units] of [
    [evidence.builders, plan.builders],
    [evidence.captures, plan.captures],
    [evidence.judgments, plan.judgments],
  ] as const) {
    if (
      new Set(records.map((record) => record.id)).size !== records.length ||
      records.some((record) => !units.some((unit) => unit.id === record.id))
    )
      throw new Error("Analysis includes duplicate or unplanned outcomes");
  }
  if (
    new Set(evidence.reviews.map((review) => review.captureId)).size !== evidence.reviews.length ||
    evidence.reviews.some(
      (review) => !plan.captures.some((capture) => capture.id === review.captureId),
    )
  )
    throw new Error("Analysis review is duplicated or unplanned");
  const captures = new Map(evidence.captures.map((item) => [item.id, item]));
  const judgments = new Map(evidence.judgments.map((item) => [item.id, item]));
  const reviews = new Map(evidence.reviews.map((item) => [item.captureId, item]));
  const builders = new Map(evidence.builders.map((item) => [item.id, item]));
  const required = (evalId: string) => {
    const ids = evidence.requiredCriteria[evalId];
    if (!ids?.length) throw new Error("Analysis lacks required criterion identities");
    return ids;
  };
  const reviewed = (capture: ExperimentPlan["captures"][number]) => {
    const review = reviews.get(capture.id);
    return captures.get(capture.id)?.state === "completed" &&
      review &&
      review.blindingIssue === null
      ? review
      : null;
  };
  const expert = (capture: ExperimentPlan["captures"][number]): Decision => {
    const review = reviewed(capture);
    return review
      ? expertCaptureDecision(review.decisions, required(capture.evalId))
      : "insufficient";
  };
  const candidate = (subjectId: string, partition: "development" | "withheld") => {
    if (builders.get(subjectId)?.state === "unrunnable") return 0 as const;
    const units = plan.captures.filter(
      (capture) => capture.subjectId === subjectId && capture.partition === partition,
    );
    return expertAcceptance(units.map(expert), units.length);
  };
  const groups = plan.reviewGroups.map((group) => {
    const units = group.captureIds.map((id) => plan.captures.find((capture) => capture.id === id)!);
    return {
      id: group.id,
      subjectId: group.subjectId,
      viewId: group.viewId,
      partition: group.partition,
      intendedPasses: units.length,
      capturedPasses: units.filter((unit) => captures.get(unit.id)?.state === "completed").length,
      reviewedPasses: units.filter((unit) => reviews.has(unit.id)).length,
      acceptance: expertAcceptance(units.map(expert), units.length),
    };
  });
  const base = {
    planHash: plan.id,
    kind: plan.kind,
    planned: plannedCounts(plan),
    units: {
      builder: count(
        plan.builders.length,
        evidence.builders.map((item) => item.state),
        "runnable",
      ),
      capture: count(
        plan.captures.length,
        evidence.captures.map((item) => item.state),
        "completed",
      ),
      judgment: count(
        plan.judgments.length,
        evidence.judgments.map((item) => item.state),
        "completed",
      ),
      review: {
        intendedPasses: plan.captures.length,
        reviewedPasses: evidence.reviews.length,
        unreviewedPasses: plan.captures.length - evidence.reviews.length,
      },
    },
    groups,
    blindingIssues: evidence.reviews
      .filter((item) => item.blindingIssue !== null)
      .map((item) => item.proofHash),
    analysis: plan.analysis,
    claimStatus:
      groups.every((group) => group.acceptance !== null) &&
      evidence.judgments.length === plan.judgments.length &&
      evidence.judgments.every((item) => item.state === "completed")
        ? "reviewed"
        : "incomplete",
  };
  if (plan.kind === "repair_discovery")
    return {
      ...base,
      discovery: plan.builders.map((builder) => ({
        id: builder.id,
        evalId: builder.evalId,
        modelId: builder.modelId,
        state: builders.get(builder.id)?.state ?? "unattempted",
        sourceHash: builders.get(builder.id)?.sourceHash ?? null,
        developmentAcceptance: candidate(builder.id, "development"),
        requiredViolationPasses: plan.captures
          .filter((capture) => capture.subjectId === builder.id && expert(capture) === "violated")
          .map((capture) => capture.id),
      })),
    };
  if (plan.kind === "detector_calibration") {
    const captureOf = new Map(plan.captures.map((capture) => [capture.id, capture]));
    const decision = (unitId: string, criterionId: string): Decision | null => {
      const judgment = judgments.get(unitId);
      return judgment?.state === "completed"
        ? (judgment.decisions[criterionId] ?? "insufficient")
        : null;
    };
    // A pixel-dependent criterion passes its evidence-use gate only when every blank and
    // unrelated control of its task and presentation answers insufficient.
    const evidenceUsePassed = (presentation: string, evalId: string, criterionId: string) => {
      if (!evidence.requiredPresentationCriteria[evalId]?.includes(criterionId)) return true;
      const controls = plan.judgments.filter(
        (unit) =>
          unit.presentation === presentation &&
          unit.substitution &&
          captureOf.get(unit.captureId)!.evalId === evalId,
      );
      return (
        controls.length > 0 &&
        controls.every((unit) => decision(unit.id, criterionId) === "insufficient")
      );
    };
    const treatments = PRESENTATIONS.flatMap((presentation) =>
      (["development", "withheld"] as const).map((partition) => {
        const units = plan.judgments.filter(
          (unit) =>
            unit.presentation === presentation &&
            captureOf.get(unit.captureId)!.partition === partition,
        );
        const native = units.filter((unit) => !unit.substitution);
        const planned = (sourceId: string) =>
          plan.captures.filter(
            (capture) => capture.subjectId === sourceId && capture.partition === partition,
          );
        const plannedCaptures = new Set(plan.sources.map((source) => planned(source.id).length));
        if (plannedCaptures.size !== 1)
          throw new Error("Detector calibration builds need equal planned captures");
        // The registered plan has one grader family. Each capture has the same number of
        // samples of one request, so the only rule is unanimity over every planned sample.
        const plannedSamples = new Set(
          judgeSampleGroups(native).map((group) => group.batches.length),
        );
        if (plannedSamples.size > 1)
          throw new Error("Detector calibration requests need equal planned samples");
        const rule: AcceptanceRule = {
          id: "unanimous-planned-captures",
          captures: [...plannedCaptures][0]!,
          repeats: [...plannedSamples][0] ?? 1,
          families: 1,
        };
        const builds = plan.sources.map((source) => {
          const sourceCaptures = planned(source.id);
          const requests = native.filter((unit) =>
            sourceCaptures.some((capture) => capture.id === unit.captureId),
          );
          const criteria = required(source.evalId).map((criterionId) => ({
            ...selectiveOutcome(
              {
                id: JSON.stringify([source.id, criterionId]),
                buildId: source.id,
                criterionId,
                threshold: null,
                samples: requests.flatMap((unit) => {
                  const value = decision(unit.id, criterionId);
                  return value === null
                    ? []
                    : [
                        {
                          captureId: unit.captureId,
                          repeat: unit.sample,
                          family: "registered-grader",
                          decision: value,
                          score: null,
                          truncated: false,
                        },
                      ];
                }),
                // Text that speaks to the judge escalates the unit. It never changes a decision.
                integrityIssue: requests.some(
                  (unit) => judgments.get(unit.id)?.integrityIssue === true,
                ),
                evidenceUseFailed: !evidenceUsePassed(presentation, source.evalId, criterionId),
                expertsDisagree: false,
              },
              rule,
            ),
            expert: expertLabel(
              expertAcceptance(
                sourceCaptures.map(
                  (capture) => reviewed(capture)?.decisions[criterionId] ?? "insufficient",
                ),
                sourceCaptures.length,
              ),
            ),
          }));
          return {
            sourceId: source.id,
            taskId: source.evalId,
            kind: source.kind,
            expert: criteria.some((item) => item.expert === "violated")
              ? ("violated" as const)
              : criteria.every((item) => item.expert === "satisfied")
                ? ("satisfied" as const)
                : null,
            outcome: buildOutcome(criteria),
            criteria,
          };
        });
        const shares = acceptanceShares(builds, plan.analysis.confidence);
        const disagreement = disagreementRates(
          native.flatMap((unit) => {
            const capture = captureOf.get(unit.captureId)!;
            return required(capture.evalId).map((criterionId) => ({
              group: JSON.stringify([capture.subjectId, capture.viewId, criterionId]),
              capture: capture.id,
              // The samples of one group are repeats of one identical request.
              request: JSON.stringify([unit.sampleGroupId, criterionId]),
              decision: decision(unit.id, criterionId),
            }));
          }),
        );
        const costs = units.map((unit) => judgments.get(unit.id)?.costUsd ?? null);
        return {
          presentation,
          partition,
          intended: native.length,
          completed: native.filter((unit) => judgments.get(unit.id)?.state === "completed").length,
          rule,
          missRate: shares.missRate,
          falseRejectionRate: shares.falseRejectionRate,
          removalShare: shares.removalShare,
          escalationShare: shares.escalationShare,
          missRateBound: missRateBound(failingBuildOutcomes(builds), plan.analysis.confidence),
          identicalRequestFlips: disagreement.identicalRequestFlips,
          crossCaptureDisagreement: disagreement.crossCaptureDisagreement,
          abstentions: native.filter((unit) => {
            const capture = captureOf.get(unit.captureId)!;
            return required(capture.evalId).some(
              (criterionId) => decision(unit.id, criterionId) === "insufficient",
            );
          }).length,
          missingJudgments: native.filter((unit) => judgments.get(unit.id)?.state !== "completed")
            .length,
          presentationControls: units
            .filter((unit) => unit.substitution)
            .map((unit) => ({
              id: unit.id,
              kind: unit.substitution!.kind,
              abstained:
                judgments.get(unit.id)?.state === "completed"
                  ? Object.values(judgments.get(unit.id)!.decisions).every(
                      (value) => value === "insufficient",
                    )
                  : null,
            })),
          knownCostUsd: costs.every((cost) => cost !== null)
            ? costs.reduce<number>((sum, cost) => sum + cost!, 0)
            : null,
          builds,
        };
      }),
    );
    return {
      ...base,
      treatments,
      baselines: analyzeBaselines(plan, required, treatments, measurements),
      exemplarComparison: plan.exemplarComparison
        ? analyzeExemplarComparison({
            plan,
            required,
            absolute: treatments,
            records: comparisons,
            confidence: plan.analysis.confidence,
          })
        : null,
    };
  }
  if (plan.kind === "harness_effectiveness") {
    const trials = plan.builders.map((unit) => ({
      id: unit.id,
      evalId: unit.evalId,
      modelId: unit.modelId,
      harness: unit.harness,
      repetition: unit.repetition,
      state: builders.get(unit.id)?.state ?? "unattempted",
      sourceHash: builders.get(unit.id)?.sourceHash ?? null,
      acceptance: candidate(unit.id, "withheld"),
      knownBuilderCostUsd: builders.get(unit.id)?.costUsd ?? null,
    }));
    return {
      ...base,
      // Builds are independent inside each task × model block. A repetition index never pairs them.
      comparison: {
        ...plan.configuration.harnessArms!,
        ...blockedComparison(
          trials.map((trial) => ({
            block: JSON.stringify([trial.evalId, trial.modelId]),
            arm:
              trial.harness === plan.configuration.harnessArms!.treatment
                ? ("treatment" as const)
                : ("baseline" as const),
            outcome: trial.acceptance,
          })),
        ),
      },
      trials,
    };
  }
  return {
    ...base,
    parents: plan.sources.map((parent) => ({
      id: parent.id,
      withheldAcceptance: candidate(parent.id, "withheld"),
    })),
    attempts: plan.builders.map((unit) => {
      const parent = unit.parentSourceId!,
        units = plan.captures.filter(
          (capture) => capture.subjectId === unit.id && capture.partition === "withheld",
        );
      const regressions = units.flatMap((capture) => {
        const parentCapture = plan.captures.find(
          (other) =>
            other.subjectId === parent &&
            other.viewId === capture.viewId &&
            other.pass === capture.pass &&
            other.partition === "withheld",
        );
        const baseline = parentCapture ? reviews.get(parentCapture.id) : undefined,
          repaired = reviews.get(capture.id);
        if (!baseline || !repaired || baseline.blindingIssue || repaired.blindingIssue) return [];
        return required(unit.evalId)
          .filter(
            (id) => baseline.decisions[id] === "satisfied" && repaired.decisions[id] === "violated",
          )
          .map((criterionId) => ({ viewId: capture.viewId, pass: capture.pass, criterionId }));
      });
      return {
        id: unit.id,
        parentId: parent,
        assistance: unit.assistance,
        state: builders.get(unit.id)?.state ?? "unattempted",
        sourceHash: builders.get(unit.id)?.sourceHash ?? null,
        knownBuilderCostUsd: builders.get(unit.id)?.costUsd ?? null,
        developmentAcceptance: candidate(unit.id, "development"),
        withheldAcceptance: candidate(unit.id, "withheld"),
        regressions,
      };
    }),
  };
}
