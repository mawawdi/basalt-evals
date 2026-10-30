import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { validateModelImages } from "../packages/model-client/src/contracts.js";
import { RepositoryFiles } from "../packages/artifact-store/src/repository.js";
import {
  contentHash,
  hashJson,
  assertEvaluatorSpec,
  type StudioEvidence,
} from "../packages/contracts/src/index.js";
import { renderedEvidence } from "../packages/studio-runner/src/rendered-evidence.js";
import type { SequencePlan } from "../packages/studio-runner/src/sequence.js";
import { boundSequence } from "../packages/operator/src/judgment-material.js";
import { capabilityFixture } from "./shared-api-fixture.js";
import {
  criterionImageDimensions,
  sequenceImageDimensions,
} from "../packages/eval-authoring/src/rendered-selection.js";
import {
  criterionMaterial,
  criterionMaterialTextBound,
} from "../packages/eval-authoring/src/criterion-material.js";

test("compiled rendered selections require a declared scenario and quote all actor frames", () => {
  const evaluator = capabilityFixture("multiplayer").privateProposal.privateEvaluator;
  assertEvaluatorSpec(evaluator);
  // The phase capture leaves room for 63 sequence frames, so the 64-frame budget quotes 63.
  const dimensions = criterionImageDimensions(evaluator.unscaled, evaluator);
  assert.equal(dimensions.length, 64);
  assert.deepEqual(dimensions[0], { width: 800, height: 600 });
  assert.deepEqual(dimensions.at(-1), { width: null, height: null });
  // A smaller authored budget sets the quote. Uniform fill never goes past it.
  const budgeted = structuredClone(evaluator);
  budgeted.sequence!.frameBudget = 12;
  assert.equal(criterionImageDimensions(budgeted.unscaled, budgeted).length, 13);
  const unbound = structuredClone(evaluator);
  unbound.sequence = null;
  assert.throws(() => assertEvaluatorSpec(unbound), /sequence/i);
  const unknown = structuredClone(evaluator);
  unknown.sequence!.scenarioId = "missing";
  assert.throws(() => assertEvaluatorSpec(unknown), /unknown scenario/);
  const view = {
    ...evaluator.sequence!,
    requiredTransitions: Array.from({ length: 16 }, (_, i) => ({
      id: `step-${i}`,
      source: { kind: "action" as const, stepId: `step-${i}` },
      effectWindowMs: 1000,
      holdMs: 0,
    })),
  };
  // Two actors keep one frame per transition and one end frame each, within the budget.
  assert.equal(sequenceImageDimensions(view, evaluator.studio, "still").length, 34);
  assert.equal(sequenceImageDimensions(view, evaluator.studio, "still", 50).length, 14);
  assert.equal(
    sequenceImageDimensions({ ...view, frameBudget: 20 }, evaluator.studio, "still").length,
    20,
  );
  assert.throws(
    () => sequenceImageDimensions(view, evaluator.studio, "sequence", 64),
    /no room for the recorded sequence/,
  );
});

test("rendered projection binds original bytes, preserves phase independence, and retains incomplete acquisition", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-rendered-"));
  try {
    const files = new RepositoryFiles(root);
    const evaluator = capabilityFixture("gui").privateProposal.privateEvaluator;
    const plan: SequencePlan = {
      schema: "basalt-evals/sequence-plan",
      suiteHash: "a".repeat(64),
      sourceHash: "b".repeat(64),
      implementationCommit: "c".repeat(40),
      viewId: "private",
      ...evaluator.sequence!,
    };
    const png = new PNG({ width: 1024, height: 768 });
    png.data.fill(255);
    const bytes = PNG.sync.write(png, { deflateLevel: 0 }),
      hash = contentHash(bytes);
    assert.ok(bytes.length > 2 * 1024 * 1024);
    const start = Date.parse("2026-09-25T00:00:00.000Z");
    const prefix = "native/sequence/inspect-attempt-01/";
    for (const state of ["sufficient", "insufficient"] as const) {
      const base = state;
      const frames = [0, 1000].map((offset, index) => ({
        file: `frame-${index}.png`,
        hash,
        bytes: bytes.length,
        mediaType: "image/png",
        width: 1024,
        height: 768,
        playerUserId: -1,
        studioId: "synthetic",
        startedAt: new Date(start + offset).toISOString(),
        endedAt: new Date(start + offset + 50).toISOString(),
      }));
      await files.writeJson(`${base}/sequence.json`, plan);
      await files.writeJson(`${base}/${prefix}assessment.json`, {
        schema: "basalt-evals/sequence-assessment",
        planHash: hashJson(plan),
        status: state,
        reasons: state === "sufficient" ? [] : ["Missing measured camera samples"],
        clock: { offsetMs: 0, uncertaintyMs: 50 },
        actorFrames: [{ actor: "primary", userId: -1 }],
        transitions: [],
        stateChanges: [],
      });
      await files.writeJson(`${base}/${prefix}index.json`, {
        schema: "basalt-evals/sequence-acquisition",
        status: "complete",
        startedAt: new Date(start).toISOString(),
        frames,
      });
      for (const frame of frames) await files.write(`${base}/${prefix}${frame.file}`, bytes);
      await files.write(`${base}/phase.png`, bytes);
      // Signature verification is a caller precondition, separately exercised by
      // the real HTTP tests; this unit checks the signed-inventory consumption.
      await files.writeJson(`${base}/native/manifest.json`, {
        manifest: {
          artifacts: [
            "sequence.json",
            `${prefix}assessment.json`,
            `${prefix}index.json`,
            ...frames.map((frame) => prefix + frame.file),
            "phase.png",
          ].map((file) => ({ file })),
        },
      });
      const evidence = {
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(start + 2000).toISOString(),
        phases: [
          {
            phaseId: "scene",
            observations: [],
            captures: [{ captureId: "scene", file: "phase.png", hash, mediaType: "image/png" }],
          },
        ],
      } as unknown as StudioEvidence;
      const input = {
        files,
        base,
        plan: evaluator.studio,
        evidence,
        sequence: plan,
        presentation: "sequence" as const,
        captureIds: ["scene", "missing"],
      };
      const result = await renderedEvidence(input);
      assert.doesNotThrow(() => validateModelImages(result.images));
      assert.equal(result.images.length, state === "sufficient" ? 3 : 1);
      assert.equal(result.context.intervals.length, result.images.length);
      assert.equal(
        result.unavailable.some((item) => item.channel === "sequence"),
        state === "insufficient",
      );
      assert.ok(result.unavailable.some((item) => item.channel === "missing"));
      assert.ok(result.context.actors.includes("presentation:scene"));
      const phase = `presentation capture scene, a separate session that is not on the scenario clock.`;
      assert.deepEqual(
        result.images.map((image) => image.label),
        state === "sufficient"
          ? [
              "Image 1: frame-1; player primary; roles uniform; acquired from 0.000 s to 0.050 s after the scenario recording start.",
              "Image 2: frame-2; player primary; roles uniform; acquired from 1.000 s to 1.050 s after the scenario recording start.",
              `Image 3: frame-3; ${phase}`,
            ]
          : [`Image 1: frame-1; ${phase}`],
      );
      assert.equal(result.context.samplingIntervalMs, state === "sufficient" ? 500 : null);
      await assert.rejects(
        renderedEvidence({ ...input, sequence: { ...plan, sourceHash: "d".repeat(64) } }),
        /frozen source/,
      );
      await writeFile(join(root, base, prefix, frames[0]!.file), "tampered");
      await assert.rejects(renderedEvidence(input), /hash|bytes|dimensions/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The judge labels and the paired request context use the measured anchors on the host clock.
// Stored paid runs stay verifiable only while these bytes stay the same, so the test pins them.
test("the judge path keeps the fraction of the clock offset in its labels and context", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-rendered-clock-"));
  try {
    const files = new RepositoryFiles(root);
    const evaluator = capabilityFixture("gui").privateProposal.privateEvaluator;
    const plan: SequencePlan = {
      schema: "basalt-evals/sequence-plan",
      suiteHash: "a".repeat(64),
      sourceHash: "b".repeat(64),
      implementationCommit: "c".repeat(40),
      viewId: "private",
      ...evaluator.sequence!,
      requiredTransitions: ["type", "activate"].map((id) => ({
        id,
        source: { kind: "action" as const, stepId: id },
        effectWindowMs: 1000,
        holdMs: 500,
      })),
    };
    const png = new PNG({ width: 16, height: 16 });
    png.data.fill(128);
    const bytes = PNG.sync.write(png),
      hash = contentHash(bytes);
    // The recording starts 1234 ms after the acquisition. Host time is Studio time plus 12.345 ms.
    const start = Date.parse("2026-09-25T00:00:00.000Z");
    const base = "clock";
    const prefix = "native/sequence/inspect-attempt-01/";
    const frames = Array.from({ length: 11 }, (_, index) => ({
      file: `frame-${index}.png`,
      hash,
      bytes: bytes.length,
      mediaType: "image/png",
      width: 16,
      height: 16,
      playerUserId: -1,
      studioId: "synthetic",
      startedAt: new Date(start + 1234 + index * 500).toISOString(),
      endedAt: new Date(start + 1234 + index * 500 + 80).toISOString(),
    }));
    await files.writeJson(`${base}/sequence.json`, plan);
    await files.writeJson(`${base}/${prefix}assessment.json`, {
      schema: "basalt-evals/sequence-assessment",
      planHash: hashJson(plan),
      status: "sufficient",
      reasons: [],
      clock: { offsetMs: 12.345, uncertaintyMs: 40 },
      actorFrames: [{ actor: "primary", userId: -1 }],
      transitions: [
        { transitionId: "type", at: new Date(start + 2500).toISOString(), covered: true },
        { transitionId: "activate", at: new Date(start + 4600).toISOString(), covered: true },
      ].map((transition) => ({ ...transition, gapMs: 420 })),
      stateChanges: [],
    });
    await files.writeJson(`${base}/${prefix}index.json`, {
      schema: "basalt-evals/sequence-acquisition",
      status: "complete",
      startedAt: new Date(start).toISOString(),
      frames,
    });
    for (const frame of frames) await files.write(`${base}/${prefix}${frame.file}`, bytes);
    await files.writeJson(`${base}/native/manifest.json`, {
      manifest: {
        artifacts: [
          "sequence.json",
          `${prefix}assessment.json`,
          `${prefix}index.json`,
          ...frames.map((frame) => prefix + frame.file),
        ].map((file) => ({ file })),
      },
    });
    const result = await renderedEvidence({
      files,
      base,
      plan: evaluator.studio,
      evidence: {
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(start + 7000).toISOString(),
        phases: [],
      } as unknown as StudioEvidence,
      sequence: plan,
      presentation: "sequence",
      captureIds: [],
    });
    assert.equal(result.images.length, frames.length);
    // The anchors keep the fraction: Studio time plus the offset, from the acquisition start.
    assert.deepEqual(result.transitions, [
      { transitionId: "type", anchor: "action", anchorMs: 2512.344970703125 },
      { transitionId: "activate", anchor: "action", anchorMs: 4612.344970703125 },
    ]);
    // The control requests read the same anchors as host epoch ms, also with the fraction.
    assert.deepEqual(
      (await boundSequence(files, base, plan)).anchors,
      [1790294402512.345, 1790294404612.345],
    );
    // The labels round to whole ms. The context and the paired inputs keep the exact anchors.
    assert.deepEqual(
      [
        hashJson(result.images.map((image) => image.label)),
        hashJson(result.context),
        hashJson({ labelled: result.labelled, transitions: result.transitions }),
      ],
      [
        "b36ea3011bc0dd80e37dff238b419fd8b3e6e28acae067856ab0488b276c7daa",
        "a9a78364c3f6594a418cdfd25c6c8c1948b25f5f5f4941ad04a58b45cb9cb693",
        "2be3cc9b129df59faf6667f761b386f11ee3420dca435816887d198008ecb58a",
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selected phase pixels retain their signed local state in the quoted criterion projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "basalt-rendered-context-"));
  try {
    const evaluator = capabilityFixture("static").privateProposal.privateEvaluator;
    const criterion = structuredClone(evaluator.unscaled[0]!);
    criterion.evidence.sourceSelection = null;
    criterion.evidence.facts = [];
    const observation = {
      kind: "instance" as const,
      factId: "beacon",
      exists: true,
      className: "Part",
    };
    const nameObservation = {
      kind: "instance_name" as const,
      factId: "beacon-name",
      exists: true,
      name: "Beacon",
    };
    const evidence = {
      phases: [{ phaseId: "scene", observations: [observation, nameObservation], captures: [] }],
      scenarios: [],
    } as unknown as StudioEvidence;
    const material = await criterionMaterial({
      files: new RepositoryFiles(root),
      sourceRoot: "source",
      sourceFiles: [],
      evidence,
      plan: evaluator.studio,
      criterion,
    });
    assert.deepEqual(material.signedObservations[0]!.observation, observation);
    assert.deepEqual(material.signedObservations[1]!.observation, nameObservation);
    assert.equal(material.unavailable.length, 0);
    assert.ok(
      criterionMaterialTextBound(criterion, evaluator.studio) >
        criterionMaterialTextBound(
          { ...criterion, evidence: { ...criterion.evidence, captureIds: [] } },
          evaluator.studio,
        ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
