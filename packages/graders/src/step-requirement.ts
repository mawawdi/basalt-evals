import {
  stepScheduleContext,
  type CriterionOutcome,
  type JsonPrimitive,
  type StudioCollectionPlan,
  type StudioEvidence,
} from "../../contracts/src/index.js";

interface StepRequirementResult {
  outcome: CriterionOutcome;
  explanation: string;
  /** The step records that the result used, for evidence hashes. */
  records: unknown[];
  /**
   * The latency of the first sighting in whole milliseconds, or `[null]` when the runner looked
   * through the bound and saw no sighting. Null when the records cannot time the step.
   */
  observed: JsonPrimitive[] | null;
}

/**
 * Grade the human-authored time bound of one fact-anchored step. The bound starts at the
 * previous step: its actedAt when it has an action, otherwise its scheduledAt. Expiry of the
 * horizon is a failure only when the runner looked through the whole bound from the reference.
 */
export function stepRequirementOutcome(
  plan: StudioCollectionPlan,
  evidence: StudioEvidence,
  scenarioId: string,
  stepId: string,
): StepRequirementResult {
  const scenario = plan.scenarios.find((entry) => entry.id === scenarioId);
  const index = scenario?.steps.findIndex((entry) => entry.id === stepId) ?? -1;
  const step = scenario?.steps[index];
  if (!scenario || !step || index < 1 || !step.requirement || !("after" in step.at))
    return incomplete("The frozen plan has no requirement for this step", []);
  const after = step.at.after;
  if (!("fact" in after)) return incomplete("The step requirement needs a fact anchor", []);
  const withinMs = step.requirement.withinMs;
  const reports = evidence.scenarios.find((entry) => entry.scenarioId === scenarioId)?.reports;
  const record = (context: string, id: string) =>
    reports?.find((report) => report.context === context)?.steps.find((s) => s.stepId === id);
  const scopeReport = reports?.find((report) => report.context === after.scope);
  const anchor = record(after.scope, step.id);
  const previous = scenario.steps[index - 1]!;
  const previousRecord = record(stepScheduleContext(previous), previous.id);
  const reference =
    previous.action.kind === "wait" ? previousRecord?.scheduledAt : previousRecord?.actedAt;
  if (!scopeReport || !anchor) return incomplete("The scope report of the step is absent", []);
  if (!previousRecord || reference === undefined)
    return incomplete(
      `The previous step ${previous.id} has no recorded reference time`,
      previousRecord ? [anchor, previousRecord] : [anchor],
    );
  const records = [anchor, previousRecord];
  if (anchor.outcome === "acquisition_failed")
    return incomplete("The runner could not acquire the anchor fact", records);
  if (anchor.anchorObservedAt !== undefined) {
    if (anchor.anchorPreexisting)
      return incomplete(
        "The fact already held when the runner started to look, so the record cannot time the change",
        records,
      );
    const latencyMs = (anchor.anchorObservedAt - reference) * 1000;
    const precisionMs = anchor.pollIntervalMs ?? 0;
    if (latencyMs < 0)
      return incomplete(
        `The first sighting precedes the reference by ${Math.round(-latencyMs)} ms; the causal order is unknown`,
        records,
      );
    if (latencyMs <= withinMs)
      return {
        outcome: "verified",
        explanation: `First sighting ${Math.round(latencyMs)} ms after the reference; the bound is ${withinMs} ms`,
        records,
        observed: [Math.round(latencyMs)],
      };
    if (latencyMs - precisionMs > withinMs)
      return {
        outcome: "rejected",
        explanation: `First sighting ${Math.round(latencyMs)} ms (precision ${Math.round(precisionMs)} ms) after the reference; the bound is ${withinMs} ms`,
        records,
        observed: [Math.round(latencyMs)],
      };
    return incomplete(
      `The poll interval of ${Math.round(precisionMs)} ms straddles the bound of ${withinMs} ms`,
      records,
    );
  }
  const budgetEnd = scopeReport.startAt + scenario.durationMs / 1000;
  const lookedUntil = Math.min(anchor.dueAt + step.horizonMs / 1000, budgetEnd);
  if (anchor.dueAt <= reference && lookedUntil >= reference + withinMs / 1000)
    return {
      outcome: "rejected",
      explanation: `The runner looked for ${Math.round((lookedUntil - reference) * 1000)} ms after the reference and did not see the fact; the bound is ${withinMs} ms`,
      records,
      observed: [null],
    };
  return incomplete(
    "The runner did not look through the whole bound from the reference, so expiry is inconclusive",
    records,
  );
}

function incomplete(explanation: string, records: unknown[]): StepRequirementResult {
  return { outcome: "incomplete", explanation, records, observed: null };
}
