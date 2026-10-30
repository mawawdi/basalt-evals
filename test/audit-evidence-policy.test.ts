import assert from "node:assert/strict";
import test from "node:test";
import { hashJson, type StudioSequenceView } from "../packages/contracts/src/index.js";
import { DIAGNOSTIC_CHANNEL_LIMIT } from "../packages/contracts/src/capabilities.js";
import {
  recordingTimeline,
  recordingTracks,
  runtimeFactSummaries,
  scenarioSteps,
} from "../packages/contracts/src/evidence-display.js";
import {
  selectEvidencePacket,
  EVIDENCE_PACKET_POLICY_HASH,
} from "../packages/studio-runner/src/evidence-packet.js";
import { presentSequenceFrames } from "../packages/studio-runner/src/presentation.js";
import type {
  SequenceAcquisition,
  SequenceFrame,
} from "../packages/studio-runner/src/studio-mcp.js";
import type { SequenceAssessment } from "../packages/studio-runner/src/sequence.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import { readFile } from "node:fs/promises";

const epoch = Date.parse("2026-09-30T00:00:00.000Z");
function scene() {
  const frames: SequenceFrame[] = Array.from({ length: 101 }, (_, index) => ({
    file: `frame-${index}.png`,
    hash: index.toString(16).padStart(64, "0"),
    bytes: 100,
    mediaType: "image/png",
    width: 1024,
    height: 768,
    playerUserId: 1,
    studioId: "synthetic",
    startedAt: new Date(epoch + index * 10).toISOString(),
    endedAt: new Date(epoch + index * 10 + 8).toISOString(),
  }));
  const plan: StudioSequenceView = {
    scenarioId: "ride",
    camera: null,
    viewport: null,
    maximumGapMs: 100,
    frameBudget: 40,
    requiredTransitions: [
      {
        id: "brief-action",
        source: { kind: "action", stepId: "board" },
        effectWindowMs: 200,
        holdMs: 100,
      },
    ],
  };
  const acquisition: SequenceAcquisition = {
    schema: "basalt-evals/sequence-acquisition",
    placeFile: "synthetic.rbxlx",
    startedAt: new Date(epoch).toISOString(),
    endedAt: new Date(epoch + 1100).toISOString(),
    expectedClients: 1,
    status: "complete",
    reason: null,
    frames,
    clockProbes: [],
  };
  const assessment: SequenceAssessment = {
    schema: "basalt-evals/sequence-assessment",
    planHash: "a".repeat(64),
    status: "sufficient",
    reasons: [],
    clock: { offsetMs: 0, uncertaintyMs: 8 },
    actorFrames: [
      {
        actor: "rider",
        userId: 1,
        frameCount: 101,
        dimensions: ["1024x768"],
        cameraSamples: 101,
        avatarSamples: 101,
        gameViewports: ["1024x768"],
      },
    ],
    transitions: [
      {
        transitionId: "brief-action",
        at: new Date(epoch + 450).toISOString(),
        covered: true,
        gapMs: 2,
      },
    ],
    stateChanges: [],
  };
  return {
    plan,
    acquisition,
    assessment,
    treatment: "sequence" as const,
    criterionIds: ["carriage"],
  };
}

test("the packet manifest describes exactly the dispatched selection and its reasons", () => {
  const input = scene();
  const packet = selectEvidencePacket(input);
  const dispatched = presentSequenceFrames(input);
  assert.equal(packet.manifest.status, "sufficient");
  assert.deepEqual(packet.presentation, dispatched);
  assert.deepEqual(
    packet.manifest.frames.map((frame) => [frame.file, frame.reasons]),
    dispatched.frames.map((frame) => [frame.file, frame.roles]),
  );
  // The last frame wholly before the action at 450 ms ends at 438 ms after the 8 ms uncertainty.
  assert.deepEqual(
    packet.manifest.frames.find((frame) => frame.reasons.includes("before:brief-action"))?.file,
    "frame-43.png",
  );
  // The effect window keeps every frame from 440 ms to 650 ms. The frame at 440 ms ends within
  // the clock uncertainty of the action. The fill uses the rest.
  assert.equal(
    packet.manifest.frames.filter((frame) => frame.reasons.includes("effect:brief-action")).length,
    22,
  );
  assert.equal(
    packet.manifest.frames.find((frame) => frame.reasons.includes("after-hold:brief-action"))?.file,
    "frame-76.png",
  );
  assert.equal(packet.manifest.selectedFrameCount, 40);
  assert.equal(packet.manifest.frameBudget, 40);
  // Before, after-hold and the three effect frames that keep the 100 ms gap.
  assert.equal(packet.manifest.requiredFrameCount, 5);
});

test("a frame budget that cannot hold the required frames is insufficient evidence", () => {
  const input = scene();
  const insufficient = selectEvidencePacket({ ...input, plan: { ...input.plan, frameBudget: 4 } });
  assert.equal(insufficient.manifest.status, "insufficient_evidence");
  assert.equal(insufficient.manifest.frames.length, 0);
  assert.equal(
    insufficient.manifest.omittedIntervals.reduce((sum, interval) => sum + interval.frames, 0),
    101,
  );
  assert.ok(
    insufficient.manifest.warnings.some((warning) =>
      warning.includes("The frame budget of 4 cannot hold the 5 required frames"),
    ),
  );
  const missing = structuredClone(input);
  missing.assessment.transitions[0]!.at = "";
  assert.match(
    selectEvidencePacket(missing).manifest.warnings.join(" "),
    /Transition brief-action has no measured anchor/,
  );
});

test("packet provenance binds sources, criteria, timestamps, omissions and policy without transformations", () => {
  const input = scene();
  const packet = selectEvidencePacket(input),
    repeated = selectEvidencePacket(input);
  assert.deepEqual(packet, repeated);
  assert.equal(packet.manifest.policyHash, EVIDENCE_PACKET_POLICY_HASH);
  assert.equal(packet.manifest.sourceAcquisitionHash, hashJson(input.acquisition));
  assert.notEqual(
    packet.manifest.id,
    selectEvidencePacket({ ...input, criterionIds: ["readability"] }).manifest.id,
  );
  assert.ok(
    packet.manifest.frames.every(
      (frame) =>
        frame.sourceFrameId === hashJson(input.acquisition.frames[frame.sourceIndex]) &&
        frame.transformations.length === 0,
    ),
  );
  assert.equal(
    packet.manifest.omittedIntervals.reduce((sum, interval) => sum + interval.frames, 0) +
      packet.manifest.frames.length,
    101,
  );
  assert.ok(packet.manifest.warnings.some((warning) => warning.includes("occluded or uncaptured")));
  assert.throws(
    () => selectEvidencePacket({ ...input, criterionIds: ["carriage", "carriage"] }),
    /Duplicate packet criterion/,
  );
});

test("recording timeline excludes a separate context session and preserves timestamp gaps", () => {
  const images = [
    {
      id: "context",
      startedAt: new Date(epoch).toISOString(),
      endedAt: new Date(epoch + 10000).toISOString(),
      actor: null,
    },
    {
      id: "first",
      startedAt: new Date(epoch + 100).toISOString(),
      endedAt: new Date(epoch + 108).toISOString(),
      actor: "p1",
    },
    {
      id: "last",
      startedAt: new Date(epoch + 940).toISOString(),
      endedAt: new Date(epoch + 948).toISOString(),
      actor: "p1",
    },
  ];
  const timeline = recordingTimeline(images, { sequence: { frames: images.slice(1) } }, "p1");
  assert.deepEqual(
    timeline.map((frame) => frame.index),
    [1, 2],
  );
  assert.equal(timeline[1]!.elapsedMs, 840);
  assert.equal(timeline[1]!.gapMs, 832);
  assert.deepEqual(recordingTimeline(images, null, "p1"), []);
});

test("each test player has its own recording track on one shared clock", () => {
  // Two clients record at the same times. One track must never alternate between their views.
  const frame = (actor: string, offset: number) => ({
    id: `${actor}-${offset}`,
    startedAt: new Date(epoch + offset).toISOString(),
    endedAt: new Date(epoch + offset + (actor === "p10" ? 9 : 8)).toISOString(),
    actor,
  });
  const images = [frame("p10", 0), frame("p2", 0), frame("p10", 500), frame("p2", 520)];
  const observations = { sequence: { frames: images } };
  assert.deepEqual(recordingTracks(images, observations), ["p2", "p10"]);
  assert.deepEqual(
    recordingTimeline(images, observations, "p2").map((item) => [item.id, item.elapsedMs]),
    [
      ["p2-0", 0],
      ["p2-520", 520],
    ],
  );
  assert.deepEqual(
    recordingTimeline(images, observations, "p10").map((item) => [item.id, item.gapMs]),
    [
      ["p10-0", 0],
      ["p10-500", 491],
    ],
    "the gap is to the previous frame of the same player",
  );
  assert.deepEqual(recordingTracks(images, null), []);
});

test("scenario steps keep each outcome, their times after the start and the plan bound", () => {
  const observations = {
    scenarios: [
      {
        scenarioId: "round",
        reports: [
          {
            context: "Server",
            startAt: 100,
            actors: [],
            steps: [
              {
                stepId: "press",
                outcome: "observed",
                dueAt: 100.5,
                anchorObservedAt: 100.75,
                pollIntervalMs: 33,
                actedAt: 100.8,
                capturedAt: 101,
                action: { kind: "activate_prompt", succeeded: true },
                observations: [{ factId: "lit" }],
              },
              // Not seen in its horizon: no action, no capture and no facts. Inconclusive.
              {
                stepId: "open",
                outcome: "not_observed_within_horizon",
                dueAt: 101,
                observations: [],
              },
              { stepId: "close", outcome: "acquisition_failed", dueAt: 102, observations: [] },
            ],
          },
        ],
      },
    ],
  };
  const plan = [
    {
      id: "round",
      label: "Full round",
      steps: [
        { id: "press", horizonMs: 2000, requirement: null },
        {
          id: "open",
          horizonMs: 3000,
          requirement: { withinMs: 1500, quote: "opens within 1.5 s" },
        },
      ],
    },
  ];
  const [scenario] = scenarioSteps(observations, plan);
  assert.equal(scenario!.label, "Full round");
  assert.deepEqual(
    scenario!.steps.map((step) => [
      step.id,
      step.outcome,
      step.dueMs,
      step.anchorMs,
      step.actedMs,
      step.capturedMs,
      step.action?.kind ?? null,
      step.facts,
      step.horizonMs,
      step.requirement?.quote ?? null,
    ]),
    [
      ["press", "observed", 500, 750, 800, 1000, "activate_prompt", 1, 2000, null],
      [
        "open",
        "not_observed_within_horizon",
        1000,
        null,
        null,
        null,
        null,
        0,
        3000,
        "opens within 1.5 s",
      ],
      ["close", "acquisition_failed", 2000, null, null, null, null, 0, null, null],
    ],
  );
  assert.deepEqual(
    scenarioSteps({ phases: [] }),
    [],
    "An observation without scenarios has no steps",
  );
});

test("runtime arrays stay compact and full measurements are not treated as a verdict", () => {
  const summaries = runtimeFactSummaries({
    phases: [
      {
        id: "ride",
        observations: [
          {
            factId: "rider-motion",
            actor: "rider",
            samples: Array.from({ length: 3000 }, (_, index) => ({
              at: index,
              avatar: [index, 3, 0],
            })),
            distances: [1, 2, 3, 4, 5],
          },
        ],
      },
    ],
  });
  assert.equal(summaries.length, 1);
  assert.ok(summaries[0]!.entries.length < 10);
  assert.ok(summaries[0]!.entries.some(([, value]) => value.includes("3000 recorded entries")));
  assert.ok(
    summaries[0]!.entries.some(([, value]) => value.includes("min 1") && value.includes("max 5")),
  );
});

test("a full diagnostics channel is grouped by text and source, and says later entries were not kept", async () => {
  const error = {
    message: "PointToLocalSpace is not a valid member of CFrame",
    stackTrace: "ServerScriptService.Main, line 47 - function isOnPlatform\n",
    source: {
      kind: "script",
      path: "ServerScriptService.Main",
      className: "Script",
      inDataModel: true,
    },
  };
  const [fact] = runtimeFactSummaries({
    steps: [
      {
        stepId: "collect-session-diagnostics",
        elapsedMs: 130015,
        observations: [
          {
            factId: "server-diagnostics",
            kind: "diagnostics",
            messages: Array(DIAGNOSTIC_CHANNEL_LIMIT).fill(error.message),
            scriptErrors: [
              ...Array(DIAGNOSTIC_CHANNEL_LIMIT - 1).fill(error),
              { ...error, source: { kind: "unavailable" } },
            ],
          },
        ],
      },
    ],
  });
  assert.deepEqual(fact!.entries, []);
  const [messages, scriptErrors] = fact!.diagnostics!;
  assert.deepEqual(messages, {
    channel: "messages",
    kept: DIAGNOSTIC_CHANNEL_LIMIT,
    full: true,
    groups: [
      { message: error.message, source: null, stackTrace: null, count: DIAGNOSTIC_CHANNEL_LIMIT },
    ],
  });
  // Identical text from an unknown source stays its own group: grouping never attributes it.
  assert.deepEqual(
    scriptErrors!.groups.map((group) => [group.count, group.source]),
    [
      [DIAGNOSTIC_CHANNEL_LIMIT - 1, "ServerScriptService.Main (Script)"],
      [1, null],
    ],
  );
  const [empty] = runtimeFactSummaries({
    factId: "rider-diagnostics",
    kind: "diagnostics",
    messages: [],
    scriptErrors: [],
  });
  assert.deepEqual(
    empty!.diagnostics!.map((channel) => [channel.kept, channel.full, channel.groups.length]),
    [
      [0, false, 0],
      [0, false, 0],
    ],
  );
  // The Studio connector keeps the same number of entries per channel.
  const collector = await readFile("plugin/src/Collector.luau", "utf8");
  assert.match(collector, new RegExp(`local CHANNEL_LIMIT = ${DIAGNOSTIC_CHANNEL_LIMIT}\\b`));
});

test("the carriage input keeps the builder prompt of the moving-platform input and splits support from appearance", async () => {
  // Time summaries use explicitly supported fact shapes, preserve every sample,
  // and highlight discontinuities without labeling them passes or failures.
  const samples = [8.4, 8.4, 3.4, 3.4].map((actorY, index) => ({
    elapsedMs: index * 250,
    x: index * 5,
    actorX: index < 2 ? index * 5 : 5,
    actorY,
    localX: index < 2 ? 0 : 5 - index * 5,
    localY: actorY - 5,
    localZ: 0,
  }));
  const fact = runtimeFactSummaries({
    context: "ride",
    steps: [
      {
        stepId: "endpoint-window",
        elapsedMs: 4000,
        observations: [
          { factId: "rider-motion", kind: "actor_part_motion", actor: "rider", samples },
        ],
      },
    ],
  })[0]!;
  assert.equal(fact.trace!.durationMs, 750);
  assert.equal(fact.trace!.maxGapMs, 250);
  assert.deepEqual(fact.trace!.samples, samples);
  assert.ok(fact.trace!.highlighted.includes(1) && fact.trace!.highlighted.includes(2));
  assert.ok(fact.context.includes("endpoint-window"));
  const original = JSON.parse(
    await readFile("studies/product-acceptance/moving-platform.json", "utf8"),
  );
  const authored = JSON.parse(
    await readFile("studies/product-acceptance/moving-platform-carriage.json", "utf8"),
  );
  assert.equal(authored.builderPrompt, original.builderPrompt);
  const before = createEvalDraft(original),
    after = createEvalDraft(authored);
  assert.notEqual(before.id, after.id);
  assert.equal(before.stages[0]!.criteria.length, 3);
  assert.equal(after.stages[0]!.criteria.length, 4);
  assert.ok(
    after.stages[0]!.criteria.some((criterion) => criterion.text.includes("Unintended detachment")),
  );
  assert.ok(
    after.stages[0]!.criteria.some((criterion) =>
      criterion.text.includes("visible platform motion"),
    ),
  );
  // The author set a class only where it is obvious. The other criteria need a human decision.
  assert.deepEqual(
    before.stages[0]!.criteria.map((criterion) => criterion.evidenceClass),
    ["motion", null, null],
  );
  assert.deepEqual(
    after.stages[0]!.criteria.map((criterion) => criterion.evidenceClass),
    ["motion", null, null, null],
  );
});
