import type { ModelTurnResult, ProviderErrorType } from "./contracts.js";

/**
 * The part of the execution that a provider failure blocks.
 * - `account`: the provider refuses each request of the account, for example for its key or its
 *   credits.
 * - `model`: the provider refuses each request of one model, for example for an unknown model.
 * - `persistent`: the provider cannot serve the request now, for example for a rate limit after
 *   the final try or a server failure.
 * - `request`: the provider refuses this request only, for example for its length or its content.
 */
export type ProviderFailureScope = "account" | "model" | "persistent" | "request";

interface ProviderFailure {
  scope: ProviderFailureScope;
  /** The model or a content policy declined the request. A refusal is always a request failure. */
  refusal: boolean;
}

/** Each documented provider error type has one scope. */
const ERROR_TYPE_SCOPES: Record<ProviderErrorType, ProviderFailureScope> = {
  authentication: "account",
  payment_required: "account",
  permission_denied: "account",
  not_found: "model",
  rate_limit_exceeded: "persistent",
  provider_overloaded: "persistent",
  provider_unavailable: "persistent",
  server: "persistent",
  timeout: "persistent",
  unmapped: "persistent",
  context_length_exceeded: "request",
  max_tokens_exceeded: "request",
  token_limit_exceeded: "request",
  string_too_long: "request",
  invalid_request: "request",
  invalid_prompt: "request",
  precondition_failed: "request",
  payload_too_large: "request",
  unprocessable: "request",
  content_policy_violation: "request",
  refusal: "request",
  invalid_image: "request",
  image_too_large: "request",
  image_too_small: "request",
  unsupported_image_format: "request",
  image_not_found: "request",
  image_download_failed: "request",
};

const REFUSAL_TYPES: ReadonlySet<ProviderErrorType> = new Set([
  "content_policy_violation",
  "refusal",
]);

/**
 * The scope of a provider failure, or null when the result is not a provider failure with an
 * HTTP status or a documented error type. Give only a result of the bounded client: it tries a
 * rate limit again itself, so a 429 here comes after the final try.
 *
 * The documented error type has priority over the HTTP status, because it is more specific. For
 * example, a moderation 403 is a request failure, but a different 403 is an account failure. A
 * 5xx failure is persistent only with a known charge. A 5xx failure without a known charge stays
 * uncertain, and the bounded client keeps its charge pending.
 */
export function classifyProviderFailure(result: ModelTurnResult): ProviderFailure | null {
  if (result.kind !== "provider_error") return null;
  const status = /^(?:http|provider_response_error)_([45][0-9]{2})$/u.exec(result.errorClass);
  const code = status ? Number(status[1]) : null;
  const type = result.providerErrorType;
  const scope = type !== null ? ERROR_TYPE_SCOPES[type] : code !== null ? statusScope(code) : null;
  if (scope === null) return null;
  if (scope === "persistent" && code !== null && code >= 500 && result.usage.costUsd === null)
    return null;
  return { scope, refusal: type !== null && REFUSAL_TYPES.has(type) };
}

function statusScope(status: number): ProviderFailureScope {
  if (status === 401 || status === 402 || status === 403) return "account";
  if (status === 404) return "model";
  // OpenRouter sends a 408 when the request timed out, which is a state of the provider.
  if (status === 408 || status === 429 || status >= 500) return "persistent";
  return "request";
}
