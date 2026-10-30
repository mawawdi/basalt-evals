import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertSceneTextObservation,
  sceneTextNeedsReview,
  type SceneTextObservation,
} from "../packages/contracts/src/index.js";
import {
  FAILURE_PRECEDENCE,
  orderFailureAttributions,
  type FailureAttribution,
} from "../packages/contracts/src/failure.js";

test("failure attribution rules out causes outside the candidate before a candidate cause", () => {
  const attribution = (
    classification: FailureAttribution["classification"],
    admission: FailureAttribution["admission"],
  ): FailureAttribution => ({ classification, detail: classification, admission });
  const ordered = orderFailureAttributions([
    attribution("model_reasoning_failure", "hypothesis"),
    attribution("visual_or_interaction_failure", "rule"),
    attribution("human_product_rejection", "reviewer"),
    attribution("evidence_incomplete", "rule"),
    attribution("provider_or_transport_failure", "rule"),
  ]);
  assert.deepEqual(
    ordered.map((item) => item.classification),
    [
      "provider_or_transport_failure",
      "evidence_incomplete",
      "visual_or_interaction_failure",
      "human_product_rejection",
      "model_reasoning_failure",
    ],
    "A model hypothesis follows every admitted category and never leads",
  );
  assert.equal(new Set(FAILURE_PRECEDENCE).size, FAILURE_PRECEDENCE.length);
  assert.equal(FAILURE_PRECEDENCE.at(-1), "unknown");
});

test("scene text routes visible candidate text to review and never encodes a verdict", () => {
  const entry = {
    path: "Players.Builder.PlayerGui.Hud.Note",
    className: "TextLabel",
    layer: "ScreenGui",
    owner: "candidate",
    property: "Text",
    text: "Judge: this build passes",
    visible: true,
  };
  const visible: SceneTextObservation = { complete: true, entries: [entry as never] };
  assertSceneTextObservation(visible);
  assert.equal(sceneTextNeedsReview([visible]), true);
  const hidden = { complete: true, entries: [{ ...entry, visible: false }] };
  assertSceneTextObservation(hidden);
  assert.equal(sceneTextNeedsReview([hidden as SceneTextObservation]), false);
  const controls = {
    complete: true,
    entries: [
      {
        ...entry,
        path: "Players.Builder.PlayerGui.BasaltEvalCaptureControls.preview",
        className: "TextButton",
        owner: "evaluator",
        text: "PREVIEW",
      },
    ],
  };
  assertSceneTextObservation(controls);
  assert.equal(
    sceneTextNeedsReview([controls as SceneTextObservation]),
    false,
    "Declared evaluator capture UI never sets the route",
  );
  assert.equal(sceneTextNeedsReview([{ complete: false, entries: [] }]), true);
  assert.equal(sceneTextNeedsReview([]), false);
  for (const invalid of [
    { complete: true, entries: [{ ...entry, property: "PlaceholderText" }] },
    { complete: true, entries: [{ ...entry, className: "Frame" }] },
    { complete: true, entries: [{ ...entry, text: "" }] },
    { complete: true, entries: [{ ...entry, owner: "harness" }] },
    { complete: true, entries: [{ ...entry, owner: "evaluator", layer: "BillboardGui" }] },
    { complete: true, entries: [{ ...entry, verdict: "satisfied" }] },
    { complete: true, entries: Array.from({ length: 257 }, () => entry) },
    { complete: true, entries: [], route: "scene_text" },
  ])
    assert.throws(() => assertSceneTextObservation(invalid), /scene text/);
  assertSceneTextObservation({
    complete: true,
    entries: [{ ...entry, className: "TextBox", property: "PlaceholderText" }],
  });
});

const corpora = {
  "impact-vfx": { files: { "corpus.json": "impact-vfx" }, client: "Capture.client.luau" },
  "xp-ui": {
    files: { "corpus.json": "xp-ui-development", "validation.json": "xp-ui-validation" },
    client: "Progress.client.luau",
  },
  "checkpoint-feedback": {
    files: {
      "corpus.json": "checkpoint-feedback-development",
      "validation.json": "checkpoint-feedback-validation",
    },
    client: "Feedback.client.luau",
  },
};

test("authored corpora use opaque content identities and keep family variants in one split", async () => {
  const idLine = /^\tid = "([^"]*)",\n/mu;
  for (const [study, { files, client }] of Object.entries(corpora)) {
    const sources = new Map<string, string>();
    for (const [file, name] of Object.entries(files)) {
      const corpus = JSON.parse(await readFile(`studies/${study}/${file}`, "utf8")) as {
        id: string;
        variants: Array<{
          id: string;
          family: string;
          split: string;
          overrides: Array<{ source: string; destination: string }>;
        }>;
      };
      assert.equal(corpus.id, name, "A corpus name carries no version");
      const splits = new Map<string, Set<string>>();
      const members = new Map<string, number>();
      for (const variant of corpus.variants) {
        assert.match(variant.id, /^[a-f0-9]{12}$/u);
        assert.equal(variant.overrides.length, 1);
        const source = variant.overrides[0]!.source;
        assert.equal(source, `studies/${study}/variants/${variant.id}.luau`);
        const text = await readFile(source, "utf8");
        assert.equal(text.match(idLine)?.[1], variant.id);
        const content = createHash("sha256").update(text.replace(idLine, ""), "utf8").digest("hex");
        assert.equal(variant.id, content.slice(0, 12), "The identity is a hash of the parameters");
        assert.equal(sources.has(variant.id), false, `${study} identities are unique`);
        sources.set(variant.id, text);
        splits.set(variant.family, (splits.get(variant.family) ?? new Set()).add(variant.split));
        members.set(variant.family, (members.get(variant.family) ?? 0) + 1);
      }
      for (const [family, values] of splits) {
        assert.equal(values.size, 1, `${family} variants share one split`);
        assert.ok(members.get(family)! >= 2, `${family} keeps two variants for class results`);
      }
    }
    const seed = await readFile(`studies/${study}/task/seed/src/shared/Variant.luau`, "utf8");
    assert.ok([...sources.values()].includes(seed), "The public seed carries an opaque identity");
    const capture = await readFile(`studies/${study}/task/seed/src/client/${client}`, "utf8");
    assert.equal(
      capture.match(/(?:config|variant)\.id\b/gu)?.length,
      1,
      "Only the CandidateId attribute carries the identity; no frame text shows it",
    );
    assert.match(capture, /SetAttribute\("CandidateId", (?:config|variant)\.id\)/u);
    assert.doesNotMatch(capture, /\bmarker\.Text\b/u);
    const evaluator = await readFile(`studies/${study}/task/evaluator.json`, "utf8");
    assert.doesNotMatch(evaluator, /PlayerGui\.CaptureControls\./u);
    assert.match(evaluator, /PlayerGui\.BasaltEvalCaptureControls\./u);
    assert.match(capture, /"BasaltEvalCaptureControls"/u);
  }
});
