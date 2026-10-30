import {
  compareCodeUnits,
  stableJson,
  type AgentRun,
  type EvidenceClass,
} from "../../contracts/src/index.js";
import { DIAGNOSTIC_CHANNEL_LIMIT } from "../../contracts/src/capabilities.js";
import type { ScriptErrorCounts, SourceLintCounts } from "../../contracts/src/source-analysis.js";
import { atifTrajectory } from "./atif.js";
import {
  answerOf,
  withManifest,
  type ExportAnswer,
  type ExportFile,
  type ExportScope,
  type RunExportInput,
} from "./export.js";

type ExportBuild = RunExportInput["columns"][number]["cases"][number]["builds"][number];

/**
 * The stored source analysis of the sealed code of a build. `counts` has the findings of each
 * lint code of a complete analysis. It is null when the analysis is unavailable or absent.
 */
export type DatasetLint =
  | { status: "complete"; counts: SourceLintCounts }
  | { status: "unavailable" | "absent"; counts: null };

/** One file of the sealed code of a build, with its UTF-8 text. */
export interface DatasetSourceFile {
  path: string;
  sha256: string;
  content: string;
}

/** The complete records of a dataset export. The scope decides what goes into the files. */
export interface DatasetExportInput {
  runId: string;
  title: string;
  evaluations: Array<{
    /** The revision of stage 1. The library knows the evaluation by it. */
    evaluationId: string;
    /** The revision of this stage. The run plan knows the evaluation by it. */
    revisionId: string;
    title: string;
    stage: { index: number; count: number };
    /** The authored public prompt of this stage. */
    prompt: string;
    criteria: Array<{
      criterionId: string;
      statement: string;
      required: boolean;
      evidenceClass: EvidenceClass | null;
    }>;
  }>;
  builds: Array<{
    revisionId: string;
    model: { id: string; revision: string };
    harness: string;
    number: number;
    subjectId: string;
    parentSubjectId: string | null;
    notReached: boolean;
    /** The builder finished and its code passed the local gate. */
    delivered: boolean;
    stopReason: AgentRun["stopReason"] | null;
    source: DatasetSourceFile[] | null;
    marks: Array<
      Pick<
        ExportBuild["marks"][number],
        "criterionId" | "pass" | "outcome" | "score" | "samples" | "reason"
      >
    >;
    charge: ExportBuild["charge"];
    buildMs: number | null;
    lint: DatasetLint;
    /** The distinct script errors of the observations of the build, by origin, or null. */
    buildErrors: ScriptErrorCounts | null;
  }>;
  histories: RunExportInput["histories"];
}

/** One answer of a build: one criterion in one observation. */
export interface DatasetAnswer {
  criterion: number;
  observation: number;
  answer: ExportAnswer;
  score: number | null;
  /** The judge samples of a combined answer. Null for one sample and for a code check. */
  samples: { met: number; of: number } | null;
  required: boolean;
  evidenceClass: EvidenceClass | null;
  /** The criterion statement. Only the private scope has it. */
  statement?: string;
  /** The judge reason. Only the private scope has it. Null when the answer has no reason. */
  reason?: string | null;
}

/** One line of `builds.jsonl`: one build of the run. */
export interface DatasetBuild {
  schema: "basalt-evals/dataset-build";
  runId: string;
  evaluation: {
    id: string;
    revisionId: string;
    title: string;
    stage: { index: number; count: number };
  };
  prompt: string;
  model: { id: string; revision: string };
  harness: string;
  buildNumber: number;
  subjectId: string;
  parentSubjectId: string | null;
  notReached: boolean;
  delivered: boolean;
  stopReason: AgentRun["stopReason"] | null;
  trajectory: string | null;
  source: DatasetSourceFile[] | null;
  answers: DatasetAnswer[];
  charge: ExportBuild["charge"];
  buildMs: number | null;
  lint: DatasetLint;
  /**
   * The distinct script errors of the observations, by origin, with `truncated`. Null when the
   * build has no complete analysis or no observation with a diagnostics fact.
   */
  buildErrors: ScriptErrorCounts | null;
}

/** The description of the dataset in `dataset.json`. */
export interface DatasetDescription {
  schema: "basalt-evals/dataset";
  scope: ExportScope;
  runId: string;
  title: string;
  file: "builds.jsonl";
  lineSchema: DatasetBuild["schema"];
  builds: number;
  order: string;
  fields: Record<string, string>;
  answers: Record<ExportAnswer, string>;
  rules: string[];
}

const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
const trajectoryPath = (subjectId: string) => `atif/${subjectId}/agent/trajectory.json`;

const FIELDS: DatasetDescription["fields"] = {
  runId: "The run of the build.",
  evaluation:
    "The evaluation. id is the revision of stage 1, which the library uses. revisionId is the revision of this stage.",
  prompt:
    "The authored public prompt of this stage. Step 2 of the trajectory has the exact first message to the builder.",
  model: "The model ID on the provider request and its frozen catalog revision.",
  harness: "The ID of the frozen tool set.",
  buildNumber: 'The number of the build in the run plan, the same as "Build n" in the console.',
  subjectId: "The ID of the build in the run.",
  parentSubjectId: "The build of the stage before that this build continues, or null.",
  notReached:
    "True when the run did not reach the stage of this build, so the build never started.",
  delivered:
    "True when the builder finished and its code passed the local gate. Only a delivered build goes on to the observations.",
  stopReason:
    "Why the builder stopped, for example finished or turn_limit. Null when Basalt saved no result of the builder.",
  trajectory:
    "The path of the ATIF-v1.7 trajectory of the build in this folder. Null when the build has no saved turns.",
  source:
    "Every file of the sealed code of the build in path order, with its SHA-256 and its UTF-8 text. Null when the build sealed no code.",
  answers: "One answer for each planned criterion in each observation of the build.",
  charge: "The builder charge, the judge charge and the pending charge in USD. Null is unrecorded.",
  buildMs: "The active time of the build stage in milliseconds. Null is unrecorded.",
  lint: "The stored luau-lsp analysis of the sealed code. status is complete, unavailable or absent. counts has the number of findings of each lint code of a complete analysis; a code without a finding has no key. counts is null for any other status, which is not zero findings.",
  buildErrors: `The script errors that Studio recorded in the observations, by origin: build is a script of the sealed code, external is a script outside the place and unknown is any other. Each Studio context keeps one growing list of errors, so each error counts one time: the diagnostics fact with the most records of each context, added over the contexts and the observations. truncated is true when the list of a context reached its limit of ${DIAGNOSTIC_CHANNEL_LIMIT} errors, so Studio recorded more errors than the counts. Null when the build has no complete analysis or no diagnostics fact.`,
};

const ANSWERS: DatasetDescription["answers"] = {
  met: "The build meets the criterion in this observation.",
  not_met: "The build does not meet the criterion in this observation.",
  split: "The judge samples disagree. samples gives the number of samples that say met.",
  scored: "The criterion has a scale. score has the value.",
  not_enough_evidence: "The check found that the evidence cannot decide the criterion.",
  missing: "The run saved no answer for this criterion in this observation.",
};

const scopeRule = (scope: ExportScope) =>
  scope === "public"
    ? "Public dataset: criteria have numbers in their authored order. The dataset has no criterion IDs, criterion text, judge reasons or images."
    : "Private dataset: each answer has the criterion statement and the judge reason. Share it only with people who may read the private criteria.";

/**
 * The files of a dataset export: builds.jsonl with one line for each build, dataset.json,
 * the trajectories and the manifest. The same run and scope give the same bytes.
 */
export function datasetExportFiles(input: DatasetExportInput, scope: ExportScope): ExportFile[] {
  const evaluations = new Map(
    input.evaluations.map((evaluation, index) => [evaluation.revisionId, { evaluation, index }]),
  );
  const histories = new Map(input.histories.map((item) => [item.subjectId, item]));
  const planned = (revisionId: string) => {
    const found = evaluations.get(revisionId);
    if (!found) throw new Error("A build names an evaluation that is not in the run.");
    return found;
  };
  const builds = [...input.builds].sort(
    (left, right) =>
      planned(left.revisionId).index - planned(right.revisionId).index ||
      compareCodeUnits(left.model.id, right.model.id) ||
      compareCodeUnits(left.harness, right.harness) ||
      left.number - right.number ||
      compareCodeUnits(left.subjectId, right.subjectId),
  );
  const lines = builds.map((build): DatasetBuild => {
    const { evaluation } = planned(build.revisionId);
    const criteria = new Map(
      evaluation.criteria.map((criterion, index) => [
        criterion.criterionId,
        { criterion, number: index + 1 },
      ]),
    );
    const answers = build.marks.flatMap((mark): DatasetAnswer[] => {
      const found = criteria.get(mark.criterionId);
      // A planned answer of a criterion without a saved statement has no number.
      if (!found) return [];
      return [
        {
          criterion: found.number,
          observation: mark.pass,
          answer: answerOf(mark.outcome),
          score: mark.score,
          samples: mark.samples && mark.samples.of > 1 ? mark.samples : null,
          required: found.criterion.required,
          evidenceClass: found.criterion.evidenceClass,
          ...(scope === "private"
            ? { statement: found.criterion.statement, reason: mark.reason }
            : {}),
        },
      ];
    });
    answers.sort(
      (left, right) => left.observation - right.observation || left.criterion - right.criterion,
    );
    return {
      schema: "basalt-evals/dataset-build",
      runId: input.runId,
      evaluation: {
        id: evaluation.evaluationId,
        revisionId: evaluation.revisionId,
        title: evaluation.title,
        stage: evaluation.stage,
      },
      prompt: evaluation.prompt,
      model: build.model,
      harness: build.harness,
      buildNumber: build.number,
      subjectId: build.subjectId,
      parentSubjectId: build.parentSubjectId,
      notReached: build.notReached,
      delivered: build.delivered,
      stopReason: build.stopReason,
      trajectory: histories.has(build.subjectId) ? trajectoryPath(build.subjectId) : null,
      source: build.source,
      answers,
      charge: build.charge,
      buildMs: build.buildMs,
      lint: build.lint,
      buildErrors: build.buildErrors,
    };
  });
  const description: DatasetDescription = {
    schema: "basalt-evals/dataset",
    scope,
    runId: input.runId,
    title: input.title,
    file: "builds.jsonl",
    lineSchema: "basalt-evals/dataset-build",
    builds: lines.length,
    order:
      "One line for each build, with sorted keys. The lines follow the plan order of the evaluations, then the model ID, the tool set ID and the build number.",
    fields: FIELDS,
    answers: ANSWERS,
    rules: [
      "not_enough_evidence is not a failure. Do not count it as 0, false or not_met.",
      "missing is not a failure. Do not count it as 0, false or not_met.",
      "Each build is independent. The observations of one build are repeated measurements of the same code.",
      scopeRule(scope),
      "Basalt never exports images, screen recordings, judge requests or request bodies.",
    ],
  };
  const trajectories = [...input.histories]
    .sort((left, right) => compareCodeUnits(left.subjectId, right.subjectId))
    .map((item) => ({
      path: trajectoryPath(item.subjectId),
      bytes: json(atifTrajectory(item.history, item.atif)),
    }));
  return withManifest(
    [
      { path: "dataset.json", bytes: json(description) },
      {
        path: "builds.jsonl",
        bytes: encoder.encode(lines.map((line) => `${stableJson(line)}\n`).join("")),
      },
      ...trajectories,
    ],
    scope,
    "dataset",
    input.runId,
  );
}
