import assert from "node:assert/strict";
import test from "node:test";
import {
  comparisonCompatibility,
  comparisonGrid,
  comparisonSet,
  summarizeComparisonPopulation,
  pairedAnswerTransitions,
} from "../packages/experiments/src/comparisons.js";
import type { ComparisonPopulation, RunComparison } from "../packages/contracts/src/comparisons.js";

test("frozen comparisons preserve missing denominators, authored scales and independent cohorts", () => {
  const baseline: ComparisonPopulation = {
    operationId: "baseline",
    manifestHash: "manifest",
    kind: "execution",
    sourceOperationId: null,
    title: "Appearance evaluation",
    evaluations: [{ evaluationId: "evaluation", title: "Appearance evaluation" }],
    recordedAt: null,
    conditions: {
      implementation: "commit",
      build: "build",
      connector: "connector",
      builders: [],
    },
    independentBuilds: 1,
    captures: 3,
    billedUsd: 2,
    reservedUsd: 1,
    toolCalls: 4,
    elapsedMs: 100,
    cells: ["met", "incomplete", "scored"].map((outcome, index) => ({
      evaluationId: "evaluation",
      rubricHash: "rubric",
      candidateId: "candidate",
      captureId: `capture-${index}`,
      pass: index + 1,
      evidenceCellId: `cell-${index}`,
      criterionId: "appearance",
      criterionOrder: 0,
      statement: "The scene is readable",
      scale: "authored-ten-point-scale",
      acquisitionHash: "view",
      graderIdentity: "grader",
      generatorIdentity: "builder",
      method: "qualitative",
      outcome: outcome as "met" | "incomplete" | "scored",
      score: index === 2 ? 7 : null,
      scaleHash: "authored-ten-point-scale",
    })),
  };
  const independent = {
    ...baseline,
    operationId: "independent",
    cells: baseline.cells.map((cell) => ({ ...cell, candidateId: "another-candidate" })),
  };
  assert.equal(
    comparisonCompatibility(baseline, independent).pairing,
    "unpaired",
    "Matching capture ordinals do not pair independent builds",
  );
  assert.equal(comparisonCompatibility(baseline, independent).compatibility, "direct");
  for (const key of ["implementation", "build", "connector"]) {
    assert.equal(
      comparisonCompatibility(baseline, {
        ...independent,
        conditions: { ...independent.conditions, [key]: "changed" },
      }).compatibility,
      "descriptive",
      key,
    );
    assert.equal(
      comparisonCompatibility(baseline, {
        ...independent,
        conditions: { ...independent.conditions, [key]: null },
      }).compatibility,
      "descriptive",
      `${key} unknown`,
    );
  }
  const recorded = {
    environment: { studioVersion: "studio", camera: "fixed" },
    transport: "transport",
  };
  assert.equal(
    comparisonCompatibility(
      { ...baseline, conditions: { ...baseline.conditions, builders: [recorded] } },
      {
        ...independent,
        conditions: {
          ...independent.conditions,
          builders: [{ ...recorded, transport: "another-transport" }],
        },
      },
    ).compatibility,
    "descriptive",
  );
  const assessment = {
    ...baseline,
    operationId: "assessment",
    kind: "assessment" as const,
    sourceOperationId: baseline.operationId,
    independentBuilds: 0,
    captures: 0,
    cells: baseline.cells.map((cell) => ({ ...cell, graderIdentity: "new-grader" })),
  };
  assert.equal(comparisonCompatibility(baseline, assessment).pairing, "same_retained_evidence");
  const reassessed = {
    ...assessment,
    cells: assessment.cells.map((cell) =>
      cell.outcome === "incomplete" ? { ...cell, outcome: "met" as const } : cell,
    ),
  };
  const paired: RunComparison = {
    id: "paired",
    createdAt: "",
    populations: [baseline, reassessed],
    scope: [
      { operationId: baseline.operationId, decisionsExcluded: 0 },
      { operationId: reassessed.operationId, decisionsExcluded: 0 },
    ],
    ...comparisonSet([baseline, assessment]),
  };
  const transitions = pairedAnswerTransitions(paired, "baseline", "assessment")!;
  assert.equal(transitions.newlyAvailable, 1);
  assert.equal(transitions.changed, 0);
  assert.equal(transitions.unchanged, 2);
  assert.equal(
    pairedAnswerTransitions(
      { ...paired, pairs: paired.pairs.map((pair) => ({ ...pair, pairing: "unpaired" })) },
      "baseline",
      "assessment",
    ),
    null,
  );
  assert.equal(
    pairedAnswerTransitions(
      {
        ...paired,
        populations: [
          baseline,
          {
            ...reassessed,
            cells: reassessed.cells.map((cell) => ({ ...cell, scaleHash: "other-scale" })),
          },
        ],
      },
      "baseline",
      "assessment",
    ),
    null,
  );
  assert.throws(
    () =>
      pairedAnswerTransitions(
        {
          ...paired,
          populations: [
            baseline,
            { ...reassessed, cells: [...reassessed.cells, reassessed.cells[0]!] },
          ],
        },
        "baseline",
        "assessment",
      ),
    /duplicate/,
  );

  assert.equal(
    comparisonCompatibility(baseline, {
      ...independent,
      cells: independent.cells.map((cell) => ({ ...cell, graderIdentity: "changed-grader" })),
    }).compatibility,
    "descriptive",
  );
  assert.equal(
    comparisonCompatibility(baseline, {
      ...independent,
      cells: independent.cells.map((cell) => ({ ...cell, rubricHash: "changed-rubric" })),
    }).compatibility,
    "incompatible",
  );
  assert.equal(
    comparisonCompatibility(baseline, { ...assessment, cells: assessment.cells.slice(1) }).pairing,
    "unpaired",
  );
  const summary = summarizeComparisonPopulation(baseline);
  assert.deepEqual(summary.qualitative, {
    planned: 3,
    met: 1,
    rejected: 0,
    split: 0,
    scored: 1,
    insufficient: 0,
    unavailable: 1,
  });
  assert.deepEqual(summary.scores, [
    {
      scale: "authored-ten-point-scale",
      statement: "The scene is readable",
      values: [7],
      planned: 3,
    },
  ]);
  assert.equal(summary.independentBuilds, 1);
  assert.equal(summary.reservedUsd, 1);
  const distinct = summarizeComparisonPopulation({
    ...baseline,
    cells: [
      ...baseline.cells,
      {
        ...baseline.cells[2]!,
        criterionId: "performance",
        statement: "Performance is responsive",
        scale: "performance-ten-point-scale",
      },
    ],
  });
  assert.equal(
    distinct.scores.length,
    2,
    "Equal numeric ranges do not pool distinct criterion meanings",
  );
  assert.equal(summarizeComparisonPopulation({ ...baseline, cells: [] }).qualitative.planned, 0);
});

test("A compared run counts split and not enough evidence apart from unavailable answers.", () => {
  const cell = {
    evaluationId: "evaluation",
    rubricHash: "rubric",
    candidateId: "candidate",
    pass: 1,
    evidenceCellId: null,
    criterionId: "appearance",
    criterionOrder: 0,
    statement: "The scene is readable",
    scale: null,
    acquisitionHash: "view",
    graderIdentity: "grader",
    generatorIdentity: null,
    method: "qualitative" as const,
    score: null,
    scaleHash: null,
  };
  const population: ComparisonPopulation = {
    operationId: "sampled",
    manifestHash: "manifest",
    kind: "execution",
    sourceOperationId: null,
    title: "Appearance evaluation",
    evaluations: [{ evaluationId: "evaluation", title: "Appearance evaluation" }],
    recordedAt: null,
    conditions: {},
    independentBuilds: 1,
    captures: 4,
    billedUsd: 0,
    reservedUsd: 0,
    toolCalls: null,
    elapsedMs: null,
    cells: (["met", "split", "insufficient", "incomplete"] as const).map((outcome, index) => ({
      ...cell,
      captureId: `capture-${index}`,
      pass: index + 1,
      outcome,
    })),
  };
  const counts = {
    planned: 4,
    met: 1,
    rejected: 0,
    split: 1,
    scored: 0,
    insufficient: 1,
    unavailable: 1,
  };
  assert.deepEqual(summarizeComparisonPopulation(population).qualitative, counts);
  const [row] = comparisonGrid({ populations: [population] }).evaluations[0]!.rows;
  const { operationId: _operationId, builds: _builds, ...grid } = row!.cells[0]!;
  assert.deepEqual(grid, counts);
});
import {
  blockedComparison,
  certifyMissRate,
  certifyRuleSequence,
  clopperPearsonInterval,
  clopperPearsonLower,
  clopperPearsonUpper,
  disagreementRates,
  exactMcNemar,
  exactShare,
  exactSignTest,
  holmAdjust,
  krippendorffAlpha,
  pairedRatingStatistics,
  quadraticWeightedKappa,
  requiredFailingBuilds,
} from "../packages/experiments/src/statistics.js";

const near = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`);
const round = (value: number) => Math.round(value * 1000) / 1000;

test("exact one-sided bounds match the Clopper–Pearson reference values", () => {
  assert.deepEqual(
    [6, 12, 18, 24].map((n) => round(clopperPearsonUpper(0, n, 0.95))),
    [0.393, 0.221, 0.153, 0.117],
  );
  assert.deepEqual(
    [12, 14, 18, 24].map((n) => round(clopperPearsonLower(n, n, 0.95))),
    [0.779, 0.807, 0.847, 0.883],
  );
  // Reference values come from an exact 40-digit inversion of the binomial tail.
  near(clopperPearsonUpper(3, 20, 0.95), 0.3436638043142818);
  near(clopperPearsonLower(17, 20, 0.95), 0.6563361956857182);
  const interval = clopperPearsonInterval(5, 20);
  near(interval.lower, 0.0865714691014345);
  near(interval.upper, 0.4910458717079575);
  assert.equal(clopperPearsonUpper(0, 0, 0.95), 1);
  assert.equal(clopperPearsonLower(0, 0, 0.95), 0);
  assert.throws(() => clopperPearsonUpper(3, 2, 0.95), /more than trials/);
});

test("a cell where all builds agree keeps a nonzero exact interval and unresolved cells widen it", () => {
  const agree = exactShare(Array.from({ length: 12 }, () => ({ member: true, event: true })));
  assert.equal(agree.estimate, 1);
  near(agree.interval!.lower, 0.025 ** (1 / 12));
  assert.ok(agree.interval!.lower < 1, "The interval does not collapse to zero width");
  const cells = [
    { member: true, event: true },
    ...Array.from({ length: 3 }, () => ({ member: true, event: false })),
    { member: null, event: true },
    { member: null, event: false },
    { member: false, event: true },
  ];
  const share = exactShare(cells);
  assert.deepEqual(
    [share.numerator, share.denominator, share.unresolved, share.estimate],
    [1, 4, 2, null],
  );
  near(share.interval!.lower, clopperPearsonLower(1, 5, 0.975));
  near(share.interval!.upper, clopperPearsonUpper(2, 5, 0.975));
});

test("zero-miss certificates need the reference counts of independent failing builds", () => {
  assert.equal(requiredFailingBuilds(0.1, 0.95), 29);
  assert.equal(requiredFailingBuilds(0.05, 0.95), 59);
  assert.equal(requiredFailingBuilds(0.2, 0.95), 14);
  assert.equal(requiredFailingBuilds(0.2, 0.9), 11);
  const caught = (n: number) => Array.from({ length: n }, () => false);
  const certificate = certifyMissRate(caught(29), 0.1, 0.95);
  assert.equal(certificate.certified, true);
  near(certificate.pValue, 0.04710128697246245);
  assert.ok(certificate.upperBound <= 0.1);
  assert.equal(certifyMissRate(caught(28), 0.1, 0.95).certified, false);
  const unresolved = certifyMissRate([...caught(28), null], 0.1, 0.95);
  assert.deepEqual([unresolved.misses, unresolved.unresolved, unresolved.countedMisses], [0, 1, 1]);
  assert.equal(unresolved.certified, false, "An unresolved label counts as a miss");
  near(certifyMissRate([...caught(45), true], 0.1, 0.95).pValue, 0.04800379962448242);
  assert.equal(certifyMissRate([...caught(44), true], 0.1, 0.95).certified, false);
  assert.equal(certifyMissRate([], 0.1, 0.95).certified, false);
});

test("fixed-sequence testing stops at the first rule that does not certify", () => {
  const caught = Array.from({ length: 29 }, () => false);
  const result = certifyRuleSequence(
    [
      { id: "strict", outcomes: caught },
      { id: "middle", outcomes: caught },
      { id: "loose", outcomes: [...caught.slice(1), true] },
      { id: "loosest", outcomes: caught },
    ],
    0.1,
    0.95,
  );
  assert.deepEqual(
    result.tests.map((item) => [item.ruleId, item.certified]),
    [
      ["strict", true],
      ["middle", true],
      ["loose", false],
    ],
  );
  assert.equal(result.certifiedRuleId, "middle");
  assert.deepEqual(result.untestedRuleIds, ["loosest"]);
  assert.equal(
    certifyRuleSequence([{ id: "strict", outcomes: caught.slice(1) }], 0.1, 0.95).certifiedRuleId,
    null,
  );
  assert.throws(
    () =>
      certifyRuleSequence(
        [
          { id: "same", outcomes: caught },
          { id: "same", outcomes: caught },
        ],
        0.1,
        0.95,
      ),
    /unique/,
  );
});

test("exact sign, McNemar mid-p and Holm values match the reference computations", () => {
  assert.equal(round(exactSignTest(6, 0).greaterP), 0.016);
  assert.equal(round(exactSignTest(7, 1).greaterP), 0.035);
  assert.equal(round(exactSignTest(8, 0).greaterP), 0.004);
  near(exactSignTest(7, 1).greaterP, 9 / 256, 1e-12);
  near(exactSignTest(7, 1).twoSidedP, 18 / 256, 1e-12);
  assert.equal(exactSignTest(0, 0).twoSidedP, 1);
  const mcnemar = exactMcNemar(2, 9);
  near(mcnemar.exactP, 0.0654296875, 1e-12);
  near(mcnemar.midP, 0.03857421875, 1e-12);
  near(exactMcNemar(5, 5).midP, 1, 1e-12);
  assert.deepEqual([exactMcNemar(0, 0).exactP, exactMcNemar(0, 0).midP], [1, 1]);
  holmAdjust([0.01, 0.04, 0.03, 0.005]).forEach((value, index) =>
    near(value, [0.03, 0.06, 0.06, 0.02][index]!, 1e-12),
  );
  assert.deepEqual(holmAdjust([]), []);
});

test("Krippendorff's alpha reproduces the 2011 worked example with four raters and missing values", () => {
  // Krippendorff (2011), "Computing Krippendorff's Alpha-Reliability", section C.
  // A reference implementation (the krippendorff Python package) gives the same values.
  const raters: Array<Array<number | null>> = [
    [1, 2, 3, 3, 2, 1, 4, 1, 2, null, null, null],
    [1, 2, 3, 3, 2, 2, 4, 1, 2, 5, null, 3],
    [null, 3, 3, 3, 2, 3, 4, 2, 2, 5, 1, null],
    [1, 2, 3, 3, 2, 4, 4, 1, 2, 5, 1, null],
  ];
  const units = raters[0]!.map((_, unit) => raters.map((values) => values[unit]!));
  near(krippendorffAlpha(units, "nominal")!, 0.743421052631579, 1e-12);
  near(krippendorffAlpha(units, "ordinal")!, 0.8153875037548814, 1e-12);
  near(krippendorffAlpha(units, "interval")!, 0.8491071428571428, 1e-12);
  assert.equal(round(krippendorffAlpha(units, "ordinal")!), 0.815);
  assert.equal(
    krippendorffAlpha(
      [
        [2, 2],
        [2, null],
      ],
      "ordinal",
    ),
    null,
    "No variation gives no alpha",
  );
});

test("paired ratings give kappa, alpha, error and bias with a deterministic cluster bootstrap", () => {
  const human = [0, 1, 2, 2, 3, 1, 0, 2, 3, 1];
  const automatic = [0, 2, 2, 1, 3, 1, 1, 2, 2, 1];
  near(
    quadraticWeightedKappa(human.map((value, index) => [value, automatic[index]!]))!,
    0.7647058823529411,
    1e-12,
  );
  const pairs = human.map((value, index) => ({
    cluster: `candidate-${Math.floor(index / 2)}`,
    human: index === 3 ? null : { score: value * 10, position: value },
    automatic: { score: automatic[index]! * 10, position: automatic[index]! },
  }));
  const options = { seed: 7, resamples: 2000, confidence: 0.95 };
  const result = pairedRatingStatistics(pairs, options);
  assert.deepEqual([result.pairs, result.compared, result.humanMissing], [10, 9, 1]);
  near(result.ordinalAlpha.value!, 0.8378226711560045, 1e-12);
  const complete = pairs.flatMap((pair) =>
    pair.human ? [[pair.human.position, pair.automatic.position] as [number, number]] : [],
  );
  near(result.quadraticKappa.value!, quadraticWeightedKappa(complete)!, 1e-12);
  near(result.ordinalAlpha.value!, krippendorffAlpha(complete, "ordinal")!, 1e-12);
  near(result.meanAbsoluteError.value!, 30 / 9, 1e-12);
  near(result.signedBias.value!, 10 / 9, 1e-12);
  assert.equal(result.bootstrap.clusters, 5);
  for (const estimate of [result.meanAbsoluteError, result.signedBias])
    assert.ok(estimate.interval!.lower <= estimate.interval!.upper);
  assert.deepEqual(result, pairedRatingStatistics(pairs.slice().reverse(), options));
  const single = pairedRatingStatistics(
    pairs.map((pair) => ({ ...pair, cluster: "one" })),
    options,
  );
  assert.equal(single.meanAbsoluteError.interval, null, "One cluster gives no interval");
});

test("identical-request flips stay separate from cross-capture disagreement", () => {
  const sample = (group: string, capture: string, request: string, decision: string | null) => ({
    group,
    capture,
    request,
    decision,
  });
  const result = disagreementRates([
    sample("g1", "c1", "r1", "satisfied"),
    sample("g1", "c1", "r1", "violated"),
    sample("g1", "c2", "r2", "satisfied"),
    sample("g2", "c4", "r4", "satisfied"),
    sample("g2", "c5", "r5", "violated"),
    sample("g3", "c6", "r6", "satisfied"),
    sample("g3", "c6", "r6", "satisfied"),
    sample("g3", "c7", "r7", "satisfied"),
  ]);
  assert.deepEqual(result.identicalRequestFlips, {
    numerator: 1,
    denominator: 2,
    unresolved: 0,
    estimate: 0.5,
  });
  assert.deepEqual(result.crossCaptureDisagreement, {
    numerator: 1,
    denominator: 2,
    unresolved: 1,
    estimate: null,
  });
  assert.throws(
    () => disagreementRates([sample("g", "c1", "r", "satisfied"), sample("g", "c2", "r", null)]),
    /one capture/,
  );
});

test("blocked comparisons never pair by repetition and count unresolved blocks against the claim", () => {
  const blocks = ["checkpoint", "xp", "shutter", "gate"].flatMap((task) =>
    ["luna", "deepseek"].map((model) => JSON.stringify([task, model])),
  );
  const items = blocks.flatMap((block, index) =>
    [0, 1, 2].flatMap((repetition) => [
      {
        block,
        arm: "baseline" as const,
        outcome: (index === 7 ? repetition < 2 : repetition === 0) ? (1 as const) : (0 as const),
      },
      {
        block,
        arm: "treatment" as const,
        outcome: (index === 7 ? repetition === 0 : true) ? (1 as const) : (0 as const),
      },
    ]),
  );
  const result = blockedComparison(items);
  assert.deepEqual(
    [result.signTest.treatmentBetter, result.signTest.baselineBetter, result.signTest.ties],
    [7, 1, 0],
  );
  assert.equal(round(result.signTest.treatmentBetterP), 0.035);
  near(result.meanDifference.observed!, (7 * (2 / 3) - 1 / 3) / 8, 1e-12);
  assert.deepEqual(result, blockedComparison(items.slice().reverse()));
  const unresolved = blockedComparison(
    items.map((item) =>
      item.block === blocks[0] && item.arm === "treatment" ? { ...item, outcome: null } : item,
    ),
  );
  assert.equal(unresolved.signTest.unresolved, 1);
  near(unresolved.signTest.treatmentBetterP, 37 / 256, 1e-12);
  assert.equal(unresolved.meanDifference.observed, null);
  const ties = blockedComparison(
    items.map((item) =>
      item.block === blocks[6] || item.block === blocks[7]
        ? { ...item, outcome: 1 as const }
        : item,
    ),
  );
  assert.deepEqual([ties.signTest.treatmentBetter, ties.signTest.ties], [6, 2]);
  assert.equal(round(ties.signTest.treatmentBetterP), 0.016);
});
