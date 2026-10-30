import { projectRun } from "./catalog-projection.js";
import type { RunStart } from "../../contracts/src/execution.js";
import { operationInputHash } from "./operation-binding.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { readRunQuote } from "./run-quotes.js";
import { hashJson } from "../../contracts/src/index.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { bindOperationImplementation } from "./execution-guard.js";
import { startRunRequest } from "./http-contracts.js";

import { readRegisteredExperiment } from "./experiment-plan.js";

export async function runStartProgress(root: string, id: string): Promise<RunStart | null> {
  const journal = await OperationJournal.open(root);
  try {
    return journal.read<RunStart>("run_starts", id);
  } finally {
    journal.close();
  }
}

/** Claim before returning to HTTP/CLI. Freezing and execution belong to the owned driver. */
export async function queueRunStart(
  root: string,
  value: unknown,
  claimedOperationId?: string,
): Promise<RunStart> {
  const request = startRunRequest(value);
  const saved = await readRunQuote(root, request.quoteId);
  const selectedInputHash =
    saved.kind === "eval" || saved.kind === "stages"
      ? (
          await new EvalDefinitionStore(root).readExecutableRevision(
            saved.kind === "eval" ? saved.selection.revisionId : saved.firstRevisionId,
          )
        ).draftId
      : saved.kind === "selection"
        ? hashJson(saved.selection)
        : (await readRegisteredExperiment(root, saved.selection.experimentId)).id;
  const requestHash = hashJson(request);
  const key = hashJson(request.idempotencyKey);
  const operationId =
    claimedOperationId ??
    (saved.kind === "eval" ? saved.selection.continuingOperationId : null) ??
    `run-${key.slice(0, 32)}`;
  const { workflowRecord } = await import("./workflow.js");
  const workflow = await workflowRecord(root, operationId);
  const inputHash = await operationInputHash(
    root,
    operationId,
    workflow?.inputHash ?? selectedInputHash,
  );
  await bindOperationImplementation(root, operationId, hashJson({ inputHash }));
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const priorKey = journal.read<{ requestHash: string; operationId: string }>(
        "start_keys",
        key,
      );
      if (
        priorKey &&
        (priorKey.requestHash !== requestHash || priorKey.operationId !== operationId)
      )
        throw new Error(
          "Basalt already used this start request for different work or a different spending limit. Make a new preview.",
        );
      const prior = journal.read<RunStart>("run_starts", operationId);
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new Error("This run already has a different start request. Make a new preview.");
        return prior;
      }
      const start: RunStart = {
        operationId,
        requestHash,
        inputHash,
        request,
        state: "queued",
        stopped: false,
        error: null,
      };
      journal.put("start_keys", key, { requestHash, operationId });
      journal.put("run_starts", operationId, start);
      projectRun(journal, operationId);
      return start;
    });
  } finally {
    journal.close();
  }
}

export async function updateRunStart(
  root: string,
  id: string,
  changes: Partial<Pick<RunStart, "state" | "stopped" | "error">>,
): Promise<RunStart> {
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const prior = journal.read<RunStart>("run_starts", id);
      if (!prior) throw new Error("No saved run start");
      const next = { ...prior, ...changes };
      journal.put("run_starts", id, next);
      projectRun(journal, id);
      return next;
    });
  } finally {
    journal.close();
  }
}
