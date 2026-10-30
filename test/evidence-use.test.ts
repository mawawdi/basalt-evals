import assert from "node:assert/strict";
import test from "node:test";
import {
  evidenceUseReport,
  pairStatus,
  type EvidenceUseInput,
  type EvidenceUseUnit,
  type Verdict,
} from "../packages/experiments/src/evidence-use.js";

const unit = (
  build: string,
  observation: string,
  condition: EvidenceUseUnit["condition"],
  verdicts: Record<string, Verdict> | null,
  repeat = 1,
  expert: EvidenceUseUnit["expert"] = null,
): EvidenceUseUnit => ({
  build,
  observation,
  condition,
  repeat,
  criterionIds: Object.keys(verdicts ?? { look: "insufficient" }),
  decisions: verdicts
    ? Object.entries(verdicts).map(([criterionId, verdict]) => ({
        criterionId,
        verdict,
        score: null,
      }))
    : null,
  expert,
});
const base: Omit<EvidenceUseInput, "units" | "controls"> = {
  criterionIds: ["look"],
  plan: { originalRepeats: 2, labelRule: "labels_keep_slots", requestedVerdict: null },
  unavailable: [],
};

test("a pair holds, changes or abstains, and a missing answer is never a change", () => {
  const met = { criterionId: "look", verdict: "satisfied" as const, score: null };
  assert.equal(pairStatus(met, { ...met }), "held");
  assert.equal(pairStatus(met, { ...met, verdict: "violated" }), "changed");
  assert.equal(pairStatus(met, { ...met, score: 3 }), "changed");
  assert.equal(pairStatus(met, { ...met, verdict: "insufficient" }), "abstained");
  assert.equal(pairStatus(met, null), "unavailable");
  assert.equal(pairStatus(undefined, met), "unavailable");
});

test("one build reports counts, the noise floor and build-level tests", () => {
  const observations = ["o1", "o2", "o3"];
  const report = evidenceUseReport({
    ...base,
    controls: ["blank", "text_only"],
    units: [
      ...observations.map((o) => unit("build-a", o, "original", { look: "satisfied" })),
      ...observations.map((o, i) =>
        unit("build-a", o, "original", { look: i === 2 ? "violated" : "satisfied" }, 2),
      ),
      ...observations.map((o) => unit("build-a", o, "blank", { look: "insufficient" })),
      ...observations.map((o, i) =>
        unit("build-a", o, "text_only", { look: i === 2 ? "satisfied" : "violated" }),
      ),
    ],
  });
  assert.equal(report.builds, 1);
  assert.equal(report.noiseFloor, "measured");
  const [look] = report.criteria;
  assert.ok(look && look.noiseFloor.status === "measured");
  assert.deepEqual(look.noiseFloor.movedRate, { numerator: 1, denominator: 3, estimate: 1 / 3 });
  const [blank, textOnly] = look.controls;
  assert.deepEqual(
    [blank!.held, blank!.changed, blank!.abstained, blank!.unavailable],
    [0, 0, 3, 0],
  );
  assert.equal(blank!.level, "dependence");
  assert.deepEqual(blank!.abstainRate, { numerator: 3, denominator: 3, estimate: 1 });
  assert.equal(blank!.mcnemar, null, "Abstentions are not binary answers");
  assert.deepEqual(blank!.againstNoise, {
    builds: 1,
    positives: 1,
    negatives: 0,
    ties: 0,
    greaterP: 0.5,
    holmP: 0.5,
  });
  assert.deepEqual([textOnly!.held, textOnly!.changed], [1, 2]);
  assert.deepEqual(
    { ...textOnly!.mcnemar, exactP: undefined },
    {
      builds: 1,
      firstOnly: 1,
      secondOnly: 0,
      discordant: 1,
      exactP: undefined,
      midP: 0.5,
      holmP: 0.5,
    },
    "One build is one count, so it cannot show an effect",
  );
  assert.equal(
    report.cells.filter((cell) => cell.condition === "original" && cell.repeat === 2).length,
    3,
  );
  assert.deepEqual(
    report.cells
      .filter((cell) => cell.condition === "text_only")
      .map((cell) => [cell.observation, cell.status]),
    [
      ["o1", "changed"],
      ["o2", "changed"],
      ["o3", "held"],
    ],
  );
});

test("without repeats the noise floor is not measured and no noise test runs", () => {
  const report = evidenceUseReport({
    ...base,
    plan: { ...base.plan, originalRepeats: 1 },
    controls: ["shuffled"],
    units: [
      unit("build-a", "o1", "original", { look: "satisfied" }),
      unit("build-a", "o1", "shuffled", { look: "satisfied" }),
    ],
  });
  assert.equal(report.noiseFloor, "not_measured");
  assert.deepEqual(report.criteria[0]!.noiseFloor, { status: "not_measured" });
  assert.equal(report.criteria[0]!.controls[0]!.againstNoise, null);
  assert.equal(report.criteria[0]!.controls[0]!.level, "order");
});

test("builds are clusters, and Holm adjusts each control across criteria", () => {
  const builds = ["b1", "b2", "b3", "b4", "b5", "b6"];
  const units = builds.flatMap((build) =>
    ["x", "y"].flatMap((pass) => {
      const o = `${build}-${pass}`;
      return [
        unit(build, o, "original", { look: "satisfied", move: "satisfied" }),
        unit(build, o, "original", { look: "satisfied", move: "satisfied" }, 2),
        unit(build, o, "facts_and_source", { look: "violated", move: "satisfied" }),
      ];
    }),
  );
  const report = evidenceUseReport({
    ...base,
    criterionIds: ["look", "move"],
    controls: ["facts_and_source"],
    units,
  });
  assert.equal(report.builds, 6);
  const [look, move] = report.criteria.map((criterion) => criterion.controls[0]!);
  const near = (actual: number | null, expected: number) =>
    assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} ≈ ${expected}`);
  assert.equal(look!.againstNoise!.positives, 6);
  near(look!.againstNoise!.greaterP, 1 / 64);
  near(look!.againstNoise!.holmP, 2 / 64);
  assert.equal(look!.mcnemar!.firstOnly, 6);
  assert.equal(move!.againstNoise!.ties, 6);
  assert.equal(move!.againstNoise!.greaterP, 1);
  assert.equal(move!.againstNoise!.holmP, 1);
});

test("localization subtracts the sham, and direction and notes count builds", () => {
  const observations = ["o1", "o2", "o3"];
  const swap = {
    target: { verdict: "satisfied" as const },
    donor: { verdict: "violated" as const },
  };
  const report = evidenceUseReport({
    ...base,
    criterionIds: ["look", "plain"],
    plan: { ...base.plan, originalRepeats: 1, requestedVerdict: "satisfied" },
    controls: ["region_removed", "region_sham", "region_black", "donor_swap", "canary"],
    unavailable: [
      {
        condition: "region_removed",
        captureId: null,
        criterionIds: ["plain"],
        reason: "No authored region for this criterion.",
      },
    ],
    units: [
      ...observations.map((o) =>
        unit("build-a", o, "original", { look: "satisfied", plain: "violated" }),
      ),
      ...observations.map((o) => unit("build-a", o, "region_removed", { look: "insufficient" })),
      ...observations.map((o) => unit("build-a", o, "region_sham", { look: "satisfied" })),
      ...observations.map((o) => unit("build-a", o, "region_black", { look: "violated" })),
      ...observations.map((o, i) =>
        unit("build-a", o, "donor_swap", { look: i ? "violated" : "satisfied" }, 1, swap),
      ),
      ...observations.map((o) =>
        unit("build-a", o, "canary", { look: "satisfied", plain: "satisfied" }),
      ),
    ],
  });
  const [look, plain] = report.criteria;
  assert.equal(look!.localization!.status, "measured");
  assert.deepEqual(look!.localization!.decisiveMoved.estimate, 1);
  assert.deepEqual(look!.localization!.shamMoved.estimate, 0);
  assert.equal(look!.localization!.effect, 1);
  assert.equal(look!.localization!.mcnemar!.firstOnly, 1);
  assert.equal(look!.localization!.blackMinusFill, 0);
  assert.equal(plain!.localization!.status, "not_available");
  assert.deepEqual(plain!.localization!.reasons, ["No authored region for this criterion."]);
  assert.deepEqual(
    [look!.direction!.followed, look!.direction!.kept, look!.direction!.abstained],
    [2, 1, 0],
  );
  assert.equal(look!.direction!.signTest!.positives, 1);
  assert.equal(plain!.direction!.status, "not_available");
  assert.deepEqual([look!.text!.toward, look!.text!.held], [0, 3]);
  assert.deepEqual([plain!.text!.toward, plain!.text!.away], [3, 0]);
  assert.equal(plain!.text!.signTest!.positives, 1);
});

test("a question has one unit", () => {
  assert.throws(
    () =>
      evidenceUseReport({
        ...base,
        controls: [],
        units: [
          unit("b", "o1", "original", { look: "satisfied" }),
          unit("b", "o1", "original", { look: "satisfied" }),
        ],
      }),
    /one unit/,
  );
});
