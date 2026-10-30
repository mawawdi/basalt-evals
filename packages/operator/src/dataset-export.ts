import { resolve } from "node:path";
import { inventoryTree } from "../../artifact-store/src/inventory.js";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { stageTitle } from "../../contracts/src/display.js";
import type { RunOperationStatus } from "../../contracts/src/execution.js";
import {
  assertAgentRun,
  contentHash,
  hashJson,
  stableJson,
  type AgentRun,
} from "../../contracts/src/index.js";
import { identity } from "../../contracts/src/validation.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import {
  datasetExportFiles,
  type DatasetExportInput,
  type DatasetLint,
  type DatasetSourceFile,
} from "../../reporting/src/dataset.js";
import type { ExportFile, ExportScope, RunExportInput } from "../../reporting/src/export.js";
import { benchmarkReport } from "./benchmarks.js";
import { buildCodeFacts, reportSourceAnalyses, type BuildCodeFacts } from "./build-code-facts.js";
import { readBuildHistory } from "./build-history.js";
import { operatorEvidence } from "./evidence-view.js";
import { savedLifecycle } from "./lifecycle.js";
import { frozenRunStatus } from "./run-builder.js";

/**
 * The sealed code of one build, or null when the build sealed no code. The latest end event of
 * the build binds its saved run and its candidate. The sealed files must still match them.
 */
export async function sealedBuildSource(
  root: string,
  status: Pick<RunOperationStatus, "manifest" | "events">,
  subjectId: string,
): Promise<{ run: AgentRun; files: DatasetSourceFile[] } | null> {
  const end = [...status.events]
    .reverse()
    .find(
      (event) =>
        event.stage === "builder" &&
        event.unitId === subjectId &&
        ["completed", "failed", "incomplete"].includes(event.kind) &&
        event.artifactHashes.length > 0,
    );
  if (!end) return null;
  const base = `.basalt-evals/eval-operations/${status.manifest.id}/builder/${subjectId}`;
  const run = await new RepositoryFiles(root).json<AgentRun>(`${base}/agent-run.json`);
  assertAgentRun(run);
  const candidate = resolve(root, base, "candidate");
  const sealed = await inventoryTree(candidate);
  const changed = new Error("The sealed code of a build changed after the build.");
  if (
    run.treatmentId !== subjectId ||
    !end.artifactHashes.includes(hashJson(run)) ||
    !end.artifactHashes.includes(run.candidate.rootHash) ||
    stableJson(sealed) !== stableJson(run.candidate.files) ||
    hashJson(sealed) !== run.candidate.rootHash
  )
    throw changed;
  // The candidate manifest keeps each file and the total inside the candidate limits.
  const files: DatasetSourceFile[] = [];
  for (const file of run.candidate.files) {
    const bytes = await readBoundedRegularFile(
      resolve(candidate, file.path),
      file.bytes,
      "sealed source",
    );
    if (contentHash(bytes) !== file.hash) throw changed;
    files.push({ path: file.path, sha256: file.hash, content: bytes.toString("utf8") });
  }
  return { run, files };
}

/** The lint field of a dataset line. A build without sealed code has no analysis. */
function datasetLint(facts: BuildCodeFacts | undefined): DatasetLint {
  if (facts?.lint) return { status: "complete", counts: facts.lint };
  return { status: facts?.analysis === "unavailable" ? "unavailable" : "absent", counts: null };
}

/**
 * The files of a dataset export of a benchmark run: one JSONL line for each build. Basalt
 * refuses a run that can still start work.
 */
export async function datasetExport(
  root: string,
  operationId: string,
  scope: ExportScope,
): Promise<{ folder: string; files: ExportFile[] }> {
  identity(operationId);
  const lifecycle = await savedLifecycle(root, operationId);
  if (lifecycle.ownerActive || !["completed", "stopped", "blocked"].includes(lifecycle.state))
    throw new Error("This run can still start work. Export it after it finishes or stops.");
  const report = await benchmarkReport(root, operationId);
  const status = await frozenRunStatus(root, operationId, false);
  const store = new EvalDefinitionStore(root);
  const evaluations: DatasetExportInput["evaluations"] = [];
  for (const evaluation of report.evaluations) {
    const revision = await store.readRevision(evaluation.evaluationId);
    const stage = { index: evaluation.stage.index, count: evaluation.stage.count };
    evaluations.push({
      evaluationId: evaluation.stage.firstEvaluationId,
      revisionId: evaluation.evaluationId,
      title: stageTitle(revision.publicTask.title, stage),
      stage,
      prompt: revision.publicTask.prompt,
      criteria: report.criteria
        .filter((criterion) => criterion.evaluationId === evaluation.evaluationId)
        .map((criterion) => ({
          criterionId: criterion.criterionId,
          statement: criterion.statement,
          required: criterion.required,
          evidenceClass: criterion.evidenceClass,
        })),
    });
  }
  const subjects = report.rows.flatMap((row) =>
    row.cases.flatMap((item) => item.builds.map((build) => build.subjectId)),
  );
  // Reasons are private. Basalt reads them only for a private export.
  const reasons = new Map<string, string | null>();
  if (scope === "private")
    for (const subjectId of subjects) {
      const view = await operatorEvidence(root, operationId, undefined, { subjectId });
      for (const cell of view.candidates.flatMap((candidate) => candidate.cells))
        reasons.set(cell.id, cell.explanation);
    }
  const histories: RunExportInput["histories"] = [];
  const sources = new Map<string, Awaited<ReturnType<typeof sealedBuildSource>>>();
  const code = new Map<string, BuildCodeFacts>();
  const analyses = await reportSourceAnalyses(root);
  for (const subjectId of subjects) {
    const saved = await readBuildHistory(root, operationId, subjectId).catch(() => null);
    if (saved) histories.push({ subjectId, ...saved });
    const sealed = await sealedBuildSource(root, status, subjectId);
    sources.set(subjectId, sealed);
    if (sealed)
      code.set(
        subjectId,
        await buildCodeFacts(root, status, subjectId, sealed.run.candidate, analyses),
      );
  }
  const input: DatasetExportInput = {
    runId: operationId,
    title: report.title,
    evaluations,
    builds: report.rows.flatMap((row) =>
      row.cases.flatMap((item) =>
        item.builds.map((build) => {
          const sealed = sources.get(build.subjectId) ?? null;
          const facts = code.get(build.subjectId);
          return {
            revisionId: item.evaluationId,
            model: { id: row.modelId, revision: row.modelRevision },
            harness: row.harnessId,
            number: build.number,
            subjectId: build.subjectId,
            parentSubjectId: build.parentSubjectId,
            notReached: build.notReached,
            delivered: status.completedUnits.includes(`builder:${build.subjectId}`),
            stopReason: sealed?.run.stopReason ?? null,
            source: sealed?.files ?? null,
            marks: build.marks.map((mark) => ({
              criterionId: mark.criterionId,
              pass: mark.pass,
              outcome: mark.outcome,
              score: mark.score,
              samples: mark.samples,
              reason: reasons.get(mark.evidenceCellId) ?? null,
            })),
            charge: build.breakdown.charge,
            buildMs: build.breakdown.time.buildMs,
            lint: datasetLint(facts),
            buildErrors: facts?.scriptErrors ?? null,
          };
        }),
      ),
    ),
    histories,
  };
  return {
    folder: `basalt-dataset-${operationId}-${scope}`,
    files: datasetExportFiles(input, scope),
  };
}
