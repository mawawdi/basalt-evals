import { compareCodeUnits } from "../../contracts/src/index.js";
import type { ModelSnapshot } from "./catalog.js";

/** The limits that every endpoint of the set accepts. A request stays inside all of them. */
export function modelLimits(model: ModelSnapshot): {
  contextLength: number;
  maxPromptTokens: number | null;
  maxOutputTokens: number;
  supportedParameters: string[];
} {
  const endpoints = model.endpoints;
  const prompts = endpoints.flatMap((endpoint) =>
    endpoint.maxPromptTokens === null ? [] : [endpoint.maxPromptTokens],
  );
  return {
    contextLength: Math.min(...endpoints.map((endpoint) => endpoint.contextLength)),
    maxPromptTokens: prompts.length ? Math.min(...prompts) : null,
    maxOutputTokens: Math.min(...endpoints.map((endpoint) => endpoint.maxOutputTokens)),
    supportedParameters: endpoints[0]!.supportedParameters
      .filter((parameter) =>
        endpoints.every((endpoint) => endpoint.supportedParameters.includes(parameter)),
      )
      .sort(compareCodeUnits),
  };
}
