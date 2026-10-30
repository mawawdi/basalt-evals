import { compareCodeUnits } from "../../contracts/src/index.js";
import {
  COMPARISON_ORDERS,
  EXEMPLAR_COMPARISON_STREAM,
  exemplarVerdict,
  pairOutcome,
  type ComparisonOrder,
  type PairOutcome,
  type PairPreference,
} from "../../contracts/src/exemplars.js";
import {
  acceptanceShares,
  buildOutcome,
  certifyAcceptance,
  chooseRuleSequence,
  failingBuildOutcomes,
  selectiveOutcome,
  type AcceptanceRule,
  type ExpertLabel,
  type SelectiveOutcome,
  type UnitOutcome,
} from "./acceptance.js";
import {
  PRESENTATIONS,
  type ExperimentPlan,
  type Partition,
  type Presentation,
} from "./protocols.js";
import { exactShare, missRateBound } from "./statistics.js";

/*
 * The report of the exemplar comparison stream. It stays separate from the absolute judge.
 * Both streams meet on one metric: the share of builds that a stream decides automatically
 * when its miss rate is certified at the preregistered bound.
 */

/** One answer of the comparison stream, after the order is removed. */
export interface ExemplarComparisonRecord {
  /** A planned capture of the judge calibration. */
  captureId: string;
  criterionId: string;
  /** The position of the exemplar in the authored choice. */
  exemplar: number;
  order: ComparisonOrder;
  /** The build that the answer prefers. Null when no completed answer exists. */
  preference: PairPreference | null;
  /** The judge reported text in the build output that speaks to it. */
  integrityIssue: boolean;
}

/** One build of one stream: its criterion outcomes, its build outcome and its expert label. */
export interface StreamBuild {
  sourceId: string;
  taskId: string;
  expert: ExpertLabel;
  outcome: SelectiveOutcome;
  criteria: Array<UnitOutcome & { expert: ExpertLabel }>;
}

/** The judge rows of the absolute stream, as the analysis reports them. */
interface AbsoluteRow {
  presentation: Presentation;
  partition: Partition;
  rule: AcceptanceRule;
  builds: StreamBuild[];
}

function buildExpert(criteria: Array<{ expert: ExpertLabel }>): ExpertLabel {
  if (criteria.some((item) => item.expert === "violated")) return "violated";
  return criteria.length && criteria.every((item) => item.expert === "satisfied")
    ? "satisfied"
    : null;
}

/**
 * Certify one stream with the selective acceptance functions. The development split chooses
 * whether the rule enters the sequence. The withheld split certifies its miss rate. Without
 * a certificate, the stream escalates every build, so it decides no build automatically.
 */
function boundedAutoDecision(
  stream: Presentation | typeof EXEMPLAR_COMPARISON_STREAM,
  rule: AcceptanceRule,
  development: StreamBuild[],
  withheld: StreamBuild[],
  maxMissRate: number,
  confidence: number,
) {
  const sequence = chooseRuleSequence(
    [rule],
    [{ ruleId: rule.id, builds: development }],
    maxMissRate,
  );
  const certification = certifyAcceptance(
    [rule],
    sequence.ruleIds,
    [{ ruleId: rule.id, builds: withheld }],
    maxMissRate,
    confidence,
  );
  const deployed = certification.certifiedRuleId !== null;
  return {
    stream,
    calibration: sequence.calibration,
    certification,
    autoDecided: acceptanceShares(
      withheld.map((build) => ({
        expert: build.expert,
        outcome: deployed ? build.outcome : ("escalate" as const),
      })),
      confidence,
    ).removalShare,
  };
}

/**
 * Analyze the exemplar comparison stream of a judge calibration. A comparison decides one
 * capture and criterion only when each exemplar has an answer in both orders. A consistent
 * win over each exemplar satisfies the criterion and a consistent loss violates it. A flip
 * or an insufficient answer escalates. The absolute rows use the same criteria and builds
 * for the one shared metric.
 */
export function analyzeExemplarComparison(input: {
  plan: ExperimentPlan;
  required: (evalId: string) => string[];
  absolute: AbsoluteRow[];
  records: ExemplarComparisonRecord[];
  confidence: number;
}) {
  const stream = input.plan.exemplarComparison;
  if (!stream) throw new Error("This plan has no exemplar comparison stream");
  const { plan, confidence } = input;
  for (const item of stream.criteria)
    if (!input.required(item.evalId).includes(item.criterionId))
      throw new Error("An exemplar comparison criterion must be a required criterion of its task");
  const planned = (evalId: string, criterionId: string) =>
    stream.criteria.find((item) => item.evalId === evalId && item.criterionId === criterionId);
  const captureOf = new Map(plan.captures.map((capture) => [capture.id, capture]));
  const answers = new Map<string, PairPreference | null>();
  for (const record of input.records) {
    const capture = captureOf.get(record.captureId);
    const item = capture ? planned(capture.evalId, record.criterionId) : undefined;
    if (
      !item ||
      !Number.isSafeInteger(record.exemplar) ||
      record.exemplar < 0 ||
      record.exemplar >= item.exemplarSourceHashes.length ||
      !(COMPARISON_ORDERS as readonly string[]).includes(record.order) ||
      typeof record.integrityIssue !== "boolean" ||
      (record.preference !== null &&
        !["candidate", "exemplar", "insufficient"].includes(record.preference))
    )
      throw new Error("An exemplar comparison answer is not planned");
    const key = JSON.stringify([
      record.captureId,
      record.criterionId,
      record.exemplar,
      record.order,
    ]);
    if (answers.has(key)) throw new Error("An exemplar comparison answer occurs more than once");
    answers.set(key, record.preference);
  }
  const answer = (captureId: string, criterionId: string, exemplar: number, order: string) =>
    answers.get(JSON.stringify([captureId, criterionId, exemplar, order])) ?? null;
  /** The verdict of one capture and criterion, or null while an answer is absent. */
  const decision = (captureId: string, criterionId: string, exemplars: number) => {
    const outcomes: PairOutcome[] = [];
    for (let exemplar = 0; exemplar < exemplars; exemplar++) {
      const [first, second] = COMPARISON_ORDERS.map((order) =>
        answer(captureId, criterionId, exemplar, order),
      );
      if (!first || !second) return null;
      outcomes.push(pairOutcome(first, second));
    }
    return exemplarVerdict(outcomes);
  };
  const evalIds = [...new Set(stream.criteria.map((item) => item.evalId))].sort(compareCodeUnits);
  const criteriaOf = (evalId: string) => stream.criteria.filter((item) => item.evalId === evalId);
  const sources = plan.sources.filter((source) => evalIds.includes(source.evalId));
  const capturesOf = (sourceId: string, partition: Partition) =>
    plan.captures.filter(
      (capture) => capture.subjectId === sourceId && capture.partition === partition,
    );
  const absoluteRow = (presentation: Presentation, partition: Partition) => {
    const row = input.absolute.find(
      (item) => item.presentation === presentation && item.partition === partition,
    );
    if (!row) throw new Error("The exemplar comparison lacks an absolute judge row");
    return row;
  };
  // The expert labels come from the absolute rows; they do not depend on the presentation.
  const expert = (partition: Partition, sourceId: string, criterionId: string) => {
    const label = absoluteRow("still", partition)
      .builds.find((build) => build.sourceId === sourceId)
      ?.criteria.find((criterion) => criterion.criterionId === criterionId)?.expert;
    if (label === undefined) throw new Error("An exemplar comparison unit lacks its expert label");
    return label;
  };
  const restrict = (builds: StreamBuild[]): StreamBuild[] =>
    sources.map((source) => {
      const build = builds.find((item) => item.sourceId === source.id);
      if (!build) throw new Error("An absolute judge row lacks a planned build");
      const ids = criteriaOf(source.evalId).map((item) => item.criterionId);
      const criteria = build.criteria.filter((criterion) => ids.includes(criterion.criterionId));
      return { ...build, criteria, outcome: buildOutcome(criteria), expert: buildExpert(criteria) };
    });
  const partitions = (["development", "withheld"] as const).map((partition) => {
    const rule = absoluteRow("still", partition).rule;
    const builds: StreamBuild[] = sources.map((source) => {
      const captures = capturesOf(source.id, partition);
      const criteria = criteriaOf(source.evalId).map((item) => ({
        ...selectiveOutcome(
          {
            id: JSON.stringify([source.id, item.criterionId, EXEMPLAR_COMPARISON_STREAM]),
            buildId: source.id,
            criterionId: item.criterionId,
            threshold: null,
            samples: captures.flatMap((capture) => {
              const value = decision(
                capture.id,
                item.criterionId,
                item.exemplarSourceHashes.length,
              );
              return value === null
                ? []
                : [
                    {
                      captureId: capture.id,
                      repeat: 1,
                      family: "registered-grader",
                      decision: value,
                      score: null,
                      truncated: false,
                    },
                  ];
            }),
            // Text that speaks to the judge escalates the unit. It never changes an answer.
            integrityIssue: input.records.some(
              (record) =>
                record.integrityIssue &&
                record.criterionId === item.criterionId &&
                captures.some((capture) => capture.id === record.captureId),
            ),
            // The stream has no image controls of its own. A pilot measures distractors.
            evidenceUseFailed: false,
            expertsDisagree: false,
          },
          // The stream sends one sample of each comparison.
          { ...rule, captures: captures.length, repeats: 1 },
        ),
        expert: expert(partition, source.id, item.criterionId),
      }));
      return {
        sourceId: source.id,
        taskId: source.evalId,
        expert: buildExpert(criteria),
        outcome: buildOutcome(criteria),
        criteria,
      };
    });
    const calls = sources.flatMap((source) =>
      capturesOf(source.id, partition).flatMap((capture) =>
        criteriaOf(source.evalId).flatMap((item) =>
          item.exemplarSourceHashes.flatMap((_, exemplar) =>
            COMPARISON_ORDERS.map((order) => answer(capture.id, item.criterionId, exemplar, order)),
          ),
        ),
      ),
    );
    const shares = acceptanceShares(builds, confidence);
    // A position flip prefers a different build in each order. The cells are pairs of one
    // capture, criterion and exemplar with a build preference in both orders.
    const positionFlips = stream.criteria.map((item) => {
      const cells = sources
        .filter((source) => source.evalId === item.evalId)
        .flatMap((source) =>
          capturesOf(source.id, partition).flatMap((capture) =>
            item.exemplarSourceHashes.map((_, exemplar) => {
              const [first, second] = COMPARISON_ORDERS.map((order) =>
                answer(capture.id, item.criterionId, exemplar, order),
              );
              if (!first || !second) return { member: null, event: null };
              if (first === "insufficient" || second === "insufficient")
                return { member: false, event: null };
              return { member: true, event: first !== second };
            }),
          ),
        );
      return {
        taskId: item.evalId,
        criterionId: item.criterionId,
        flips: exactShare(cells, confidence),
        insufficientPairs: cells.filter((cell) => cell.member === false).length,
      };
    });
    return {
      partition,
      rule,
      intendedCalls: calls.length,
      answeredCalls: calls.filter((value) => value !== null).length,
      missRate: shares.missRate,
      falseRejectionRate: shares.falseRejectionRate,
      removalShare: shares.removalShare,
      escalationShare: shares.escalationShare,
      missRateBound: missRateBound(failingBuildOutcomes(builds), confidence),
      positionFlips,
      builds,
    };
  });
  const [development, withheld] = partitions as [
    (typeof partitions)[number],
    (typeof partitions)[number],
  ];
  return {
    stream: EXEMPLAR_COMPARISON_STREAM,
    maxMissRate: stream.maxMissRate,
    criteria: stream.criteria.map((item) => ({
      taskId: item.evalId,
      criterionId: item.criterionId,
      exemplars: item.exemplarSourceHashes.length,
    })),
    partitions,
    // One metric for each stream on the same criteria and builds.
    boundedAutoDecision: [
      ...PRESENTATIONS.map((presentation) =>
        boundedAutoDecision(
          presentation,
          absoluteRow(presentation, "withheld").rule,
          restrict(absoluteRow(presentation, "development").builds),
          restrict(absoluteRow(presentation, "withheld").builds),
          stream.maxMissRate,
          confidence,
        ),
      ),
      boundedAutoDecision(
        EXEMPLAR_COMPARISON_STREAM,
        withheld.rule,
        development.builds,
        withheld.builds,
        stream.maxMissRate,
        confidence,
      ),
    ],
  };
}
