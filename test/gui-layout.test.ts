import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import {
  assertEvaluatorSpec,
  assertStudioEvidence,
  assertStudioObservation,
  hashJson,
  statedQuantities,
  type CandidateManifest,
  type DeterministicCriterion,
  type EvaluatorSpec,
  type StudioEvidence,
} from "../packages/contracts/src/index.js";
import {
  compileCuratedRevision,
  readCuratedTaskFiles,
} from "../packages/eval-authoring/src/curated-revision.js";
import { checkGuiLayout, type GuiLayoutObservation } from "../packages/graders/src/gui-layout.js";
import { evaluateDeterministicCriteria } from "../packages/graders/src/index.js";
import { loadRegisteredTask, materializeTaskSeed } from "../packages/task-registry/src/index.js";

const hud = "Players.Tester.PlayerGui.Hud";
const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const frame = (name: string, area: ReturnType<typeof rect>, extra: object = {}) => ({
  path: `${hud}.${name}`,
  className: "Frame",
  rect: area,
  clippedRect: area,
  zIndex: 1,
  hasText: false,
  ...extra,
});
const label = (name: string, area: ReturnType<typeof rect>, extra: object = {}) => ({
  path: `${hud}.${name}`,
  className: "TextLabel",
  rect: area,
  clippedRect: area,
  zIndex: 1,
  hasText: true,
  textBounds: { w: 40, h: 14 },
  textSize: 14,
  textScaled: false,
  textWrapped: false,
  textFits: true,
  ...extra,
});
/** An 800 × 600 viewport with a top inset of 36 px. In GUI pixels it starts at y -36. */
function layout(elements: object[], extra: object = {}): GuiLayoutObservation {
  const value = {
    factId: "layout",
    kind: "gui_layout",
    exists: true,
    complete: true,
    screen: rect(0, 0, 800, 564),
    guiInset: { left: 0, top: 36, right: 0, bottom: 0 },
    viewport: { w: 800, h: 600 },
    ignoreGuiInset: false,
    elements,
    ...extra,
  };
  assertStudioObservation(value);
  return value as GuiLayoutObservation;
}
const absentLayout = layout([], {
  exists: false,
  screen: rect(0, 0, 0, 0),
  guiInset: { left: 0, top: 0, right: 0, bottom: 0 },
  viewport: { w: 0, h: 0 },
});

test("on_screen places the viewport in GUI pixels with the recorded inset", () => {
  const verified = checkGuiLayout(
    layout([
      frame("Backdrop", rect(0, -36, 800, 600)),
      frame("TopBar", rect(10, -30, 100, 20)),
      label("Score", rect(10, 540, 100, 20)),
    ]),
    "on_screen",
    null,
  );
  assert.equal(verified.outcome, "verified");
  assert.deepEqual(verified.counts, [3, 0, 0]);
  assert.match(verified.reason, /\(x 0, y -36, 800 × 600 px\)/u);
  // The inset moves the bottom edge to y 564 in GUI pixels, so y 570 is off the screen.
  const low = layout([frame("Footer", rect(10, 550, 100, 20)), frame("Up", rect(10, -40, 9, 9))]);
  const rejected = checkGuiLayout(low, "on_screen", null);
  assert.equal(rejected.outcome, "rejected");
  assert.deepEqual(rejected.counts, [2, 2, 0]);
  assert.match(rejected.reason, /^2 visible elements extend outside the viewport/u);
  assert.match(rejected.reason, /Hud\.Footer at \(x 10, y 550, 100 × 20 px\)/u);
  assert.match(rejected.reason, /Hud\.Up at/u);
  // Without an inset the same rectangles lie on the screen, except the one above y 0.
  const flat = { guiInset: { left: 0, top: 0, right: 0, bottom: 0 }, screen: rect(0, 0, 800, 600) };
  const noInset = checkGuiLayout(
    layout([frame("Footer", rect(10, 550, 100, 20)), frame("Up", rect(10, -40, 9, 9))], flat),
    "on_screen",
    null,
  );
  assert.deepEqual(noInset.counts, [2, 1, 0]);
  assert.doesNotMatch(noInset.reason, /Footer/u);
  // The formula is the same for both values of IgnoreGuiInset.
  assert.deepEqual(
    checkGuiLayout(
      layout(low.elements, { ignoreGuiInset: true, screen: rect(0, -36, 800, 600) }),
      "on_screen",
      null,
    ).counts,
    rejected.counts,
  );
  // An element that shows nothing cannot be off the screen.
  const { clippedRect: _clipped, ...hidden } = frame("Hidden", rect(900, 900, 50, 50));
  const nothing = checkGuiLayout(
    layout([hidden, frame("Anchor", rect(-50, -50, 0, 0))]),
    "on_screen",
    null,
  );
  assert.equal(nothing.outcome, "verified");
  assert.deepEqual(nothing.counts, [0, 0, 0]);
  // A rejection names the first five offenders.
  const many = checkGuiLayout(
    layout(Array.from({ length: 7 }, (_, index) => frame(`Off${index}`, rect(790, 0, 20, 20)))),
    "on_screen",
    null,
  );
  assert.equal(many.outcome, "rejected");
  assert.equal(many.reason.match(/Hud\.Off\d/gu)?.length, 5);
  assert.match(many.reason, /; and 2 more$/u);
});

test("a GUI layout check is incomplete without a whole layout", () => {
  for (const check of ["on_screen", "no_text_overlap", "text_fits"] as const) {
    const missing = checkGuiLayout(null, check, null);
    assert.equal(missing.outcome, "incomplete");
    assert.equal(missing.counts, null);
    assert.match(missing.reason, /absent/u);
    const absent = checkGuiLayout(absentLayout, check, null);
    assert.equal(absent.outcome, "incomplete");
    assert.match(absent.reason, /No ScreenGui exists/u);
    const partial = checkGuiLayout(
      layout([label("Score", rect(0, 0, 100, 20))], { complete: false }),
      check,
      null,
    );
    assert.equal(partial.outcome, "incomplete");
    assert.deepEqual(partial.counts, [1, 0, 0]);
    assert.match(partial.reason, /left out visible elements/u);
  }
  assert.equal(checkGuiLayout(absentLayout, "min_text_px", 14).outcome, "incomplete");
  // A known offender rejects, also when the layout left out elements.
  const partialOffender = checkGuiLayout(
    layout([frame("Off", rect(790, 0, 20, 20))], { complete: false }),
    "on_screen",
    null,
  );
  assert.equal(partialOffender.outcome, "rejected");
  // Only min_text_px has a minimum.
  assert.throws(() => checkGuiLayout(absentLayout, "min_text_px", null), /min_text_px/u);
  assert.throws(() => checkGuiLayout(absentLayout, "text_fits", 14), /min_text_px/u);
});

test("no_text_overlap ignores an ancestor pair, a frame and a common edge", () => {
  const clean = checkGuiLayout(
    layout([
      frame("Panel", rect(0, 0, 300, 100)),
      label("Title", rect(0, 0, 100, 20)),
      label("Score", rect(100, 0, 100, 20)),
      label("Button", rect(0, 40, 200, 40), { className: "TextButton" }),
      label("Button.Caption", rect(10, 50, 100, 20)),
    ]),
    "no_text_overlap",
    null,
  );
  assert.equal(clean.outcome, "verified");
  assert.deepEqual(clean.counts, [4, 0, 0]);
  const { clippedRect: _clipped, ...scrolledAway } = label("Old", rect(0, 0, 100, 20));
  const overlap = checkGuiLayout(
    layout([
      label("Title", rect(0, 0, 100, 20)),
      label("Score", rect(50, 0, 100, 20)),
      label("Name", rect(0, 60, 100, 20)),
      label("Name", rect(0, 70, 100, 20)),
      scrolledAway,
    ]),
    "no_text_overlap",
    null,
  );
  assert.equal(overlap.outcome, "rejected");
  assert.deepEqual(overlap.counts, [4, 2, 0]);
  assert.match(overlap.reason, /^2 pairs of text elements overlap/u);
  assert.match(overlap.reason, /Hud\.Title and .*Hud\.Score share 50 × 20 px/u);
  // Two siblings with one name are two elements, not an element and its ancestor.
  assert.match(overlap.reason, /Hud\.Name and .*Hud\.Name share 100 × 10 px/u);
});

test("text_fits counts a TextScaled element only when Studio reports that its text fits", () => {
  const fits = checkGuiLayout(
    layout([
      frame("Panel", rect(0, 0, 300, 100)),
      label("Score", rect(0, 0, 100, 20)),
      label("Banner", rect(0, 30, 100, 20), { textScaled: true }),
    ]),
    "text_fits",
    null,
  );
  assert.equal(fits.outcome, "verified");
  assert.deepEqual(fits.counts, [2, 0, 0]);
  const overflow = checkGuiLayout(
    layout([
      label("Score", rect(0, 0, 30, 20), { textFits: false, textBounds: { w: 42, h: 14 } }),
      label("Banner", rect(0, 30, 100, 20), { textScaled: true, textFits: false }),
    ]),
    "text_fits",
    null,
  );
  assert.equal(overflow.outcome, "rejected");
  assert.deepEqual(overflow.counts, [2, 2, 0]);
  assert.match(overflow.reason, /^2 text elements do not fit their text/u);
  assert.match(overflow.reason, /Hud\.Score \(text 42 × 14 px in 30 × 20 px\)/u);
  assert.match(overflow.reason, /Hud\.Banner \(.*, TextScaled\)/u);
});

test("min_text_px reads TextSize and cannot decide a TextScaled element", () => {
  const large = checkGuiLayout(
    layout([
      label("Score", rect(0, 0, 100, 20)),
      label("Title", rect(0, 30, 100, 30), { textSize: 24 }),
    ]),
    "min_text_px",
    14,
  );
  assert.equal(large.outcome, "verified");
  assert.deepEqual(large.counts, [2, 0, 0]);
  assert.match(large.reason, /at least 14 px/u);
  const small = checkGuiLayout(
    layout([
      label("Score", rect(0, 0, 100, 20), { textSize: 12 }),
      label("Title", rect(0, 30, 100, 30)),
    ]),
    "min_text_px",
    14,
  );
  assert.equal(small.outcome, "rejected");
  assert.deepEqual(small.counts, [2, 1, 0]);
  assert.match(
    small.reason,
    /^1 text element has a TextSize below 14 px: .*Hud\.Score \(TextSize 12\)$/u,
  );
  const scaled = checkGuiLayout(
    layout([
      label("Score", rect(0, 0, 100, 20)),
      label("Banner", rect(0, 30, 100, 30), { textScaled: true, textSize: 8 }),
    ]),
    "min_text_px",
    14,
  );
  assert.equal(scaled.outcome, "incomplete");
  assert.deepEqual(scaled.counts, [2, 0, 1]);
  assert.match(scaled.reason, /uses TextScaled.*Hud\.Banner$/u);
  // A known small text rejects before an undecided TextScaled element.
  const both = checkGuiLayout(
    layout([
      label("Score", rect(0, 0, 100, 20), { textSize: 10 }),
      label("Banner", rect(0, 30, 100, 30), { textScaled: true }),
    ]),
    "min_text_px",
    14,
  );
  assert.equal(both.outcome, "rejected");
  assert.deepEqual(both.counts, [2, 1, 1]);
});

test("statedQuantities reads a value only in digits and in the asked unit", () => {
  assert.deepEqual(statedQuantities("a contrast of at least 4.5:1", "ratio"), [4.5]);
  assert.deepEqual(statedQuantities("a contrast of 4.5 : 1 or more", "ratio"), [4.5]);
  assert.deepEqual(statedQuantities("text of at least 14 px", "px"), [14]);
  assert.deepEqual(statedQuantities("text of at least 14px.", "px"), [14]);
  assert.deepEqual(statedQuantities("a 14-pixel minimum and 16 pixels for titles", "px"), [14, 16]);
  assert.deepEqual(statedQuantities("at most 3 buttons", "count"), [3]);
  assert.deepEqual(statedQuantities("at least 90% or 95 percent", "percent"), [90, 95]);
  assert.deepEqual(statedQuantities("under 512 MB", "mb"), [512]);
  assert.deepEqual(statedQuantities("within 1.5 s", "ms"), [1500]);
  // A mismatched unit states no value.
  assert.deepEqual(statedQuantities("text of at least 14 px", "count"), []);
  assert.deepEqual(statedQuantities("text of at least 14 px", "ratio"), []);
  assert.deepEqual(statedQuantities("a contrast of at least 4.5:1", "px"), []);
  assert.deepEqual(statedQuantities("within 300 ms", "count"), []);
  assert.deepEqual(statedQuantities("at least 14 studs", "px"), []);
  // A name, a digit group, a time of day, another ratio and a decimal count are not values.
  assert.deepEqual(statedQuantities("Level2 at 12:30 with 1,000 coins in 3D", "count"), []);
  assert.deepEqual(statedQuantities("an aspect of 16:9", "ratio"), []);
  assert.deepEqual(statedQuantities("2.5 lives", "count"), []);
  assert.deepEqual(statedQuantities("at least fourteen pixels", "px"), []);
});

const repository = resolve(process.cwd());
const layoutRule = (check: string, minimum: object | null = null, fact: object = hudFact) =>
  ({ kind: "gui_layout_holds", fact, check, minimum }) as unknown as DeterministicCriterion["rule"];
const hudFact = { phaseId: "motion", factId: "hud" };
const fourteen = { value: 14, quote: "text of at least 14 px" };

/** The moving platform task, with a gui_layout fact and the four GUI layout checks. */
async function platformWithHud(root: string) {
  const task = await loadRegisteredTask(repository, "tasks/pilot/moving-platform");
  const workspace = resolve(root, "workspace");
  await materializeTaskSeed(repository, task, workspace);
  const files = await inventoryTree(workspace);
  const candidate: CandidateManifest = {
    rootHash: hashJson(files),
    projectFile: "default.project.json",
    files,
  };
  const evaluator: EvaluatorSpec = structuredClone(task.evaluator);
  evaluator.studio.phases[0]!.facts.push({
    id: "hud",
    kind: "gui_layout",
    path: "game.Players.LocalPlayer.PlayerGui.Hud",
  });
  const criterion = (id: string, rule: DeterministicCriterion["rule"]) => ({
    id,
    layer: "engine" as const,
    statement: "The HUD is readable.",
    required: true,
    rule,
  });
  evaluator.deterministic.push(
    criterion("hud-on-screen", layoutRule("on_screen")),
    criterion("hud-no-overlap", layoutRule("no_text_overlap")),
    criterion("hud-fits", layoutRule("text_fits")),
    criterion("hud-text-size", layoutRule("min_text_px", fourteen)),
  );
  assertEvaluatorSpec(evaluator);
  return { workspace, candidate, evaluator };
}

function evidenceWith(
  candidate: CandidateManifest,
  evaluator: EvaluatorSpec,
  observation: GuiLayoutObservation | null,
): StudioEvidence {
  const body: Omit<StudioEvidence, "schema" | "id"> = {
    treatmentId: "tr-gui-layout",
    candidateHash: candidate.rootHash,
    collectionPlanHash: hashJson(evaluator.studio),
    connectorSourceHash: "a".repeat(64),
    connectorArtifactHash: "d".repeat(64),
    place: { file: "candidate.rbxlx", hash: "c".repeat(64) },
    studio: { version: "test", sessionId: "studio-fixture" },
    startedAt: "2026-10-07T00:00:02.000Z",
    endedAt: "2026-10-07T00:00:03.000Z",
    scenarios: [],
    phases: [
      {
        phaseId: "motion",
        observations: [
          { factId: "platform", kind: "instance", exists: true, className: "Part" },
          ...(observation ? [{ ...observation, factId: "hud" }] : []),
        ],
        captures: [],
      },
    ],
  };
  const evidence: StudioEvidence = {
    schema: "basalt-evals/studio-evidence",
    id: `evidence-${hashJson(body).slice(0, 20)}`,
    ...body,
  };
  assertStudioEvidence(evidence);
  return evidence;
}

test("a GUI layout rule grades its bound fact and records the counts", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-gui-layout-"));
  try {
    const { workspace, candidate, evaluator } = await platformWithHud(root);
    const grade = async (observation: GuiLayoutObservation | null) =>
      new Map(
        (
          await evaluateDeterministicCriteria({
            workspaceRoot: workspace,
            evaluator,
            candidate,
            treatmentId: "tr-gui-layout",
            evidence: evidenceWith(candidate, evaluator, observation),
          })
        ).map((item) => [item.criterionId, item]),
      );
    const observation = layout([
      label("Score", rect(10, 10, 100, 20), { textSize: 12 }),
      label("Title", rect(60, 10, 100, 20), { textFits: false }),
      frame("Side", rect(780, 10, 40, 40)),
    ]);
    const graded = await grade(observation);
    assert.deepEqual(
      ["hud-on-screen", "hud-no-overlap", "hud-fits", "hud-text-size"].map((id) => [
        graded.get(id)!.outcome,
        graded.get(id)!.observed,
      ]),
      [
        ["rejected", [3, 1, 0]],
        ["rejected", [2, 1, 0]],
        ["rejected", [2, 1, 0]],
        ["rejected", [2, 1, 0]],
      ],
    );
    assert.deepEqual(graded.get("hud-fits")!.evidence, [
      hashJson({ ...observation, factId: "hud" }),
    ]);
    const missing = await grade(null);
    assert.equal(missing.get("hud-on-screen")!.outcome, "incomplete");
    assert.equal(missing.get("hud-on-screen")!.observed, null);
    assert.match(missing.get("hud-on-screen")!.explanation, /absent/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a GUI layout rule binds one gui_layout fact and only a quoted minimum in px", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-gui-layout-contract-"));
  try {
    const { evaluator } = await platformWithHud(root);
    const variant = (patch: Partial<DeterministicCriterion>) => {
      const copy = structuredClone(evaluator);
      Object.assign(
        copy.deterministic.find((item) => item.id === "hud-text-size")!,
        patch,
      );
      return copy;
    };
    const minimum = (value: unknown) =>
      variant({ rule: layoutRule("min_text_px", value as object) });
    assertEvaluatorSpec(minimum({ value: 14, quote: "text of at least 14px" }));
    assertEvaluatorSpec(minimum({ value: 14.5, quote: "at least 14.5 pixels" }));
    assert.throws(() => assertEvaluatorSpec(variant({ layer: "static" })), /evidence authority/u);
    assert.throws(
      () =>
        assertEvaluatorSpec(
          variant({ rule: layoutRule("text_fits", null, { phaseId: "motion", factId: "errors" }) }),
        ),
      /bind a gui_layout fact/u,
    );
    assert.throws(
      () =>
        assertEvaluatorSpec(
          variant({ rule: layoutRule("text_fits", null, { phaseId: "motion" }) }),
        ),
      /GUI layout phase fact binding/u,
    );
    assert.throws(
      () => assertEvaluatorSpec(variant({ rule: layoutRule("on_top") })),
      /GUI layout check/u,
    );
    assert.throws(() => assertEvaluatorSpec(minimum(null)), /GUI layout minimum/u);
    assert.throws(
      () => assertEvaluatorSpec(minimum({ value: 14, quote: "at least 14 ms" })),
      /states the value 14 in px/u,
    );
    assert.throws(
      () => assertEvaluatorSpec(minimum({ value: 4.5, quote: "at least 4.5:1" })),
      /in px/u,
    );
    assert.throws(
      () => assertEvaluatorSpec(minimum({ value: 16, quote: "text of at least 14 px" })),
      /in px/u,
    );
    assert.throws(
      () => assertEvaluatorSpec(minimum({ value: 14, quote: "readable text" })),
      /in px/u,
    );
    assert.throws(() => assertEvaluatorSpec(minimum({ value: 0, quote: "0 px" })), /above 0 px/u);
    assert.throws(
      () => assertEvaluatorSpec(minimum({ value: 14, quote: "14 px", unit: "px" })),
      /fields/u,
    );
    assert.throws(
      () => assertEvaluatorSpec(variant({ rule: layoutRule("on_screen", fourteen) })),
      /only min_text_px has a minimum/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the compiler needs the quote of a bound in the text of its criterion", async () => {
  const files = await readCuratedTaskFiles(resolve("studies/connector-spike/task"));
  const text = "Every HUD label uses text of at least 14 px.";
  const withBound = (rubricLine: string, quote: string) => {
    const evaluator = structuredClone(files.evaluator);
    evaluator.deterministic.push({
      id: "hud-text-size",
      layer: "engine",
      statement: "A statement that the compile replaces.",
      required: true,
      rule: layoutRule(
        "min_text_px",
        { value: 14, quote },
        {
          phaseId: "hud",
          factId: "layout-full",
        },
      ),
    });
    const map = structuredClone(files.criteriaMap) as { criteria: object[] };
    map.criteria.push({
      authoredCriterionId: "criterion-2",
      text: rubricLine,
      executableCriterionId: "hud-text-size",
      rationale: "The GUI layout fact gives the TextSize of each label.",
    });
    return compileCuratedRevision({
      ...files,
      evaluator,
      rubric: `${files.rubric.trimEnd()}\n- ${rubricLine}\n`,
      criteriaMap: map,
    });
  };
  const quoted = withBound(text, "text of at least 14 px");
  assert.equal(quoted.validation.status, "ready", JSON.stringify(quoted.validation.diagnostics));
  assert.deepEqual(
    quoted.revision?.privateEvaluator.deterministic.find((item) => item.id === "hud-text-size")
      ?.rule,
    layoutRule(
      "min_text_px",
      { value: 14, quote: "text of at least 14 px" },
      {
        phaseId: "hud",
        factId: "layout-full",
      },
    ),
  );
  // The quote states 14 px, but the criterion of the person states no number.
  const invented = withBound("Every HUD label uses readable text.", "text of at least 14 px");
  assert.equal(invented.validation.status, "needs_clarification");
  assert.equal(invented.revision, null);
  assert.deepEqual(
    invented.validation.diagnostics.map((item) => [item.code, item.authoredCriterionId]),
    [["authority_conflict", "criterion-2"]],
  );
  assert.match(invented.validation.diagnostics[0]!.message, /does not contain that quote/u);
});
