import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import {
  assertEvaluatorSpec,
  assertStudioEvidence,
  assertStudioObservation,
  contentHash,
  hashJson,
  type CandidateManifest,
  type DeterministicCriterion,
  type EvaluatorSpec,
  type StudioEvidence,
} from "../packages/contracts/src/index.js";
import type { SceneTextObservation } from "../packages/contracts/src/scene-text.js";
import {
  compileCuratedRevision,
  readCuratedTaskFiles,
} from "../packages/eval-authoring/src/curated-revision.js";
import {
  checkExposure,
  checkTextContrast,
  exposure,
  exposurePercent,
  framePixels,
  guiRectInCapture,
  pixelLuminance,
  textContrast,
  type Raster,
} from "../packages/graders/src/frame-measures.js";
import type { GuiLayoutObservation } from "../packages/graders/src/gui-layout.js";
import { evaluateDeterministicCriteria } from "../packages/graders/src/index.js";
import { loadRegisteredTask, materializeTaskSeed } from "../packages/task-registry/src/index.js";

type Rgb = [number, number, number];
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

function canvas(width: number, height: number, color: Rgb): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) data.set([...color, 255], pixel * 4);
  return { width, height, data };
}
function fill(raster: Raster, x: number, y: number, w: number, h: number, color: Rgb): Raster {
  for (let row = y; row < y + h; row++)
    for (let column = x; column < x + w; column++)
      raster.data.set([...color, 255], (row * raster.width + column) * 4);
  return raster;
}
const whole = (raster: Raster) => ({ x: 0, y: 0, width: raster.width, height: raster.height });

test("relative luminance follows the WCAG formula", () => {
  assert.equal(pixelLuminance(canvas(1, 1, BLACK), 0), 0);
  assert.equal(pixelLuminance(canvas(1, 1, WHITE), 0), 1);
  // The sRGB code 128 is 0.2158605 in linear light.
  assert.ok(Math.abs(pixelLuminance(canvas(1, 1, [128, 128, 128]), 0) - 0.2158605) < 1e-6);
  // Green has the largest weight.
  assert.ok(Math.abs(pixelLuminance(canvas(1, 1, [0, 255, 0]), 0) - 0.7152) < 1e-12);
});

test("text contrast splits the rectangle into two tones and compares their medians", () => {
  // Black text on white: 24 of 200 pixels are text.
  const page = fill(canvas(20, 10, WHITE), 4, 2, 4, 6, BLACK);
  const ink = textContrast(page, whole(page));
  assert.equal(ink.ratio, 21);
  assert.equal(ink.pixels, 200);
  assert.equal(ink.minorityShare, 0.12);
  // White text on black gives the same ratio.
  const inverse = fill(canvas(20, 10, BLACK), 4, 2, 4, 6, WHITE);
  assert.equal(textContrast(inverse, whole(inverse)).ratio, 21);
  // Gray text on a gray background has almost no contrast.
  const gray = fill(canvas(20, 10, [128, 128, 128]), 4, 2, 4, 6, [134, 134, 134]);
  const faint = textContrast(gray, whole(gray));
  assert.ok(faint.ratio > 1 && faint.ratio < 1.1, String(faint.ratio));
  // One tone has no split.
  const plain = canvas(20, 10, [90, 90, 90]);
  assert.deepEqual(textContrast(plain, whole(plain)), { ratio: 1, pixels: 200, minorityShare: 0 });
  // Antialiased edges are a minority of each cluster, so they do not move the medians.
  const soft = fill(fill(page, 3, 2, 1, 6, [160, 160, 160]), 8, 2, 1, 6, [160, 160, 160]);
  assert.equal(textContrast(soft, whole(soft)).ratio, 21);
  // Only the rectangle counts: this rectangle has only white pixels.
  assert.equal(textContrast(page, { x: 10, y: 0, width: 10, height: 10 }).ratio, 1);
});

test("a second tone under 2% of the rectangle gives a ratio of 1", () => {
  // 40 of 2500 pixels (1.6%) are black.
  const speck = fill(canvas(50, 50, WHITE), 0, 0, 40, 1, BLACK);
  const under = textContrast(speck, whole(speck));
  assert.equal(under.ratio, 1);
  assert.equal(under.minorityShare, 0.016);
  // 60 of 2500 pixels (2.4%) are black.
  const line = fill(canvas(50, 50, WHITE), 0, 0, 50, 1, BLACK);
  fill(line, 0, 1, 10, 1, BLACK);
  assert.equal(textContrast(line, whole(line)).ratio, 21);
  assert.throws(
    () => textContrast(line, { x: 45, y: 0, width: 10, height: 1 }),
    /inside the frame/u,
  );
});

test("exposure gives the mean luminance and the clipped shares", () => {
  assert.deepEqual(exposure(canvas(4, 4, BLACK)), {
    meanLuminance: 0,
    darkShare: 1,
    brightShare: 0,
  });
  assert.deepEqual(exposure(canvas(4, 4, WHITE)), {
    meanLuminance: 1,
    darkShare: 0,
    brightShare: 1,
  });
  const mid = exposure(canvas(4, 4, [128, 128, 128]));
  assert.ok(Math.abs(mid.meanLuminance - 0.2158605) < 1e-6);
  assert.equal(mid.darkShare, 0);
  assert.equal(mid.brightShare, 0);
  const split = fill(canvas(4, 4, BLACK), 0, 0, 4, 1, WHITE);
  assert.deepEqual(exposure(split), { meanLuminance: 0.25, darkShare: 0.75, brightShare: 0.25 });
  assert.equal(exposurePercent(split, "dark_share"), 75);
  assert.equal(exposurePercent(split, "mean_luminance"), 25);
  // The clips are luminance 0.02 and 0.98: between the codes 38 and 39, and 252 and 253.
  assert.equal(exposure(canvas(2, 2, [38, 38, 38])).darkShare, 1);
  assert.equal(exposure(canvas(2, 2, [39, 39, 39])).darkShare, 0);
  assert.equal(exposure(canvas(2, 2, [252, 252, 252])).brightShare, 0);
  assert.equal(exposure(canvas(2, 2, [253, 253, 253])).brightShare, 1);
});

test("an exposure check compares a percent with the authored bounds", () => {
  const split = fill(canvas(4, 4, BLACK), 0, 0, 4, 1, WHITE);
  const dark = checkExposure(split, "dark_share", null, 50);
  assert.equal(dark.outcome, "rejected");
  assert.deepEqual(dark.observed, [75]);
  assert.match(
    dark.reason,
    /dark clipped pixels is 75%, outside the authored bounds \(at most 50%\)/u,
  );
  assert.equal(checkExposure(split, "mean_luminance", 20, 30).outcome, "verified");
  assert.equal(checkExposure(split, "mean_luminance", 25, 25).outcome, "verified");
  assert.equal(checkExposure(split, "bright_share", 30, null).outcome, "rejected");
  assert.throws(() => checkExposure(split, "bright_share", null, null), /needs a bound/u);
});

test("a GUI rectangle maps to capture pixels with the inset and the capture scale", () => {
  const layout = {
    guiInset: { left: 4, top: 36, right: 0, bottom: 0 },
    viewport: { w: 800, h: 600 },
  };
  // A Retina capture has two pixels for each viewport pixel.
  assert.deepEqual(guiRectInCapture({ x: 10, y: 20, w: 100, h: 30 }, layout, 1600), {
    x: 28,
    y: 112,
    w: 200,
    h: 60,
  });
  assert.deepEqual(guiRectInCapture({ x: -4, y: -36, w: 800, h: 600 }, layout, 800), {
    x: 0,
    y: 0,
    w: 800,
    h: 600,
  });
  assert.deepEqual(framePixels({ x: 10.4, y: 19.6, w: 20.2, h: 10 }, 100, 100), {
    x: 10,
    y: 20,
    width: 21,
    height: 10,
  });
  // The frame clips a rectangle at its edges.
  assert.deepEqual(framePixels({ x: -5, y: 90, w: 20, h: 20 }, 100, 100), {
    x: 0,
    y: 90,
    width: 15,
    height: 10,
  });
  assert.equal(framePixels({ x: 120, y: 10, w: 20, h: 20 }, 100, 100), null);
});

/*
 * A 200 × 150 viewport with a top inset of 10 GUI px, in a 400 × 300 capture. A GUI rectangle
 * (x, y, w, h) has the capture pixels (2x, 2y + 20, 2w, 2h).
 */
const hud = "Players.Player1.PlayerGui.SpikeHudFull";
const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const label = (name: string, area: ReturnType<typeof rect>) => ({
  path: `${hud}.${name}`,
  className: "TextLabel",
  rect: area,
  clippedRect: area,
  zIndex: 1,
  hasText: true,
  textBounds: { w: 30, h: 10 },
  textSize: 14,
  textScaled: false,
  textWrapped: false,
  textFits: true,
});
function layout(elements: object[], extra: object = {}): GuiLayoutObservation {
  const value = {
    factId: "layout-full",
    kind: "gui_layout",
    exists: true,
    complete: true,
    screen: rect(0, 0, 200, 140),
    guiInset: { left: 0, top: 10, right: 0, bottom: 0 },
    viewport: { w: 200, h: 150 },
    ignoreGuiInset: false,
    elements,
    ...extra,
  };
  assertStudioObservation(value);
  return value as GuiLayoutObservation;
}
const shown = (...names: string[]): SceneTextObservation => ({
  complete: true,
  entries: names.map((name) => ({
    path: `${hud}.${name}`,
    className: "TextLabel" as const,
    layer: "ScreenGui" as const,
    owner: "candidate" as const,
    property: "Text" as const,
    text: name,
    visible: true,
  })),
});
/** Score has black text on white. Hint has gray text on gray. Both labels are 60 × 20 GUI px. */
function hudFrame(): Raster {
  const frame = canvas(400, 300, [40, 60, 90]);
  // Score at GUI (10, 10, 60, 20): pixels (20, 40, 120, 40).
  fill(frame, 20, 40, 120, 40, WHITE);
  fill(frame, 40, 50, 60, 20, BLACK);
  // Hint at GUI (10, 50, 60, 20): pixels (20, 120, 120, 40).
  fill(frame, 20, 120, 120, 40, [120, 120, 120]);
  fill(frame, 40, 130, 60, 20, [126, 126, 126]);
  return frame;
}
const score = label("Score", rect(10, 10, 60, 20));
const hint = label("Hint", rect(10, 50, 60, 20));

test("a text contrast check measures each shown text element of the layout", () => {
  const frame = hudFrame();
  const verified = checkTextContrast(layout([score]), shown("Score"), frame, 4.5);
  assert.equal(verified.outcome, "verified");
  assert.deepEqual(verified.observed, [1, 0, 0, 21]);
  assert.match(verified.reason, /at least 4\.5:1 \(1 text element checked, lowest 21:1\)/u);
  const rejected = checkTextContrast(layout([score, hint]), shown("Score", "Hint"), frame, 4.5);
  assert.equal(rejected.outcome, "rejected");
  assert.deepEqual(rejected.observed!.slice(0, 3), [2, 1, 0]);
  assert.match(
    rejected.reason,
    /1 text element has a contrast below 4\.5:1: .*SpikeHudFull\.Hint \(1\.0\d:1\)/u,
  );
  // A label without a scene text entry that is visible cannot be measured.
  const hidden = checkTextContrast(layout([score, hint]), shown("Score"), frame, 4.5);
  assert.equal(hidden.outcome, "incomplete");
  assert.deepEqual(hidden.observed, [2, 0, 1, 21]);
  assert.match(hidden.reason, /Hint \(not visible in the scene text of the capture\)/u);
  const invisible = shown("Score");
  invisible.entries[0]!.visible = false;
  assert.equal(checkTextContrast(layout([score]), invisible, frame, 4.5).outcome, "incomplete");
  // An offender rejects, also when another element is undecided.
  assert.equal(
    checkTextContrast(layout([score, hint]), shown("Hint"), frame, 4.5).outcome,
    "rejected",
  );
  const outside = checkTextContrast(
    layout([label("Far", rect(300, 10, 60, 20))]),
    shown("Far"),
    frame,
    4.5,
  );
  assert.equal(outside.outcome, "incomplete");
  assert.match(outside.reason, /Far \(outside the frame\)/u);
  const partial = checkTextContrast(
    layout([score], { complete: false }),
    shown("Score"),
    frame,
    4.5,
  );
  assert.equal(partial.outcome, "incomplete");
  assert.match(partial.reason, /left out visible elements/u);
  // An element without text or without a shown area is not checked.
  const frameOnly = { ...score, path: `${hud}.Panel`, className: "Frame", hasText: false };
  for (const key of ["textBounds", "textSize", "textScaled", "textWrapped", "textFits"])
    delete (frameOnly as Record<string, unknown>)[key];
  const clipped: Record<string, unknown> = { ...hint };
  delete clipped.clippedRect;
  assert.deepEqual(checkTextContrast(layout([frameOnly, clipped]), shown(), frame, 4.5).observed, [
    0,
    0,
    0,
    null,
  ]);
  assert.equal(checkTextContrast(null, shown(), frame, 4.5).outcome, "incomplete");
  const absent = checkTextContrast(
    layout([], {
      exists: false,
      screen: rect(0, 0, 0, 0),
      guiInset: { left: 0, top: 0, right: 0, bottom: 0 },
      viewport: { w: 0, h: 0 },
    }),
    shown(),
    frame,
    4.5,
  );
  assert.equal(absent.outcome, "incomplete");
  assert.match(absent.reason, /No ScreenGui exists/u);
});

const repository = resolve(process.cwd());
const contrastRule = (minimum: unknown, extra: object = {}) =>
  ({
    kind: "capture_text_contrast",
    phaseId: "hud",
    captureId: "hud-frame",
    layoutFactId: "layout-full",
    minimum,
    ...extra,
  }) as unknown as DeterministicCriterion["rule"];
const exposureRule = (measure: string, minimum: unknown, maximum: unknown, extra: object = {}) =>
  ({
    kind: "capture_exposure",
    phaseId: "hud",
    captureId: "hud-frame",
    measure,
    minimum,
    maximum,
    ...extra,
  }) as unknown as DeterministicCriterion["rule"];
const wcag = { value: 4.5, quote: "a contrast of at least 4.5:1" };

/** The connector spike task with one text contrast check and one exposure check. */
async function spikeTask(root: string) {
  const task = await loadRegisteredTask(repository, "studies/connector-spike/task");
  const workspace = resolve(root, "workspace");
  await materializeTaskSeed(repository, task, workspace);
  const files = await inventoryTree(workspace);
  const candidate: CandidateManifest = {
    rootHash: hashJson(files),
    projectFile: "default.project.json",
    files,
  };
  const evaluator: EvaluatorSpec = structuredClone(task.evaluator);
  const criterion = (id: string, rule: DeterministicCriterion["rule"]) => ({
    id,
    layer: "engine" as const,
    statement: "The HUD is readable.",
    required: true,
    rule,
  });
  evaluator.deterministic.push(
    criterion("hud-contrast", contrastRule(wcag)),
    criterion(
      "hud-dark",
      exposureRule("dark_share", null, { value: 5, quote: "at most 5% of the frame is black" }),
    ),
  );
  assertEvaluatorSpec(evaluator);
  return { workspace, candidate, evaluator };
}

/** Write the frame as the PNG file of the capture and give the signed evidence of the phase. */
async function evidenceWith(
  directory: string,
  candidate: CandidateManifest,
  evaluator: EvaluatorSpec,
  frame: Raster,
  observation: GuiLayoutObservation | null,
  sceneText: SceneTextObservation,
): Promise<StudioEvidence> {
  const png = new PNG({ width: frame.width, height: frame.height });
  png.data = Buffer.from(frame.data);
  const bytes = PNG.sync.write(png);
  await mkdir(resolve(directory, "captures"), { recursive: true });
  await writeFile(resolve(directory, "captures/hud.png"), bytes);
  const body: Omit<StudioEvidence, "schema" | "id"> = {
    treatmentId: "tr-frame",
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
        phaseId: "hud",
        observations: observation ? [observation] : [],
        captures: [
          {
            captureId: "hud-frame",
            file: "captures/hud.png",
            hash: contentHash(bytes),
            bytes: bytes.length,
            mediaType: "image/png",
            width: frame.width,
            height: frame.height,
            sceneText,
          },
        ],
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

test("the pixel rules read the signed frame of the evidence directory", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-frame-rules-"));
  try {
    const { workspace, candidate, evaluator } = await spikeTask(root);
    const directory = resolve(root, "studio");
    const grade = async (evidence: StudioEvidence, evidenceDirectory: string | null = directory) =>
      new Map(
        (
          await evaluateDeterministicCriteria({
            workspaceRoot: workspace,
            evaluator,
            candidate,
            treatmentId: "tr-frame",
            evidence,
            evidenceDirectory: evidenceDirectory ?? undefined,
          })
        ).map((item) => [item.criterionId, item]),
      );
    const readable = await evidenceWith(
      directory,
      candidate,
      evaluator,
      hudFrame(),
      layout([score]),
      shown("Score"),
    );
    const capture = readable.phases[0]!.captures[0]!;
    const graded = await grade(readable);
    assert.equal(graded.get("hud-contrast")!.outcome, "verified");
    assert.deepEqual(graded.get("hud-contrast")!.observed, [1, 0, 0, 21]);
    assert.deepEqual(graded.get("hud-contrast")!.evidence, [
      capture.hash,
      hashJson(readable.phases[0]!.observations[0]),
    ]);
    assert.equal(graded.get("hud-dark")!.outcome, "verified");
    assert.deepEqual(graded.get("hud-dark")!.observed, [1]);
    assert.deepEqual(graded.get("hud-dark")!.evidence, [capture.hash]);

    const faint = await grade(
      await evidenceWith(
        directory,
        candidate,
        evaluator,
        fill(hudFrame(), 0, 0, 400, 30, BLACK),
        layout([score, hint]),
        shown("Score", "Hint"),
      ),
    );
    assert.equal(faint.get("hud-contrast")!.outcome, "rejected");
    assert.match(faint.get("hud-contrast")!.explanation, /SpikeHudFull\.Hint/u);
    // The black band and the text of Score are 13200 of 120000 pixels: 11%.
    assert.equal(faint.get("hud-dark")!.outcome, "rejected");
    assert.deepEqual(faint.get("hud-dark")!.observed, [11]);

    const withoutDirectory = await grade(readable, null);
    for (const id of ["hud-contrast", "hud-dark"]) {
      assert.equal(withoutDirectory.get(id)!.outcome, "incomplete");
      assert.match(withoutDirectory.get(id)!.explanation, /no evidence directory/u);
    }
    const withoutLayout = await grade(
      await evidenceWith(directory, candidate, evaluator, hudFrame(), null, shown("Score")),
    );
    assert.equal(withoutLayout.get("hud-contrast")!.outcome, "incomplete");
    assert.match(withoutLayout.get("hud-contrast")!.explanation, /gui_layout fact is absent/u);
    assert.equal(withoutLayout.get("hud-dark")!.outcome, "verified");

    await rm(resolve(directory, "captures/hud.png"));
    const missing = await grade(readable);
    assert.equal(missing.get("hud-dark")!.outcome, "incomplete");
    assert.match(
      missing.get("hud-dark")!.explanation,
      /image file of capture hud-frame is absent/u,
    );
    // An evidence directory without its captures folder is incomplete, as an absent file is.
    const folderless = resolve(root, "studio-without-captures");
    await mkdir(folderless);
    const withoutFolder = await grade(readable, folderless);
    for (const id of ["hud-contrast", "hud-dark"]) {
      assert.equal(withoutFolder.get(id)!.outcome, "incomplete");
      assert.match(
        withoutFolder.get(id)!.explanation,
        /image file of capture hud-frame is absent, because its folder captures does not exist/u,
      );
    }
    // Bytes that differ from the signed hash stop the grade of all criteria.
    await writeFile(resolve(directory, "captures/hud.png"), "not the signed frame");
    await assert.rejects(grade(readable), /differs from its signed evidence/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the pixel rules bind a capture of the plan and quoted bounds", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-frame-contract-"));
  try {
    const { evaluator } = await spikeTask(root);
    const variant = (id: string, rule: DeterministicCriterion["rule"]) => {
      const copy = structuredClone(evaluator);
      copy.deterministic.find((item) => item.id === id)!.rule = rule;
      return copy;
    };
    const refuses = (id: string, rule: DeterministicCriterion["rule"], pattern: RegExp) =>
      assert.throws(() => assertEvaluatorSpec(variant(id, rule)), pattern);
    assertEvaluatorSpec(variant("hud-contrast", contrastRule({ value: 7, quote: "7:1" })));
    assertEvaluatorSpec(
      variant(
        "hud-dark",
        exposureRule(
          "mean_luminance",
          { value: 20, quote: "at least 20%" },
          { value: 80, quote: "at most 80 percent" },
        ),
      ),
    );
    refuses("hud-contrast", contrastRule({ value: 4.5, quote: "at least 4.5 px" }), /in ratio/u);
    refuses("hud-contrast", contrastRule({ value: 0.5, quote: "0.5:1" }), /from 1:1 to 21:1/u);
    refuses("hud-contrast", contrastRule({ value: 30, quote: "30:1" }), /from 1:1 to 21:1/u);
    refuses("hud-contrast", contrastRule(null), /text contrast minimum/u);
    refuses(
      "hud-contrast",
      contrastRule(wcag, { layoutFactId: "presentation-errors" }),
      /bind a gui_layout fact of the phase of the capture/u,
    );
    refuses(
      "hud-contrast",
      contrastRule(wcag, { captureId: "other-frame" }),
      /bind a capture of the Studio plan/u,
    );
    refuses(
      "hud-contrast",
      contrastRule(wcag, { factId: "layout-full" }),
      /text contrast rule fields/u,
    );
    refuses(
      "hud-dark",
      exposureRule("dark_share", null, null),
      /give a minimum, a maximum or both/u,
    );
    refuses(
      "hud-dark",
      exposureRule("glare", null, { value: 5, quote: "5%" }),
      /exposure measure/u,
    );
    refuses(
      "hud-dark",
      exposureRule("dark_share", null, { value: 5, quote: "5 px" }),
      /states the value 5 in percent/u,
    );
    refuses(
      "hud-dark",
      exposureRule("dark_share", null, { value: 150, quote: "150%" }),
      /from 0 to 100/u,
    );
    refuses(
      "hud-dark",
      exposureRule("mean_luminance", { value: 60, quote: "60%" }, { value: 40, quote: "40%" }),
      /minimum is above the maximum/u,
    );
    refuses(
      "hud-dark",
      exposureRule("dark_share", null, { value: 5, quote: "5%" }, { phaseId: "other" }),
      /bind a capture of the Studio plan/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the compiler needs the quote of each exposure bound in the text of its criterion", async () => {
  const files = await readCuratedTaskFiles(resolve("studies/connector-spike/task"));
  const compile = (rubricLine: string) => {
    const evaluator = structuredClone(files.evaluator);
    evaluator.deterministic.push({
      id: "hud-exposure",
      layer: "engine",
      statement: "A statement that the compile replaces.",
      required: true,
      rule: exposureRule(
        "mean_luminance",
        { value: 20, quote: "at least 20%" },
        { value: 80, quote: "at most 80%" },
      ),
    });
    const map = structuredClone(files.criteriaMap) as { criteria: object[] };
    map.criteria.push({
      authoredCriterionId: "criterion-2",
      text: rubricLine,
      executableCriterionId: "hud-exposure",
      rationale: "The captured frame gives the luminance.",
    });
    return compileCuratedRevision({
      ...files,
      evaluator,
      rubric: `${files.rubric.trimEnd()}\n- ${rubricLine}\n`,
      criteriaMap: map,
    });
  };
  const quoted = compile("The HUD frame has a mean luminance of at least 20% and at most 80%.");
  assert.equal(quoted.validation.status, "ready", JSON.stringify(quoted.validation.diagnostics));
  const half = compile("The HUD frame has a mean luminance of at least 20%.");
  assert.equal(half.validation.status, "needs_clarification");
  assert.deepEqual(
    half.validation.diagnostics.map((item) => [item.code, item.authoredCriterionId]),
    [["authority_conflict", "criterion-2"]],
  );
  assert.match(half.validation.diagnostics[0]!.message, /bound 80 from "at most 80%"/u);
});
