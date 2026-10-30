import type { RunOperationEvent, RunStage } from "../../contracts/src/execution.js";
import {
  FAILURE_PRECEDENCE,
  OUTCOME_CAUSE_ORDER,
  orderFailureAttributions,
  type CauseUnits,
  type ExecutionFailure,
  type FailureRecord,
  type OutcomeCause,
} from "../../contracts/src/failure.js";

/*
 * The cause of each unit that did not finish. A unit gets one cause, or "unclassified" when no
 * record names one. Only recorded facts admit a cause: the structured failure record of the last
 * attempt and the reason of the terminal event. When both name a cause, the fixed precedence
 * decides, so a cause outside the build comes before a cause in the build. Prose is never read.
 */

/** The record that named the cause of a unit. */
export type CauseSource = "failure_record" | "event_reason";

export interface OutcomeAttribution {
  stage: RunStage;
  unitId: string;
  kind: "failed" | "incomplete";
  cause: OutcomeCause;
  /** Null when no record names a cause. */
  source: CauseSource | null;
  at: string;
}

const CLASSIFICATIONS = new Set<string>(FAILURE_PRECEDENCE);

/** A failure class that a record names. */
type NamedCause = Exclude<OutcomeCause, "unclassified">;

/** The failure class of each record category. An unknown category names no cause. */
const CATEGORY_CAUSES: Record<ExecutionFailure["category"], NamedCause | null> = {
  provider: "provider_or_transport_failure",
  startup: "environment_failure",
  // Studio did not record the evidence. The cause can be Studio or the build, so Basalt does
  // not blame either one.
  acquisition: "evidence_incomplete",
  integrity: "evidence_incomplete",
  budget: "budget_or_stop_failure",
  recovery: "environment_failure",
  unknown: null,
};

/** Cause codes whose category names the dependency and not the cause. */
const CODE_CAUSES: Record<string, NamedCause> = {
  preparation_output_limit: "budget_or_stop_failure",
  studio_lane_wait_cancelled: "budget_or_stop_failure",
};

function recordCause(failure: ExecutionFailure): NamedCause | null {
  if (CODE_CAUSES[failure.causeCode]) return CODE_CAUSES[failure.causeCode]!;
  // A lost driver records only that the work needs recovery. It does not know why.
  if (failure.category === "recovery" && failure.causeCode === "unclassified") return null;
  return CATEGORY_CAUSES[failure.category];
}

function reasonCause(stage: string, reason: string | null): NamedCause | null {
  if (!reason || reason === "unknown") return null;
  if (CLASSIFICATIONS.has(reason)) return reason as NamedCause;
  if (stage === "builder" && reason === "local_gate_rejected") return "static_or_luau_failure";
  if (stage === "judgment" && reason === "judge_refusal") return "grader_failure";
  return null;
}

function recordKey(record: FailureRecord) {
  // Some writers put the whole unit key in the stage field.
  return record.unit.stage.includes(":")
    ? record.unit.stage
    : `${record.unit.stage}:${record.unit.id}`;
}

/**
 * One attribution for each unit whose last terminal event is failed or incomplete. A unit that
 * started again after that event is in flight and has none. A failure record counts only when
 * the last attempt wrote it, so a cause that a resume already cleared stays out.
 */
export function attributeOutcomes(
  events: readonly RunOperationEvent[],
  records: readonly FailureRecord[],
): OutcomeAttribution[] {
  const terminal = new Map<string, RunOperationEvent>();
  const started = new Map<string, RunOperationEvent>();
  for (const event of events) {
    if (!event.stage || !event.unitId) continue;
    const key = `${event.stage}:${event.unitId}`;
    if (event.kind === "started") started.set(key, event);
    if (["completed", "failed", "incomplete"].includes(event.kind)) terminal.set(key, event);
  }
  const attributions: OutcomeAttribution[] = [];
  for (const [key, event] of terminal) {
    if (event.kind !== "failed" && event.kind !== "incomplete") continue;
    const start = started.get(key);
    if (start && start.sequence > event.sequence) continue;
    // A writer can save its record just after the terminal event. A unit that started again is
    // in flight, so each record after the last start belongs to the last attempt.
    const since = start?.at ?? "";
    const candidates = [
      ...records
        .filter((record) => recordKey(record) === key && record.at >= since)
        .flatMap((record) => {
          const classification = recordCause(record);
          return classification
            ? [
                {
                  classification,
                  detail: record.causeCode,
                  admission: "rule" as const,
                  source: "failure_record" as const,
                },
              ]
            : [];
        }),
      ...(() => {
        const classification = reasonCause(event.stage!, event.reason);
        return classification
          ? [
              {
                classification,
                detail: event.reason!,
                admission: "rule" as const,
                source: "event_reason" as const,
              },
            ]
          : [];
      })(),
    ];
    const first = orderFailureAttributions(candidates)[0];
    attributions.push({
      stage: event.stage!,
      unitId: event.unitId!,
      kind: event.kind,
      cause: first?.classification ?? "unclassified",
      source: first?.source ?? null,
      at: event.at,
    });
  }
  return attributions;
}

/** The units of each cause, in the fixed precedence. "unclassified" comes last. */
export function countCauses(
  attributions: readonly OutcomeAttribution[],
  subjectOf: (unit: OutcomeAttribution) => string | null = () => null,
): CauseUnits[] {
  return OUTCOME_CAUSE_ORDER.flatMap((cause) => {
    const units = attributions
      .filter((attribution) => attribution.cause === cause)
      .map((attribution) => ({
        stage: attribution.stage,
        unitId: attribution.unitId,
        subjectId: subjectOf(attribution),
      }));
    return units.length ? [{ cause, units }] : [];
  });
}
