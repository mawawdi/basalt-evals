import { contentHash, stableJson } from "../../contracts/src/index.js";
import type { BuildHistory } from "../../contracts/src/build-history.js";
import type { RunComparison } from "../../contracts/src/comparisons.js";
import type {
  ClassComparison,
  CriterionComparison,
  ModelReport,
  PairComparison,
  PatternComparison,
  PatternShare,
} from "../../contracts/src/model-report.js";
import type { ComparisonGrid } from "../../experiments/src/comparisons.js";
import { atifTrajectory, type AtifOptions } from "./atif.js";
import { comparisonReportHtml, runReportHtml } from "./report-html.js";
import { tarArchive } from "./tar.js";

/**
 * The public scope numbers the criteria and has no private text. The private scope adds the
 * criterion statements, the scales, the reasons and the images of development observations.
 */
export type ExportScope = "public" | "private";

export type ExportAnswer =
  "met" | "not_met" | "split" | "scored" | "not_enough_evidence" | "missing";

export interface ExportFile {
  path: string;
  bytes: Uint8Array;
}

export interface ExportManifest {
  schema: "basalt-evals/export-manifest";
  scope: ExportScope;
  kind: "run" | "comparison" | "dataset";
  id: string;
  /** The SHA-256 of the canonical JSON of the other fields of the manifest. */
  manifestHash: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}

/** The complete records of a run export. The scope decides what goes into the files. */
export interface RunExportInput {
  runId: string;
  title: string;
  exportedAt: string;
  chargedUsd: number;
  pendingUsd: number;
  evaluations: Array<{
    evaluationId: string;
    title: string | null;
    /** The stage of a staged evaluation. An evaluation without stages has stage 1 of 1. */
    stage: { index: number; count: number };
    criteria: Array<{
      criterionId: string;
      statement: string;
      scale: string | null;
      required: boolean;
    }>;
  }>;
  columns: Array<{
    model: string;
    toolSet: string;
    cases: Array<{
      evaluationId: string;
      builds: Array<{
        subjectId: string;
        number: number;
        marks: Array<{
          criterionId: string;
          pass: number;
          outcome: "met" | "rejected" | "split" | "scored" | "insufficient" | "missing";
          score: number | null;
          /** The judge samples of a combined answer and the samples that say met. */
          samples: { met: number; of: number } | null;
          reason: string | null;
          /** An observation of the withheld partition. Its images never leave Basalt. */
          withheld: boolean;
          /** The images of the observation. */
          frames: ExportFile[];
        }>;
        charge: { builderUsd: number | null; judgeUsd: number | null; pendingUsd: number };
        buildMs: number | null;
        /** The build of the stage before that this build continues, or null. */
        parentSubjectId: string | null;
        /** The run did not reach the stage of this build. */
        notReached: boolean;
      }>;
    }>;
  }>;
  histories: Array<{ subjectId: string; history: BuildHistory; atif: AtifOptions }>;
  /** The model report of the run. The export names each criterion by its numbers. */
  models: ModelReport;
}

type ExportPattern = Pick<PatternShare, "key" | "builds" | "of" | "events" | "interval">;

/**
 * One ordered pair of rows in an export. A model pair has the same tool set on both sides, and a
 * tool-set pair has the same model on both sides.
 */
export interface ExportPair {
  model: string;
  toolSet: string;
  otherModel: string;
  otherToolSet: string;
  decisionPossible: boolean;
  criteria: Array<
    { evaluation: number; criterion: number } & Pick<
      CriterionComparison,
      "model" | "other" | "direction" | "p" | "adjustedP" | "minimumAchievableP" | "verdict"
    >
  >;
  classes: ClassComparison[];
  /** The pattern tests. A key is a stop, a check name, a tool name, a cause or a lint code. */
  patterns: PatternComparison[];
}

/**
 * The model report in an export. Each criterion has the number of its evaluation in
 * `evaluations` and its authored number, never its statement. The patterns have lint codes and
 * counts only. They have no finding message, no file path and no script error message.
 */
export interface ExportModels {
  outcomeRuleHash: string;
  alpha: number;
  models: Array<{
    model: string;
    toolSet: string;
    builds: number;
    judgeFamily: boolean;
    patterns: {
      builds: number;
      recordedBuilds: number;
      stops: ExportPattern[];
      gateFailures: ExportPattern[];
      failedToolCalls: ExportPattern[];
      refusedBatches: ExportPattern;
      causes: ExportPattern[];
      lint: { codes: ExportPattern[]; analyzed: number; unanalyzed: number };
      scriptErrors: {
        build: ExportPattern;
        unknown: ExportPattern;
        measured: number;
        unmeasured: number;
      };
    };
  }>;
  /** The pairs of models of one tool set. */
  modelPairs: ExportPair[];
  /** The pairs of tool sets of one model. */
  toolSetPairs: ExportPair[];
}

/** The model report in an export. Both scopes have the same model report. */
function exportModels(
  report: ModelReport,
  evaluations: RunExportInput["evaluations"],
): ExportModels {
  const rows = new Map(report.models.map((model) => [model.rowId, model]));
  const numbers = new Map(
    evaluations.flatMap((evaluation, index) =>
      evaluation.criteria.map(
        (criterion, position) =>
          [
            `${evaluation.evaluationId}:${criterion.criterionId}`,
            { evaluation: index + 1, criterion: position + 1 },
          ] as const,
      ),
    ),
  );
  const pattern = ({ key, builds, of, events, interval }: PatternShare): ExportPattern => ({
    key,
    builds,
    of,
    events,
    interval,
  });
  const exportPair = (pair: PairComparison): ExportPair => {
    const row = rows.get(pair.rowId)!,
      other = rows.get(pair.otherRowId)!;
    return {
      model: row.modelName,
      toolSet: row.harnessTitle,
      otherModel: other.modelName,
      otherToolSet: other.harnessTitle,
      decisionPossible: pair.decisionPossible,
      criteria: pair.criteria.flatMap((item) => {
        const number = numbers.get(`${item.evaluationId}:${item.criterionId}`);
        return number
          ? [
              {
                ...number,
                model: item.model,
                other: item.other,
                direction: item.direction,
                p: item.p,
                adjustedP: item.adjustedP,
                minimumAchievableP: item.minimumAchievableP,
                verdict: item.verdict,
              },
            ]
          : [];
      }),
      classes: pair.classes,
      patterns: pair.patterns.map((item) => ({
        family: item.family,
        key: item.key,
        model: item.model,
        other: item.other,
        direction: item.direction,
        p: item.p,
        adjustedP: item.adjustedP,
        minimumAchievableP: item.minimumAchievableP,
        verdict: item.verdict,
      })),
    };
  };
  return {
    outcomeRuleHash: report.outcomeRule.hash,
    alpha: report.alpha,
    models: report.models.map((model) => ({
      model: model.modelName,
      toolSet: model.harnessTitle,
      builds: model.builds,
      judgeFamily: model.judgeFamily,
      patterns: {
        builds: model.patterns.builds,
        recordedBuilds: model.patterns.recordedBuilds,
        stops: model.patterns.stops.map(pattern),
        gateFailures: model.patterns.gateFailures.map(pattern),
        failedToolCalls: model.patterns.failedToolCalls.map(pattern),
        refusedBatches: pattern(model.patterns.refusedBatches),
        causes: model.patterns.causes.map(pattern),
        lint: {
          codes: model.patterns.lint.codes.map(pattern),
          analyzed: model.patterns.lint.analyzed,
          unanalyzed: model.patterns.lint.unanalyzed,
        },
        scriptErrors: {
          build: pattern(model.patterns.scriptErrors.build),
          unknown: pattern(model.patterns.scriptErrors.unknown),
          measured: model.patterns.scriptErrors.measured,
          unmeasured: model.patterns.scriptErrors.unmeasured,
        },
      },
    })),
    modelPairs: report.modelPairs.map(exportPair),
    toolSetPairs: report.toolSetPairs.map(exportPair),
  };
}

export interface RunExportReport {
  schema: "basalt-evals/run-export";
  scope: ExportScope;
  runId: string;
  title: string;
  exportedAt: string;
  chargedUsd: number;
  pendingUsd: number;
  evaluations: Array<{
    title: string | null;
    stage: { index: number; count: number };
    criteria: Array<{ number: number; required: boolean; statement?: string; scale?: string }>;
    columns: Array<{
      model: string;
      toolSet: string;
      builds: Array<{
        number: number;
        subjectId: string;
        answers: Array<{
          criterion: number;
          observation: number;
          answer: ExportAnswer;
          score: number | null;
          /** Present when two or more judge samples gave the answer. */
          samples?: { met: number; of: number };
          reason?: string;
          frames?: string[];
        }>;
        charge: { builderUsd: number | null; judgeUsd: number | null; pendingUsd: number };
        buildMs: number | null;
        parentSubjectId: string | null;
        notReached: boolean;
        history: {
          turns: number;
          toolCalls: number;
          changes: number;
          unverifiedChanges: number;
          finished: boolean;
          trajectory: string;
        } | null;
      }>;
    }>;
  }>;
  models: ExportModels;
  notes: string[];
}

export interface ComparisonExportReport {
  schema: "basalt-evals/comparison-export";
  scope: ExportScope;
  comparisonId: string;
  title: string;
  exportedAt: string;
  compatibility: RunComparison["compatibility"];
  runs: Array<{
    number: number;
    operationId: string;
    kind: "execution" | "assessment";
    title: string;
    models: string;
    judge: string;
    excludedAnswers: number;
    builds: number;
    observations: number;
    chargedUsd: number;
    pendingUsd: number;
    toolCalls: number | null;
    buildMs: number | null;
    conditions: unknown;
  }>;
  pairs: Array<{
    runs: [number, number];
    compatibility: RunComparison["compatibility"];
    pairing: "unpaired" | "same_retained_evidence";
    reasons: string[];
  }>;
  evaluations: Array<{
    title: string | null;
    criteria: Array<{
      number: number;
      statement?: string;
      scale?: string;
      runs: Array<{
        run: number;
        planned: number;
        met: number;
        rejected: number;
        split: number;
        scored: number;
        /** The judge answered "not enough evidence". It is an answer, not an absent result. */
        insufficient: number;
        unavailable: number;
        marks: Array<{
          build: number;
          observation: number;
          answer: ExportAnswer;
          score: number | null;
        }>;
      }>;
    }>;
  }>;
  notes: string[];
}

const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
export const answerOf = (outcome: string): ExportAnswer =>
  outcome === "met"
    ? "met"
    : outcome === "rejected"
      ? "not_met"
      : outcome === "split"
        ? "split"
        : outcome === "scored"
          ? "scored"
          : outcome === "insufficient"
            ? "not_enough_evidence"
            : "missing";

const scopeNotes = (scope: ExportScope) => [
  scope === "public"
    ? "Public export: criteria have numbers in their authored order. The export has no criterion text, scales, judge reasons or images."
    : "Private export: the export has the private criteria, the scales, the judge reasons and the images of development observations. Share it only with people who may read the private criteria.",
  "Basalt never exports images of withheld observations, screen recordings, judge requests or request bodies.",
];

/** Add the manifest: the SHA-256 and the size of each file. */
export function withManifest(
  files: ExportFile[],
  scope: ExportScope,
  kind: ExportManifest["kind"],
  id: string,
): ExportFile[] {
  const listed = files.map((file) => ({
    path: file.path,
    sha256: contentHash(file.bytes),
    bytes: file.bytes.length,
  }));
  const body = { schema: "basalt-evals/export-manifest" as const, scope, kind, id, files: listed };
  const manifest: ExportManifest = { ...body, manifestHash: contentHash(stableJson(body)) };
  return [...files, { path: "manifest.json", bytes: json(manifest) }];
}

/** The files of a run export: index.html, report.json, frames, trajectories and the manifest. */
export function runExportFiles(input: RunExportInput, scope: ExportScope): ExportFile[] {
  const frames: ExportFile[] = [];
  const histories = new Map(input.histories.map((item) => [item.subjectId, item]));
  const report: RunExportReport = {
    schema: "basalt-evals/run-export",
    scope,
    runId: input.runId,
    title: input.title,
    exportedAt: input.exportedAt,
    chargedUsd: input.chargedUsd,
    pendingUsd: input.pendingUsd,
    evaluations: input.evaluations.map((evaluation) => {
      const numbers = new Map(
        evaluation.criteria.map((criterion, index) => [criterion.criterionId, index + 1]),
      );
      return {
        title: evaluation.title,
        stage: evaluation.stage,
        criteria: evaluation.criteria.map((criterion, index) => ({
          number: index + 1,
          required: criterion.required,
          ...(scope === "private"
            ? {
                statement: criterion.statement,
                ...(criterion.scale === null ? {} : { scale: criterion.scale }),
              }
            : {}),
        })),
        columns: input.columns.map((column) => ({
          model: column.model,
          toolSet: column.toolSet,
          builds: (
            column.cases.find((item) => item.evaluationId === evaluation.evaluationId)?.builds ?? []
          ).map((build) => {
            const saved = histories.get(build.subjectId);
            return {
              number: build.number,
              subjectId: build.subjectId,
              answers: build.marks.flatMap((mark) => {
                const criterion = numbers.get(mark.criterionId);
                // A planned answer of a criterion without a saved statement keeps its number.
                if (criterion === undefined) return [];
                const paths =
                  scope === "private" && !mark.withheld
                    ? mark.frames.map((frame) => {
                        const path = `frames/${frame.path}`;
                        if (!frames.some((item) => item.path === path))
                          frames.push({ path, bytes: frame.bytes });
                        return path;
                      })
                    : [];
                return [
                  {
                    criterion,
                    observation: mark.pass,
                    answer: answerOf(mark.outcome),
                    score: mark.score,
                    ...(mark.samples && mark.samples.of > 1 ? { samples: mark.samples } : {}),
                    ...(scope === "private" && mark.reason !== null ? { reason: mark.reason } : {}),
                    ...(paths.length ? { frames: paths } : {}),
                  },
                ];
              }),
              charge: build.charge,
              buildMs: build.buildMs,
              parentSubjectId: build.parentSubjectId,
              notReached: build.notReached,
              history: saved
                ? {
                    turns: saved.history.totals.turns,
                    toolCalls: saved.history.totals.toolCalls,
                    changes: saved.history.totals.changes,
                    unverifiedChanges: saved.history.totals.unverifiedChanges,
                    finished: saved.history.finished,
                    trajectory: `atif/${build.subjectId}/agent/trajectory.json`,
                  }
                : null,
            };
          }),
        })),
      };
    }),
    models: exportModels(input.models, input.evaluations),
    notes: scopeNotes(scope),
  };
  const trajectories = input.histories.map((item) => ({
    path: `atif/${item.subjectId}/agent/trajectory.json`,
    bytes: json(atifTrajectory(item.history, item.atif)),
  }));
  return withManifest(
    [
      { path: "index.html", bytes: encoder.encode(runReportHtml(report)) },
      { path: "report.json", bytes: json(report) },
      ...frames,
      ...trajectories,
    ],
    scope,
    "run",
    input.runId,
  );
}

interface ComparisonExportInput {
  comparison: RunComparison;
  grid: ComparisonGrid;
  exportedAt: string;
  /** The display name of each model ID. */
  models: Record<string, string>;
}

/** The files of a comparison export: index.html, report.json and the manifest. */
export function comparisonExportFiles(
  input: ComparisonExportInput,
  scope: ExportScope,
): ExportFile[] {
  const { comparison } = input;
  const number = (operationId: string) =>
    comparison.populations.findIndex((item) => item.operationId === operationId) + 1;
  const titles = [...new Set(comparison.populations.map((item) => item.title))];
  const report: ComparisonExportReport = {
    schema: "basalt-evals/comparison-export",
    scope,
    comparisonId: comparison.id,
    title:
      titles.length === 1
        ? `${titles[0]}: ${comparison.populations.length} runs`
        : titles.join(" ↔ "),
    exportedAt: input.exportedAt,
    compatibility: comparison.compatibility,
    runs: comparison.populations.map((population, index) => ({
      number: index + 1,
      operationId: population.operationId,
      kind: population.kind,
      title: population.title,
      models:
        (population.conditions.builders as Array<{ model: string }>)
          .map((item) => input.models[item.model] ?? item.model)
          .join(", ") || "Saved build",
      judge: String(population.conditions.gradingStream),
      excludedAnswers:
        comparison.scope.find((item) => item.operationId === population.operationId)
          ?.decisionsExcluded ?? 0,
      builds: population.independentBuilds,
      observations: population.captures,
      chargedUsd: population.billedUsd,
      pendingUsd: population.reservedUsd,
      toolCalls: population.toolCalls,
      buildMs: population.elapsedMs,
      conditions: population.conditions,
    })),
    pairs: comparison.pairs.map((pair) => ({
      runs: [number(pair.left), number(pair.right)],
      compatibility: pair.compatibility,
      pairing: pair.pairing,
      reasons: pair.reasons,
    })),
    evaluations: input.grid.evaluations.map((evaluation) => ({
      title: evaluation.title,
      criteria: evaluation.rows.map((row, index) => ({
        number: index + 1,
        ...(scope === "private"
          ? { statement: row.statement, ...(row.scale === null ? {} : { scale: row.scale }) }
          : {}),
        runs: row.cells.map((cell) => ({
          run: number(cell.operationId),
          planned: cell.planned,
          met: cell.met,
          rejected: cell.rejected,
          split: cell.split,
          scored: cell.scored,
          insufficient: cell.insufficient,
          unavailable: cell.unavailable,
          marks: cell.builds.flatMap((build) =>
            build.marks.map((mark) => ({
              build: build.number,
              observation: mark.pass,
              answer: mark.outcome === "incomplete" ? "missing" : answerOf(mark.outcome),
              score: mark.score,
            })),
          ),
        })),
      })),
    })),
    notes: scopeNotes(scope),
  };
  return withManifest(
    [
      { path: "index.html", bytes: encoder.encode(comparisonReportHtml(report)) },
      { path: "report.json", bytes: json(report) },
    ],
    scope,
    "comparison",
    comparison.id,
  );
}

/** One .tar file with every export file under one folder. */
export function exportArchive(folder: string, files: ExportFile[], modifiedAt: Date): Uint8Array {
  return tarArchive(
    files.map((file) => ({ path: `${folder}/${file.path}`, bytes: file.bytes })),
    modifiedAt,
  );
}
