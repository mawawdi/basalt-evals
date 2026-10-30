import { hashJson } from "../../contracts/src/index.js";
import {
  PRESENTATIONS,
  selectPresentation,
  selectRepairAttempt,
  type ExperimentPlan,
} from "./protocols.js";

export type Decision = "satisfied" | "violated" | "insufficient";
export interface ProtocolEvidence {
  requiredCriteria: Record<string, string[]>;
  requiredPresentationCriteria: Record<string, string[]>;
  captures: Array<{ id: string; state: "completed" | "failed"; proofHash: string }>;
  judgments: Array<{
    id: string;
    state: "completed" | "failed";
    proofHash: string;
    decisions: Record<string, Decision>;
    /** The judge reported text in the build output that speaks to it. */
    integrityIssue: boolean;
    costUsd: number | null;
  }>;
  reviews: Array<{
    captureId: string;
    proofHash: string;
    decisions: Record<string, Decision>;
    blindingIssue: string | null;
  }>;
  builders: Array<{
    id: string;
    state: "runnable" | "unrunnable";
    proofHash: string;
    sourceHash: string | null;
    costUsd: number | null;
  }>;
  completedGates: string[];
}
interface ProtocolDecision {
  gateId: string;
  kind: "review" | "selection";
  planHash: string;
  evidenceHashes: string[];
  decision: unknown;
}

function route(decisions: Record<string, Decision>, required: string[]): Decision {
  if (required.some((id) => decisions[id] === "violated")) return "violated";
  return required.length && required.every((id) => decisions[id] === "satisfied")
    ? "satisfied"
    : "insufficient";
}
function knownCost(values: Array<number | null>): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + value!, 0);
}

/** Pure protocol policy: no files, clocks, provider clients, worker ownership or accounting. */
export function nextProtocolDecision(
  plan: ExperimentPlan,
  evidence: ProtocolEvidence,
): ProtocolDecision | null {
  const { id, ...body } = plan;
  if (id !== hashJson(body)) throw new Error("Protocol plan changed");
  const development = plan.captures.filter((capture) => capture.partition === "development");
  const developmentIds = new Set(development.map((capture) => capture.id));
  if (
    evidence.captures.some((capture) => !developmentIds.has(capture.id)) ||
    evidence.reviews.some((review) => !developmentIds.has(review.captureId)) ||
    evidence.judgments.some(
      (judgment) =>
        !plan.judgments.some(
          (unit) => unit.id === judgment.id && developmentIds.has(unit.captureId),
        ),
    )
  )
    throw new Error("Development selection cannot consume withheld or unplanned evidence");
  for (const records of [evidence.captures, evidence.judgments, evidence.builders]) {
    if (new Set(records.map((record) => record.id)).size !== records.length)
      throw new Error("Protocol evidence contains duplicate unit records");
  }
  if (new Set(evidence.reviews.map((review) => review.captureId)).size !== evidence.reviews.length)
    throw new Error("Each reviewed pass needs one consolidated expert decision");
  if (
    Object.values(evidence.requiredCriteria).some(
      (ids) => !ids.length || new Set(ids).size !== ids.length,
    )
  )
    throw new Error("Protocol criteria must be exact nonempty required identities");
  for (const [evalId, required] of Object.entries(evidence.requiredCriteria)) {
    const presentation = evidence.requiredPresentationCriteria[evalId];
    if (
      !presentation ||
      new Set(presentation).size !== presentation.length ||
      presentation.some((id) => !required.includes(id))
    )
      throw new Error(
        "Protocol presentation criteria must be an exact subset of required criteria",
      );
  }
  for (const record of [
    ...evidence.captures,
    ...evidence.judgments,
    ...evidence.reviews,
    ...evidence.builders,
  ])
    if (!/^[a-f0-9]{64}$/u.test(record.proofHash))
      throw new Error("Protocol evidence needs an immutable proof");
  for (const record of [...evidence.judgments, ...evidence.builders])
    if (record.costUsd !== null && (!Number.isFinite(record.costUsd) || record.costUsd < 0))
      throw new Error("Invalid known protocol cost");
  const gate = plan.gates.find(
    (gate) =>
      !evidence.completedGates.includes(gate.id) &&
      gate.requires.every((id) => evidence.completedGates.includes(id)),
  );
  if (!gate) return null;
  const terminal = new Map(evidence.captures.map((record) => [record.id, record]));
  const builders = new Map(evidence.builders.map((record) => [record.id, record]));
  const unavailable = (capture: ExperimentPlan["captures"][number]) =>
    builders.get(capture.subjectId)?.state === "unrunnable";
  if (development.some((capture) => !terminal.has(capture.id) && !unavailable(capture)))
    return null;
  const labels = new Map(evidence.reviews.map((review) => [review.captureId, review]));
  const expertSelection =
    plan.kind === "detector_calibration" ||
    plan.configuration.repairSelectionAuthority === "expert";
  for (const capture of development.filter(
    (capture) => expertSelection && terminal.get(capture.id)?.state === "completed",
  )) {
    const required = evidence.requiredCriteria[capture.evalId];
    if (!required) throw new Error("Protocol lacks its frozen rubric criteria");
    const review = labels.get(capture.id);
    if (
      !review ||
      required.some(
        (id) => !["satisfied", "violated", "insufficient"].includes(review.decisions[id]!),
      )
    )
      return null;
  }
  const proofs = [
    ...new Set(
      [...evidence.captures, ...evidence.reviews, ...evidence.builders].map(
        (record) => record.proofHash,
      ),
    ),
  ].sort();
  if (gate.kind === "review")
    return {
      gateId: gate.id,
      kind: gate.kind,
      planHash: plan.id,
      evidenceHashes: proofs,
      decision: {
        reviewedPasses: evidence.reviews.length,
        intendedPasses: development.length,
        incompletePasses: development.filter(
          (capture) => terminal.get(capture.id)?.state !== "completed",
        ).length,
        blindingIssues: evidence.reviews
          .filter((review) => review.blindingIssue !== null)
          .map((review) => review.proofHash),
      },
    };
  const judgments = new Map(evidence.judgments.map((record) => [record.id, record]));
  const units = plan.judgments.filter((unit) => developmentIds.has(unit.captureId));
  if (
    units.some(
      (unit) => !judgments.has(unit.id) && terminal.get(unit.captureId)?.state === "completed",
    )
  )
    return null;
  proofs.push(...evidence.judgments.map((record) => record.proofHash));
  if (plan.kind === "repair_discovery") {
    if (plan.builders.some((builder) => !builders.has(builder.id))) return null;
    const tasks = [...new Set(plan.builders.map((builder) => builder.evalId))].map((evalId) => {
      const attempts = plan.builders
        .filter((builder) => builder.evalId === evalId)
        .map((builder) => {
          const passes = development
            .filter((capture) => capture.subjectId === builder.id)
            .map((capture) => {
              const label = labels.get(capture.id);
              return {
                captureId: capture.id,
                acquired: terminal.get(capture.id)?.state === "completed",
                reviewed: !!label,
                blindingIssue: label?.blindingIssue ?? null,
                requiredViolations:
                  label?.blindingIssue === null
                    ? evidence.requiredCriteria[evalId]!.filter(
                        (id) => label.decisions[id] === "violated",
                      )
                    : [],
              };
            });
          return {
            ...builders.get(builder.id)!,
            passes,
            eligible:
              builders.get(builder.id)!.state === "runnable" &&
              passes.some((pass) => pass.acquired && pass.requiredViolations.length > 0),
          };
        });
      const selected = attempts.find((attempt) => attempt.eligible);
      return {
        evalId,
        outcome: selected ? "eligible" : "inconclusive",
        selectedBuilderId: selected?.id ?? null,
        sourceHash: selected?.sourceHash ?? null,
        attempts,
      };
    });
    return {
      gateId: gate.id,
      kind: gate.kind,
      planHash: plan.id,
      evidenceHashes: [...new Set(proofs)].sort(),
      decision: { tasks },
    };
  }
  if (plan.kind === "detector_calibration") {
    const treatments = PRESENTATIONS.map((presentation) => {
      const selected = units.filter((unit) => unit.presentation === presentation);
      const native = selected.filter((unit) => !unit.substitution);
      const correctness = (unit: (typeof selected)[number]) => {
        const capture = development.find((capture) => capture.id === unit.captureId)!;
        const result = judgments.get(unit.id),
          label = labels.get(capture.id);
        const required = evidence.requiredCriteria[capture.evalId]!;
        const source = plan.sources.find((source) => source.id === capture.subjectId)!;
        const validControl =
          source.kind === "working"
            ? !!label && route(label.decisions, required) === "satisfied"
            : source.kind === "negative"
              ? !!label &&
                source.targetCriterionIds.every((id) => label.decisions[id] === "violated")
              : true;
        return {
          complete: result?.state === "completed" && !!label && label.blindingIssue === null,
          correct:
            validControl &&
            !!result &&
            !!label &&
            route(result.decisions, required) === route(label.decisions, required),
        };
      };
      return {
        id: presentation,
        controlDecisions: native
          .filter((unit) => {
            const capture = development.find((capture) => capture.id === unit.captureId)!;
            return (
              plan.sources.find((source) => source.id === capture.subjectId)?.kind !== "generated"
            );
          })
          .map(correctness),
        missingEvidenceDecisions: selected
          .filter((unit) => unit.substitution)
          .map((unit) => {
            const capture = development.find((capture) => capture.id === unit.captureId)!;
            const result = judgments.get(unit.id);
            return {
              complete: result?.state === "completed",
              abstained:
                !!result &&
                evidence.requiredPresentationCriteria[capture.evalId]!.length > 0 &&
                evidence.requiredPresentationCriteria[capture.evalId]!.every(
                  (id) => result.decisions[id] === "insufficient",
                ),
            };
          }),
        developmentCorrect: native.filter((unit) => {
          const value = correctness(unit);
          return value.complete && value.correct;
        }).length,
        knownCostUsd: knownCost(selected.map((unit) => judgments.get(unit.id)?.costUsd ?? null)),
      };
    });
    return {
      gateId: gate.id,
      kind: gate.kind,
      planHash: plan.id,
      evidenceHashes: [...new Set(proofs)].sort(),
      decision: { selection: selectPresentation(treatments), treatments },
    };
  }
  if (plan.kind === "matched_repair") {
    if (plan.builders.some((builder) => !builders.has(builder.id))) return null;
    const groups = plan.sources.flatMap((parent) =>
      ["public_observations", "public_task_only"].map((assistance) => {
        const attempts = plan.builders
          .filter(
            (builder) => builder.parentSourceId === parent.id && builder.assistance === assistance,
          )
          .map((builder) => {
            const outcomes = development
              .filter((capture) => capture.subjectId === builder.id)
              .flatMap((capture) =>
                evidence.requiredCriteria[capture.evalId]!.map(
                  (id) =>
                    (expertSelection
                      ? labels.get(capture.id)?.decisions[id]
                      : judgments.get(units.find((unit) => unit.captureId === capture.id)!.id)
                          ?.decisions[id]) ?? "insufficient",
                ),
              );
            return {
              id: builder.id,
              runnable: builders.get(builder.id)!.state === "runnable",
              sourceHash: builders.get(builder.id)!.sourceHash,
              requiredViolations: outcomes.filter((value) => value === "violated").length,
              insufficientJudgments: outcomes.filter((value) => value === "insufficient").length,
              knownCostUsd: knownCost([
                builders.get(builder.id)!.costUsd,
                ...units
                  .filter(
                    (unit) =>
                      development.find((capture) => capture.id === unit.captureId)?.subjectId ===
                      builder.id,
                  )
                  .map((unit) => judgments.get(unit.id)?.costUsd ?? null),
              ]),
            };
          });
        return {
          parentId: parent.id,
          assistance,
          attempts,
          selectedId: selectRepairAttempt(attempts),
        };
      }),
    );
    return {
      gateId: gate.id,
      kind: gate.kind,
      planHash: plan.id,
      evidenceHashes: [...new Set(proofs)].sort(),
      decision: { authority: plan.configuration.repairSelectionAuthority, groups },
    };
  }
  throw new Error("No selection gate is defined for this protocol");
}
