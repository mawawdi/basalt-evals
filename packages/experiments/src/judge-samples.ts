import type { RunJudgmentBatch } from "../../contracts/src/execution.js";
import { answerVerdict, type JudgeAnswer } from "../../eval-authoring/src/criterion-response.js";

/*
 * Judge samples. A run can send the same judge request more than one time. Each sample is its
 * own batch with its own ledger entry, and the samples of one request share a sample group.
 * The answers of a sample group combine into one answer for each criterion. Samples that
 * disagree give a split answer: it is neither met nor failed, and a person decides it.
 */

/** The answer of one sample for one criterion. */
export type SampleVote = "met" | "not_met" | "scored" | "insufficient";

/**
 * The combined answer of the samples of one criterion and one sample group. `insufficient` is
 * the answer "not enough evidence". `missing` is a check with a sample without an answer.
 */
export interface CombinedSamples {
  answer: "met" | "not_met" | "split" | "scored" | "insufficient" | "missing";
  /** The samples that say met. */
  met: number;
  /** The planned samples, also the samples without an answer. */
  of: number;
}

/**
 * The vote of one judge decision, from the exact answer word of the judge. An absence answer
 * uses the rule of the parser: present is not met, and absent is met. A criterion with an
 * authored minimum score is met only when the score is at or above it. A score without a
 * minimum is only a score.
 */
export function sampleVote(
  decision: { answer: JudgeAnswer; score: number | null },
  threshold: number | null,
): SampleVote {
  if (threshold !== null)
    return decision.score === null
      ? "insufficient"
      : decision.score >= threshold
        ? "met"
        : "not_met";
  if (decision.score !== null) return "scored";
  const verdict = answerVerdict(decision.answer);
  return verdict === "satisfied" ? "met" : verdict === "violated" ? "not_met" : "insufficient";
}

/**
 * The vote of one recorded criterion outcome of a run. An absent outcome has no vote. Each
 * other outcome, for example insufficient or incomplete, votes insufficient.
 */
export function outcomeVote(outcome: string | undefined): SampleVote | null {
  return outcome === undefined
    ? null
    : outcome === "verified"
      ? "met"
      : outcome === "rejected"
        ? "not_met"
        : outcome === "scored"
          ? "scored"
          : "insufficient";
}

/**
 * Combine the samples of one criterion. A null vote is a sample without an answer.
 *
 * - Any sample without an answer: `missing`. The check has no answer yet, or a sample failed.
 * - Every sample met: met. Every sample not met: not met.
 * - Any insufficient sample: insufficient, which is an answer and not an absent result.
 * - Samples that disagree: split, which is neither met nor failed.
 * - Every sample scored without a minimum: scored.
 */
export function combineSamples(votes: Array<SampleVote | null>): CombinedSamples {
  if (!votes.length) throw new Error("A sample group needs at least one planned sample");
  const met = votes.filter((vote) => vote === "met").length;
  const of = votes.length;
  const answer: CombinedSamples["answer"] = votes.some((vote) => vote === null)
    ? "missing"
    : votes.some((vote) => vote === "insufficient")
      ? "insufficient"
      : votes.every((vote) => vote === "scored")
        ? "scored"
        : votes.some((vote) => vote === "scored")
          ? "insufficient"
          : met === of
            ? "met"
            : met === 0
              ? "not_met"
              : "split";
  return { answer, met, of };
}

/**
 * The run outcome word of a combined answer. A split answer and an insufficient answer keep
 * their own words. A check with a sample without an answer is incomplete.
 */
export function combinedOutcome(
  combined: CombinedSamples,
): "verified" | "rejected" | "split" | "scored" | "insufficient" | "incomplete" {
  return {
    met: "verified" as const,
    not_met: "rejected" as const,
    split: "split" as const,
    scored: "scored" as const,
    insufficient: "insufficient" as const,
    missing: "incomplete" as const,
  }[combined.answer];
}

/**
 * The sample groups of a run, in the sequence of their first batch. Each group lists its batches
 * by sample number. The samples of a group are identical requests, so they share a capture,
 * criteria, presentation, grouping, configuration and substitution.
 */
export function judgeSampleGroups<T extends Pick<RunJudgmentBatch, "sampleGroupId" | "sample">>(
  batches: T[],
): Array<{ id: string; batches: T[] }> {
  const groups = new Map<string, T[]>();
  for (const batch of batches) {
    const group = groups.get(batch.sampleGroupId) ?? [];
    group.push(batch);
    groups.set(batch.sampleGroupId, group);
  }
  return [...groups].map(([id, group]) => ({
    id,
    batches: group.sort((a, b) => a.sample - b.sample),
  }));
}
