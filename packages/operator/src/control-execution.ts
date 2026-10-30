import type { StudioAdapter } from "../../studio-runner/src/adapter.js";
import { resolve } from "node:path";
import {
  boundStudioObservation,
  boundStudioAction,
  type StudyDefinition,
} from "../../contracts/src/index.js";
import type {
  ProposedControlSource,
  ControlAttemptResult,
} from "../../agent-runtime/src/control-generation.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { observeFixedSource } from "./source-observation.js";

const hashPattern = /^[a-f0-9]{64}$/u;
const casePattern = /^[a-z][a-z0-9-]{0,63}$/u;

/**
 * One create-only native control attempt. Complete receipts replay after interruption. The
 * observation is the same as for any fixed source; a control adds only the comparison of its
 * code check outcomes and required evidence with the expected outcomes of its source.
 */
export async function executeEvalControlSource(input: {
  root: string;
  revisionId: string;
  batchId: string;
  source: ProposedControlSource;
  /** The registered working control of the stage before, or null for stage 1. */
  parentSourceId: string | null;
  implementationCommit: string;
  connectorArtifactHash: string;
  environment: Omit<StudyDefinition["environment"], "studioVersion">;
  signal?: AbortSignal;
  studio?: StudioAdapter;
}): Promise<ControlAttemptResult> {
  if (
    !hashPattern.test(input.revisionId) ||
    !hashPattern.test(input.batchId) ||
    !casePattern.test(input.source.id)
  )
    throw new Error("Invalid frozen eval control identity");
  const root = resolve(input.root);
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(input.revisionId);
  const observation = await observeFixedSource({
    root,
    revisionId: revision.id,
    base: `.basalt-evals/eval-control-runs/${revision.id}/${input.batchId}/${input.source.id}`,
    purpose: "control",
    // The record keeps the whole proposal, so its identity covers the expected outcomes too. A
    // control of a later stage also names its parent.
    source: input.parentSourceId
      ? { ...input.source, parentSourceId: input.parentSourceId }
      : input.source,
    treatmentId: `control-${input.batchId.slice(0, 8)}-${input.source.id}`,
    implementationCommit: input.implementationCommit,
    connectorArtifactHash: input.connectorArtifactHash,
    environment: input.environment,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.studio ? { studio: input.studio } : {}),
  });
  if (observation.status === "rejected")
    return {
      accepted: false,
      candidateHash: observation.candidateHash,
      diagnostics: observation.diagnostics,
    };
  const { evidence, sequence } = observation;
  const outcomes = new Map(
    observation.results.map((criterion) => [criterion.criterionId, criterion.outcome]),
  );
  const diagnostics: string[] = [];
  if (sequence && !sequence.complete)
    diagnostics.push("Control rendered acquisition is incomplete: " + sequence.reasons.join("; "));
  for (const criterion of revision.privateEvaluator.deterministic.filter((item) => item.required)) {
    const expected = input.source.expectedDeterministic[criterion.id];
    if (outcomes.get(criterion.id) !== expected)
      diagnostics.push(
        `${criterion.id}: expected ${expected}, got ${outcomes.get(criterion.id) ?? "missing"}`,
      );
  }
  const captures = new Set(
    evidence.phases.flatMap((phase) => phase.captures.map((capture) => capture.captureId)),
  );
  for (const criterion of revision.privateEvaluator.visual.filter((item) => item.required))
    for (const id of criterion.captureIds)
      if (!captures.has(id)) diagnostics.push("Required capture missing: " + id);
  for (const criterion of revision.privateEvaluator.unscaled.filter((item) => item.required)) {
    for (const id of criterion.evidence.captureIds)
      if (!captures.has(id)) diagnostics.push("Required capture missing: " + id);
    for (const binding of criterion.evidence.facts)
      if (!boundStudioObservation(evidence, binding))
        diagnostics.push(`Required Studio observation missing: ${JSON.stringify(binding)}`);
    for (const binding of criterion.evidence.actions)
      if (!boundStudioAction(evidence, binding, revision.privateEvaluator.studio))
        diagnostics.push(`Required Studio action receipt missing: ${JSON.stringify(binding)}`);
  }
  return {
    accepted: diagnostics.length === 0,
    candidateHash: observation.candidateHash,
    diagnostics,
  };
}
