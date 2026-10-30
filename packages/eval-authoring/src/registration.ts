import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { hashJson } from "../../contracts/src/index.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { loadRegisteredTask } from "../../task-registry/src/index.js";
import { EvalDefinitionStore } from "./store.js";
import { stageEvalRevision } from "./stage.js";
import { materializeEvalRevision } from "./materialize.js";
import { projectRegisteredEvaluation } from "./catalog.js";
import type { EvalRevision, EvalValidation } from "./compiler.js";
import type { ControlCheck } from "./controls.js";

/**
 * The readiness record of one stage revision. The record of a stage names the record of the next
 * stage through `nextRecordHash`, so the record hash of stage 1 binds the records of every stage.
 */
export interface EvaluationReadinessRecord {
  validation: EvalValidation;
  check: ControlCheck | null;
  /** The readiness record of the next stage, or null for the last stage. */
  nextRecordHash: string | null;
}

/** The readiness record of a compiled revision without a reference test. */
export function readyValidationRecord(
  revision: Pick<EvalRevision, "id" | "draftId">,
): Omit<EvaluationReadinessRecord, "nextRecordHash"> {
  return {
    validation: {
      schema: "basalt-evals/eval-validation",
      draftId: revision.draftId,
      revisionId: revision.id,
      status: "ready",
      preparation: "compiled",
      diagnostics: [],
      acquisition: "not_run",
      discrimination: "not_run",
      humanCalibration: "unavailable",
      controlSetHash: null,
      unreviewedClaims: [
        "Basalt did not test these checks on reference builds or compare their answers with answers from people.",
      ],
    },
    check: null,
  };
}

/**
 * Register each stage of an evaluation from the revision of stage 1, with its ready record. Only
 * stage 1 enters the catalog.
 */
export async function registerReadyEvaluation(
  root: string,
  revisionId: string,
  signal?: AbortSignal,
) {
  const stages = await new EvalDefinitionStore(root).readStageRevisions(revisionId, true);
  const registered = await registerStages(
    root,
    stages,
    async (stage) => readyValidationRecord(stage),
    signal,
  );
  await projectRegisteredEvaluation(root, revisionId, registered.validationRecordHash, false);
  return registered;
}

/**
 * Save the readiness record and the registered task of each stage in `stages`, which are all
 * stages of one evaluation. Each record names the record of the next stage, so the last stage is
 * saved first. `record` gives the record of one stage without that link. The result is the
 * registration of stage 1.
 */
export async function registerStages(
  root: string,
  stages: EvalRevision[],
  record: (stage: EvalRevision) => Promise<Omit<EvaluationReadinessRecord, "nextRecordHash">>,
  signal?: AbortSignal,
) {
  let registered: Awaited<ReturnType<typeof registerStage>> | null = null;
  for (const stage of [...stages].reverse())
    registered = await registerStage(
      root,
      stage.id,
      { ...(await record(stage)), nextRecordHash: registered?.validationRecordHash ?? null },
      signal,
    );
  return registered!;
}

/**
 * Read the readiness record `recordHash` of one stage revision. The hash and the revision of the
 * record must agree.
 */
export async function readReadinessRecord(
  root: string,
  revisionId: string,
  recordHash: string,
): Promise<EvaluationReadinessRecord> {
  const record = await new RepositoryFiles(root).json<EvaluationReadinessRecord>(
    `.basalt-evals/eval-validations/${revisionId}/${recordHash}.json`,
  );
  if (
    hashJson(record) !== recordHash ||
    record.validation.revisionId !== revisionId ||
    (record.check !== null && record.check.revisionId !== revisionId)
  )
    throw new Error("Validation evidence identity changed");
  return record;
}

/**
 * The readiness record hashes of `stages`, which are consecutive stages of one evaluation, from
 * the record hash of the first of them. An evaluation without stages reads no record.
 */
export async function stageRecordHashes(
  root: string,
  stages: Array<Pick<EvalRevision, "id">>,
  firstRecordHash: string,
): Promise<string[]> {
  const hashes = [firstRecordHash];
  for (const stage of stages.slice(0, -1)) {
    const { nextRecordHash } = await readReadinessRecord(root, stage.id, hashes.at(-1)!);
    if (typeof nextRecordHash !== "string")
      throw new Error(
        "A stage of this evaluation is not linked to the next stage. Prepare the evaluation again.",
      );
    hashes.push(nextRecordHash);
  }
  return hashes;
}

/** Save the readiness record and the registered task of one stage revision. */
async function registerStage(
  root: string,
  revisionId: string,
  record: EvaluationReadinessRecord,
  signal?: AbortSignal,
) {
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(revisionId);
  const next = revision.stage.nextRevisionId;
  if ((next === null) !== (record.nextRecordHash === null))
    throw new Error("A readiness record must name the record of the next stage, if one exists");
  // A chain of records has one status, so a checked stage 1 means that every stage is checked.
  if (
    next !== null &&
    (await readReadinessRecord(root, next, record.nextRecordHash!)).validation.status !==
      record.validation.status
  )
    throw new Error("The readiness records of the stages of an evaluation have different statuses");
  const validationHash = hashJson(record);
  const files = new RepositoryFiles(root);
  await files.directory(".basalt-evals/eval-validations/" + revisionId);
  const validationFile = `.basalt-evals/eval-validations/${revisionId}/${validationHash}.json`;
  try {
    await files.writeJson(validationFile, record);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (hashJson(await files.json(validationFile)) !== validationHash)
      throw new Error("Stored control validation identity changed");
  }
  const staged = await stageEvalRevision(root, revisionId, signal);
  const targetRelative = `.basalt-evals/eval-revisions/${revisionId}`;
  const existing = await files.optional<{ schema: string; revisionId: string }>(
    `${targetRelative}/authoring.json`,
  );
  if (existing) {
    if (existing.schema !== "basalt-evals/registered-eval" || existing.revisionId !== revisionId)
      throw new Error("Registered eval has a different revision identity");
  } else {
    const temporary = resolve(
      root,
      ".basalt-evals/eval-revisions",
      `${revisionId}-${randomUUID()}.tmp`,
    );
    await files.directory(".basalt-evals/eval-revisions");
    await mkdir(temporary, { mode: 0o700 });
    try {
      const stagedDirectory = `.basalt-evals/eval-revisions/${basename(temporary)}`;
      await materializeEvalRevision({
        repositoryRoot: root,
        relativeDirectory: stagedDirectory,
        revision,
        metadata: {
          schema: "basalt-evals/registered-eval",
          revisionId,
        },
      });
      await rename(temporary, resolve(root, targetRelative));
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }
  // The registered task, old or new, must be the checked revision.
  const registered = await loadRegisteredTask(root, targetRelative);
  const stagedTask = await loadRegisteredTask(root, staged.directory);
  if (
    registered.publicTaskHash !== stagedTask.publicTaskHash ||
    registered.evaluatorHash !== stagedTask.evaluatorHash ||
    registered.seedHash !== stagedTask.seedHash
  )
    throw new Error("Registered eval differs from the checked revision");
  return { validationRecordHash: validationHash };
}
