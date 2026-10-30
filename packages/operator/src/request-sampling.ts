import type { RunOperationManifest } from "../../contracts/src/execution.js";
import { benchmarkRequestRole } from "../../contracts/src/benchmarks.js";
import { SAMPLING_PARAMETERS, type ModelSampling } from "../../model-client/src/contracts.js";
import { frozenRunStatus } from "./run-builder.js";

/**
 * The sampling values that one request of a run sent, from the frozen manifest. A judge request
 * sends the values of its frozen batch configuration. A build sends none, so every value is null
 * and the provider defaults apply. Null for a request whose values the manifest does not hold.
 */
export function requestSampling(
  manifest: Pick<RunOperationManifest, "judgmentBatches">,
  stage: string,
): ModelSampling | null {
  if (stage.startsWith("judgment:"))
    return (
      manifest.judgmentBatches.find((batch) => batch.id === stage.slice("judgment:".length))
        ?.configuration.sampling ?? null
    );
  if (benchmarkRequestRole(stage) === "builder")
    return Object.fromEntries(
      SAMPLING_PARAMETERS.map((parameter) => [parameter, null]),
    ) as ModelSampling;
  return null;
}

/**
 * The sampling values of one request of a saved run. It only reads the frozen manifest. Null
 * when the operation is not a run or its manifest holds no values for the request.
 */
export async function savedRequestSampling(
  root: string,
  operationId: string,
  stage: string,
): Promise<ModelSampling | null> {
  try {
    return requestSampling((await frozenRunStatus(root, operationId, false)).manifest, stage);
  } catch {
    return null;
  }
}
