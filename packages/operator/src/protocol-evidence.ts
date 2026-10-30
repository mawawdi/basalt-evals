import type {
  RunOperationEvent,
  RunOperationManifest,
  SpendLedgerState,
} from "../../contracts/src/execution.js";
import { requiresImages } from "../../eval-authoring/src/rendered-selection.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { hashJson } from "../../contracts/src/index.js";
import { nextProtocolDecision, type ProtocolEvidence } from "../../experiments/src/controller.js";

import { readRegisteredExperiment } from "./experiment-plan.js";
import type { RunJudgmentArtifact } from "./judgment-artifact.js";

import { operationReviews, consolidatedReviewLabels } from "./review-store.js";
import { manifestHash } from "./run-manifest.js";

interface EvidenceInput {
  root: string;
  manifest: RunOperationManifest;
  events: RunOperationEvent[];
  spending: SpendLedgerState;
  reviewRecordIds?: string[];
}

/** Selection has a fixed development-only projection. */
export function protocolEvidence(input: EvidenceInput) {
  return gatherEvidence(input, "development");
}

/** Reporting consumes both partitions after retaining their distinct identities. */
export function experimentReportEvidence(input: EvidenceInput) {
  return gatherEvidence(input, "all");
}

async function gatherEvidence(input: EvidenceInput, partition: "development" | "all") {
  const { root, manifest, events, spending } = input;
  if (!manifest.protocol) throw new Error("Operation has no experiment protocol");
  const registered = await readRegisteredExperiment(root, manifest.protocol.registrationId),
    plan = registered.plan;
  if (plan.id !== manifest.protocol.hash) throw new Error("Operation protocol changed");
  const files = new RepositoryFiles(root);
  const allReviews = (
    await operationReviews(root, manifest.id, manifestHash(manifest), input.reviewRecordIds)
  ).filter(({ item }) => partition === "all" || item.partition === "development");
  const reviewRecordIds = allReviews.map(({ record }) => record.id);
  if (input.reviewRecordIds && hashJson(reviewRecordIds) !== hashJson(input.reviewRecordIds))
    throw new Error("Sealed review selection is no longer available");
  const labels = consolidatedReviewLabels(allReviews, registered.reviewer);
  const evidence: ProtocolEvidence = {
    requiredCriteria: Object.fromEntries(
      manifest.evals.map((evaluation) => [evaluation.id, evaluation.requiredCriterionIds]),
    ),
    requiredPresentationCriteria: Object.fromEntries(
      await Promise.all(
        manifest.evals.map(async (evaluation) => {
          const revision = await new EvalDefinitionStore(root).readExecutableRevision(
            evaluation.id,
          );
          return [
            evaluation.id,
            [
              ...revision.privateEvaluator.visual.filter(requiresImages),
              ...revision.privateEvaluator.unscaled.filter(requiresImages),
            ]
              .filter((criterion) => evaluation.requiredCriterionIds.includes(criterion.id))
              .map((criterion) => criterion.id),
          ];
        }),
      ),
    ),
    captures: [],
    judgments: [],
    reviews: [],
    builders: [],
    completedGates: events
      .filter(
        (event) =>
          event.kind === "completed" && ["selection", "review"].includes(event.stage ?? ""),
      )
      .map((event) => event.unitId!),
  };
  // The first terminal event for each unit, indexed once instead of scanned per unit.
  const terminals = new Map<string, RunOperationEvent>();
  for (const event of events)
    if (["completed", "failed", "incomplete"].includes(event.kind)) {
      const key = `${event.stage}:${event.unitId}`;
      if (!terminals.has(key)) terminals.set(key, event);
    }
  const terminal = (stage: string, id: string) => terminals.get(`${stage}:${id}`);
  const cost = (stage: string) => {
    const entries = spending.entries.filter((entry) => entry.stage === stage);
    return entries.some((entry) => entry.status !== "billed")
      ? null
      : entries.reduce((sum, entry) => sum + entry.billedUsd!, 0);
  };
  for (const unit of plan.builders) {
    const id = manifest.protocol.subjectBindings[unit.id]!,
      event = terminal("builder", id);
    if (event)
      evidence.builders.push({
        id: unit.id,
        state: event.kind === "completed" ? "runnable" : "unrunnable",
        proofHash: event.id,
        sourceHash: event.kind === "completed" ? event.artifactHashes[1]! : null,
        costUsd: cost(`builder:${id}`),
      });
  }
  for (const capture of plan.captures.filter(
    (capture) => partition === "all" || capture.partition === "development",
  )) {
    const event = terminal("final_capture", capture.id);
    if (!event) continue;
    evidence.captures.push({
      id: capture.id,
      state: event.kind === "completed" ? "completed" : "failed",
      proofHash: event.id,
    });
    if (event.kind !== "completed") continue;
    const evaluation = manifest.evals.find((evaluation) => evaluation.id === capture.evalId)!;
    const passId = hashJson({ cell: capture.id, evidence: event.artifactHashes[1] });
    const selected = evaluation.requiredCriterionIds.map((id) =>
      labels.get(`${evaluation.rubricHash}:${passId}:${id}`),
    );
    if (selected.every((label) => label !== undefined))
      evidence.reviews.push({
        captureId: capture.id,
        proofHash: hashJson(selected.map((label) => label!.recordId)),
        decisions: Object.fromEntries(
          selected.map((label) => [label!.criterionId, label!.verdict]),
        ),
        blindingIssue: selected.find((label) => label!.blindingIssue)?.blindingIssue ?? null,
      });
    for (const unit of plan.judgments.filter((unit) => unit.captureId === capture.id)) {
      const result = terminal("judgment", unit.id);
      if (!result) continue;
      const artifact =
        result.kind === "completed"
          ? await files.json<RunJudgmentArtifact>(
              `.basalt-evals/eval-operations/${manifest.id}/judgments/${unit.id}.json`,
            )
          : null;
      if (artifact && hashJson(artifact) !== result.artifactHashes[0])
        throw new Error("Controller judgment proof changed");
      evidence.judgments.push({
        id: unit.id,
        state: artifact ? "completed" : "failed",
        proofHash: result.id,
        decisions: artifact
          ? Object.fromEntries(
              artifact.decisions.map((decision) => [decision.criterionId, decision.verdict]),
            )
          : {},
        integrityIssue: artifact?.addressedToEvaluator?.found === true,
        costUsd: cost(`judgment:${unit.id}`),
      });
    }
  }
  return { plan, evidence, reviewRecordIds };
}

export async function verifyProtocolGate(input: {
  root: string;
  manifest: RunOperationManifest;
  event: RunOperationEvent;
  events: RunOperationEvent[];
  spending: SpendLedgerState;
}) {
  const files = new RepositoryFiles(input.root),
    event = input.event;
  const receipt = await files.json<{
    manifestHash: string;
    gateId: string;
    reviewRecordIds: string[];
    evidence: ProtocolEvidence;
    decision: unknown;
    kind: string;
    planHash: string;
    evidenceHashes: string[];
  }>(`.basalt-evals/eval-operations/${input.manifest.id}/gates/${event.unitId}.json`);
  if (
    event.artifactHashes.length !== 1 ||
    hashJson(receipt) !== event.artifactHashes[0] ||
    receipt.manifestHash !== manifestHash(input.manifest)
  )
    throw new Error("Protocol gate receipt changed");
  const before = input.events.filter(
    (item) =>
      item.sequence < event.sequence &&
      !(item.stage === event.stage && item.unitId === event.unitId),
  );
  const state = await protocolEvidence({
    ...input,
    events: before,
    reviewRecordIds: receipt.reviewRecordIds,
  });
  const decision = nextProtocolDecision(state.plan, state.evidence);
  if (
    !decision ||
    decision.gateId !== event.unitId ||
    decision.kind !== event.stage ||
    hashJson({
      manifestHash: manifestHash(input.manifest),
      ...decision,
      evidence: state.evidence,
      reviewRecordIds: state.reviewRecordIds,
    }) !== hashJson(receipt)
  )
    throw new Error(
      "Gate decision differs from its frozen development evidence or selection policy",
    );
}
