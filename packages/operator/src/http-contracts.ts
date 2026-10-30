import type { StartRunRequest } from "../../contracts/src/execution.js";
import { launchIdentity } from "../../contracts/src/validation.js";

export function startRunRequest(value: unknown): StartRunRequest {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "ceilingUsd,idempotencyKey,quoteId"
  )
    throw new Error("Start requires a saved quote, spending ceiling, and idempotency key");
  const request = value as StartRunRequest;
  if (
    typeof request.quoteId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(request.quoteId) ||
    !Number.isFinite(request.ceilingUsd) ||
    request.ceilingUsd < 0
  )
    throw new Error("Invalid quote, nonnegative ceiling, or idempotency key");
  launchIdentity(request.idempotencyKey);
  return request;
}
