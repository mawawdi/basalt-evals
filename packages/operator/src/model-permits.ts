import { isModelConcurrency } from "../../contracts/src/execution-limits.js";

interface ModelLine {
  readonly limit: number;
  active: number;
  readonly waiters: Array<{ admit: () => void }>;
}

/**
 * The request permits of one run, with one first-in, first-out line for each model. A bounded
 * client takes a permit before it reserves the charge of a request and gives the permit back
 * when the result settles. Thus a model gets at most its frozen number of requests at the same
 * time from the builds and judgments of the run. A wait for a Studio job, a tool or a rate
 * limit holds no permit.
 */
export class ModelPermits {
  private readonly lines = new Map<string, ModelLine>();

  constructor(limits: Readonly<Record<string, number>>) {
    for (const [model, limit] of Object.entries(limits)) {
      if (!isModelConcurrency(limit)) throw new Error("Invalid model request concurrency");
      this.lines.set(model, { limit, active: 0, waiters: [] });
    }
  }

  /**
   * Wait for a permit of the model. The returned function gives the permit back, and a second
   * call does nothing. A stop ends the wait with the reason of the signal, and the line keeps no
   * entry of the caller.
   */
  async acquire(model: string, signal?: AbortSignal): Promise<() => void> {
    const line = this.lines.get(model);
    if (!line) throw new Error("The run has no request concurrency for this model");
    signal?.throwIfAborted();
    if (line.active < line.limit && !line.waiters.length) line.active += 1;
    else
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          admit: () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        const onAbort = () => {
          const index = line.waiters.indexOf(waiter);
          if (index >= 0) line.waiters.splice(index, 1);
          reject(signal!.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        line.waiters.push(waiter);
      });
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const next = line.waiters.shift();
      // The permit passes directly to the next waiter, so no new caller can take it first.
      if (next) next.admit();
      else line.active -= 1;
    };
  }
}
