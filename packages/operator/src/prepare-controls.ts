import { operationInputHash, preparationPath, authorizePreparation } from "./operation-binding.js";
import { requiresImages } from "../../eval-authoring/src/rendered-selection.js";
import { modelRoute } from "../../model-client/src/catalog.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { executeEvalControlSource } from "./control-execution.js";
import {
  ModelControlProposer,
  prepareControlCases,
  type ControlPreparationResult,
  type ControlSourceFile,
  type RetainedControlAttempt,
} from "../../agent-runtime/src/control-generation.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inventoryTree } from "../../artifact-store/src/inventory.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { judgeControlSource } from "../../agent-runtime/src/control-judging.js";
import { hashJson, validRubricScore, type CriterionResult } from "../../contracts/src/index.js";
import {
  checkEvalControls,
  assertUnattendedEvalRevision,
  EvalDefinitionStore,
  gateCheckIds,
  quoteControlPreparation,
  checkedStageRecord,
  type EvalControlSet,
  type EvalRevision,
} from "../../eval-authoring/src/index.js";
import { projectRegisteredEvaluation } from "../../eval-authoring/src/catalog.js";
import { registerStages } from "../../eval-authoring/src/registration.js";
import type { ModelClient } from "../../model-client/src/contracts.js";
import type { ModelSnapshot } from "../../model-client/src/catalog.js";
import { DurableSpendLedger } from "../../model-client/src/ledger.js";
import { settleSavedRejections } from "../../model-client/src/bounded-client.js";
import { type RunQuote } from "../../model-client/src/quote.js";
import { readOperatorStudy } from "./config.js";
import { bindOperationImplementation } from "./execution-guard.js";
import { cleanImplementationCommit } from "../../artifact-store/src/implementation.js";
import {
  defaultPreparationModel,
  readModelRegistry,
  assertRegisteredModels,
} from "./model-registry.js";
import { registerSource } from "./sources.js";

const hashPattern = /^[a-f0-9]{64}$/u;
const operationPattern = /^[a-z0-9][a-z0-9-]{0,80}$/u;

/**
 * Read-only provider lookup; save the exact quote before accepting a ceiling. A reference test
 * covers each stage of the evaluation of `revisionId`, the revision of stage 1.
 */
export async function quoteEvalControls(
  root: string,
  revisionId: string,
  gradingModelId: string,
  adapters: ExecutionAdapters = liveExecutionAdapters,
): Promise<RunQuote> {
  if (!hashPattern.test(revisionId)) throw new Error("Invalid eval revision identity");
  // The preparation model of the defaults writes the builds of a reference test.
  const registry = await readModelRegistry(root);
  const controlModelId = defaultPreparationModel(registry);
  assertRegisteredModels(registry, [gradingModelId]);
  const stages = await new EvalDefinitionStore(root).readStageRevisions(revisionId, true);
  for (const stage of stages) assertUnattendedEvalRevision(stage);
  const images = stages.some(
    (stage) =>
      stage.privateEvaluator.visual.length || stage.privateEvaluator.unscaled.some(requiresImages),
  );
  const models = await adapters.catalog(
    [...new Set([controlModelId, gradingModelId])].map((id) => ({
      id,
      requirement: { tools: true, ...(id === gradingModelId && images ? { images: true } : {}) },
    })),
  );
  const quote = quoteControlPreparation(
    stages,
    models.find((model) => model.id === controlModelId)!,
    models.find((model) => model.id === gradingModelId)!,
  );
  const files = new RepositoryFiles(root);
  const file = `.basalt-evals/eval-quotes/${quote.id}.json`;
  try {
    await files.writeJson(file, quote);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (hashJson(await files.json(file)) !== hashJson(quote))
      throw new Error("Frozen control quote identity changed");
  }
  return quote;
}

/** Continuation binds the prepared revision and all spending to the same operation. */
export async function preparedOperationSpending(input: {
  root: string;
  operationId: string;
  revisionId: string;
  draftId: string;
}): Promise<Awaited<ReturnType<DurableSpendLedger["read"]>>> {
  if (
    !operationPattern.test(input.operationId) ||
    !hashPattern.test(input.revisionId) ||
    !hashPattern.test(input.draftId)
  )
    throw new Error("Invalid prepared revision identity");
  const files = new RepositoryFiles(input.root);
  const ledger = new DurableSpendLedger(
    input.root,
    input.operationId,
    hashJson({ inputHash: await operationInputHash(input.root, input.operationId, input.draftId) }),
  );
  await settleSavedRejections(ledger);
  const preparation = await files.json<{
    schema: string;
    draftId: string;
    revisionId: string | null;
    quoteId: string;
    validation: { status: string; revisionId: string | null };
  }>(preparationPath(input.operationId, input.draftId));
  if (
    preparation.schema !== "basalt-evals/preparation-receipt" ||
    preparation.draftId !== input.draftId
  )
    throw new Error("Continuation requires the current preparation receipt in this operation");
  const spending = await ledger.read();
  const preparationQuoteHash = hashJson(
    await files.json<RunQuote>(`.basalt-evals/eval-quotes/${preparation.quoteId}.json`),
  );
  if (!spending.authorizations.some((item) => item.quoteHash === preparationQuoteHash))
    throw new Error("Preparation quote does not bind this spending operation");
  if (
    preparation.revisionId !== input.revisionId ||
    preparation.validation.status !== "ready" ||
    preparation.validation.revisionId !== input.revisionId
  )
    throw new Error("The compiled evaluation is not bound to this preparation operation");
  return spending;
}

/**
 * The reference test of one stage. A later stage starts from the checked working control of
 * the stage before, and only when that control passes each gate check of that stage.
 */
interface ReferenceStage {
  revisionId: string;
  /** False when the stage before has no checked working control that passes its gate. */
  reached: boolean;
  /** The registered working control of the stage before, or null for stage 1. */
  parentSourceId: string | null;
  /** The outcome of each gate check of the stage before on its working control. */
  gate: Array<{ criterionId: string; outcome: CriterionResult["outcome"] | "missing" }>;
  /** Null for a stage that the test did not reach. That stage sends no request. */
  result: Awaited<ReturnType<typeof prepareEvalControls>> | null;
}

/**
 * The checked working control of a stage, registered as the parent of the controls of the next
 * stage, with the outcome of each gate check of the stage on it. Null when the reference test of
 * the stage is not checked.
 */
async function workingParent(input: {
  root: string;
  revision: EvalRevision;
  batchId: string;
  parentSourceId: string | null;
}): Promise<{
  sourceId: string;
  gate: ReferenceStage["gate"];
  startingFiles: ControlSourceFile[];
} | null> {
  const check = await checkEvalControls(input.root, input.revision.id, input.batchId);
  const working = check.cases.find((item) => item.kind === "working");
  if (check.status !== "checked" || !working) return null;
  const gate: ReferenceStage["gate"] = gateCheckIds(input.revision).map((criterionId) => ({
    criterionId,
    outcome:
      working.criteria.find((item) => item.criterionId === criterionId)?.outcome ?? "missing",
  }));
  const workspace = resolve(
    input.root,
    `.basalt-evals/eval-control-runs/${input.revision.id}/${input.batchId}/${working.id}/workspace`,
  );
  const files = await inventoryTree(workspace);
  if (hashJson(files) !== working.candidateHash)
    throw new Error("The working control changed after its check");
  const source = await registerSource({
    root: input.root,
    workspace,
    candidate: {
      projectFile: input.revision.publicTask.seed.projectFile,
      files,
      rootHash: working.candidateHash,
    },
    provenance: {
      kind: "control",
      // A reference test is not a run, so the control set and the signed receipt name the source.
      evidenceHashes: [check.controlSetHash, working.receiptHash],
      originOperationId: null,
      parentSourceId: input.parentSourceId,
    },
  });
  // Each control of the next stage gets the Luau source files of the working control.
  const startingFiles = await Promise.all(
    files
      .filter((file) => /^src\/(?:server|client|shared)\/[A-Za-z0-9_./-]+\.luau?$/u.test(file.path))
      .map(async (file) => ({
        path: file.path,
        text: await readFile(resolve(workspace, file.path), "utf8"),
      })),
  );
  return { sourceId: source.id, gate, startingFiles };
}

/**
 * Execute the exact quoted control workload; a small ceiling leaves a resumable stop. The stages
 * run in stage order. When every stage is checked, the test saves the checked readiness record
 * of each stage, and the catalog shows the evaluation as checked. `validationRecordHash` is then
 * the record of stage 1, which binds the records of the later stages.
 */
export async function runQuotedEvalControls(input: {
  root: string;
  revisionId: string;
  quoteId: string;
  operationId: string;
  ceilingUsd: number;
  signal?: AbortSignal;
  adapters?: ExecutionAdapters;
}): Promise<{
  stages: ReferenceStage[];
  validationRecordHash: string | null;
  interrupted: string | null;
  spending: Awaited<ReturnType<DurableSpendLedger["read"]>>;
}> {
  if (
    !hashPattern.test(input.revisionId) ||
    !hashPattern.test(input.quoteId) ||
    !operationPattern.test(input.operationId) ||
    !Number.isFinite(input.ceilingUsd) ||
    input.ceilingUsd < 0
  )
    throw new Error("Invalid quoted control operation");
  const files = new RepositoryFiles(input.root);
  const quote = await files.json<RunQuote>(`.basalt-evals/eval-quotes/${input.quoteId}.json`);
  const { id: _id, ...body } = quote;
  if (
    quote.id !== input.quoteId ||
    hashJson(body) !== quote.id ||
    quote.subjectId !== input.revisionId ||
    !quote.models.length ||
    quote.models.length > 2 ||
    quote.workload.modelWork.some((item) => item.stage !== "controls" && item.stage !== "grading")
  )
    throw new Error("Control quote does not bind this revision and workload");
  const revisions = await new EvalDefinitionStore(input.root).readStageRevisions(
    input.revisionId,
    true,
  );
  const builder = quote.models.find((model) =>
    quote.workload.modelWork.some((work) => work.stage === "controls" && work.modelId === model.id),
  );
  const grader =
    quote.models.find((model) =>
      quote.workload.modelWork.some(
        (work) => work.stage === "grading" && work.modelId === model.id,
      ),
    ) ?? builder;
  if (!builder || !grader) throw new Error("Reference quote lacks its frozen model roles");
  if (
    hashJson(quote.workload) !==
    hashJson(quoteControlPreparation(revisions, builder, grader).workload)
  )
    throw new Error("Control quote workload differs from its executable control and grading plan");
  for (const revision of revisions) assertUnattendedEvalRevision(revision);
  const fresh = quote.models;
  const ledger = new DurableSpendLedger(
    input.root,
    input.operationId,
    hashJson({
      inputHash: await operationInputHash(input.root, input.operationId, revisions[0]!.draftId),
    }),
  );
  await authorizePreparation(input.root, ledger, {
    quoteHash: hashJson(quote),
    ceilingUsd: input.ceilingUsd,
  });
  const client = (input.adapters ?? liveExecutionAdapters).model(fresh);
  const stages: ReferenceStage[] = [];
  try {
    for (const [index, revision] of revisions.entries()) {
      const before = stages[index - 1];
      const parent =
        before?.reached && before.result?.checkStatus === "checked"
          ? await workingParent({
              root: input.root,
              revision: revisions[index - 1]!,
              batchId: before.result.batchId,
              parentSourceId: before.parentSourceId,
            })
          : null;
      const gate = parent?.gate ?? [];
      // A later stage starts only from a working control that passes each gate check.
      if (before && (!parent || gate.some((check) => check.outcome !== "verified"))) {
        stages.push({
          revisionId: revision.id,
          reached: false,
          parentSourceId: null,
          gate,
          result: null,
        });
        continue;
      }
      const result = await prepareEvalControls({
        root: input.root,
        revisionId: revision.id,
        quoteId: quote.id,
        parentSourceId: parent?.sourceId ?? null,
        startingFiles: parent?.startingFiles ?? null,
        client,
        adapters: input.adapters ?? liveExecutionAdapters,
        snapshot: fresh.find((model) => model.id === builder.id)!,
        gradingSnapshot: fresh.find((model) => model.id === grader.id)!,
        ledger,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      stages.push({
        revisionId: revision.id,
        reached: true,
        parentSourceId: parent?.sourceId ?? null,
        gate,
        result,
      });
    }
    if (stages.some((stage) => stage.result?.checkStatus !== "checked"))
      return {
        stages,
        validationRecordHash: null,
        interrupted: null,
        spending: await ledger.read(),
      };
    const registered = await registerStages(input.root, revisions, (revision) =>
      checkedStageRecord(
        input.root,
        revision.id,
        stages.find((stage) => stage.revisionId === revision.id)!.result!.batchId,
      ),
    );
    await projectRegisteredEvaluation(
      input.root,
      revisions[0]!.id,
      registered.validationRecordHash,
      true,
    );
    return {
      stages,
      validationRecordHash: registered.validationRecordHash,
      interrupted: null,
      spending: await ledger.read(),
    };
  } catch (error) {
    return {
      stages,
      validationRecordHash: null,
      interrupted: error instanceof Error ? error.message : String(error),
      spending: await ledger.read(),
    };
  }
}

/**
 * Private control preparation and check of one stage under an already quoted, initialized shared
 * ledger. Each control of a later stage starts from `parentSourceId`, whose Luau files the
 * control model gets as `startingFiles`.
 */
async function prepareEvalControls(input: {
  root: string;
  revisionId: string;
  quoteId: string;
  parentSourceId: string | null;
  startingFiles: ControlSourceFile[] | null;
  client: ModelClient;
  snapshot: ModelSnapshot;
  gradingSnapshot: ModelSnapshot;
  ledger: DurableSpendLedger;
  signal?: AbortSignal;
  adapters?: ExecutionAdapters;
}): Promise<{
  batchId: string;
  preparation: ControlPreparationResult | null;
  checkStatus: "checked" | "failed" | "incomplete" | null;
  unreviewedClaims: string[];
  validation: {
    preparation: "compiled";
    acquisition: "not_run" | "validated" | "incomplete";
    discrimination: "not_run" | "validated" | "failed" | "incomplete";
    humanCalibration: "unavailable";
  };
}> {
  if (!hashPattern.test(input.revisionId) || !hashPattern.test(input.quoteId))
    throw new Error("Invalid eval control quote identity");
  if (
    hashJson(input.client.descriptor.configuration.routing.routes?.[input.snapshot.id]) !==
    hashJson(modelRoute(input.snapshot))
  )
    throw new Error("Control model does not use the endpoint set of its quote");
  const root = resolve(input.root);
  const files = new RepositoryFiles(root);
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(input.revisionId);
  const guard = await bindOperationImplementation(
    root,
    input.ledger.operationId,
    hashJson({
      inputHash: await operationInputHash(root, input.ledger.operationId, revision.draftId),
    }),
  );
  assertUnattendedEvalRevision(revision);
  const implementationCommit = await cleanImplementationCommit(root);
  const { connectorArtifactHash } = await (input.adapters ?? liveExecutionAdapters).studio.identity(
    root,
  );
  const batchId = hashJson({
    revisionId: revision.id,
    quoteId: input.quoteId,
    implementationCommit,
    connectorArtifactHash,
  });
  const study = await readOperatorStudy(root, [`.basalt-evals/eval-staging/${revision.id}`]);
  const { studioVersion: _studioVersion, ...environment } = study.environment;
  const base = `.basalt-evals/eval-control-runs/${revision.id}/${batchId}`;
  const setFile = `${base}/set.json`;
  let preparation: ControlPreparationResult | null = null;
  const frozen = await files.optional<EvalControlSet>(setFile);
  if (frozen) {
    if (
      frozen.revisionId !== revision.id ||
      frozen.batchId !== batchId ||
      frozen.implementationCommit !== implementationCommit ||
      frozen.connectorArtifactHash !== connectorArtifactHash
    )
      throw new Error("Frozen controls belong to a different implementation or connector");
  } else {
    const proposer = new ModelControlProposer(
      input.client,
      input.ledger,
      input.snapshot,
      Number.parseInt(revision.id.slice(0, 8), 16),
      batchId,
      guard,
      input.signal,
    );
    const recordAttempt = async (attempt: RetainedControlAttempt) => {
      const file = `${base}/attempts/${attempt.id}.json`;
      try {
        await files.writeJson(file, attempt);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const prior = await files.json<RetainedControlAttempt>(file);
        if (hashJson(prior) === hashJson(attempt)) return;
        if (
          prior.id !== attempt.id ||
          prior.kind !== attempt.kind ||
          prior.targetCriterionId !== attempt.targetCriterionId ||
          prior.attempt !== attempt.attempt ||
          prior.sourceHash !== null ||
          prior.result.candidateHash !== null ||
          prior.result.diagnostics[0] !==
            "Control generator returned an invalid contrast expectation" ||
          attempt.sourceHash === null
        )
          throw new Error("Retained control attempt changed during resume");
        const recoveredFile = `${base}/attempts/${attempt.id}-recovered.json`;
        try {
          await files.writeJson(recoveredFile, { priorHash: hashJson(prior), attempt });
        } catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code !== "EEXIST") throw recoveryError;
          if (
            hashJson(await files.json(recoveredFile)) !==
            hashJson({ priorHash: hashJson(prior), attempt })
          )
            throw new Error("Recovered control attempt changed during resume");
        }
      }
    };
    preparation = await prepareControlCases({
      revision,
      startingFiles: input.startingFiles,
      batchId,
      implementationCommit,
      connectorArtifactHash,
      propose: proposer.propose.bind(proposer),
      verify: async (source) => {
        await guard();
        const acquired = await executeEvalControlSource({
          root,
          revisionId: revision.id,
          batchId,
          source,
          parentSourceId: input.parentSourceId,
          implementationCommit,
          connectorArtifactHash,
          environment,
          studio: (input.adapters ?? liveExecutionAdapters).studio,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!acquired.accepted) return acquired;
        await guard();
        const judgments = await judgeControlSource({
          root,
          base: `.basalt-evals/eval-control-runs/${revision.id}/${batchId}/${source.id}`,
          revision,
          client: input.client,
          ledger: input.ledger,
          snapshot: input.gradingSnapshot,
          beforeRequest: guard,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const diagnostics = judgments.flatMap((judgment) => {
          const scoringOnly = [
            ...revision.privateEvaluator.visual,
            ...revision.privateEvaluator.codeQuality,
          ].find(
            (criterion) =>
              criterion.id === judgment.criterionId && criterion.minimumPassingScore === null,
          );
          if (scoringOnly)
            return typeof judgment.score === "number" &&
              validRubricScore(scoringOnly, judgment.score)
              ? []
              : [
                  `${judgment.criterionId}: score is unavailable; acceptance has no authored threshold`,
                ];
          const expected =
            source.kind === "negative" && source.targetCriterionId === judgment.criterionId
              ? "rejected"
              : "verified";
          return judgment.outcome === expected
            ? []
            : [
                `${judgment.criterionId}: expected ${expected}, got ${judgment.outcome}: ${judgment.explanation}`,
              ];
        });
        return { ...acquired, accepted: diagnostics.length === 0, diagnostics };
      },
      recordAttempt,
      readAttempt: (id) => files.optional<RetainedControlAttempt>(`${base}/attempts/${id}.json`),
    });
    if (preparation.status !== "ready_to_check" || !preparation.set)
      return {
        batchId,
        preparation,
        checkStatus: null,
        unreviewedClaims: [],
        validation: {
          preparation: "compiled",
          acquisition: "incomplete",
          discrimination: "not_run",
          humanCalibration: "unavailable",
        },
      };
    await files.writeJson(setFile, preparation.set);
  }
  await guard();
  const check = await checkEvalControls(root, revision.id, batchId);
  return {
    batchId,
    preparation,
    checkStatus: check.status,
    unreviewedClaims: check.unreviewedClaims,
    validation: {
      preparation: "compiled",
      acquisition: check.acquisition,
      discrimination: check.discrimination,
      humanCalibration: "unavailable",
    },
  };
}
