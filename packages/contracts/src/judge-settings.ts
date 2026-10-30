import { fields, integer } from "./validation.js";

/** The largest number of identical judge requests for one criterion and one observation. */
export const MAX_JUDGE_SAMPLES = 5;

/** How the judge criteria of one observation share requests. */
export const JUDGE_GROUPINGS = ["shared", "per_criterion"] as const;
export type JudgeGrouping = (typeof JUDGE_GROUPINGS)[number];

/**
 * The person's settings for judge requests. `samples` sends identical requests, each one with its
 * own ledger entry. `shared` puts the compatible criteria of an observation in one request, and
 * `per_criterion` gives each criterion its own request.
 */
export interface JudgeSettings {
  samples: number;
  grouping: JudgeGrouping;
}

/** One sample and shared requests: the settings of every run until a person changes them. */
export const DEFAULT_JUDGE_SETTINGS: JudgeSettings = Object.freeze({
  samples: 1,
  grouping: "shared",
});

export function judgeSettings(value: unknown): JudgeSettings {
  const row = fields(value, ["samples", "grouping"], "Judge settings");
  integer(row.samples, 1, MAX_JUDGE_SAMPLES, "Judge samples");
  if (!(JUDGE_GROUPINGS as readonly unknown[]).includes(row.grouping))
    throw new Error("Choose shared requests or one request for each criterion.");
  return { samples: row.samples as number, grouping: row.grouping as JudgeGrouping };
}
