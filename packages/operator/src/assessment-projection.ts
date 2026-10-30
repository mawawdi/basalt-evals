import { OperationJournal } from "../../artifact-store/src/journal.js";
import type { AssessmentProgress } from "../../contracts/src/assessments.js";
import { readLifecycle } from "./lifecycle.js";
import type { FailureRecord } from "../../contracts/src/failure.js";
import type { RunSummary } from "../../contracts/src/catalog.js";
import { assertRunNotDeleted, runArchived } from "./run-visibility.js";

export function projectAssessment(journal: OperationJournal, progress: AssessmentProgress) {
  assertRunNotDeleted(journal, progress.operationId);
  const owner = journal.read<{ active: boolean; pid: number; error: string | null }>(
    "drivers",
    progress.operationId,
  );
  const spending = journal.read<{ billedUsd: number; reservedUsd: number }>(
    "spending_progress",
    progress.operationId,
  );
  const lifecycle = readLifecycle(journal, progress.operationId);
  const phase = journal.read("comparison_progress", progress.operationId)
    ? "comparison"
    : "assessment";
  const state = progress.stopped
    ? "stopped"
    : progress.finished
      ? progress.incomplete
        ? "partial"
        : "complete"
      : lifecycle.state === "blocked"
        ? "attention"
        : "active";
  const row: RunSummary = {
    id: progress.operationId,
    title: progress.title,
    models: [],
    startedAt: progress.startedAt,
    state,
    phase,
    blocker: lifecycle.blocker,
    billedUsd: spending?.billedUsd ?? 0,
    reservedUsd: spending?.reservedUsd ?? 0,
    updatedAt: new Date().toISOString(),
    evaluationId: null,
    draftId: null,
    finished: progress.finished,
    stopped: progress.stopped,
    archived: runArchived(journal, progress.operationId),
  };
  journal.put("catalog_runs", progress.operationId, row);
  journal.project("runs", progress.operationId, {
    body: row,
    search: row.title,
    status: row.archived ? "archived" : state,
    sort: progress.startedAt,
  });
  const failures = Object.values(
    journal.read<Record<string, FailureRecord>>("failure_heads", progress.operationId) ?? {},
  );
  const groups = new Map<
    string,
    { code: string; dependency: string; explanation: string; units: Set<string> }
  >();
  for (const failure of failures) {
    if (failure.unit.stage === "driver" && !owner?.error) continue;
    const dependency =
      failure.category === "unknown" || !failure.dependency
        ? `${progress.operationId}:${failure.unit.stage}:${failure.unit.id}`
        : failure.dependency;
    const key = `${failure.causeCode}:${dependency}`;
    const group = groups.get(key) ?? {
      code: failure.causeCode,
      dependency,
      explanation: failure.explanation,
      units: new Set<string>(),
    };
    // Provider stages bind all requests for one captured pass to the same assessment unit.
    if (failure.unit.stage === phase) group.units.add(failure.unit.id);
    groups.set(key, group);
  }
  if (!groups.size && row.blocker)
    groups.set("operation", {
      code: "unclassified",
      dependency: progress.operationId,
      explanation: row.blocker,
      units: new Set(),
    });
  journal.replaceIssues(
    progress.operationId,
    [...groups.values()].map((group) => ({
      code: group.code,
      dependency: group.dependency,
      explanation: group.explanation,
      affectedCaptures: group.units.size,
      affectedCandidates: 1,
      action: "inspect",
    })),
  );
}
