/** Read-only OpenRouter generation metadata. A missing or mismatched charge stays uncertain. */
interface OpenRouterGenerationBilling {
  generationId: string;
  costUsd: number;
  createdAt: string;
  model: string;
  providerName: string;
  cancelled: boolean;
  requestId: string;
}

export async function lookupOpenRouterGenerationBilling(
  generationId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterGenerationBilling> {
  if (!/^[a-zA-Z0-9_-]{1,160}$/u.test(generationId) || !apiKey.trim())
    throw new Error("Generation billing lookup needs a bounded ID and provider key");
  const url = new URL("https://openrouter.ai/api/v1/generation");
  url.searchParams.set("id", generationId);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Generation billing metadata is unavailable");
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Generation billing metadata is malformed");
  const data = (body as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Generation billing metadata is malformed");
  const record = data as Record<string, unknown>;
  if (
    record.id !== generationId ||
    typeof record.total_cost !== "number" ||
    !Number.isFinite(record.total_cost) ||
    record.total_cost < 0 ||
    typeof record.created_at !== "string" ||
    !Number.isFinite(Date.parse(record.created_at)) ||
    typeof record.model !== "string" ||
    typeof record.provider_name !== "string" ||
    typeof record.cancelled !== "boolean" ||
    typeof record.request_id !== "string"
  )
    throw new Error("Generation billing metadata has no matching known USD charge");
  return {
    generationId,
    costUsd: record.total_cost,
    createdAt: record.created_at,
    model: record.model,
    providerName: record.provider_name,
    cancelled: record.cancelled,
    requestId: record.request_id,
  };
}
