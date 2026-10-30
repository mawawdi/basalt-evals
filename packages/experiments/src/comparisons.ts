import type {
  ComparisonCell,
  ComparisonCompatibility,
  ComparisonPair,
  ComparisonPopulation,
  RunComparison,
} from "../../contracts/src/comparisons.js";
import type { AnswerCounts } from "../../contracts/src/catalog.js";

const severity: Record<ComparisonCompatibility, number> = {
  direct: 0,
  descriptive: 1,
  incompatible: 2,
};

/**
 * Every pair of the selected runs, in the order that a person chose them. The comparison has
 * the classification of its worst pair. Matching generation ordinals never create pairs.
 */
export function comparisonSet(
  populations: ComparisonPopulation[],
): Pick<RunComparison, "pairs" | "compatibility"> {
  if (populations.length < 2 || populations.length > 6)
    throw new Error("A comparison needs two to six runs.");
  if (new Set(populations.map((item) => item.operationId)).size !== populations.length)
    throw new Error("A comparison can include each run one time.");
  const pairs: ComparisonPair[] = [];
  for (let left = 0; left < populations.length; left++)
    for (let right = left + 1; right < populations.length; right++)
      pairs.push({
        left: populations[left]!.operationId,
        right: populations[right]!.operationId,
        ...comparisonCompatibility(populations[left]!, populations[right]!),
      });
  return {
    pairs,
    compatibility: pairs.reduce<ComparisonCompatibility>(
      (worst, pair) =>
        severity[pair.compatibility] > severity[worst] ? pair.compatibility : worst,
      "direct",
    ),
  };
}

/**
 * A source run and its reassessments checked the same saved evidence. Each of them keeps only
 * the answers in the scope that all of them checked. Then every run of the set keeps only the
 * criteria of that scope, so that each pair compares the same criteria. The scope records the
 * answers that it excluded from each run. A set without a reassessment keeps every answer.
 */
export function sharedEvidenceScope(
  populations: ComparisonPopulation[],
): Pick<RunComparison, "populations" | "scope"> {
  const family = (population: ComparisonPopulation) =>
    population.sourceOperationId ?? population.operationId;
  const key = (cell: ComparisonCell) =>
    JSON.stringify([cell.candidateId, cell.captureId, cell.criterionId]);
  const criterion = (cell: ComparisonCell) => JSON.stringify([cell.evaluationId, cell.criterionId]);
  const families = new Map<string, Array<Set<string>>>();
  for (const population of populations)
    families.set(family(population), [
      ...(families.get(family(population)) ?? []),
      new Set(population.cells.map(key)),
    ]);
  const shared = populations.map((population) => {
    const members = families.get(family(population))!;
    return members.length < 2
      ? null
      : population.cells.filter((cell) => members.every((scope) => scope.has(key(cell))));
  });
  // The criteria that every run of the same saved evidence checked.
  const criteria = shared.some((cells) => cells !== null)
    ? shared
        .filter((cells) => cells !== null)
        .map((cells) => new Set(cells.map(criterion)))
        .reduce((left, right) => new Set([...left].filter((item) => right.has(item))))
    : null;
  const scoped = populations.map((population, index) => ({
    ...population,
    cells: (shared[index] ?? population.cells).filter(
      (cell) => criteria === null || criteria.has(criterion(cell)),
    ),
  }));
  return {
    populations: scoped,
    scope: populations.map((population, index) => ({
      operationId: population.operationId,
      decisionsExcluded: population.cells.length - scoped[index]!.cells.length,
    })),
  };
}

/**
 * The answers of two runs that checked the same saved evidence, matched by answer identity.
 * Null when the two runs are not a pair of the same saved evidence.
 */
export function pairedAnswerTransitions(comparison: RunComparison, left: string, right: string) {
  const pair = comparison.pairs.find(
    (item) =>
      (item.left === left && item.right === right) || (item.left === right && item.right === left),
  );
  if (!pair || pair.pairing !== "same_retained_evidence") return null;
  const before = comparison.populations.find((item) => item.operationId === left),
    after = comparison.populations.find((item) => item.operationId === right);
  if (!before || !after) return null;
  const key = (cell: ComparisonCell) =>
    JSON.stringify([
      cell.evaluationId,
      cell.rubricHash,
      cell.candidateId,
      cell.captureId,
      cell.criterionId,
      cell.acquisitionHash,
      cell.scaleHash,
    ]);
  const selected = new Map(after.cells.map((cell) => [key(cell), cell]));
  if (
    selected.size !== after.cells.length ||
    new Set(before.cells.map(key)).size !== before.cells.length
  )
    throw new Error("Paired comparison contains duplicate answer identities");
  if (
    before.cells.length !== selected.size ||
    before.cells.some((cell) => !selected.has(key(cell)))
  )
    return null;
  const rows = before.cells.map((earlier) => {
    const later = selected.get(key(earlier))!;
    const change =
      earlier.outcome === "incomplete" && later.outcome !== "incomplete"
        ? "newly_available"
        : earlier.outcome !== "incomplete" && later.outcome === "incomplete"
          ? "newly_unavailable"
          : earlier.outcome === later.outcome && earlier.score === later.score
            ? "unchanged"
            : "changed";
    return { before: earlier, after: later, change };
  });
  return {
    left,
    right,
    rows,
    newlyAvailable: rows.filter((row) => row.change === "newly_available").length,
    newlyUnavailable: rows.filter((row) => row.change === "newly_unavailable").length,
    changed: rows.filter((row) => row.change === "changed").length,
    unchanged: rows.filter((row) => row.change === "unchanged").length,
  };
}

/** The answers of a set of comparison cells. A check without an answer is unavailable. */
function answerCounts(cells: ComparisonCell[]): AnswerCounts {
  const count = (outcome: ComparisonCell["outcome"]) =>
    cells.filter((cell) => cell.outcome === outcome).length;
  return {
    planned: cells.length,
    met: count("met"),
    rejected: count("rejected"),
    split: count("split"),
    scored: count("scored"),
    insufficient: count("insufficient"),
    unavailable: count("incomplete"),
  };
}

interface ComparisonGridCell extends AnswerCounts {
  operationId: string;
  /** The builds of the run in its own order. "Build n" counts only the builds of that run. */
  builds: Array<{ candidateId: string; number: number; marks: ComparisonCell[] }>;
}
interface ComparisonGridRow {
  criterionId: string;
  statement: string;
  scale: string | null;
  /** One cell for each run, in the order of the comparison. */
  cells: ComparisonGridCell[];
}
export interface ComparisonGrid {
  evaluations: Array<{ evaluationId: string; title: string | null; rows: ComparisonGridRow[] }>;
}

/**
 * The answers of each run grouped by evaluation and criterion. Criteria keep their authored
 * order, and runs keep the order of the comparison. The grid ranks nothing and adds no runs
 * together.
 */
export function comparisonGrid(comparison: Pick<RunComparison, "populations">): ComparisonGrid {
  const evaluations: string[] = [];
  for (const population of comparison.populations)
    for (const cell of population.cells)
      if (!evaluations.includes(cell.evaluationId)) evaluations.push(cell.evaluationId);
  const numbers = comparison.populations.map((population) => {
    const order = new Map<string, number>();
    for (const cell of population.cells)
      if (!order.has(cell.candidateId)) order.set(cell.candidateId, order.size + 1);
    return order;
  });
  return {
    evaluations: evaluations.map((evaluationId) => {
      const cells = comparison.populations.flatMap((population) =>
        population.cells.filter((cell) => cell.evaluationId === evaluationId),
      );
      const criteria = new Map<
        string,
        { order: number; statement: string; scale: string | null }
      >();
      for (const cell of cells) {
        const known = criteria.get(cell.criterionId);
        if (!known || cell.criterionOrder < known.order)
          criteria.set(cell.criterionId, {
            order: cell.criterionOrder,
            statement: known?.statement || cell.statement,
            scale: known?.scale ?? cell.scale,
          });
      }
      const rows = [...criteria.entries()]
        .sort(([leftId, left], [rightId, right]) =>
          left.order !== right.order ? left.order - right.order : leftId < rightId ? -1 : 1,
        )
        .map(([criterionId, criterion]) => ({
          criterionId,
          statement: criterion.statement,
          scale: criterion.scale,
          cells: comparison.populations.map((population, index) => {
            const answers = population.cells.filter(
              (cell) => cell.evaluationId === evaluationId && cell.criterionId === criterionId,
            );
            const builds = new Map<string, ComparisonCell[]>();
            for (const answer of answers)
              builds.set(answer.candidateId, [...(builds.get(answer.candidateId) ?? []), answer]);
            return {
              operationId: population.operationId,
              ...answerCounts(answers),
              builds: [...builds.entries()]
                .map(([candidateId, marks]) => ({
                  candidateId,
                  number: numbers[index]!.get(candidateId)!,
                  marks: [...marks].sort((left, right) => left.pass - right.pass),
                }))
                .sort((left, right) => left.number - right.number),
            };
          }),
        }));
      return {
        evaluationId,
        title:
          comparison.populations
            .flatMap((population) => population.evaluations)
            .find((item) => item.evaluationId === evaluationId)?.title ?? null,
        rows,
      };
    }),
  };
}

function keys(cells: ComparisonCell[], fields: Array<keyof ComparisonCell>) {
  return [
    ...new Set(cells.map((cell) => JSON.stringify(fields.map((field) => cell[field])))),
  ].sort();
}
function equal(left: string[], right: string[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** One pair of runs. Each run makes its own builds, so the builds of two runs never pair. */
export function comparisonCompatibility(
  left: ComparisonPopulation,
  right: ComparisonPopulation,
): Pick<ComparisonPair, "compatibility" | "reasons" | "pairing"> {
  const reasons: string[] = [];
  if (
    !equal(
      keys(left.cells, ["evaluationId", "rubricHash", "criterionId"]),
      keys(right.cells, ["evaluationId", "rubricHash", "criterionId"]),
    )
  )
    return {
      compatibility: "incompatible",
      reasons: [
        "The evaluations or criteria differ between the runs. Compare only a set of criteria that you select in both runs.",
      ],
      pairing: "unpaired",
    };
  const sameEvidence =
    right.sourceOperationId === left.operationId ||
    left.sourceOperationId === right.operationId ||
    (!!left.sourceOperationId && left.sourceOperationId === right.sourceOperationId);
  for (const [key, name] of [
    ["implementation", "Basalt code version"],
    ["build", "compiled Basalt code"],
    ["connector", "Basalt connector version"],
  ] as const) {
    const earlier = left.conditions[key],
      later = right.conditions[key];
    if (earlier === null || earlier === undefined || later === null || later === undefined)
      reasons.push(
        `Basalt did not record the ${name} for both runs. Basalt cannot confirm that it is the same.`,
      );
    else if (JSON.stringify(earlier) !== JSON.stringify(later))
      reasons.push(
        `The ${name} differs between the runs: ${JSON.stringify(earlier)} → ${JSON.stringify(later)}.`,
      );
  }
  if (!sameEvidence) {
    const confounds = (population: ComparisonPopulation) =>
      ((population.conditions.builders as Array<Record<string, unknown>>) ?? [])
        .map(({ environment, transport }) => JSON.stringify({ environment, transport }))
        .sort();
    if (
      !Array.isArray(left.conditions.builders) ||
      !Array.isArray(right.conditions.builders) ||
      [left, right].some((population) =>
        (population.conditions.builders as Array<Record<string, unknown>>).some((builder) =>
          ["environment", "transport"].some(
            (key) => builder[key] === undefined || builder[key] === null,
          ),
        ),
      )
    )
      reasons.push(
        "Basalt did not fully record the builder environment or the provider transport. Basalt cannot confirm that the runs used the same setup.",
      );
    else if (JSON.stringify(confounds(left)) !== JSON.stringify(confounds(right)))
      reasons.push(
        "The builder environment or the provider transport differs between the runs. Examine the recorded values of each run.",
      );
  }
  if (
    !equal(
      keys(left.cells, ["evaluationId", "acquisitionHash"]),
      keys(right.cells, ["evaluationId", "acquisitionHash"]),
    )
  )
    reasons.push("The runs used different settings to record evidence.");
  const sameGrader = equal(
    keys(left.cells, ["evaluationId", "criterionId", "graderIdentity"]),
    keys(right.cells, ["evaluationId", "criterionId", "graderIdentity"]),
  );
  const sameGenerator = equal(
    keys(left.cells, ["evaluationId", "generatorIdentity"]),
    keys(right.cells, ["evaluationId", "generatorIdentity"]),
  );
  if (!sameEvidence && !sameGrader)
    reasons.push(
      "The judge and the evidence differ between the runs. The differences can come from the judge or the evidence, not only from the builder model.",
    );
  if (left.cells.length !== right.cells.length)
    reasons.push(
      "The runs planned different numbers of checks. Each run uses its own number of planned checks as its total.",
    );
  if (
    sameEvidence &&
    !equal(
      keys(left.cells, ["captureId", "candidateId", "criterionId"]),
      keys(right.cells, ["captureId", "candidateId", "criterionId"]),
    )
  )
    reasons.push("The runs checked different parts of the saved evidence.");
  return {
    compatibility: reasons.length ? "descriptive" : "direct",
    reasons: reasons.length
      ? reasons
      : [
          sameEvidence
            ? "Both runs used the same saved evidence, so this comparison shows the differences between the judges. It adds no new builds."
            : sameGenerator
              ? "The runs used the same builder models, tools, evaluations, judge and settings to record evidence. Each run made its own builds, so Basalt does not pair them."
              : "The runs used different builder models or tools with the same evaluations, judge and settings to record evidence. Basalt does not pair the builds.",
        ],
    pairing: sameEvidence && !reasons.length ? "same_retained_evidence" : "unpaired",
  };
}

export function summarizeComparisonPopulation(population: ComparisonPopulation) {
  const scales = [
    ...new Set(population.cells.flatMap((cell) => (cell.scale ? [cell.scale] : []))),
  ].sort();
  return {
    functional: answerCounts(population.cells.filter((cell) => cell.method === "functional")),
    qualitative: answerCounts(population.cells.filter((cell) => cell.method === "qualitative")),
    scores: scales.map((scale) => ({
      scale,
      statement: population.cells.find((cell) => cell.scale === scale)!.statement,
      values: population.cells
        .filter((cell) => cell.scale === scale && cell.score !== null)
        .map((cell) => cell.score!),
      planned: population.cells.filter((cell) => cell.scale === scale).length,
    })),
    independentBuilds: population.independentBuilds,
    captures: population.captures,
    billedUsd: population.billedUsd,
    reservedUsd: population.reservedUsd,
    toolCalls: population.toolCalls,
    elapsedMs: population.elapsedMs,
  };
}
