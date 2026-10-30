import { projectJourney } from "./journey-progress.js";
import { projectAssessment } from "./assessment-projection.js";
import { readLifecycle } from "./lifecycle.js";
import { processAlive } from "./process-owner.js";
import type { AssessmentProgress } from "../../contracts/src/assessments.js";
import type {
  AuthoringProgress,
  EvaluationWorkflow,
  RunOperationStatus,
  RunSubject,
  SpendLedgerState,
  RunStart,
} from "../../contracts/src/execution.js";
import type { FailureRecord } from "../../contracts/src/failure.js";

import { OperationJournal } from "../../artifact-store/src/journal.js";
import type { EvaluationSummary, RunSummary, ResultSummary } from "../../contracts/src/catalog.js";

import { buildMaker, buildName, buildTitle, frozenModelName } from "./model-registry.js";
import { stageTitle } from "../../contracts/src/display.js";
import { notReachedCause, notReachedSubjects } from "./stage-reach.js";
import { stageActiveMs } from "../../experiments/src/benchmarks.js";
import { answerCounts, plannedChecks, runAnswerCounts } from "./answer-counts.js";
import { assertRunNotDeleted, listStatus, runArchived } from "./run-visibility.js";

/** Why the run did not reach the stage of a build, in the words of the results. */
export function notReachedSummary(
  status: Pick<RunOperationStatus, "manifest" | "events" | "criterionOutcomes">,
  subject: RunSubject,
): ResultSummary["notReached"] {
  const cause = notReachedCause(status, subject);
  if (!cause) return null;
  const manifest = status.manifest;
  return {
    parentCandidateId: cause.parent.id,
    parentTitle: buildTitle(manifest, cause.parent),
    parentStage: cause.parent.stageIndex,
    failedGateChecks: cause.failedGateCells.map((cell) => ({
      cellId: cell.id,
      pass: manifest.captureCells.find((capture) => capture.id === cell.captureCellId)!.pass,
    })),
  };
}

/** Synchronous projection updates share the authoritative journal transaction. */
export function projectRun(
  journal: OperationJournal,
  id: string,
  status = journal.read<RunOperationStatus>("operations", id),
) {
  assertRunNotDeleted(journal, id);
  const assessment =
    journal.read<AssessmentProgress>("assessment_progress", id) ??
    journal.read<AssessmentProgress>("comparison_progress", id);
  if (assessment) {
    projectAssessment(journal, assessment);
    return;
  }
  const workflow = journal.read<EvaluationWorkflow>("workflows", id);
  const context = journal.read<import("../../contracts/src/launch.js").OperationContext>(
    "operation_context",
    id,
  );
  const start = journal.read<RunStart>("run_starts", id);
  const authoring = journal.read<AuthoringProgress>("authoring_progress", id);
  if (!workflow && !status && !authoring && !start) return;
  const owner = journal.read<{ active: boolean; error: string | null }>("drivers", id);
  const spending = journal.read<{ billedUsd: number; reservedUsd: number }>(
    "spending_progress",
    id,
  );
  const evaluationId =
    Object.values(workflow?.revisions ?? {})[0] ??
    status?.manifest.evals[0]?.id ??
    authoring?.action.revisionId ??
    null;
  const draftId =
    workflow?.draftIds[0] ??
    authoring?.action.draftId ??
    status?.manifest.evals[0]?.draftId ??
    null;
  const evaluation = evaluationId
    ? journal.read<EvaluationSummary>("catalog_evaluations", evaluationId)
    : null;
  const draft = draftId ? journal.read<EvaluationSummary>("catalog_evaluations", draftId) : null;
  const finished = workflow
    ? workflow.state === "complete"
    : (status?.finished ?? authoring?.state === "completed");
  const stopped =
    workflow?.state === "stopped" || !!status?.stopped || !!authoring?.stopped || !!start?.stopped;
  // An insufficient answer is an answer. Only a check without an answer makes the results incomplete.
  const incomplete = status && runAnswerCounts(status).unavailable > 0;
  const lifecycle = readLifecycle(journal, id);
  const row: RunSummary = {
    id,
    title:
      workflow?.title ?? context?.title ?? evaluation?.title ?? draft?.title ?? "Evaluation run",
    models: (workflow?.selection.builderModelIds ?? status?.manifest.selectedModelIds ?? []).map(
      (id) => frozenModelName(status?.manifest.modelSnapshots ?? [], id),
    ),
    startedAt: status?.events[0]?.at ?? workflow?.createdAt ?? null,
    state: stopped
      ? "stopped"
      : finished
        ? incomplete
          ? "partial"
          : "complete"
        : lifecycle.state === "blocked"
          ? "attention"
          : "active",
    phase:
      workflow?.phase ??
      (status || start ? "execution" : (authoring?.action.stage ?? "preparation")),
    blocker: lifecycle.blocker,
    billedUsd: spending?.billedUsd ?? status?.billedUsd ?? null,
    reservedUsd: spending?.reservedUsd ?? status?.reservedUsd ?? null,
    updatedAt: new Date().toISOString(),
    evaluationId,
    draftId,
    finished,
    stopped,
    archived: runArchived(journal, id),
  };
  journal.put("catalog_runs", id, row);
  if (
    context &&
    row.finished &&
    status?.measurementComplete &&
    row.reservedUsd === 0 &&
    row.billedUsd !== null
  ) {
    const samples = journal.read<Record<string, number>>("measured_costs", context.costScope) ?? {};
    journal.put("measured_costs", context.costScope, { ...samples, [id]: row.billedUsd });
  }
  projectJourney(journal, id, workflow, status, authoring);
  const heads = Object.values(
    journal.read<Record<string, FailureRecord>>("failure_heads", id) ?? {},
  );
  const issues = new Map<
    string,
    {
      code: string;
      dependency: string;
      explanation: string;
      captures: Set<string>;
      candidates: Set<string>;
      action: string;
    }
  >();
  const affected = (stage: string, unitId: string) => {
    const captures =
      status?.manifest.captureCells.filter((capture) =>
        stage === "builder"
          ? capture.treatmentId === unitId
          : stage === "final_capture"
            ? capture.id === unitId
            : stage === "grading"
              ? status.manifest.gradingCells.some(
                  (c) => c.id === unitId && c.captureCellId === capture.id,
                )
              : stage === "judgment"
                ? status.manifest.judgmentBatches.some(
                    (c) => c.id === unitId && c.captureCellId === capture.id,
                  )
                : false,
      ) ?? [];
    return { captures: captures.map((c) => c.id), candidates: captures.map((c) => c.treatmentId) };
  };
  const add = (stage: string, unitId: string, failure?: FailureRecord, explanation?: string) => {
    const code = failure?.causeCode ?? "unclassified";
    const dependency =
      failure?.category !== "unknown" && failure?.dependency
        ? failure.dependency
        : `${id}:${stage}:${unitId}`;
    const key = `${code}:${dependency}`,
      counts = affected(stage, unitId);
    const group = issues.get(key) ?? {
      code,
      dependency,
      explanation:
        failure?.explanation ??
        explanation ??
        "The run did not complete. Examine the saved evidence before you resume the run.",
      captures: new Set<string>(),
      candidates: new Set<string>(),
      action: "inspect",
    };
    counts.captures.forEach((value) => group.captures.add(value));
    counts.candidates.forEach((value) => group.candidates.add(value));
    issues.set(key, group);
  };
  const seen = new Set<string>();
  const ledger = journal.read<SpendLedgerState>("spending", id);
  for (const event of [...(status?.events ?? [])].reverse()) {
    const key = `${event.stage}:${event.unitId}`;
    if (!event.stage || !event.unitId || seen.has(key) || status!.completedUnits.includes(key))
      continue;
    seen.add(key);
    if (!["failed", "incomplete"].includes(event.kind)) continue;
    const failure = heads.find((f) => f.unit.stage === event.stage && f.unit.id === event.unitId);
    add(event.stage, event.unitId, failure, event.reason ?? undefined);
  }
  for (const failure of heads) {
    const key = `${failure.unit.stage}:${failure.unit.id}`;
    const outstanding = ledger?.entries.some(
      (entry) => entry.status !== "billed" && failure.evidenceRefs.includes(entry.requestHash),
    );
    const prepared = [
      "prepare_public",
      "prepare_private_plan",
      "prepare_private_criteria",
      "preparation",
    ].includes(failure.unit.stage);
    const controlled =
      failure.unit.stage === "controls" ||
      failure.unit.stage === "control-judge" ||
      failure.unit.stage.startsWith("control_");
    if (
      !outstanding &&
      workflow &&
      ((prepared &&
        (workflow.phase !== "preparation" ||
          !workflow.selection.sources.some((source) => source.id === failure.unit.id))) ||
        (controlled && workflow.phase === "complete"))
    )
      continue;
    if (status?.completedUnits.includes(key)) continue;
    if (failure.unit.stage === "driver" && !owner?.error) continue;
    add(failure.unit.stage, failure.unit.id, failure);
  }
  if (!issues.size && ["attention", "partial", "stopped"].includes(row.state))
    add(
      "operation",
      id,
      undefined,
      row.blocker ?? "The run has work that did not complete. Use the available recovery actions.",
    );
  journal.replaceIssues(
    id,
    [...issues.values()].map((issue) => ({
      code: issue.code,
      dependency: issue.dependency,
      explanation: issue.explanation,
      affectedCaptures: issue.captures.size,
      affectedCandidates: issue.candidates.size,
      action: issue.action,
    })),
  );
  journal.project("runs", id, {
    search: `${row.title} ${row.id} ${evaluationId ?? ""} ${draftId ?? ""} ${Object.values(workflow?.revisions ?? {}).join(" ")} ${(workflow?.draftIds ?? []).join(" ")} ${(status?.manifest.evals ?? []).map((item) => item.id).join(" ")}`,
    status: row.archived ? "archived" : row.state,
    // Lists show runs newest first by their start. The projection time is the same for all
    // rows of one rebuild, so it cannot order them.
    sort: row.startedAt ?? row.updatedAt,
    body: row,
  });
  if (status) projectResults(journal, status, row.updatedAt, row.startedAt ?? row.updatedAt);
}
function projectResults(
  journal: OperationJournal,
  status: RunOperationStatus,
  updatedAt: string,
  startedAt: string,
) {
  const { manifest } = status;
  const owner = journal.read<{ active: boolean; pid: number }>("drivers", manifest.id);
  const ownerActive = Boolean(owner?.active && processAlive(owner.pid));
  const unitState = (stage: "builder" | "seal" | "final_capture", id: string) => {
    if (status.completedUnits.includes(`${stage}:${id}`)) return "complete";
    const event = [...status.events]
      .reverse()
      .find((item) => item.stage === stage && item.unitId === id);
    if (!event) return "planned";
    return event.kind === "started" && ownerActive && !status.stopped ? "active" : "incomplete";
  };
  // Build time follows the one rule of active intervals. Group the build events one time.
  const builderEvents = new Map<string, RunOperationStatus["events"]>();
  for (const event of status.events)
    if (event.stage === "builder" && event.unitId) {
      if (!builderEvents.has(event.unitId)) builderEvents.set(event.unitId, []);
      builderEvents.get(event.unitId)!.push(event);
    }
  // A judge check is one sample group and criterion. Its samples combine into one outcome.
  const cells = plannedChecks(status);
  const notReached = notReachedSubjects(status.events);
  for (const subject of manifest.subjects) {
    const captures = manifest.captureCells.filter((cell) => cell.treatmentId === subject.id);
    // The planned answers of a build that the run did not reach are outside the measurement.
    const selected = notReached.has(subject.id)
      ? []
      : cells.filter((cell) => captures.some((capture) => capture.id === cell.captureCellId));
    // The catalog knows a staged evaluation by its first stage. Each stage has its own title.
    const stage = manifest.evals.find((item) => item.id === subject.evalId)!.stage;
    const evaluation = journal.read<EvaluationSummary>(
      "catalog_evaluations",
      stage.firstRevisionId,
    );
    const metrics = journal.read<{ costUsd: number | null; toolCalls: number }>(
      "builder_metrics",
      `${manifest.id}:${subject.id}`,
    );
    const building = unitState(subject.sourceId ? "seal" : "builder", subject.id);
    const buildState = notReached.has(subject.id)
      ? "not_reached"
      : building === "complete"
        ? "ready"
        : building === "active"
          ? "running"
          : building;
    const allCollected =
      captures.length > 0 &&
      captures.every((cell) => unitState("final_capture", cell.id) === "complete");
    const allAnswered = selected.length > 0 && answerCounts(selected).unavailable === 0;
    const body: ResultSummary = {
      id: `${manifest.id}:${subject.id}`,
      operationId: manifest.id,
      evaluationId: subject.evalId,
      evaluationTitle: stageTitle(evaluation?.title ?? "Evaluation", stage),
      candidateId: subject.id,
      candidateTitle: buildName(manifest, subject.id),
      kind: subject.kind,
      buildState,
      notReached: notReached.has(subject.id) ? notReachedSummary(status, subject) : null,
      model: buildMaker(manifest.modelSnapshots, subject),
      harness: subject.builder?.harness.title ?? null,
      captures: [...new Set(captures.map((capture) => capture.pass))]
        .sort((a, b) => a - b)
        .map((number) => {
          const group = selected.filter((cell) =>
            captures.some(
              (capture) => capture.id === cell.captureCellId && capture.pass === number,
            ),
          );
          return {
            number,
            state: (() => {
              const states = captures
                .filter((cell) => cell.pass === number)
                .map((cell) => unitState("final_capture", cell.id));
              if (states.every((state) => state === "complete")) return "collected" as const;
              if (states.includes("active")) return "collecting" as const;
              if (states.includes("incomplete")) return "incomplete" as const;
              return "planned" as const;
            })(),
            ...answerCounts(group),
          };
        }),
      functional: answerCounts(selected.filter((cell) => cell.method === "deterministic")),
      qualitative: answerCounts(selected.filter((cell) => cell.method !== "deterministic")),
      costUsd: metrics?.costUsd ?? null,
      toolCalls: metrics?.toolCalls ?? null,
      elapsedMs: stageActiveMs(builderEvents.get(subject.id) ?? [], "builder", subject.id),
      // A build that the run did not reach is neither complete nor incomplete.
      state:
        buildState === "not_reached"
          ? "not_reached"
          : buildState === "ready" && allCollected && allAnswered
            ? "complete"
            : !status.finished && !status.stopped && ownerActive
              ? "active"
              : "incomplete",
      updatedAt,
    };
    journal.put("catalog_results", body.id, body);
    journal.project("results", body.id, {
      search: `${body.evaluationTitle} ${body.model} ${body.harness ?? ""} ${body.operationId} ${body.evaluationId}`,
      status: listStatus(journal, manifest.id, body.state),
      sort: `${body.evaluationTitle.toLowerCase()}:${body.evaluationId}:${startedAt}`,
      body,
    });
  }
}
