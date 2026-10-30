import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import { identity } from "../../contracts/src/validation.js";
import { comparisonGrid } from "../../experiments/src/comparisons.js";
import {
  comparisonExportFiles,
  exportArchive,
  runExportFiles,
  type ExportFile,
  type ExportScope,
  type RunExportInput,
} from "../../reporting/src/export.js";
import { benchmarkReport } from "./benchmarks.js";
import { readBuildHistory } from "./build-history.js";
import { savedComparison } from "./comparisons.js";
import { evidenceImage, readOperationEvidence } from "./evidence.js";
import { operatorEvidence } from "./evidence-view.js";
import { savedLifecycle } from "./lifecycle.js";
import { readModelRegistry } from "./model-registry.js";
import { modelReportOf } from "./model-report.js";
import { frozenRunStatus } from "./run-builder.js";
import { checkCapture } from "./run-manifest.js";

export function exportScope(value: string | null): ExportScope {
  if (value === null || value === "public") return "public";
  if (value === "private") return "private";
  throw new Error('The export scope is not valid. Use "public" or "private".');
}

/** The files of a run export. Basalt refuses a run that can still start work. */
export async function runExport(
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
  const subjects = report.rows.flatMap((row) =>
    row.cases.flatMap((item) => item.builds.map((build) => build.subjectId)),
  );
  // Reasons and images are private. Basalt reads them only for a private export.
  const reasons = new Map<string, string | null>();
  const frames = new Map<string, ExportFile[]>();
  if (scope === "private")
    for (const subjectId of subjects) {
      const view = await operatorEvidence(root, operationId, undefined, { subjectId });
      for (const cell of view.candidates.flatMap((candidate) => candidate.cells))
        reasons.set(cell.id, cell.explanation);
      const evidence = await readOperationEvidence(root, operationId, { subjectId });
      for (const item of evidence.items.filter((item) => item.partition === "development"))
        for (const pass of item.passes) {
          const images: ExportFile[] = [];
          for (const image of pass.images) {
            const bytes = (await evidenceImage(root, evidence, item.id, pass.id, image.id)).bytes;
            const name = image.id.replace(/[^a-z0-9-]/giu, "-").slice(0, 80);
            images.push({
              path: `${subjectId}/${pass.number}/${name}.${image.mediaType === "image/jpeg" ? "jpg" : "png"}`,
              bytes: new Uint8Array(bytes),
            });
          }
          frames.set(`${subjectId}:${pass.number}`, [
            ...(frames.get(`${subjectId}:${pass.number}`) ?? []),
            ...images,
          ]);
        }
    }
  const histories: RunExportInput["histories"] = [];
  for (const subjectId of subjects) {
    const saved = await readBuildHistory(root, operationId, subjectId).catch(() => null);
    if (saved) histories.push({ subjectId, ...saved });
  }
  const input: RunExportInput = {
    runId: operationId,
    title: report.title,
    exportedAt: new Date().toISOString(),
    chargedUsd: status.billedUsd,
    pendingUsd: status.reservedUsd,
    evaluations: report.evaluations.map((evaluation) => ({
      evaluationId: evaluation.evaluationId,
      title: evaluation.title,
      stage: { index: evaluation.stage.index, count: evaluation.stage.count },
      criteria: report.criteria
        .filter((criterion) => criterion.evaluationId === evaluation.evaluationId)
        .map((criterion) => ({
          criterionId: criterion.criterionId,
          statement: criterion.statement,
          scale: criterion.scale,
          required: criterion.required,
        })),
    })),
    columns: report.rows.map((row) => ({
      model: row.modelName,
      toolSet: row.harnessTitle,
      cases: row.cases.map((item) => ({
        evaluationId: item.evaluationId,
        builds: item.builds.map((build) => ({
          subjectId: build.subjectId,
          number: build.number,
          marks: build.marks.map((mark) => {
            const observation = checkCapture(
              status.manifest,
              mark.evidenceCellId,
              mark.criterionId,
            );
            return {
              criterionId: mark.criterionId,
              pass: mark.pass,
              outcome: mark.outcome,
              score: mark.score,
              samples: mark.samples,
              reason: reasons.get(mark.evidenceCellId) ?? null,
              withheld: observation?.partition !== "development",
              frames: frames.get(`${build.subjectId}:${mark.pass}`) ?? [],
            };
          }),
          charge: build.breakdown.charge,
          buildMs: build.breakdown.time.buildMs,
          parentSubjectId: build.parentSubjectId,
          notReached: build.notReached,
        })),
      })),
    })),
    histories,
    models: await modelReportOf(root, report, status),
  };
  return { folder: `basalt-run-${operationId}-${scope}`, files: runExportFiles(input, scope) };
}

/** The files of a comparison export. A saved comparison is frozen, so it is always settled. */
export async function comparisonExport(
  root: string,
  id: string,
  scope: ExportScope,
): Promise<{ folder: string; files: ExportFile[] }> {
  const comparison = await savedComparison(root, id);
  const registry = await readModelRegistry(root);
  return {
    folder: `basalt-comparison-${id.slice(0, 16)}-${scope}`,
    files: comparisonExportFiles(
      {
        comparison,
        grid: comparisonGrid(comparison),
        exportedAt: new Date().toISOString(),
        models: Object.fromEntries(registry.models.map((model) => [model.id, model.name])),
      },
      scope,
    ),
  };
}

/** A .tar file of an export, for a download from the console. */
export function exportTar(saved: { folder: string; files: ExportFile[] }): Uint8Array {
  return exportArchive(saved.folder, saved.files, new Date());
}

/**
 * Write an export to a folder that does not exist yet. Basalt writes a sibling temporary
 * folder first and then renames it, so a stopped export never leaves a partial folder.
 */
export async function writeExportFolder(target: string, files: ExportFile[]): Promise<string> {
  const destination = resolve(target);
  const exists = () =>
    lstat(destination).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
  if (await exists()) throw new Error("The export folder already exists. Choose a new folder.");
  const parent = dirname(destination);
  await assertSafeAbsoluteDirectory(parent);
  const temporary = resolve(
    parent,
    `.${basename(destination)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  await mkdir(temporary, { mode: 0o755 });
  try {
    for (const file of files) {
      const path = resolve(temporary, file.path);
      const relation = relative(temporary, path);
      if (!relation || relation.startsWith(`..${sep}`) || relation === "..")
        throw new Error(`An export file escapes its folder: ${file.path}`);
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      await writeFile(path, file.bytes, { flag: "wx", mode: 0o644 });
    }
    // A rename replaces an empty folder, so check again just before it.
    if (await exists()) throw new Error("The export folder already exists. Choose a new folder.");
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return destination;
}
