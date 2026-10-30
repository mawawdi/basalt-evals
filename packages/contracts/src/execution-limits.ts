/** Studio infrastructure safeguards; model work has no elapsed-time cutoff. */
export const EXECUTION_LIMITS = Object.freeze({
  readinessCacheMs: 600_000,
  readinessRequestMs: 180_000,
});

/**
 * The maximum number of units of one stage that run at the same time in one run. Studio jobs
 * do not use these limits: one in-run queue admits one Studio job for each Studio lane.
 */
export const RUN_CONCURRENCY = Object.freeze({ builder: 4, judgment: 6 });

/**
 * The limits of the requests that one run sends to one model at the same time. A person sets
 * the value of each model on the Models page. A new model gets the default.
 */
export const MODEL_CONCURRENCY = Object.freeze({ default: 4, minimum: 1, maximum: 16 });

/** True for a request concurrency that a model can have. */
export function isModelConcurrency(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= MODEL_CONCURRENCY.minimum &&
    (value as number) <= MODEL_CONCURRENCY.maximum
  );
}

/** Independent generations per model, harness and evaluation in one frozen launch. */
export const MAX_GENERATIONS = 5;
