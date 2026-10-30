import {
  fetchModelSnapshots,
  modelRoute,
  type ModelSnapshot,
} from "../../model-client/src/catalog.js";
import { OpenRouterModelClient } from "../../model-client/src/openrouter-ai-sdk.js";
import type { ModelClient } from "../../model-client/src/contracts.js";
import { nativeStudioAdapter, type StudioAdapter } from "../../studio-runner/src/adapter.js";
import { lookupOpenRouterGenerationBilling } from "../../model-client/src/generation-billing.js";

export interface ExecutionAdapters {
  catalog: typeof fetchModelSnapshots;
  model(models: ModelSnapshot[]): ModelClient;
  studio: StudioAdapter;
  billing(generationId: string): Promise<{ generationId: string; costUsd: number }>;
}
/** Transports only. Ownership, guards, bounded orchestration, signatures and spending stay in their services. */
export const liveExecutionAdapters: ExecutionAdapters = {
  catalog: fetchModelSnapshots,
  model(models) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey)
      throw new Error(
        "Basalt needs OPENROUTER_API_KEY to send model requests. Set it in the repository .env file. Then restart the console.",
      );
    return new OpenRouterModelClient({
      apiKey,
      allowedModels: models.map((model) => model.id),
      routes: Object.fromEntries(models.map((model) => [model.id, modelRoute(model)])),
    });
  },
  studio: nativeStudioAdapter,
  async billing(generationId) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key)
      throw new Error(
        "Basalt needs OPENROUTER_API_KEY to check charges with the provider. Set it in the repository .env file. Then restart the console.",
      );
    return lookupOpenRouterGenerationBilling(generationId, key);
  },
};
