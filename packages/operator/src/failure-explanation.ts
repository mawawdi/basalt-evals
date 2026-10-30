import { readdir } from "node:fs/promises";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import type { BenchmarkMark } from "../../contracts/src/benchmarks.js";
import type { RunCriterionArtifact, RunOperationStatus } from "../../contracts/src/execution.js";
import { hashJson, type JsonValue } from "../../contracts/src/index.js";
import { fields } from "../../contracts/src/validation.js";
import {
  FAILURE_QUESTIONS_FILE,
  failureExplanationQuote,
  parseFailureQuestions,
  type ExplainedCriterion,
  type ExplainedObservation,
  type FailureExplanationInput,
  type FailureHypothesis,
  type FailureQuestions,
} from "../../eval-authoring/src/failure-explanation-request.js";
import { scoringCriteria } from "../../eval-authoring/src/scoring.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { explainFailures } from "../../agent-runtime/src/failure-explanation.js";
import { PreparationDispatcher } from "../../agent-runtime/src/preparation-models.js";
import { modelTreatmentIdentity } from "../../model-client/src/catalog.js";
import { DurableSpendLedger } from "../../model-client/src/ledger.js";
import { modelLimits } from "../../model-client/src/model-limits.js";
import type { RunQuote } from "../../model-client/src/quote.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { readEmptyBuildCheck } from "./empty-build-check.js";
import { bindOperationImplementation } from "./execution-guard.js";
import type { RunJudgmentArtifact } from "./judgment-artifact.js";
import { assertRegisteredModels, readModelRegistry } from "./model-registry.js";
import { operationInputHash, authorizePreparation } from "./operation-binding.js";
import { revisionPlanWarnings } from "./plan-warnings.js";
import { frozenRunRecords } from "./run-records.js";

/** The request reads the observations of at most this many builds of each flagged criterion. */
const MAX_EXPLAINED_BUILDS = 3;
const idPattern = /^[a-f0-9]{64}$/u;
const operationPattern = /^[a-z0-9][a-z0-9-]{0,80}$/u;
const directory = ".basalt-evals/authoring/failure-explanations";
const materialPath = (id: string) => `${directory}/inputs/${id}.json`;
const recordDirectory = (revisionId: string) => `${directory}/${revisionId}`;
const UNVERIFIED = "Basalt cannot verify the saved reason of this answer.";

/** Where one observation of the request comes from. The model never reads it. */
interface ExplainedObservationSource {
  criterionId: string;
  observationId: string;
  /** Null for the empty build. */
  operationId: string | null;
  subjectId: string | null;
  /** The number of the build in its run plan. Null for the empty build. */
  buildNumber: number | null;
  pass: number;
  evidenceCellId: string | null;
}

/** The frozen material of one request. The preview saves it, and the run reads it. */
interface FailureExplanationMaterial {
  schema: "basalt-evals/failure-explanation-input";
  id: string;
  revisionId: string;
  questions: Pick<FailureQuestions, "hash" | "status">;
  input: FailureExplanationInput;
  sources: ExplainedObservationSource[];
}

/** The hypotheses of one explanation. They never change an answer, a review or a total. */
export interface FailureExplanationRecord {
  schema: "basalt-evals/failure-explanation";
  revisionId: string;
  operationId: string;
  materialId: string;
  model: { id: string; identityHash: string };
  /** The authored questions of the request. A draft needs a review by a person. */
  questions: Pick<FailureQuestions, "hash" | "status"> & { items: FailureQuestions["questions"] };
  criteria: Array<
    Pick<ExplainedCriterion, "criterionId" | "statement" | "warnings"> & {
      observations: Array<Pick<ExplainedObservation, "id" | "build" | "answer">>;
    }
  >;
  sources: ExplainedObservationSource[];
  /** Complete only when each answer is complete. */
  state: "complete" | "incomplete";
  requestHash: string | null;
  hypotheses: FailureHypothesis[];
  reason: string | null;
}

/** The deterministic seed of the requests of a revision. */
const seedOf = (revisionId: string) => Number.parseInt(revisionId.slice(0, 8), 16);

/** The reasons that the saved answers of one mark give, after Basalt checks their hashes. */
async function savedReasons(
  root: string,
  status: RunOperationStatus,
  mark: BenchmarkMark,
): Promise<string[]> {
  if (mark.outcome === "missing") return [];
  const files = new RepositoryFiles(root);
  const base = `.basalt-evals/eval-operations/${status.manifest.id}`;
  const bound = (stage: "grading" | "judgment", unitId: string, artifact: unknown) =>
    status.events.some(
      (event) =>
        event.kind === "completed" &&
        event.stage === stage &&
        event.unitId === unitId &&
        event.artifactHashes[0] === hashJson(artifact),
    );
  const cell = status.manifest.gradingCells.find((item) => item.id === mark.evidenceCellId);
  if (cell) {
    const artifact = await files.json<RunCriterionArtifact>(
      `${base}/grading/${cell.id}/result.json`,
    );
    return [bound("grading", cell.id, artifact) ? artifact.criterion.explanation : UNVERIFIED];
  }
  const groupId = mark.evidenceCellId.slice(0, -(mark.criterionId.length + 1));
  const reasons: string[] = [];
  for (const batch of status.manifest.judgmentBatches
    .filter((item) => item.sampleGroupId === groupId)
    .sort((a, b) => a.sample - b.sample)) {
    const artifact = await files.optional<RunJudgmentArtifact>(
      `${base}/judgments/${batch.id}.json`,
    );
    const decision = artifact?.decisions.find((item) => item.criterionId === mark.criterionId);
    reasons.push(
      `Sample ${batch.sample}: ${
        !artifact || !decision
          ? "no saved answer."
          : !bound("judgment", batch.id, artifact)
            ? UNVERIFIED
            : `${decision.answer}. ${decision.rationale}`
      }`,
    );
  }
  return reasons;
}

/**
 * Collect the material of one request: the flagged criteria of an evaluation version, with the
 * plan, the private check and the observations of two or three builds of each criterion. A
 * criterion that passes on the empty build also gets the observation of the empty build.
 */
async function failureExplanationMaterial(
  root: string,
  revisionId: string,
): Promise<FailureExplanationMaterial> {
  if (!idPattern.test(revisionId)) throw new Error("Invalid evaluation ID");
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(revisionId);
  const files = new RepositoryFiles(root);
  const questions = parseFailureQuestions(
    (await files.bytes(FAILURE_QUESTIONS_FILE)).toString("utf8"),
  );
  const runRecords = frozenRunRecords(root);
  const collected = await revisionPlanWarnings(root, revisionId, runRecords);
  const checks = [
    ...revision.privateEvaluator.deterministic,
    ...revision.privateEvaluator.codeQuality,
    ...revision.privateEvaluator.visual,
    ...revision.privateEvaluator.unscaled,
  ];
  const flagged = [...new Set(collected.warnings.map((warning) => warning.criterionId))].filter(
    (id) => checks.some((check) => check.id === id),
  );
  if (!flagged.length) throw new Error("This evaluation has no plan warnings to explain.");
  const empty = await readEmptyBuildCheck(root, revisionId);
  const criteria: ExplainedCriterion[] = [];
  const sources: ExplainedObservationSource[] = [];
  for (const criterionId of flagged) {
    const [scoring] = scoringCriteria(revision, [criterionId]);
    const warnings = collected.warnings
      .filter((warning) => warning.criterionId === criterionId)
      .map((warning) => warning.kind);
    const observations: ExplainedObservation[] = [];
    const emptyResult = empty?.results.find((result) => result.criterionId === criterionId);
    if (warnings.includes("passes_empty_build") && empty?.state === "complete" && emptyResult) {
      observations.push({
        id: "empty-o1",
        build: "Empty build",
        answer: emptyResult.outcome === "verified" ? "met" : "rejected",
        observed: emptyResult.observed,
        reasons: [emptyResult.explanation],
      });
      sources.push({
        criterionId,
        observationId: "empty-o1",
        operationId: null,
        subjectId: null,
        buildNumber: null,
        pass: 1,
        evidenceCellId: null,
      });
    }
    // Builds with an answer in each observation come first. Each run keeps its build order.
    const marked = collected.builds
      .map((build) => ({
        build,
        marks: build.marks
          .filter((mark) => mark.criterionId === criterionId)
          .sort((a, b) => a.pass - b.pass),
      }))
      .filter((item) => item.marks.length);
    const answered = (item: (typeof marked)[number]) =>
      item.marks.every((mark) => mark.outcome !== "missing");
    const chosen = [...marked.filter(answered), ...marked.filter((item) => !answered(item))].slice(
      0,
      MAX_EXPLAINED_BUILDS,
    );
    for (const [index, { build, marks }] of chosen.entries())
      for (const mark of marks) {
        const id = `b${index + 1}-o${mark.pass}`;
        observations.push({
          id,
          build: `Build ${index + 1}`,
          answer: mark.outcome,
          observed: mark.observed,
          reasons: await savedReasons(root, (await runRecords(build.operationId)).status, mark),
        });
        sources.push({
          criterionId,
          observationId: id,
          operationId: build.operationId,
          subjectId: build.subjectId,
          buildNumber: build.number,
          pass: mark.pass,
          evidenceCellId: mark.evidenceCellId,
        });
      }
    criteria.push({
      criterionId,
      statement: scoring!.statement,
      authoredPassages: scoring!.authoredPassages,
      required: scoring!.required,
      polarity: scoring!.polarity,
      evidenceClass: scoring!.evidenceClass,
      check: checks.find((check) => check.id === criterionId) as unknown as JsonValue,
      warnings,
      observations,
    });
  }
  const body = {
    schema: "basalt-evals/failure-explanation-input" as const,
    revisionId,
    questions: { hash: questions.hash, status: questions.status },
    input: {
      questions: questions.questions,
      builderPrompt: revision.authored.builderPrompt,
      publicRoles: revision.publicTask.roles as unknown as JsonValue,
      plan: {
        studio: revision.privateEvaluator.studio,
        sequence: revision.privateEvaluator.sequence,
      } as unknown as JsonValue,
      criteria,
    },
    sources,
  };
  return { ...body, id: hashJson(body) };
}

/** Read the frozen material of one request. */
export async function readFailureExplanationMaterial(
  root: string,
  id: string,
): Promise<FailureExplanationMaterial> {
  if (!idPattern.test(id)) throw new Error("Invalid explanation input ID");
  const material = await new RepositoryFiles(root).json<FailureExplanationMaterial>(
    materialPath(id),
  );
  const { id: savedId, ...body } = material;
  if (
    material.schema !== "basalt-evals/failure-explanation-input" ||
    savedId !== id ||
    hashJson(body) !== id
  )
    throw new Error("The saved input of the explanation changed.");
  return material;
}

/**
 * The free preview of one explanation. It freezes the material and the exact quote of its one
 * request. A later run, or a change to the questions, needs a new preview.
 */
export async function quoteFailureExplanation(
  root: string,
  value: unknown,
  adapters: ExecutionAdapters = liveExecutionAdapters,
): Promise<RunQuote> {
  const selection = fields(value, ["revisionId", "modelId"], "Explain failures") as {
    revisionId: string;
    modelId: string;
  };
  if (!idPattern.test(selection.revisionId) || typeof selection.modelId !== "string")
    throw new Error("Invalid explanation selection");
  assertRegisteredModels(await readModelRegistry(root), [selection.modelId]);
  const material = await failureExplanationMaterial(root, selection.revisionId);
  const [model] = await adapters.catalog([{ id: selection.modelId, requirement: { tools: true } }]);
  if (!model) throw new Error("The explanation model is not in the catalog.");
  const quote = failureExplanationQuote(
    material.input,
    model,
    seedOf(selection.revisionId),
    material.id,
  );
  const files = new RepositoryFiles(root);
  await files.writeJsonOnce(materialPath(material.id), material);
  await files.writeJsonOnce(`.basalt-evals/eval-quotes/${quote.id}.json`, quote);
  return quote;
}

/** Read a saved explanation quote and verify its hash. */
async function readExplanationQuote(root: string, quoteId: string): Promise<RunQuote> {
  if (!idPattern.test(quoteId)) throw new Error("Invalid explanation quote ID");
  const quote = await new RepositoryFiles(root).json<RunQuote>(
    `.basalt-evals/eval-quotes/${quoteId}.json`,
  );
  const { id: _id, ...body } = quote;
  if (
    quote.id !== quoteId ||
    hashJson(body) !== quote.id ||
    quote.models.length !== 1 ||
    quote.workload.modelWork.some((work) => work.stage !== "explanation")
  )
    throw new Error("The explanation quote does not bind one explanation request.");
  return quote;
}

/** The evaluation version of the frozen material of an explanation quote. */
export async function explanationRevision(root: string, quoteId: string): Promise<string> {
  const quote = await readExplanationQuote(root, quoteId);
  return (await readFailureExplanationMaterial(root, quote.subjectId ?? "")).revisionId;
}

/**
 * Send the one quoted request of an explanation and save its hypotheses. A small spending limit
 * or a stop leaves a resumable interruption. The hypotheses never change an answer.
 */
export async function runFailureExplanation(input: {
  root: string;
  revisionId: string;
  operationId: string;
  quoteId: string;
  ceilingUsd: number;
  signal?: AbortSignal;
  adapters?: ExecutionAdapters;
}): Promise<{
  record: FailureExplanationRecord | null;
  interrupted: string | null;
  spending: Awaited<ReturnType<DurableSpendLedger["read"]>>;
}> {
  if (
    !idPattern.test(input.revisionId) ||
    !idPattern.test(input.quoteId) ||
    !operationPattern.test(input.operationId) ||
    !Number.isFinite(input.ceilingUsd) ||
    input.ceilingUsd < 0
  )
    throw new Error("Invalid quoted explanation");
  const files = new RepositoryFiles(input.root);
  const quote = await readExplanationQuote(input.root, input.quoteId);
  const material = await readFailureExplanationMaterial(input.root, quote.subjectId ?? "");
  const model = quote.models[0]!;
  if (
    material.revisionId !== input.revisionId ||
    hashJson(
      failureExplanationQuote(material.input, model, seedOf(input.revisionId), material.id)
        .workload,
    ) !== hashJson(quote.workload)
  )
    throw new Error("The explanation request differs from its preview. Make a new preview.");
  const revision = await new EvalDefinitionStore(input.root).readExecutableRevision(
    input.revisionId,
  );
  const context = hashJson({
    inputHash: await operationInputHash(input.root, input.operationId, revision.draftId),
  });
  const ledger = new DurableSpendLedger(input.root, input.operationId, context);
  await authorizePreparation(input.root, ledger, {
    quoteHash: hashJson(quote),
    ceilingUsd: input.ceilingUsd,
  });
  const file = `${recordDirectory(input.revisionId)}/${input.operationId}.json`;
  const saved = await files.optional<FailureExplanationRecord>(file);
  if (saved) return { record: saved, interrupted: null, spending: await ledger.read() };
  try {
    const guard = await bindOperationImplementation(input.root, input.operationId, context);
    const adapters = input.adapters ?? liveExecutionAdapters;
    const result = await explainFailures({
      dispatcher: new PreparationDispatcher(
        adapters.model(quote.models),
        ledger,
        quote.models,
        guard,
        input.signal,
      ),
      model: { id: model.id, maxOutputTokens: modelLimits(model).maxOutputTokens },
      seed: seedOf(input.revisionId),
      material: material.input,
    });
    input.signal?.throwIfAborted();
    const record: FailureExplanationRecord = {
      schema: "basalt-evals/failure-explanation",
      revisionId: input.revisionId,
      operationId: input.operationId,
      materialId: material.id,
      model: { id: model.id, identityHash: hashJson(modelTreatmentIdentity(model)) },
      questions: { ...material.questions, items: material.input.questions },
      criteria: material.input.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        statement: criterion.statement,
        warnings: criterion.warnings,
        observations: criterion.observations.map(({ id, build, answer }) => ({
          id,
          build,
          answer,
        })),
      })),
      sources: material.sources,
      ...result,
    };
    await files.writeJsonOnce(file, record);
    return { record, interrupted: null, spending: await ledger.read() };
  } catch (error) {
    return {
      record: null,
      interrupted: error instanceof Error ? error.message : String(error),
      spending: await ledger.read(),
    };
  }
}

/** The saved explanations of one evaluation version, one for each explanation run. */
export async function readFailureExplanations(
  root: string,
  revisionId: string,
): Promise<FailureExplanationRecord[]> {
  if (!idPattern.test(revisionId)) throw new Error("Invalid evaluation ID");
  const files = new RepositoryFiles(root);
  const names = await readdir(files.path(recordDirectory(revisionId))).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const records = await Promise.all(
    names
      .filter((name) => /^[a-z0-9][a-z0-9-]{0,80}\.json$/u.test(name))
      .sort()
      .map((name) =>
        files.json<FailureExplanationRecord>(`${recordDirectory(revisionId)}/${name}`),
      ),
  );
  for (const record of records)
    if (record.schema !== "basalt-evals/failure-explanation" || record.revisionId !== revisionId)
      throw new Error("A saved explanation does not match its evaluation");
  return records;
}
