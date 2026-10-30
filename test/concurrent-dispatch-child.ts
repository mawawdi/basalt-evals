import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashJson } from "../packages/contracts/src/index.js";
import { BoundedModelClient } from "../packages/model-client/src/bounded-client.js";
import type { ModelSnapshot } from "../packages/model-client/src/catalog.js";
import type { ModelClient, ModelTurnRequest } from "../packages/model-client/src/contracts.js";
import { DurableSpendLedger } from "../packages/model-client/src/ledger.js";
import { openRouterModelClientDescriptor } from "../packages/model-client/src/openrouter-ai-sdk.js";

/** Shared data of a run that crashes while two of its units hold dispatched paid requests. */
export const crashOperation = "crash-run";
export const crashContext = hashJson("crash-context");
export const crashStages = ["builder:first", "judgment:second"] as const;
export const crashModel: ModelSnapshot = {
  id: "openai/gpt-6-luna",
  name: "GPT-6 Luna",
  revision: "openai/gpt-6-luna-test",
  capturedAt: "2026-10-03T00:00:00.000Z",
  inputModalities: ["text"],
  reasoning: null,
  recommendedSampling: {
    temperature: null,
    top_p: null,
    top_k: null,
    frequency_penalty: null,
    presence_penalty: null,
    repetition_penalty: null,
  },
  endpoints: [
    {
      tag: "openai",
      provider: "OpenAI",
      quantization: "unknown",
      contextLength: 16_384,
      maxPromptTokens: null,
      rawPricing: {},
      maxOutputTokens: 1_024,
      supportedParameters: ["tools"],
      tiers: [
        {
          minPromptTokens: 0,
          temporal: null,
          inputPerTokenUsd: 0.000001,
          outputPerTokenUsd: 0.000002,
          imagePerImageUsd: null,
          requestUsd: 0,
          cacheReadPerTokenUsd: null,
          cacheWritePerTokenUsd: null,
        },
      ],
    },
  ],
  hash: hashJson("crash-model"),
};
export const crashRequest: ModelTurnRequest = {
  model: crashModel.id,
  seed: 1,
  system: "Build the task",
  messages: [{ role: "user", content: "Hello" }],
  tools: [],
  maxOutputTokens: 100,
};

/** Two units dispatch their requests at the same time. Then the process ends with SIGKILL. */
async function crashAfterDispatch(root: string) {
  const ledger = new DurableSpendLedger(root, crashOperation, crashContext);
  let dispatched = 0;
  const client: ModelClient = {
    observesDispatch: true,
    descriptor: openRouterModelClientDescriptor([crashModel.id]),
    async complete(_request, _signal, observer) {
      await observer!.beforeDispatch();
      await appendFile(resolve(root, "dispatches.log"), "crashed process\n");
      dispatched += 1;
      if (dispatched === crashStages.length) process.kill(process.pid, "SIGKILL");
      return new Promise(() => {});
    },
  };
  for (const stage of crashStages)
    void new BoundedModelClient(client, ledger, [crashModel], stage).complete(crashRequest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await crashAfterDispatch(process.argv[2]!);
