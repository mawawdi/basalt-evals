import type { RunOperationManifest } from "../../contracts/src/execution.js";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * What a person reads at the end of a run, in console words. A run with no planned answers, for
 * example a Studio replay, mentions no review of answers. Otherwise each kind of claim that no
 * person confirmed gets one sentence:
 *
 * - A sentence, for example from registration, says that no reference test or comparison with
 *   people's answers confirmed the checks.
 * - `acceptance-threshold-unresolved:<criterion>` is a required score with no pass mark.
 * - `control-distinction:<case>` is a broken reference build that a judge check must tell apart.
 * - Any other claim is a criterion whose answers no person reviewed.
 */
export function completedReportReason(
  executed: boolean,
  manifest: Pick<RunOperationManifest, "planned" | "unreviewedClaims">,
): string | null {
  if (!executed) return "Some planned work did not complete.";
  if (manifest.planned.criterionOutcomes === 0 || !manifest.unreviewedClaims.length) return null;
  const sentences = manifest.unreviewedClaims.filter((claim) => claim.includes(" "));
  const thresholds = manifest.unreviewedClaims.filter((claim) =>
    claim.startsWith("acceptance-threshold-unresolved:"),
  ).length;
  const distinctions = manifest.unreviewedClaims.filter((claim) =>
    claim.startsWith("control-distinction:"),
  ).length;
  const criteria = manifest.unreviewedClaims.length - sentences.length - thresholds - distinctions;
  return [
    "All planned work completed.",
    ...(sentences.length
      ? [
          "These checks haven’t been tried on reference builds or compared with people’s answers yet.",
        ]
      : []),
    ...(thresholds
      ? [`${plural(thresholds, "criterion has", "criteria have")} a score but no pass mark.`]
      : []),
    ...(distinctions
      ? [
          `No one has confirmed yet that the judge tells ${plural(distinctions, "broken reference build", "broken reference builds")} apart.`,
        ]
      : []),
    ...(criteria
      ? [`No one has reviewed the answers to ${plural(criteria, "criterion", "criteria")} yet.`]
      : []),
  ].join(" ");
}
