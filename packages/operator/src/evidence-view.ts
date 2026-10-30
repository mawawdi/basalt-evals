import type { OperatorEvidence } from "../../contracts/src/console.js";
import type { RunCriterionArtifact } from "../../contracts/src/execution.js";
import { operationReviewTreatments } from "./review-treatments.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { frozenRunStatus, frozenRunStageStatus } from "./run-builder.js";
import { readOperationEvidence, releasedEvidenceItems, evidenceView } from "./evidence.js";
import { subjectEval, manifestHash } from "./run-manifest.js";
import { stageActiveMs } from "../../experiments/src/benchmarks.js";
import { authoredCriteria, criterionNumbers } from "./benchmarks.js";
import {
  combinedOutcome,
  combineSamples,
  judgeSampleGroups,
  sampleVote,
} from "../../experiments/src/judge-samples.js";

import type { RunJudgmentArtifact } from "./judgment-artifact.js";
import { buildMaker, buildName } from "./model-registry.js";
import { notReachedSummary } from "./catalog-projection.js";
import { notReachedSubjects } from "./stage-reach.js";
import { operationSource } from "./sources.js";
import type { OperationEvidence } from "../../contracts/src/review.js";

/** Operator-only projection. Blind review endpoints never call or return this shape. */
export async function operatorEvidence(
  root: string,
  operationId: string,
  retained?: OperationEvidence,
  selection?: { subjectId: string; criterionId?: string },
): Promise<OperatorEvidence> {
  let status = await frozenRunStatus(root, operationId, false);
  let verifiedSnapshot = false;
  try {
    if (selection) throw new Error("Use selected dependencies");
    status = await frozenRunStatus(root, operationId);
    verifiedSnapshot = true;
  } catch {
    // Verify each record independently to preserve valid partial results.
  }
  const passFacts = new Map<
    string,
    Pick<
      OperatorEvidence["candidates"][number]["items"][number]["passes"][number],
      "events" | "transitions" | "scenarioPlan"
    >
  >();
  const evidence =
    retained ??
    (await readOperationEvidence(root, operationId, selection, (passId, facts) =>
      passFacts.set(passId, facts),
    ));
  if (
    evidence.operationId !== operationId ||
    evidence.manifestHash !== manifestHash(status.manifest)
  )
    throw new Error("Evidence belongs to another operation");
  const released = {
    items: (await releasedEvidenceItems(root, evidence)).map((item) => {
      const view = evidenceView(item);
      for (const pass of view.passes) Object.assign(pass, passFacts.get(pass.id));
      return view;
    }),
  };
  const files = new RepositoryFiles(root);
  const candidates = [];
  const treatmentCatalog = operationReviewTreatments(status.manifest);
  const verifiedRecords = new Map<string, boolean>();
  const latestEvents = new Map(
    status.events.map((event) => [`${event.stage}:${event.unitId}`, event]),
  );
  const notReached = notReachedSubjects(status.events);
  for (const subject of status.manifest.subjects) {
    if (selection && subject.id !== selection.subjectId) continue;
    const evaluation = subjectEval(status.manifest, subject.id);
    const revision = await new EvalDefinitionStore(root).readRevision(evaluation.id);
    const criteria = authoredCriteria(revision);
    const cells = [];
    // The cells follow the authored order of the criteria, as the rows of the benchmark report
    // do. The cells of one criterion keep their plan order.
    const numbers = criterionNumbers(revision);
    const position = (criterionId: string) => numbers.get(criterionId) ?? numbers.size + 1;
    // A judge cell is one sample group and criterion. Its samples combine into one answer.
    const plannedCells = [
      ...status.manifest.gradingCells.map((cell) => ({
        ...cell,
        recordId: cell.id,
        batchIds: null as string[] | null,
      })),
      ...judgeSampleGroups(status.manifest.judgmentBatches).flatMap(({ id, batches }) =>
        batches[0]!.criterionIds.map((criterionId) => ({
          id: `${id}:${criterionId}`,
          recordId: id,
          captureCellId: batches[0]!.captureCellId,
          criterionId,
          method: "visual" as const,
          batchIds: batches.map((batch) => batch.id),
        })),
      ),
    ].sort((left, right) => position(left.criterionId) - position(right.criterionId));
    /** The recorded outcome of one unit, or undefined when Basalt cannot verify it. */
    const verifiedOutcome = async (
      stage: "grading" | "judgment",
      unitId: string,
      criterionId: string,
    ) => {
      const outcome = status.criterionOutcomes.find(
        (outcome) => outcome.cellId === unitId && outcome.criterionId === criterionId,
      );
      if (!outcome) return { outcome, integrityUnavailable: false };
      if (verifiedSnapshot) verifiedRecords.set(unitId, true);
      if (!verifiedRecords.has(unitId)) {
        try {
          await frozenRunStageStatus(root, operationId, stage, unitId);
          verifiedRecords.set(unitId, true);
        } catch {
          verifiedRecords.set(unitId, false);
        }
      }
      return verifiedRecords.get(unitId)
        ? { outcome, integrityUnavailable: false }
        : { outcome: undefined, integrityUnavailable: true };
    };
    const unavailableReason = (stage: "grading" | "judgment", unitId: string) => {
      const checkEvent = latestEvents.get(`${stage}:${unitId}`);
      return checkEvent && ["failed", "incomplete"].includes(checkEvent.kind)
        ? checkEvent.reason
        : null;
    };
    for (const cell of plannedCells.filter(
      (cell) =>
        (!selection?.criterionId || cell.criterionId === selection.criterionId) &&
        status.manifest.captureCells.some(
          (capture) => capture.id === cell.captureCellId && capture.treatmentId === subject.id,
        ),
    )) {
      const capture = status.manifest.captureCells.find(
        (capture) => capture.id === cell.captureCellId,
      )!;
      const retainedItem = evidence.items.find(
        (item) =>
          item.subjectId === subject.id &&
          item.viewId === capture.viewId &&
          item.partition === capture.partition,
      );
      const item = released.items.find((item) => item.id === retainedItem?.id);
      const pass = item?.passes.find((pass) => pass.number === capture.pass);
      const authored = criteria.find((criterion) => criterion.id === cell.criterionId);
      const threshold =
        authored && "minimumPassingScore" in authored ? authored.minimumPassingScore : null;
      const shared = {
        id: cell.id,
        treatment: treatmentCatalog.byRecord.get(cell.recordId) ?? null,
        criterionId: cell.criterionId,
        statement: authored?.statement ?? cell.criterionId,
        number: numbers.get(cell.criterionId) ?? null,
        method: cell.method,
        evidenceClass:
          cell.method === "visual" && authored && "evidenceClass" in authored
            ? authored.evidenceClass
            : null,
        pass: capture.pass,
        itemId: item?.id ?? null,
        passId: pass?.id ?? null,
        configurationHash: hashJson({
          manifestHash: manifestHash(status.manifest),
          recordId: cell.recordId,
        }),
      };
      if (!cell.batchIds) {
        const { outcome, integrityUnavailable } = await verifiedOutcome(
          "grading",
          cell.recordId,
          cell.criterionId,
        );
        const artifact = outcome
          ? await files.json<RunCriterionArtifact>(
              `.basalt-evals/eval-operations/${operationId}/grading/${cell.id}/result.json`,
            )
          : null;
        const score = artifact?.criterion.score ?? null;
        cells.push({
          ...shared,
          automaticDecision: {
            operationId,
            recordId: cell.recordId,
            criterionId: cell.criterionId,
            artifactHash: artifact ? hashJson(artifact) : null,
            configurationHash: shared.configurationHash,
          },
          outcome:
            score !== null && authored && "minimumPassingScore" in authored && threshold === null
              ? "scored"
              : (outcome?.outcome ?? "missing"),
          decisionAuthority: outcome?.decisionAuthority ?? null,
          judgment: null,
          samples: null,
          addressedToEvaluator: null,
          explanation: integrityUnavailable
            ? "Basalt cannot verify the saved answer. This check is incomplete."
            : (artifact?.criterion.explanation ?? unavailableReason("grading", cell.recordId)),
          score,
          verdict: null,
          criterion: artifact?.criterion ?? null,
          evidenceHashes: outcome?.evidence ?? [],
        });
        continue;
      }
      // Each sample is verified and read on its own. A sample without an answer leaves the
      // check incomplete. An insufficient answer of the judge stays insufficient.
      const samples = [];
      for (const batchId of cell.batchIds) {
        const { outcome, integrityUnavailable } = await verifiedOutcome(
          "judgment",
          batchId,
          cell.criterionId,
        );
        const artifact = outcome
          ? await files.json<RunJudgmentArtifact>(
              `.basalt-evals/eval-operations/${operationId}/judgments/${batchId}.json`,
            )
          : null;
        samples.push({
          batchId,
          outcome,
          integrityUnavailable,
          artifact,
          decision:
            artifact?.decisions.find((decision) => decision.criterionId === cell.criterionId) ??
            null,
        });
      }
      const answered = samples.filter((sample) => sample.outcome && sample.decision);
      const combined = combineSamples(
        samples.map((sample) =>
          sample.outcome && sample.decision ? sampleVote(sample.decision, threshold) : null,
        ),
      );
      const found = samples.find((sample) => sample.artifact?.addressedToEvaluator?.found);
      const single = samples.length === 1 ? samples[0]!.decision : null;
      cells.push({
        ...shared,
        automaticDecision: {
          operationId,
          recordId: cell.recordId,
          criterionId: cell.criterionId,
          // A review binds the combined answer of all samples of the group.
          artifactHash: answered.length
            ? hashJson(
                samples.map((sample) => (sample.artifact ? hashJson(sample.artifact) : null)),
              )
            : null,
          configurationHash: shared.configurationHash,
        },
        outcome: answered.length ? combinedOutcome(combined) : "missing",
        decisionAuthority: answered[0]?.outcome!.decisionAuthority ?? null,
        judgment: single,
        samples: { ...combined, decisions: samples.map((sample) => sample.decision) },
        addressedToEvaluator: answered.length
          ? (found?.artifact!.addressedToEvaluator ?? { found: false, quote: null })
          : null,
        explanation: samples.some((sample) => sample.integrityUnavailable)
          ? "Basalt cannot verify the saved answer. This check is incomplete."
          : samples.length === 1
            ? (single?.rationale ?? unavailableReason("judgment", samples[0]!.batchId))
            : (samples
                .map((sample) =>
                  sample.outcome ? null : unavailableReason("judgment", sample.batchId),
                )
                .find((reason) => reason) ?? null),
        score: single?.score ?? null,
        verdict: single?.verdict ?? null,
        criterion: null,
        evidenceHashes: answered[0]?.outcome!.evidence ?? [],
      });
    }
    const sealed = status.completedUnits.includes(
      `${subject.sourceId ? "seal" : "builder"}:${subject.id}`,
    );
    const agentRun = sealed
      ? ((await operationSource(root, status.manifest, subject.id).catch(() => null))?.agentRun ??
        null)
      : null;
    candidates.push({
      id: subject.id,
      title: buildName(status.manifest, subject.id),
      evaluationId: evaluation.id,
      criterionCount: criteria.length,
      kind: subject.kind,
      builder: subject.builder,
      builderName: buildMaker(status.manifest.modelSnapshots, subject),
      notReached: notReached.has(subject.id) ? notReachedSummary(status, subject) : null,
      sealed,
      builderCostUsd: agentRun?.usage.providerReportedCostUsd ?? null,
      builderToolCalls: agentRun
        ? agentRun.trace.filter((event) => event.kind === "tool_call").length
        : null,
      builderElapsedMs: stageActiveMs(status.events, "builder", subject.id),
      captured: status.manifest.captureCells.filter(
        (cell) =>
          cell.treatmentId === subject.id &&
          status.completedUnits.includes(`final_capture:${cell.id}`),
      ).length,
      plannedCaptures: status.manifest.captureCells.filter(
        (cell) => cell.treatmentId === subject.id,
      ).length,
      cells,
      items: released.items.filter((item) =>
        evidence.items.some(
          (retained) => retained.id === item.id && retained.subjectId === subject.id,
        ),
      ),
    });
  }
  return {
    operationId,
    manifestHash: manifestHash(status.manifest),
    unavailableEvidence: evidence.unavailable,
    candidates,
    claims: status.manifest.unreviewedClaims,
    planned: status.manifest.planned,
  };
}
