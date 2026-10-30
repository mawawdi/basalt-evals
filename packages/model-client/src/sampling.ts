import type { ModelSnapshot } from "./catalog.js";
import { modelLimits } from "./model-limits.js";
import { SAMPLING_PARAMETERS, type ModelSampling } from "./contracts.js";

/**
 * Read the `default_parameters` object of an OpenRouter catalog entry. The catalog states the
 * values that the model publisher recommends. Null records that the catalog states no value.
 */
export function catalogRecommendedSampling(value: unknown): ModelSampling {
  const sampling = Object.fromEntries(
    SAMPLING_PARAMETERS.map((parameter) => [parameter, null]),
  ) as ModelSampling;
  if (value === undefined || value === null) return sampling;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid provider default sampling parameters");
  for (const [key, item] of Object.entries(value)) {
    if (!(SAMPLING_PARAMETERS as readonly string[]).includes(key))
      throw new Error("Provider default sampling parameters contain an unknown parameter");
    if (item === null) continue;
    if (typeof item !== "number" || !Number.isFinite(item))
      throw new Error("Invalid provider default sampling value: " + key);
    sampling[key as keyof ModelSampling] = item;
  }
  return sampling;
}

/**
 * The frozen sampling policy of a judge request: send each recommended value that the frozen
 * endpoint accepts. Basalt does not supply a value of its own.
 */
export function recommendedRequestSampling(snapshot: ModelSnapshot): ModelSampling {
  return Object.fromEntries(
    SAMPLING_PARAMETERS.map((parameter) => {
      const value = snapshot.recommendedSampling[parameter];
      return [
        parameter,
        value !== null && modelLimits(snapshot).supportedParameters.includes(parameter)
          ? value
          : null,
      ];
    }),
  ) as ModelSampling;
}

/** Pure validation shared by transport serialization, quotes and spending admission. */
export function assertRequestSampling(
  sampling: ModelSampling | undefined,
  snapshot?: ModelSnapshot,
): void {
  if (sampling === undefined) return;
  if (
    !sampling ||
    typeof sampling !== "object" ||
    Array.isArray(sampling) ||
    Object.keys(sampling).sort().join(",") !== [...SAMPLING_PARAMETERS].sort().join(",")
  )
    throw new Error("Request sampling must state every sampling parameter");
  for (const parameter of SAMPLING_PARAMETERS) {
    const value = sampling[parameter];
    if (value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error("Request sampling values must be finite numbers or null");
    if (snapshot && !modelLimits(snapshot).supportedParameters.includes(parameter))
      throw new Error(
        "An endpoint of the frozen set does not accept the sampling parameter " + parameter + ".",
      );
  }
}
