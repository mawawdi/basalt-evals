import assert from "node:assert/strict";
import test from "node:test";
import type { StudioSequenceView } from "../packages/contracts/src/index.js";
import { presentSequenceFrames } from "../packages/studio-runner/src/presentation.js";
import type { SequenceAssessment } from "../packages/studio-runner/src/sequence.js";
import type {
  SequenceAcquisition,
  SequenceFrame,
} from "../packages/studio-runner/src/studio-mcp.js";

const base = Date.parse("2026-09-22T12:00:00.000Z");
function frame(number: number, userId: number, startMs: number): SequenceFrame {
  return {
    file: `frame-${String(number).padStart(4, "0")}.png`,
    hash: String(number).padStart(64, "a"),
    bytes: 100,
    mediaType: "image/png",
    width: 1280,
    height: 720,
    playerUserId: userId,
    studioId: `client-${userId}`,
    startedAt: new Date(base + startMs).toISOString(),
    endedAt: new Date(base + startMs + 80).toISOString(),
  };
}

/** Frames every `stepMs` for each actor, with the Studio anchor of one transition. */
function evidence(input: {
  users?: number[];
  stepMs?: number;
  durationMs?: number;
  anchorMs?: number | null;
  source?: "action" | "state";
  effectWindowMs?: number;
  holdMs?: number;
  frameBudget?: number;
}) {
  const users = input.users ?? [1001];
  const stepMs = input.stepMs ?? 500;
  const durationMs = input.durationMs ?? 6000;
  const frames: SequenceFrame[] = [];
  for (let at = 0; at <= durationMs; at += stepMs)
    for (const user of users) frames.push(frame(frames.length + 1, user, at));
  const plan: StudioSequenceView = {
    scenarioId: "operate",
    camera: null,
    viewport: null,
    maximumGapMs: 1000,
    frameBudget: input.frameBudget ?? 64,
    requiredTransitions: [
      {
        id: "open",
        source:
          input.source === "state"
            ? {
                kind: "state",
                context: "server",
                path: "game.Workspace.Door",
                attribute: "Open",
                from: false,
                to: true,
              }
            : { kind: "action", stepId: "press" },
        effectWindowMs: input.effectWindowMs ?? 1000,
        holdMs: input.holdMs ?? 1000,
      },
    ],
  };
  const acquisition: SequenceAcquisition = {
    schema: "basalt-evals/sequence-acquisition",
    placeFile: "BasaltEval-aaaaaaaaaaaaaaaaaaaa.rbxlx",
    startedAt: new Date(base).toISOString(),
    endedAt: new Date(base + durationMs + 80).toISOString(),
    expectedClients: users.length,
    status: "complete",
    reason: null,
    frames,
    clockProbes: [],
  };
  const anchorMs = input.anchorMs === undefined ? 2000 : input.anchorMs;
  const assessment: SequenceAssessment = {
    schema: "basalt-evals/sequence-assessment",
    planHash: "b".repeat(64),
    status: "sufficient",
    reasons: [],
    clock: { offsetMs: 0, uncertaintyMs: 80 },
    actorFrames: users.map((userId, index) => ({
      actor: `actor-${index + 1}`,
      userId,
      frameCount: frames.filter((item) => item.playerUserId === userId).length,
      dimensions: ["1280×720"],
      cameraSamples: 4,
      avatarSamples: 4,
      gameViewports: ["1280×720"],
    })),
    transitions: [
      {
        transitionId: "open",
        at: anchorMs === null ? "" : new Date(base + anchorMs).toISOString(),
        covered: true,
        gapMs: anchorMs === null ? null : 0,
      },
    ],
    stateChanges: [],
  };
  return { plan, acquisition, assessment };
}

const startOf = (presented: { frames: Array<{ startedAt: string }> }) =>
  presented.frames.map((item) => Date.parse(item.startedAt) - base);
const rolesAt = (
  presented: { frames: Array<{ startedAt: string; roles: string[] }> },
  startMs: number,
) => presented.frames.find((item) => Date.parse(item.startedAt) - base === startMs)?.roles;

test("the fixed rule keeps the frame before the action, the effect window and the frame after the hold", () => {
  const input = evidence({ frameBudget: 6 });
  const presented = presentSequenceFrames({ ...input, treatment: "sequence" });
  assert.equal(presented.status, "sufficient", presented.reasons.join("; "));
  // Before, after-hold and the two effect frames that keep the 1000 ms gap are required.
  assert.equal(presented.requiredFrameCount, 4);
  assert.equal(presented.frameBudget, 6);
  // The frame at 2000 ms ends within the clock uncertainty of the action, so 1500 ms is before.
  assert.deepEqual(rolesAt(presented, 1500), ["before:open"]);
  for (const startMs of [2000, 2500, 3000])
    assert.deepEqual(rolesAt(presented, startMs), ["effect:open"]);
  // The hold ends at 4000 ms. The first frame that starts after it and its uncertainty is 4500 ms.
  assert.deepEqual(rolesAt(presented, 4500), ["after-hold:open"]);
  // One slot of the budget remains. The even fill takes the first unselected frame.
  assert.deepEqual(rolesAt(presented, 0), ["uniform"]);
  assert.deepEqual(startOf(presented), [0, 1500, 2000, 2500, 3000, 4500]);
  assert.deepEqual(
    presented.context.intervals.map((item) => item.frameId),
    presented.frames.map((item) => item.id),
  );
  // Phase captures in the same request reduce the room for sequence frames.
  const shared = presentSequenceFrames({
    ...evidence({}),
    treatment: "sequence",
    phaseCaptureCount: 60,
  });
  assert.equal(shared.frameBudget, 4);
  assert.equal(shared.frames.length, 4);
  const full = presentSequenceFrames({
    ...input,
    plan: { ...input.plan, frameBudget: 64 },
    treatment: "sequence",
  });
  assert.equal(full.frames.length, input.acquisition.frames.length);
  assert.equal(JSON.stringify(full.context).includes("client-1001"), false);
});

test("a still keeps only the frame after each hold and the last frame of each actor", () => {
  const presented = presentSequenceFrames({ ...evidence({}), treatment: "still" });
  assert.deepEqual(startOf(presented), [4500, 6000]);
  assert.deepEqual(
    presented.frames.map((item) => item.roles),
    [["after-hold:open"], ["end"]],
  );
});

test("a state anchor adds the first frame after the observed effect", () => {
  const presented = presentSequenceFrames({
    ...evidence({ source: "state", frameBudget: 5 }),
    treatment: "sequence",
  });
  assert.equal(presented.status, "sufficient", presented.reasons.join("; "));
  assert.deepEqual(rolesAt(presented, 2500), ["after-effect:open", "effect:open"]);
  assert.deepEqual(rolesAt(presented, 1500), ["before:open"]);
  assert.deepEqual(rolesAt(presented, 4500), ["after-hold:open"]);
});

test("an effect that the recording never observed labels the end of the observation horizon", () => {
  const input = evidence({ source: "state", anchorMs: null, frameBudget: 4 });
  const presented = presentSequenceFrames({ ...input, treatment: "sequence" });
  assert.equal(presented.status, "sufficient", presented.reasons.join("; "));
  assert.deepEqual(rolesAt(presented, 6000), ["horizon-end:open"]);
  assert.equal(
    presented.frames.filter((item) => item.roles.includes("uniform")).length,
    3,
    "The rest of the budget fills evenly",
  );
  // An action anchor always needs its measured start.
  const action = evidence({ anchorMs: null });
  const missing = presentSequenceFrames({ ...action, treatment: "sequence" });
  assert.equal(missing.status, "insufficient");
  assert.match(missing.reasons.join(" "), /Transition open has no measured anchor/);
});

test("the fewest effect frames that keep the view gap are required within the frame budget", () => {
  // A 4000 ms window at four frames per second holds 17 frames.
  const input = evidence({ stepMs: 250, durationMs: 10_000, effectWindowMs: 4000, holdMs: 0 });
  const budget = (frameBudget: number) =>
    presentSequenceFrames({
      ...input,
      plan: { ...input.plan, frameBudget },
      treatment: "sequence",
    });
  const spread = budget(8);
  assert.equal(spread.status, "sufficient", spread.reasons.join("; "));
  // Before, after-hold and five effect frames at most 1000 ms apart are required.
  assert.equal(spread.requiredFrameCount, 7);
  assert.equal(spread.frames.length, 8);
  assert.equal(spread.frames.filter((item) => item.roles.includes("uniform")).length, 0);
  const shown = spread.frames.filter(
    (item) => item.roles.includes("before:open") || item.roles.includes("effect:open"),
  );
  assert.equal(shown.length, 7);
  for (const [index, item] of shown.entries())
    if (index > 0)
      assert.ok(
        Date.parse(item.startedAt) - Date.parse(shown[index - 1]!.endedAt) <= 1000,
        "The shown frames keep the view gap",
      );
  assert.equal(Date.parse(shown.at(-1)!.startedAt) - base, 6000, "The last window frame is shown");
  // Six frames cannot hold the seven required frames. The evidence is insufficient, not cut.
  for (const frameBudget of [6, 1]) {
    const narrow = budget(frameBudget);
    assert.equal(narrow.status, "insufficient");
    assert.deepEqual(narrow.frames, []);
    assert.match(
      narrow.reasons.join(" "),
      new RegExp(`The frame budget of ${frameBudget} cannot hold the 7 required frames`),
    );
  }
});

test("two actors each get transition frames and an even share of the fill", () => {
  const input = evidence({ users: [1001, 1002], frameBudget: 14 });
  const presented = presentSequenceFrames({ ...input, treatment: "sequence" });
  assert.equal(presented.status, "sufficient", presented.reasons.join("; "));
  for (const actor of ["actor-1", "actor-2"]) {
    const frames = presented.frames.filter((item) => item.actor === actor);
    assert.ok(frames.some((item) => item.roles.includes("before:open")));
    assert.ok(frames.some((item) => item.roles.includes("after-hold:open")));
    assert.equal(frames.filter((item) => item.roles.includes("uniform")).length, 2);
  }
  // Frames sort by acquisition start, then by actor.
  assert.deepEqual(
    presented.frames.slice(0, 2).map((item) => item.actor),
    ["actor-1", "actor-2"],
  );
});

test("static scenes with no transition reach bounded still and sequence prompts", () => {
  const input = evidence({ users: [1001, 1002], durationMs: 500 });
  input.plan.requiredTransitions = [];
  input.assessment.transitions = [];
  const still = presentSequenceFrames({ ...input, treatment: "still" });
  assert.deepEqual(
    still.frames.map((item) => [item.actor, item.roles]),
    [
      ["actor-1", ["end"]],
      ["actor-2", ["end"]],
    ],
  );
  const sequence = presentSequenceFrames({ ...input, treatment: "sequence" });
  assert.equal(sequence.frames.length, 4);
});

test("missing, reordered, or unrelated frames cannot enter a prompt", () => {
  const sparse = evidence({});
  sparse.acquisition.frames = sparse.acquisition.frames.filter(
    (item) => ![2500, 3000].includes(Date.parse(item.startedAt) - base),
  );
  const gap = presentSequenceFrames({ ...sparse, treatment: "sequence" });
  assert.equal(gap.status, "insufficient");
  assert.match(gap.reasons.join(" "), /1420 ms frame gap in open/);
  const reordered = evidence({});
  [reordered.acquisition.frames[0], reordered.acquisition.frames[2]] = [
    reordered.acquisition.frames[2]!,
    reordered.acquisition.frames[0]!,
  ];
  assert.throws(() => presentSequenceFrames({ ...reordered, treatment: "sequence" }), /Reordered/);
  const unrelated = evidence({});
  unrelated.acquisition.frames.push(frame(99, 9999, 2200));
  assert.throws(() => presentSequenceFrames({ ...unrelated, treatment: "sequence" }), /Unbound/);
  const incomplete = evidence({});
  incomplete.assessment.status = "insufficient";
  incomplete.assessment.reasons = ["Actor actor-1 lacks concurrent state samples around open"];
  const rejected = presentSequenceFrames({ ...incomplete, treatment: "sequence" });
  assert.equal(rejected.status, "insufficient");
  assert.match(rejected.reasons.join(" "), /concurrent state samples/);
  const otherView = evidence({});
  otherView.plan.requiredTransitions[0]!.id = "close";
  assert.throws(
    () => presentSequenceFrames({ ...otherView, treatment: "sequence" }),
    /assessed sequence of this view/,
  );
});
