import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import type { RunOperationStatus } from "../../contracts/src/execution.js";
import {
  hashJson,
  type CandidateManifest,
  type StudioEvidence,
} from "../../contracts/src/index.js";
import type {
  ScriptErrorCounts,
  ScriptErrorOrigin,
  SourceAnalysis,
  SourceLintCounts,
} from "../../contracts/src/source-analysis.js";
import { evidenceScriptErrors } from "../../graders/src/script-origin.js";
import { storedSourceAnalyses } from "../../graders/src/source-analysis.js";

/** Read the stored source analysis of one sealed build. Null when Basalt stored none. */
export type SourceAnalysisReader = (candidate: CandidateManifest) => Promise<SourceAnalysis | null>;

/**
 * The code facts of one sealed build from saved records. A report reads them. It runs no tool
 * and makes no analysis.
 */
export interface BuildCodeFacts {
  /** The status of the stored source analysis, or `absent` when Basalt stored none. */
  analysis: SourceAnalysis["status"] | "absent";
  /** The findings of each lint code of a complete analysis. Null for any other status. */
  lint: SourceLintCounts | null;
  /**
   * The script errors of the signed observations of the build, by origin: the sum over the
   * observations and their contexts. Null without a complete analysis or without an
   * observation with a diagnostics fact.
   */
  scriptErrors: ScriptErrorCounts | null;
}

/**
 * The reader of the stored analyses for a report. If Basalt cannot read the pins or a stored
 * record, the build has no analysis in the report.
 */
export async function reportSourceAnalyses(root: string): Promise<SourceAnalysisReader> {
  const read = await storedSourceAnalyses(root).catch(() => null);
  return async (candidate) => (read ? await read(candidate).catch(() => null) : null);
}

/**
 * The code facts of one build of a run. Each observation must be a completed final capture of
 * the build, and its evidence must have the hash that the capture event binds.
 */
export async function buildCodeFacts(
  root: string,
  status: Pick<RunOperationStatus, "manifest" | "events">,
  subjectId: string,
  candidate: CandidateManifest,
  analyses: SourceAnalysisReader,
): Promise<BuildCodeFacts> {
  const analysis = await analyses(candidate);
  if (analysis?.status !== "complete")
    return { analysis: analysis?.status ?? "absent", lint: null, scriptErrors: null };
  const files = new RepositoryFiles(root);
  const observed: ScriptErrorCounts[] = [];
  for (const cell of status.manifest.captureCells) {
    if (cell.treatmentId !== subjectId) continue;
    const capture = status.events.find(
      (event) =>
        event.stage === "final_capture" && event.unitId === cell.id && event.kind === "completed",
    );
    if (!capture) continue;
    const evidence = await files
      .optional<StudioEvidence>(
        `.basalt-evals/eval-operations/${status.manifest.id}/capture/${cell.id}/studio/evidence.json`,
      )
      .catch(() => null);
    if (
      !evidence ||
      hashJson(evidence) !== capture.artifactHashes[1] ||
      evidence.candidateHash !== candidate.rootHash
    )
      continue;
    const counts = evidenceScriptErrors(evidence, analysis.scripts);
    if (counts) observed.push(counts);
  }
  const total = (origin: ScriptErrorOrigin) =>
    observed.reduce((sum, counts) => sum + counts[origin], 0);
  return {
    analysis: "complete",
    lint: { ...analysis.counts },
    scriptErrors: observed.length
      ? {
          build: total("build"),
          unknown: total("unknown"),
          external: total("external"),
          truncated: observed.some((counts) => counts.truncated),
        }
      : null,
  };
}
