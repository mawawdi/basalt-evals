import type { ModelSnapshot } from "./catalog.js";
import { modelLimits } from "./model-limits.js";
import { REASONING_EFFORTS, type ModelRequestReasoning } from "./contracts.js";

/** Pure validation shared by transport serialization, quoting and spending admission. */
export function assertRequestReasoning(
  reasoning: ModelRequestReasoning | undefined,
  snapshot?: ModelSnapshot,
): void {
  if (reasoning === undefined) return;
  if (!reasoning || typeof reasoning !== "object")
    throw new Error("Invalid request reasoning policy");
  const keys = Object.keys(reasoning).sort().join(",");
  if (reasoning.kind === "provider_default" && keys === "kind") return;
  if (
    reasoning.kind === "effort" &&
    keys === "effort,kind" &&
    REASONING_EFFORTS.includes(reasoning.effort)
  ) {
    const metadata = snapshot?.reasoning;
    if (
      snapshot &&
      (!metadata ||
        metadata.effortSelection === "unavailable" ||
        !modelLimits(snapshot).supportedParameters.some(
          (parameter) => parameter === "reasoning" || parameter === "reasoning_effort",
        ) ||
        (metadata.effortSelection === "listed" &&
          !metadata.supportedEfforts.includes(reasoning.effort)) ||
        (reasoning.effort === "none" && metadata.mandatory === true))
    )
      throw new Error("Frozen model does not advertise the selected reasoning effort");
    return;
  }
  throw new Error("Invalid request reasoning policy");
}
