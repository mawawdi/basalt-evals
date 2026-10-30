import type { RunOperationManifest } from "../../contracts/src/execution.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { hashJson } from "../../contracts/src/index.js";
import { analyzeExperiment } from "../../experiments/src/analysis.js";
import { RunOperationStore } from "./operation.js";
import { assertExecutionImplementation } from "./execution-guard.js";
import { experimentReportEvidence } from "./protocol-evidence.js";
import { operationReviews } from "./review-store.js";
import { reviewBatchProgress } from "./review-batches.js";
import { readRegisteredExperiment } from "./experiment-plan.js";
import type {
  ExperimentAnalysisReport,
  ExperimentAnalysisView,
} from "../../contracts/src/experiment-report.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import type { EvalRevision } from "../../eval-authoring/src/compiler.js";
import { authoredCriteria, criterionNumbers } from "./benchmarks.js";
import { manifestHash } from "./run-manifest.js";
import { measureProtocolCaptures } from "./pixel-measurement.js";
import { pinnedComparisonRecords } from "./exemplar-comparison.js";

/** A later review yields a new immutable report; it cannot revise the evaluated plan or selections. */
export async function sealExperimentAnalysis(
  root: string,
  operationId: string,
): Promise<ExperimentAnalysisReport> {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/u.test(operationId))
    throw new Error("Invalid operation identity");
  const files = new RepositoryFiles(root),
    base = `.basalt-evals/eval-operations/${operationId}`;
  const manifest = await files.json<RunOperationManifest>(`${base}/manifest.json`);
  if (!manifest.protocol)
    throw new Error("This run is not a registered research run, so it has no benchmark analysis.");
  const store = new RunOperationStore(
    root,
    operationId,
    manifestHash(manifest),
    manifest.inputHash,
  );
  const status = await store.read();
  await assertExecutionImplementation(root, manifest);
  const spending = await store.ledger.read();
  const projected = await experimentReportEvidence({
    root,
    manifest,
    events: status.events,
    spending,
  });
  const registered = await readRegisteredExperiment(root, manifest.protocol.registrationId);
  const reviews = await operationReviews(root, operationId, manifestHash(manifest));
  const reviewProgress = await Promise.all(
    [...new Set(reviews.map(({ record }) => record.batchId))].map((id) =>
      reviewBatchProgress(root, id),
    ),
  );
  const selections = [];
  for (const event of status.events.filter(
    (event) => event.kind === "completed" && event.stage === "selection",
  )) {
    const receipt = await files.json(`${base}/gates/${event.unitId}.json`);
    if (hashJson(receipt) !== event.artifactHashes[0])
      throw new Error("Experiment selection receipt changed");
    selections.push({ hash: hashJson(receipt), receipt });
  }
  const times = status.events
    .filter((event) => event.kind === "started")
    .map((event) => {
      const terminal = status.events.find(
        (other) =>
          other.sequence > event.sequence &&
          other.stage === event.stage &&
          other.unitId === event.unitId &&
          ["completed", "failed", "incomplete"].includes(other.kind),
      );
      return {
        stage: event.stage,
        unitId: event.unitId,
        startedAt: event.at,
        endedAt: terminal?.at ?? null,
        elapsedMs: terminal ? Date.parse(terminal.at) - Date.parse(event.at) : null,
      };
    });
  const pending = spending.entries.filter((entry) => entry.status !== "billed");
  const body = {
    operationId,
    manifestHash: manifestHash(manifest),
    eventHead: status.events.at(-1)?.id ?? null,
    evidenceHashes: [
      ...projected.evidence.builders,
      ...projected.evidence.captures,
      ...projected.evidence.judgments,
      ...projected.evidence.reviews,
    ].map((item) => item.proofHash),
    reviewRecordIds: projected.reviewRecordIds,
    activeReviewMs: reviewProgress.reduce((sum, batch) => sum + batch.activeMs, 0),
    selections,
    selectionAuthority: registered.selectionAuthority,
    repairPopulation: registered.repairPopulation,
    executionComplete: status.finished,
    evidenceComplete:
      projected.evidence.captures.length === projected.plan.captures.length &&
      projected.evidence.captures.every((item) => item.state === "completed"),
    spending: {
      billedUsd: spending.entries.reduce((sum, entry) => sum + (entry.billedUsd ?? 0), 0),
      retainedLiabilityUsd: pending.reduce((sum, entry) => sum + entry.reservedUsd, 0),
      recordedActions: spending.entries.length,
      billedActions: spending.entries.filter((entry) => entry.status === "billed").length,
      unresolvedActions: pending.length,
    },
    failures: status.events
      .filter((event) => ["failed", "incomplete"].includes(event.kind))
      .map((event) => ({
        stage: event.stage,
        unitId: event.unitId,
        kind: event.kind,
        reason: event.reason,
        receipt: event.id,
      })),
    times,
    // The operation read above verified each capture receipt before this measurement. Each
    // stored comparison answer is checked against its retained billed responses. A unit
    // without a verified answer is absent, so the stream escalates that build.
    analysis: analyzeExperiment(
      projected.plan,
      projected.evidence,
      await measureProtocolCaptures({
        root,
        manifest,
        plan: projected.plan,
        events: status.events,
      }),
      await pinnedComparisonRecords(root, manifest),
    ),
  };
  const report = { ...body, id: hashJson(body) },
    path = `${base}/analyses/${report.id}.json`;
  try {
    await files.writeJson(path, report);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (hashJson(await files.json(path)) !== hashJson(report))
      throw new Error("Analysis bytes changed");
  }
  const journal = await OperationJournal.open(root);
  try {
    journal.put("experiment_reports", operationId, { id: report.id, path });
  } finally {
    journal.close();
  }
  return report;
}

/**
 * The criteria of one evaluation, each with its authored statement and its number in the
 * authored order, as the evidence view numbers it.
 */
export function analysisCriteria(
  evalId: string,
  revision: Pick<EvalRevision, "authored" | "criterionMappings" | "privateEvaluator">,
): ExperimentAnalysisView["criteria"] {
  const numbers = criterionNumbers(revision);
  return authoredCriteria(revision).map((criterion) => ({
    evalId,
    criterionId: criterion.id,
    number: numbers.get(criterion.id)!,
    statement: criterion.statement,
  }));
}

/** Seal the analysis and add the names of the criteria of its evaluations. */
export async function experimentAnalysisView(
  root: string,
  operationId: string,
): Promise<ExperimentAnalysisView> {
  const report = await sealExperimentAnalysis(root, operationId);
  const manifest = await new RepositoryFiles(root).json<RunOperationManifest>(
    `.basalt-evals/eval-operations/${operationId}/manifest.json`,
  );
  const definitions = new EvalDefinitionStore(root);
  const criteria = [];
  for (const evaluation of manifest.evals)
    criteria.push(
      ...analysisCriteria(evaluation.id, await definitions.readRevision(evaluation.id)),
    );
  return { ...report, criteria };
}
