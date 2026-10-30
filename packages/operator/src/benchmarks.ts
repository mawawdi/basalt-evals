import { stageTitle } from "../../contracts/src/display.js";
import { readdir } from "node:fs/promises";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { STUDIO_ADMISSIONS_FILE } from "../../studio-runner/src/adapter.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson, validRubricScore } from "../../contracts/src/index.js";
import { formatMoney } from "../../contracts/src/display.js";
import type { RunSummary } from "../../contracts/src/catalog.js";
import type {
  EvaluationWorkflow,
  RunOperationStatus,
  RunCriterionArtifact,
  SpendLedgerState,
} from "../../contracts/src/execution.js";
import type {
  BenchmarkCatalogEntry,
  BenchmarkCriterionDefinition,
  BenchmarkCriterionOutcome,
  BenchmarkStudioSession,
  ConsoleNotification,
} from "../../contracts/src/benchmarks.js";
import { projectBenchmarkReport } from "../../experiments/src/benchmark-projection.js";
import { benchmarkReceipts } from "../../model-client/src/benchmark-receipts.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { scoringCriteria } from "../../eval-authoring/src/scoring.js";
import type { EvalRevision } from "../../eval-authoring/src/compiler.js";
import { frozenRunRecords, recordValue, type FrozenRunReader } from "./run-records.js";
import { operationAttributions } from "./outcome-causes.js";
import { DurableSpendLedger } from "../../model-client/src/ledger.js";
import { runCatalog } from "./discovery.js";
import type { RunJudgmentArtifact } from "./judgment-artifact.js";
import { LISTED_RUN_STATES } from "./run-visibility.js";
import { readEmptyBuildCheck } from "./empty-build-check.js";
import type { PlanWarningRow } from "../../experiments/src/plan-warnings.js";

function eligible(status: RunOperationStatus) {
  return (
    status.manifest.protocol === null &&
    status.manifest.gates.length === 0 &&
    status.manifest.subjects.length > 0 &&
    status.manifest.subjects.every((subject) => subject.kind === "generated")
  );
}
/** Timing of one retained Studio session directory; absent records stay unknown. */
async function studioSession(
  files: RepositoryFiles,
  directory: string,
  stage: BenchmarkStudioSession["stage"],
  unitId: string,
): Promise<BenchmarkStudioSession | null> {
  const receipt = await files
    .optional<{ manifest: { startedAt: string; completedAt: string } }>(
      `${directory}/studio/native/manifest.json`,
    )
    .catch(() => null);
  const admissions = await files.bytes(`${directory}/${STUDIO_ADMISSIONS_FILE}`).then(
    (bytes) => bytes.toString("utf8"),
    () => null,
  );
  if (!receipt && admissions === null) return null;
  const active = receipt
    ? Date.parse(receipt.manifest.completedAt) - Date.parse(receipt.manifest.startedAt)
    : NaN;
  const waits =
    admissions
      ?.split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { waitedMs: unknown }).waitedMs) ?? null;
  return {
    stage,
    unitId,
    activeMs: Number.isFinite(active) && active >= 0 ? active : null,
    queueMs:
      waits?.length && waits.every((ms) => typeof ms === "number" && Number.isFinite(ms) && ms >= 0)
        ? (waits as number[]).reduce((sum, ms) => sum + ms, 0)
        : null,
  };
}

/** Builder development runs and final captures of one operation, from retained files only. */
async function studioSessions(
  root: string,
  status: RunOperationStatus,
): Promise<BenchmarkStudioSession[]> {
  const files = new RepositoryFiles(root),
    base = `.basalt-evals/eval-operations/${status.manifest.id}`;
  const sessions: Array<BenchmarkStudioSession | null> = [];
  for (const subject of status.manifest.subjects) {
    const development = `${base}/builder/${subject.id}/development`;
    const entries = await readdir(files.path(development), { withFileTypes: true }).catch(() => []);
    for (const entry of entries)
      if (entry.isDirectory() && /^development-[a-f0-9]{24}$/u.test(entry.name))
        sessions.push(
          await studioSession(files, `${development}/${entry.name}`, "builder", subject.id),
        );
  }
  for (const capture of status.manifest.captureCells)
    sessions.push(
      await studioSession(files, `${base}/capture/${capture.id}`, "final_capture", capture.id),
    );
  return sessions.filter((session) => session !== null);
}

/**
 * The executable criteria of a revision in the order of their authored passages. A criterion
 * that maps to no authored criterion comes after them, in the order of its passage.
 */
export function authoredCriterionOrder(
  revision: Pick<EvalRevision, "authored" | "criterionMappings">,
  ids: string[],
): string[] {
  const authored = new Map(revision.authored.criteria.map((criterion, i) => [criterion.id, i]));
  const position = (id: string) => {
    const mappings = revision.criterionMappings.filter(
      (mapping) => mapping.executableCriterionId === id,
    );
    return {
      authored: Math.min(
        Infinity,
        ...mappings.map((mapping) => authored.get(mapping.authoredCriterionId ?? "") ?? Infinity),
      ),
      start: Math.min(Infinity, ...mappings.map((mapping) => mapping.authority.start)),
    };
  };
  const positions = new Map(ids.map((id) => [id, position(id)]));
  return [...ids].sort((a, b) => {
    const left = positions.get(a)!,
      right = positions.get(b)!;
    if (left.authored !== right.authored) return left.authored < right.authored ? -1 : 1;
    if (left.start !== right.start) return left.start < right.start ? -1 : 1;
    return 0;
  });
}

/** The executable criteria of a revision in the authored order. */
export function authoredCriteria(
  revision: Pick<EvalRevision, "authored" | "criterionMappings" | "privateEvaluator">,
) {
  const all = [
    ...revision.privateEvaluator.deterministic,
    ...revision.privateEvaluator.codeQuality,
    ...revision.privateEvaluator.visual,
    ...revision.privateEvaluator.unscaled,
  ];
  return authoredCriterionOrder(
    revision,
    all.map((criterion) => criterion.id),
  ).map((id) => all.find((criterion) => criterion.id === id)!);
}

/**
 * The number of each executable criterion of a revision, from 1, in the authored order. Every
 * run of the revision shows "Criterion n" with this number, also a run that plans fewer criteria.
 */
export function criterionNumbers(
  revision: Pick<EvalRevision, "authored" | "criterionMappings" | "privateEvaluator">,
): Map<string, number> {
  return new Map(authoredCriteria(revision).map((criterion, index) => [criterion.id, index + 1]));
}

/** Ordinary automatic matrices only; optional research/reassessment records stay in Records. Archived runs stay out. */
export async function benchmarkCatalog(root: string): Promise<BenchmarkCatalogEntry[]> {
  const journal = await OperationJournal.open(root);
  try {
    const rows: BenchmarkCatalogEntry[] = [];
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      const result = journal.page<RunSummary>("runs", {
        page,
        limit: 50,
        statuses: LISTED_RUN_STATES,
      });
      pages = result.pages;
      for (const row of result.items) {
        const status = journal.read<RunOperationStatus>("operations", row.id);
        const workflow = journal.read<EvaluationWorkflow>("workflows", row.id);
        if (status ? !eligible(status) : !workflow || workflow.selection.objective !== "evaluate")
          continue;
        rows.push({
          id: row.id,
          title: row.title,
          state: row.state,
          at: row.startedAt ?? row.updatedAt,
          frozen: !!status,
          models: status?.manifest.selectedModelIds ?? workflow!.selection.builderModelIds,
          cases: status?.manifest.evals.length ?? workflow!.selection.sources.length,
          harnesses: status?.manifest.selectedHarnessIds ?? workflow!.selection.harnessIds,
        });
      }
    }
    return rows;
  } finally {
    journal.close();
  }
}

/**
 * The plan rows of the empty build of each evaluation: one met row for each required code check
 * that passes on it. An incomplete or absent check gives no row.
 */
export async function emptyBuildRows(
  root: string,
  evaluationIds: string[],
): Promise<PlanWarningRow[]> {
  const rows: PlanWarningRow[] = [];
  for (const evaluationId of evaluationIds) {
    const check = await readEmptyBuildCheck(root, evaluationId).catch(() => null);
    if (check?.state !== "complete") continue;
    for (const criterionId of check.hollow)
      rows.push({
        evaluationId,
        criterionId,
        origin: "empty_build",
        buildId: `empty-build/${evaluationId}`,
        answer: "met",
        observed:
          check.results.find((result) => result.criterionId === criterionId)?.observed ?? null,
        expectation: null,
      });
  }
  return rows;
}

/** Hash-bound original answers of a benchmark run. Does not rerun graders or load frames. */
export async function benchmarkAnswers(
  root: string,
  id: string,
  runRecords: FrozenRunReader = frozenRunRecords(root),
) {
  const records = await runRecords(id);
  const status = records.status;
  if (!eligible(status))
    throw new Error(
      "This run is not a standard benchmark of model builds. Open the run to see its details.",
    );
  const files = new RepositoryFiles(root),
    store = new EvalDefinitionStore(root),
    manifestHash = hashJson(status.manifest);
  const definitions: BenchmarkCriterionDefinition[] = [],
    outcomes: BenchmarkCriterionOutcome[] = [],
    issues: string[] = [];
  const criteria = new Map<string, ReturnType<typeof scoringCriteria>>(),
    evaluationTitles = new Map<string, string>();
  for (const evaluation of status.manifest.evals) {
    try {
      const revision = await store.readExecutableRevision(evaluation.id);
      if (revision.rubricHash !== evaluation.rubricHash)
        throw new Error("Authored rubric hash differs from the frozen evaluation.");
      evaluationTitles.set(evaluation.id, stageTitle(revision.publicTask.title, evaluation.stage));
      const scored = scoringCriteria(
        revision,
        authoredCriteria(revision).map((row) => row.id),
      );
      criteria.set(evaluation.id, scored);
      definitions.push(
        ...scored.map((criterion) => ({
          evaluationId: evaluation.id,
          criterionId: criterion.id,
          statement: criterion.statement,
          required: criterion.required,
          evidenceClass: criterion.evidenceClass,
          scaleHash:
            criterion.anchors === null
              ? null
              : hashJson({ criterion, rubricHash: revision.rubricHash }),
          scale:
            criterion.anchors === null
              ? null
              : JSON.stringify({
                  anchors: criterion.anchors,
                  range: criterion.scoreRange,
                  minimumPassingScore: criterion.minimumPassingScore,
                }),
        })),
      );
    } catch (cause) {
      issues.push(
        `Evaluation ${evaluation.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  const captureToEval = new Map(
    status.manifest.captureCells.map((capture) => [
      capture.id,
      status.manifest.subjects.find((subject) => subject.id === capture.treatmentId)!.evalId,
    ]),
  );
  for (const event of status.events.filter(
    (event) =>
      event.kind === "completed" && (event.stage === "grading" || event.stage === "judgment"),
  )) {
    try {
      if (event.artifactHashes.length !== 1)
        throw new Error("Original answer has no single bound artifact.");
      if (event.stage === "grading") {
        const cell = status.manifest.gradingCells.find((cell) => cell.id === event.unitId);
        if (!cell) throw new Error("Criterion cell is absent from the immutable plan.");
        const artifact = await files.json<RunCriterionArtifact>(
          `.basalt-evals/eval-operations/${id}/grading/${cell.id}/result.json`,
        );
        if (
          hashJson(artifact) !== event.artifactHashes[0] ||
          artifact.operationId !== id ||
          artifact.cellId !== cell.id ||
          artifact.criterion.criterionId !== cell.criterionId ||
          artifact.decisionAuthority !== "deterministic"
        )
          throw new Error("Original deterministic answer identity or hash changed.");
        outcomes.push({
          cellId: cell.id,
          criterionId: cell.criterionId,
          method: "deterministic",
          outcome:
            artifact.criterion.outcome === "verified"
              ? "met"
              : artifact.criterion.outcome === "rejected"
                ? "rejected"
                : artifact.criterion.score !== undefined
                  ? "scored"
                  : "insufficient",
          score: artifact.criterion.score ?? null,
          samples: null,
          observed: artifact.criterion.observed,
        });
      } else {
        const batch = status.manifest.judgmentBatches.find((batch) => batch.id === event.unitId);
        if (!batch) throw new Error("Judgment batch is absent from the immutable plan.");
        const artifact = await files.json<RunJudgmentArtifact>(
          `.basalt-evals/eval-operations/${id}/judgments/${batch.id}.json`,
        );
        const evaluation = status.manifest.evals.find(
          (evaluation) => evaluation.id === captureToEval.get(batch.captureCellId),
        )!;
        if (
          hashJson(artifact) !== event.artifactHashes[0] ||
          artifact.operationId !== id ||
          artifact.batchId !== batch.id ||
          artifact.manifestHash !== manifestHash ||
          artifact.rubricHash !== evaluation.rubricHash ||
          new Set(artifact.decisions.map((row) => row.criterionId)).size !==
            artifact.decisions.length ||
          artifact.decisions.length !== batch.criterionIds.length
        )
          throw new Error("Original model answer identity, rubric or hash changed.");
        const answers = artifact.decisions.map((decision) => {
          if (!batch.criterionIds.includes(decision.criterionId))
            throw new Error("Answer criterion is outside its frozen batch.");
          const method = artifact.decisionAuthorities[decision.criterionId];
          if (method !== "model" && method !== "deterministic")
            throw new Error("Answer method is absent.");
          if (decision.score !== null) {
            const criterion = criteria
              .get(evaluation.id)
              ?.find((row) => row.id === decision.criterionId);
            if (
              !criterion ||
              criterion.anchors === null ||
              !validRubricScore(
                { anchors: criterion.anchors, scoreRange: criterion.scoreRange },
                decision.score,
              )
            )
              throw new Error("Score cannot be bound to its original authored scale.");
          }
          return {
            cellId: batch.id,
            criterionId: decision.criterionId,
            method,
            outcome:
              decision.verdict === "satisfied"
                ? ("met" as const)
                : decision.verdict === "violated"
                  ? ("rejected" as const)
                  : decision.score !== null
                    ? ("scored" as const)
                    : ("insufficient" as const),
            score: decision.score,
            // The projection combines the samples of a sample group.
            samples: null,
            observed: null,
          };
        });
        outcomes.push(...answers);
      }
    } catch (cause) {
      issues.push(
        `${event.stage} ${event.unitId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return {
    status,
    spending: recordValue(records.spending),
    title: recordValue(records.title) ?? id,
    definitions,
    outcomes,
    issues,
    evaluationTitles,
  };
}

/** Hash-bound original answers and receipts. Does not rerun graders, load every frame or reconcile bills. */
export async function benchmarkReport(
  root: string,
  id: string,
  runRecords: FrozenRunReader = frozenRunRecords(root),
) {
  const { spending, ...answers } = await benchmarkAnswers(root, id, runRecords);
  const { status } = answers;
  const receipts = await benchmarkReceipts(root, id, spending);
  return projectBenchmarkReport({
    ...answers,
    requests: receipts.requests,
    studioSessions: await studioSessions(root, status),
    planRows: await emptyBuildRows(
      root,
      status.manifest.evals.map((evaluation) => evaluation.id),
    ),
    attributions: await operationAttributions(root, status),
  });
}

/** Active operational problems, not terminal missing answers or a routine human review queue. */
export async function consoleNotifications(root: string): Promise<ConsoleNotification[]> {
  const issues = new Map<string, ConsoleNotification>();
  let pages = 1;
  for (let page = 1; page <= pages; page++) {
    const result = await runCatalog(root, new URLSearchParams({ page: String(page), limit: "50" }));
    pages = result.pages;
    for (const row of result.items) {
      if (row.state === "attention") {
        const id = `interruption:${row.id}`;
        issues.set(id, {
          id,
          title: row.title,
          detail:
            row.blocker ?? "Basalt cannot continue this run. Open the run to see the problem.",
          href: `/runs/${row.id}?tab=progress`,
          kind: "interruption",
          at: row.updatedAt,
        });
      }
      // The pending charges of a stopped run stay visible until Basalt knows their cost.
      if (row.state !== "stopped") continue;
      let ledger: SpendLedgerState | null;
      try {
        const journal = await OperationJournal.open(root);
        let saved: SpendLedgerState | null;
        try {
          saved = journal.read<SpendLedgerState>("spending", row.id);
        } finally {
          journal.close();
        }
        ledger = saved
          ? await new DurableSpendLedger(root, row.id, saved.contextHash).read()
          : null;
      } catch {
        // If the record of one run is not readable, show the notifications of the other runs.
        const id = `billing:${row.id}:unreadable`;
        issues.set(id, {
          id,
          title: `Unknown charges · ${row.title}`,
          detail:
            "Basalt cannot read the saved charges of this run. It cannot show its pending charges.",
          href: `/runs/${row.id}?tab=progress`,
          kind: "billing",
          at: row.updatedAt,
        });
        continue;
      }
      let checkNumber = 0;
      for (const request of ledger?.entries ?? [])
        if (request.status === "pending") {
          const id = `billing:${row.id}:${request.requestId}`;
          const kind = request.stage.startsWith("assessment:")
            ? "Reassessment"
            : request.stage.startsWith("judgment:")
              ? "Check"
              : request.stage.startsWith("builder:")
                ? "Build"
                : "Model request";
          checkNumber++;
          issues.set(id, {
            id,
            title: `Pending charge · ${row.title}`,
            detail: `${kind} ${checkNumber} · The request holds ${formatMoney(request.reservedUsd)} until the provider confirms the cost.`,
            href: `/runs/${row.id}/requests/${request.requestId}`,
            kind: "billing",
            at: row.updatedAt,
          });
        }
    }
  }
  return [...issues.values()];
}
