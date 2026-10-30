import { hashJson } from "../../contracts/src/index.js";
import type { EvalRevision } from "./compiler.js";
import type { AuthoredCriterion } from "./input.js";

/** One authored criterion of one revision, with the executable criteria that check it. */
interface PairedCriterionSide {
  criterionId: string;
  textHash: string;
  executableIds: string[];
}

/** The executable criteria of a pair. A null side has no executable criterion to match. */
interface ExecutablePair {
  from: string | null;
  to: string | null;
}

interface CriterionPair {
  from: PairedCriterionSide;
  to: PairedCriterionSide;
  /** True when the pair has the same criterion ID and different text. */
  textChanged: boolean;
  executables: ExecutablePair[];
}

interface CriterionPairing {
  pairs: CriterionPair[];
  /** Criteria of the target revision that have no pair in the source revision. */
  added: PairedCriterionSide[];
  /** Criteria of the source revision that have no pair in the target revision. */
  removed: PairedCriterionSide[];
}

type PairingRevision = Pick<EvalRevision, "authored" | "criterionMappings">;

/** The identity of the text of an authored criterion. A rubric edit can renumber the IDs. */
export function criterionTextHash(criterion: Pick<AuthoredCriterion, "text">): string {
  return hashJson(criterion.text);
}

/**
 * Pair the authored criteria of two revisions. Criterion IDs come from the position in the
 * rubric, so equal text pairs first. Then a criterion that keeps its ID with different text
 * pairs, and is marked as changed. The other criteria are added or removed.
 */
export function pairCriteria(from: PairingRevision, to: PairingRevision): CriterionPairing {
  const source = from.authored.criteria.map((criterion) => side(from, criterion));
  const target = to.authored.criteria.map((criterion) => side(to, criterion));
  const paired = new Map<number, number>();
  const used = new Set<number>();
  // Equal text pairs first. Among equal texts, the same ID is preferred over the first one.
  source.forEach((item, index) => {
    const candidates = target
      .map((candidate, position) => ({ candidate, position }))
      .filter(
        ({ candidate, position }) => !used.has(position) && candidate.textHash === item.textHash,
      );
    const match =
      candidates.find(({ candidate }) => candidate.criterionId === item.criterionId) ??
      candidates[0];
    if (!match) return;
    paired.set(index, match.position);
    used.add(match.position);
  });
  source.forEach((item, index) => {
    if (paired.has(index)) return;
    const position = target.findIndex(
      (candidate, place) => !used.has(place) && candidate.criterionId === item.criterionId,
    );
    if (position < 0) return;
    paired.set(index, position);
    used.add(position);
  });
  const pairs = [...paired]
    .sort((left, right) => left[1] - right[1])
    .map(([index, position]) => {
      const left = source[index]!;
      const right = target[position]!;
      return {
        from: left,
        to: right,
        textChanged: left.textHash !== right.textHash,
        executables: executablePairs(left.executableIds, right.executableIds),
      };
    });
  return {
    pairs,
    added: target.filter((_, position) => !used.has(position)),
    removed: source.filter((_, index) => !paired.has(index)),
  };
}

function side(revision: PairingRevision, criterion: AuthoredCriterion): PairedCriterionSide {
  return {
    criterionId: criterion.id,
    textHash: criterionTextHash(criterion),
    executableIds: [
      ...new Set(
        revision.criterionMappings
          .filter(
            (mapping) =>
              mapping.authoredCriterionId === criterion.id &&
              mapping.executableCriterionId !== null,
          )
          .map((mapping) => mapping.executableCriterionId!),
      ),
    ],
  };
}

/**
 * Equal executable IDs pair first. The other executable criteria pair in their sequence, so a
 * renamed check is compared with the check that it replaced. A surplus side pairs with null.
 */
function executablePairs(from: string[], to: string[]): ExecutablePair[] {
  const shared = from.filter((id) => to.includes(id));
  const restFrom = from.filter((id) => !shared.includes(id));
  const restTo = to.filter((id) => !shared.includes(id));
  return [
    ...shared.map((id) => ({ from: id, to: id })),
    ...Array.from({ length: Math.max(restFrom.length, restTo.length) }, (_, index) => ({
      from: restFrom[index] ?? null,
      to: restTo[index] ?? null,
    })),
  ];
}
