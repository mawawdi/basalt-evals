/*
 * The preparation parity study. A person writes the rubric and the map of a curated plan. Each
 * preparation model writes the private plan for the same rubric and the same public part. The
 * same saved study builds run under each plan with code checks only. This pure function pairs
 * the answers by authored criterion and source hash, never by evaluation identity, and counts how
 * often a prepared plan disagrees with the curated plan. It makes no claim about which plan is
 * correct.
 */

/** One answer of one observation of one saved build for one authored criterion. */
export interface ParityRow {
  /** The model that prepared the plan, or null for the curated plan. */
  preparationModelId: string | null;
  revisionId: string;
  authoredCriterionId: string;
  /** The content hash of the saved build. The same build has the same hash under each plan. */
  sourceHash: string;
  answer: "met" | "not_met" | "insufficient";
}

/** The combined answer of one plan, one criterion and one build over its observations. */
type ParityAnswer = "met" | "not_met" | "insufficient" | "unstable";

interface ParityCount {
  numerator: number;
  denominator: number;
}

/** The observations of one plan disagree with each other: the noise floor inside one plan. */
interface ParityNoise {
  preparationModelId: string | null;
  revisionId: string;
  /** Cells whose observations give different definite answers. */
  unstable: ParityCount;
}

interface ParityModelReport {
  preparationModelId: string;
  revisionId: string;
  /** Cells of the criterion and build on both sides. */
  pairs: number;
  /** Pairs with a definite and stable answer on both sides, and the pairs that disagree. */
  disagreement: ParityCount;
  /** Pairs with an insufficient answer on one side or both. They stay apart, not in the rate. */
  insufficient: number;
  /** Pairs with unstable observations on one side or both. They stay apart, not in the rate. */
  unstable: number;
  /** Cells that only one side has, for example a criterion that one plan does not check. */
  unmatched: number;
}

export interface PreparationParityReport {
  curatedRevisionId: string;
  noise: ParityNoise[];
  models: ParityModelReport[];
  limitation: string;
}

/** Combine the observations of one cell. Any insufficient observation gives insufficient. */
function parityAnswer(answers: ParityRow["answer"][]): ParityAnswer {
  if (!answers.length) throw new Error("A parity cell needs at least one observation");
  if (answers.includes("insufficient")) return "insufficient";
  return answers.every((answer) => answer === answers[0]) ? answers[0]! : "unstable";
}

function cells(rows: ParityRow[]): Map<string, ParityAnswer> {
  const grouped = new Map<string, ParityRow["answer"][]>();
  for (const row of rows) {
    const key = `${row.authoredCriterionId}\u0000${row.sourceHash}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row.answer]);
  }
  return new Map([...grouped].map(([key, answers]) => [key, parityAnswer(answers)]));
}

/**
 * Pair each prepared plan with the curated plan by authored criterion and source hash. The
 * disagreement rate counts only pairs with definite and stable answers on both sides. The cells
 * of one build are not independent, so the report gives counts and no interval.
 */
export function preparationParity(rows: ParityRow[]): PreparationParityReport {
  const plans = new Map<string, { model: string | null; revisionId: string; rows: ParityRow[] }>();
  for (const row of rows) {
    const key = `${row.preparationModelId ?? ""}\u0000${row.revisionId}`;
    const plan = plans.get(key) ?? {
      model: row.preparationModelId,
      revisionId: row.revisionId,
      rows: [],
    };
    plan.rows.push(row);
    plans.set(key, plan);
  }
  const all = [...plans.values()];
  const curated = all.filter((plan) => plan.model === null);
  if (curated.length !== 1) throw new Error("A parity study compares exactly one curated plan");
  const prepared = all.filter((plan) => plan.model !== null);
  if (new Set(prepared.map((plan) => plan.model)).size !== prepared.length)
    throw new Error("A parity study compares one plan for each preparation model");
  const reference = cells(curated[0]!.rows);
  const noise = all.map((plan) => {
    const planCells = [...cells(plan.rows).values()];
    return {
      preparationModelId: plan.model,
      revisionId: plan.revisionId,
      unstable: {
        numerator: planCells.filter((answer) => answer === "unstable").length,
        denominator: planCells.filter((answer) => answer !== "insufficient").length,
      },
    };
  });
  const models = prepared
    .sort((a, b) => a.model!.localeCompare(b.model!))
    .map((plan) => {
      const candidate = cells(plan.rows);
      const keys = [...new Set([...reference.keys(), ...candidate.keys()])];
      let pairs = 0,
        compared = 0,
        disagreements = 0,
        insufficient = 0,
        unstable = 0,
        unmatched = 0;
      for (const key of keys) {
        const left = reference.get(key),
          right = candidate.get(key);
        if (!left || !right) {
          unmatched += 1;
          continue;
        }
        pairs += 1;
        if (left === "insufficient" || right === "insufficient") insufficient += 1;
        else if (left === "unstable" || right === "unstable") unstable += 1;
        else {
          compared += 1;
          if (left !== right) disagreements += 1;
        }
      }
      return {
        preparationModelId: plan.model!,
        revisionId: plan.revisionId,
        pairs,
        disagreement: { numerator: disagreements, denominator: compared },
        insufficient,
        unstable,
        unmatched,
      };
    });
  return {
    curatedRevisionId: curated[0]!.revisionId,
    noise,
    models,
    limitation:
      "A disagreement shows that two plans answer differently. It does not show which plan is correct. The cells of one build are not independent.",
  };
}
