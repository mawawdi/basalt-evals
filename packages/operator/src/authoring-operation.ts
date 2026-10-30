import type { AuthoringResult } from "../../contracts/src/console.js";
import { projectPreparationOutcome } from "./preparation-outcome.js";
import type { AuthoringAction, AuthoringProgress } from "../../contracts/src/execution.js";
import { projectRun } from "./catalog-projection.js";
import { operationInputHash, preparationPath, authorizePreparation } from "./operation-binding.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { hashJson } from "../../contracts/src/index.js";
import { DurableSpendLedger } from "../../model-client/src/ledger.js";
import type { RunQuote } from "../../model-client/src/quote.js";
import { bindOperationImplementation } from "./execution-guard.js";
import { assertOperationOwnerStopped, processAlive } from "./process-owner.js";
import { prepareTextDraft, textDraft } from "./prepare-draft.js";
import { runQuotedEvalControls } from "./prepare-controls.js";
import { explanationRevision, runFailureExplanation } from "./failure-explanation.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";

export async function authoringProgress(
  root: string,
  operationId: string,
): Promise<AuthoringProgress | null> {
  const journal = await OperationJournal.open(root);
  try {
    return journal.read<AuthoringProgress>("authoring_progress", operationId);
  } finally {
    journal.close();
  }
}

/** Claim an immutable quoted stage. The shared operation driver performs it after returning. */
export async function queueAuthoringAction(
  root: string,
  input: Omit<AuthoringAction, "id" | "draftId"> & { draftId?: string },
  ownerToken?: string,
) {
  if (
    typeof input.operationId !== "string" ||
    typeof input.quoteId !== "string" ||
    !["preparation", "controls", "explanation"].includes(input.stage) ||
    !/^[a-z0-9][a-z0-9-]{0,80}$/u.test(input.operationId) ||
    !/^[a-f0-9]{64}$/u.test(input.quoteId) ||
    !Number.isFinite(input.ceilingUsd) ||
    input.ceilingUsd < 0
  )
    throw new Error("Invalid quoted authoring action");
  const files = new RepositoryFiles(root);
  const draftId =
    input.stage === "preparation"
      ? (await textDraft(root, input.draftId ?? "")).id
      : (await new EvalDefinitionStore(root).readExecutableRevision(input.revisionId ?? ""))
          .draftId;
  const quote = await files.json<RunQuote>(`.basalt-evals/eval-quotes/${input.quoteId}.json`);
  const { id, ...body } = quote;
  // The quote of an explanation binds its frozen material, and the material binds the revision.
  if (
    id !== input.quoteId ||
    hashJson(body) !== id ||
    (input.stage === "explanation"
      ? (await explanationRevision(root, input.quoteId)) !== input.revisionId
      : quote.subjectId !== (input.stage === "preparation" ? draftId : input.revisionId))
  )
    throw new Error("Authoring quote belongs to another input");
  const actionBody = {
    operationId: input.operationId,
    stage: input.stage,
    draftId,
    revisionId: input.stage === "preparation" ? null : input.revisionId,
    quoteId: input.quoteId,
    ceilingUsd: input.ceilingUsd,
  };
  const action: AuthoringAction = { ...actionBody, id: hashJson(actionBody) };
  const prior = await authoringProgress(root, input.operationId);
  if (prior?.action.id === action.id) return prior;
  if (ownerToken) {
    const owners = await OperationJournal.open(root);
    try {
      const owner = owners.read<{ token: string; pid: number; active: boolean }>(
        "drivers",
        input.operationId,
      );
      if (!owner?.active || owner.token !== ownerToken || owner.pid !== process.pid)
        throw new Error("Only the current driver may advance authoring");
    } finally {
      owners.close();
    }
  } else await assertOperationOwnerStopped(root, input.operationId);
  await bindOperationImplementation(
    root,
    input.operationId,
    hashJson({ inputHash: await operationInputHash(root, input.operationId, draftId) }),
  );
  const ledger = new DurableSpendLedger(
    root,
    input.operationId,
    hashJson({ inputHash: await operationInputHash(root, input.operationId, draftId) }),
  );
  const authorization = { quoteHash: hashJson(quote), ceilingUsd: input.ceilingUsd };
  await authorizePreparation(root, ledger, authorization);
  const path = `.basalt-evals/eval-operations/${input.operationId}/authoring/${action.id}.json`;
  await files.writeJsonOnce(path, action);
  const progress: AuthoringProgress = {
    action,
    state: "queued",
    stopped: false,
    resultHash: null,
    error: null,
  };
  const journal = await OperationJournal.open(root);
  try {
    journal.transaction(() => {
      const owner = journal.read<{ active: boolean; pid: number; token: string }>(
        "drivers",
        input.operationId,
      );
      if (
        ownerToken
          ? !owner?.active || owner.token !== ownerToken || owner.pid !== process.pid
          : owner?.active && processAlive(owner.pid)
      )
        throw new Error("Authoring ownership changed before stage admission");
      const current = journal.read<AuthoringProgress>("authoring_progress", input.operationId);
      if (current?.action.id === action.id) return;
      if (
        current?.action.id !== prior?.action.id ||
        (!current?.stopped && (current?.state === "queued" || current?.state === "running"))
      )
        throw new Error("Another authoring stage is already claimed");
      journal.put("authoring_progress", input.operationId, progress);
      projectRun(journal, input.operationId);
    });
  } finally {
    journal.close();
  }
  return progress;
}

export async function executeAuthoringAction(
  root: string,
  operationId: string,
  signal: AbortSignal,
  adapters: ExecutionAdapters = liveExecutionAdapters,
) {
  const progress = await authoringProgress(root, operationId);
  if (!progress || progress.stopped || !["queued", "running"].includes(progress.state)) return;
  const { action } = progress;
  const files = new RepositoryFiles(root);
  if (
    hashJson(
      await files.json(`.basalt-evals/eval-operations/${operationId}/authoring/${action.id}.json`),
    ) !== hashJson(action)
  )
    throw new Error("Authoring action changed after its claim");
  const update = async (changes: Partial<AuthoringProgress>, result?: unknown) => {
    const journal = await OperationJournal.open(root);
    try {
      journal.transaction(() => {
        const prior = journal.read<AuthoringProgress>("authoring_progress", operationId);
        if (prior?.action.id !== action.id)
          throw new Error("Authoring action no longer owns this operation");
        journal.put("authoring_progress", operationId, { ...prior, ...changes });
        if (result !== undefined) projectPreparationOutcome(journal, prior, result);
        projectRun(journal, operationId);
      });
    } finally {
      journal.close();
    }
  };
  await update({ state: "running" });
  try {
    const result =
      action.stage === "preparation"
        ? await prepareTextDraft({
            root,
            draftId: action.draftId,
            operationId,
            quoteId: action.quoteId,
            ceilingUsd: action.ceilingUsd,
            signal,
            adapters,
          })
        : action.stage === "explanation"
          ? await runFailureExplanation({
              root,
              revisionId: action.revisionId!,
              operationId,
              quoteId: action.quoteId,
              ceilingUsd: action.ceilingUsd,
              signal,
              adapters,
            })
          : await runQuotedEvalControls({
              root,
              revisionId: action.revisionId!,
              operationId,
              quoteId: action.quoteId,
              ceilingUsd: action.ceilingUsd,
              signal,
              adapters,
            });
    const resultHash = hashJson(result);
    const path = `.basalt-evals/eval-operations/${operationId}/authoring/results/${resultHash}.json`;
    await files.writeJsonOnce(path, result);
    const retained = result as { schema?: string; error?: string; interrupted?: string | null };
    const interruption =
      retained.schema === "basalt-evals/preparation-interruption"
        ? retained.error
        : retained.interrupted;
    await update(
      {
        state: interruption ? "incomplete" : "completed",
        resultHash,
        error: interruption ?? null,
      },
      result,
    );
  } catch (error) {
    await update({
      state: "incomplete",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function authoringActionResult(
  root: string,
  operationId: string,
): Promise<AuthoringResult> {
  const progress = await authoringProgress(root, operationId);
  if (!progress) throw new Error("No saved authoring operation");
  const files = new RepositoryFiles(root);
  // A reference test of an already prepared evaluation owns no preparation of its own.
  const preparation =
    progress.action.stage === "controls"
      ? await files.optional(preparationPath(operationId, progress.action.draftId))
      : null;
  if (!progress.resultHash) return { ...progress, result: null, preparation };
  const result = await new RepositoryFiles(root).json(
    `.basalt-evals/eval-operations/${operationId}/authoring/results/${progress.resultHash}.json`,
  );
  if (hashJson(result) !== progress.resultHash) throw new Error("Saved authoring receipt changed");
  return { ...progress, result, preparation };
}

export async function stopAuthoringAction(root: string, operationId: string) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const prior = journal.read<AuthoringProgress>("authoring_progress", operationId);
      if (!prior) throw new Error("No authoring operation to stop");
      const next = { ...prior, stopped: true };
      journal.put("authoring_progress", operationId, next);
      projectRun(journal, operationId);
      return next;
    });
  } finally {
    journal.close();
  }
}

export async function resumeAuthoringAction(root: string, operationId: string) {
  await assertOperationOwnerStopped(root, operationId);
  const saved = await authoringActionResult(root, operationId);
  if (saved.state === "completed")
    throw new Error(
      "This action already has a saved result. Read the result before you prepare another input.",
    );
  await bindOperationImplementation(
    root,
    operationId,
    hashJson({ inputHash: await operationInputHash(root, operationId, saved.action.draftId) }),
  );
  const ledger = new DurableSpendLedger(
    root,
    operationId,
    hashJson({ inputHash: await operationInputHash(root, operationId, saved.action.draftId) }),
  );
  if ((await ledger.read()).entries.some((entry) => entry.status === "pending"))
    throw new Error(
      "A saved request has a pending charge. Basalt cannot send it again. Select Check payment status before you resume.",
    );
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const prior = journal.read<AuthoringProgress>("authoring_progress", operationId);
      if (!prior || prior.action.id !== saved.action.id || prior.state !== saved.state)
        throw new Error("Authoring changed during recovery");
      const next = { ...prior, state: "queued" as const, stopped: false, error: null };
      journal.put("authoring_progress", operationId, next);
      projectRun(journal, operationId);
      return next;
    });
  } finally {
    journal.close();
  }
}
