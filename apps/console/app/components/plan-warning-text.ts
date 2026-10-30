import type {
  BenchmarkPlanWarning,
  PlanWarningKind,
} from "../../../../dist/packages/contracts/src/benchmarks.js";

/** The short label of each plan warning, for a status chip. */
export const planWarningLabels: Record<PlanWarningKind, string> = {
  same_observed_failure: "Every build fails with the same value",
  every_build_fails: "Every build fails",
  every_build_meets: "Every build meets it",
  passes_empty_build: "Passes on the empty build",
  known_build_disagrees: "Known build answers differently",
};

/**
 * True for a warning that every build meets or fails a check. An easy or a hard check gives it
 * too, so the console shows it as neutral and counts it apart from the other warnings.
 */
export function buildPattern(kind: PlanWarningKind) {
  return kind === "every_build_meets" || kind === "every_build_fails";
}

/** Observed Studio values as a person reads them: text in quotes, other values as written. */
function observedText(values: BenchmarkPlanWarning["observed"]) {
  return (values ?? [])
    .map((value) => (typeof value === "string" ? `“${value}”` : String(value)))
    .join(", ");
}

/** One sentence that says what the warning saw. `knownName` names a known build by its ID. */
export function planWarningDetail(
  warning: BenchmarkPlanWarning,
  knownName: (id: string) => string = () => "A known build",
) {
  const builds = `${warning.builds} ${warning.builds === 1 ? "build" : "builds"}`;
  const value = observedText(warning.observed);
  switch (warning.kind) {
    case "same_observed_failure":
      return `All ${builds} failed, and each one read ${value}. The check may be looking at the wrong thing.`;
    case "every_build_fails":
      return `All ${builds} failed this check. It may be stricter than the prompt or the criterion.`;
    case "every_build_meets":
      return `All ${builds} met this check, so it hasn’t told any builds apart yet.`;
    case "passes_empty_build":
      return value
        ? `The starting files with no changes pass this check. Studio read ${value}.`
        : "The starting files with no changes pass this check.";
    case "known_build_disagrees": {
      const names = warning.knownBuildIds.map(knownName);
      return names.length === 1
        ? `${names[0]} doesn’t get the answer it was marked with.`
        : `These known builds don’t get the answers they were marked with: ${names.join("; ")}.`;
    }
  }
}
