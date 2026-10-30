import { setTimeout as delay } from "node:timers/promises";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { processAlive } from "./process-owner.js";

type Computation<T> =
  | { state: "running"; pid: number; operationId: string }
  | { state: "complete"; value: T }
  | { state: "interrupted"; operationId: string; reason: string };

/** Matching callers share one owned computation. Death never grants permission to replay it. */
export async function ownedComputation<T>(input: {
  root: string;
  namespace: string;
  key: string;
  operationId: string;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  for (;;) {
    input.signal?.throwIfAborted();
    const journal = await OperationJournal.open(input.root);
    let claimed = false;
    let previous: Computation<T> | null;
    try {
      previous = journal.transaction(() => {
        const prior = journal.read<Computation<T>>(input.namespace, input.key);
        if (
          !prior ||
          ((prior.state === "interrupted" ||
            (prior.state === "running" && !processAlive(prior.pid))) &&
            prior.operationId === input.operationId)
        ) {
          journal.put(input.namespace, input.key, {
            state: "running",
            pid: process.pid,
            operationId: input.operationId,
          });
          claimed = true;
        }
        return claimed ? null : prior;
      });
    } finally {
      journal.close();
    }
    if (previous?.state === "complete") return previous.value;
    if (previous?.state === "interrupted")
      throw new Error(
        `An earlier attempt in run ${previous.operationId} failed. Read the failure in that run before you try again. Cause: ${previous.reason}`,
      );
    if (!claimed) {
      if (!previous || previous.state !== "running" || !processAlive(previous.pid))
        throw new Error(
          "Another run stopped before it finished this step. Examine that run before you start a new run.",
        );
      await delay(250, undefined, input.signal ? { signal: input.signal } : {});
      continue;
    }
    try {
      const value = await input.run();
      const completed = await OperationJournal.open(input.root);
      try {
        completed.put(input.namespace, input.key, { state: "complete", value });
      } finally {
        completed.close();
      }
      return value;
    } catch (error) {
      const failed = await OperationJournal.open(input.root);
      try {
        failed.put(input.namespace, input.key, {
          state: "interrupted",
          operationId: input.operationId,
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        failed.close();
      }
      throw error;
    }
  }
}
