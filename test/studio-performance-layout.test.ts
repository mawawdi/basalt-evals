import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSemanticRoles,
  assertStudioObservation,
  studioFactWindowMs,
} from "../packages/contracts/src/index.js";

const sample = (elapsedMs: number, extra: Record<string, unknown> = {}) => ({
  elapsedMs,
  frames: 15,
  meanFrameMs: 16.7,
  maxFrameMs: 21.4,
  instanceCount: 5120,
  memoryMb: 812.5,
  ...extra,
});
const trace = (samples: unknown[]) => ({ factId: "load", kind: "performance_trace", samples });

test("a performance trace keeps measured intervals and omits an unreadable Stats value", () => {
  assertStudioObservation(trace([sample(251), sample(502)]));
  const { instanceCount: _count, memoryMb: _memory, ...framesOnly } = sample(251);
  assertStudioObservation(trace([framesOnly]));
  assertStudioObservation(
    trace([sample(251, { frames: 0, meanFrameMs: 0, maxFrameMs: 0, instanceCount: 0 })]),
  );
  assert.equal(
    studioFactWindowMs({ id: "load", kind: "performance_trace", sampleCount: 4, intervalMs: 250 }),
    1000,
  );
});

test("a performance trace rejects wrong keys, null values and impossible frame times", () => {
  const { memoryMb: _memory, ...noMemory } = sample(502);
  for (const [name, value] of [
    ["mixed sample shapes", trace([sample(251), noMemory])],
    ["value after a refused read", trace([noMemory, sample(753)])],
    ["no samples", trace([])],
    ["too many samples", trace(Array.from({ length: 481 }, (_, index) => sample(index + 1)))],
    ["time goes back", trace([sample(500), sample(400)])],
    ["time zero", trace([sample(0)])],
    ["extra sample key", trace([sample(251, { fps: 60 })])],
    ["null instance count", trace([sample(251, { instanceCount: null })])],
    ["fractional instance count", trace([sample(251, { instanceCount: 1.5 })])],
    ["negative memory", trace([sample(251, { memoryMb: -1 })])],
    ["mean above maximum", trace([sample(251, { meanFrameMs: 30 })])],
    ["frame time without frames", trace([sample(251, { frames: 0 })])],
    ["fractional frames", trace([sample(251, { frames: 1.5 })])],
    ["extra observation key", { ...trace([sample(251)]), exists: true }],
  ] as const)
    assert.throws(() => assertStudioObservation(value), Error, name);
});

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const element = (extra: Record<string, unknown> = {}) => ({
  path: "Players.Tester.PlayerGui.Hud.Score",
  className: "TextLabel",
  rect: rect(60, 80, 100, 20),
  clippedRect: rect(60, 80, 50, 20),
  zIndex: 2,
  hasText: true,
  textBounds: { w: 40, h: 14 },
  textSize: 14,
  textScaled: false,
  textWrapped: true,
  textFits: false,
  ...extra,
});
const layout = (extra: Record<string, unknown> = {}) => ({
  factId: "layout",
  kind: "gui_layout",
  exists: true,
  complete: true,
  screen: rect(0, 58, 1280, 662),
  guiInset: { left: 0, top: 58, right: 0, bottom: 0 },
  viewport: { w: 1280, h: 720 },
  ignoreGuiInset: false,
  elements: [element()],
  ...extra,
});
const absent = {
  factId: "layout",
  kind: "gui_layout",
  exists: false,
  complete: true,
  screen: rect(0, 0, 0, 0),
  guiInset: { left: 0, top: 0, right: 0, bottom: 0 },
  viewport: { w: 0, h: 0 },
  ignoreGuiInset: false,
  elements: [],
};

test("a GUI layout keeps geometry and text fit, and absence keeps zero values", () => {
  assertStudioObservation(layout());
  assertStudioObservation(layout({ complete: false, ignoreGuiInset: true }));
  const { clippedRect: _clipped, ...fullyClipped } = element();
  assertStudioObservation(layout({ elements: [fullyClipped] }));
  assertStudioObservation(
    layout({
      elements: [
        {
          path: "Players.Tester.PlayerGui.Hud.Panel",
          className: "Frame",
          rect: rect(10, 68, 100, 50),
          clippedRect: rect(10, 68, 100, 50),
          zIndex: -1,
          hasText: false,
        },
      ],
    }),
  );
  assertStudioObservation(absent);
});

test("a GUI layout rejects wrong keys, text of another class and impossible rectangles", () => {
  const { textFits: _fits, ...missingFit } = element();
  const { hasText: _hasText, ...noFlag } = element();
  for (const [name, value] of [
    ["extra key", layout({ text: "Score 4" })],
    ["missing elements", { ...layout(), elements: undefined }],
    ["element text content", layout({ elements: [element({ text: "Score 4" })] })],
    ["missing text fit", layout({ elements: [missingFit] })],
    ["missing text flag", layout({ elements: [noFlag] })],
    ["text fields without text", layout({ elements: [element({ hasText: false })] })],
    ["text on a frame", layout({ elements: [element({ className: "Frame" })] })],
    ["null clipped rectangle", layout({ elements: [element({ clippedRect: null })] })],
    ["clipped outside", layout({ elements: [element({ clippedRect: rect(0, 80, 50, 20) })] })],
    ["clipped larger", layout({ elements: [element({ clippedRect: rect(60, 80, 101, 20) })] })],
    ["rectangle key", layout({ elements: [element({ rect: { x: 1, y: 1, width: 2, h: 2 } })] })],
    ["fractional z index", layout({ elements: [element({ zIndex: 1.5 })] })],
    ["infinite position", layout({ elements: [element({ rect: rect(Infinity, 0, 1, 1) })] })],
    ["negative inset", layout({ guiInset: { left: 0, top: -58, right: 0, bottom: 0 } })],
    ["zero viewport", layout({ viewport: { w: 0, h: 720 } })],
    ["over the limit", layout({ elements: Array.from({ length: 257 }, () => element()) })],
    ["absent with elements", { ...absent, elements: [element()] }],
    ["absent with viewport", { ...absent, viewport: { w: 1280, h: 720 } }],
    ["absent and incomplete", { ...absent, complete: false }],
  ] as const)
    assert.throws(() => assertStudioObservation(value), Error, name);
});

test("a ScreenGui role needs the local player GUI scope", () => {
  assertSemanticRoles([
    { id: "hud", className: "ScreenGui", scope: "local_player_gui", cardinality: "exactly_one" },
  ]);
  assert.throws(
    () =>
      assertSemanticRoles([
        { id: "hud", className: "ScreenGui", scope: "workspace", cardinality: "exactly_one" },
      ]),
    /a ScreenGui role needs the local_player_gui scope/u,
  );
});
