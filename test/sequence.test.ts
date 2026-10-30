import assert from "node:assert/strict";
import test from "node:test";
import {
  contentHash,
  isSequenceTransitionBinding,
  assertStudioSequenceView,
  type StudioCollectionPlan,
  type StudioScenarioReport,
} from "../packages/contracts/src/index.js";
import {
  assertSequenceBytes,
  assertSequencePlan,
  assessSequence,
  parseSequenceSample,
  parseSequenceStateChange,
  type ClockAlignment,
  type SequencePlan,
  type SequenceSample,
  type SequenceStateChange,
} from "../packages/studio-runner/src/sequence.js";
import { probeClock } from "../packages/studio-runner/src/sequence-timing.js";
import type {
  SequenceAcquisition,
  SequenceFrame,
} from "../packages/studio-runner/src/studio-mcp.js";

const image = Buffer.from("fake signed image bytes");
const base = Date.parse("2026-09-22T12:00:00.000Z");
const plan: SequencePlan = {
  schema: "basalt-evals/sequence-plan",
  suiteHash: "a".repeat(64),
  sourceHash: "b".repeat(64),
  implementationCommit: "c".repeat(40),
  scenarioId: "gate-open",
  viewId: "standard",
  requiredTransitions: [
    {
      id: "activation-window",
      source: { kind: "action", stepId: "activate" },
      effectWindowMs: 0,
      holdMs: 0,
    },
  ],
  camera: null,
  viewport: { width: 1280, height: 720 },
  maximumGapMs: 1000,
  frameBudget: 64,
};
const reports: StudioScenarioReport[] = [
  {
    context: "server",
    startAt: base / 1000,
    actors: [
      { actor: "left", userId: -1, name: "Player1" },
      { actor: "right", userId: -2, name: "Player2" },
    ],
    steps: [],
  },
];
function frame(userId: number, sequence: number, offset: number): SequenceFrame {
  return {
    file: `frame-${String(sequence).padStart(4, "0")}.png`,
    hash: contentHash(image),
    bytes: image.length,
    mediaType: "image/png",
    width: 1280,
    height: 720,
    playerUserId: userId,
    studioId: `client-${userId}`,
    startedAt: new Date(base + offset).toISOString(),
    endedAt: new Date(base + offset + 50).toISOString(),
  };
}
function acquisition(): SequenceAcquisition {
  return {
    schema: "basalt-evals/sequence-acquisition",
    placeFile: "BasaltEval-0123456789abcdef0123.rbxlx",
    startedAt: new Date(base).toISOString(),
    endedAt: new Date(base + 1500).toISOString(),
    expectedClients: 2,
    status: "complete",
    reason: null,
    frames: [
      frame(-1, 1, 0),
      frame(-2, 2, 0),
      frame(-1, 3, 450),
      frame(-2, 4, 450),
      frame(-1, 5, 900),
      frame(-2, 6, 900),
      frame(-1, 7, 1350),
      frame(-2, 8, 1350),
    ],
    // The Studio clock agrees with the host clock. The shortest probe takes 100 ms.
    clockProbes: [-1, -2].flatMap((userId) => [
      clockProbe(userId, 100, 100),
      clockProbe(userId, 1100, 160),
    ]),
  };
}
function clockProbe(userId: number, sentMs: number, roundTripMs: number) {
  const middle = base + sentMs + roundTripMs / 2;
  return {
    playerUserId: userId,
    studioId: `client-${userId}`,
    hostSentAt: new Date(base + sentMs).toISOString(),
    hostReceivedAt: new Date(base + sentMs + roundTripMs).toISOString(),
    serverTime: middle / 1000,
    clientTime: middle / 1000,
  };
}
function samples(): SequenceSample[] {
  return [-1, -2].flatMap((userId) =>
    [0, 500, 1000, 1500].map((offset) => ({
      context: userId === -1 ? "left" : "right",
      userId,
      at: (base + offset) / 1000,
      avatar: [0, 5, 0] as [number, number, number],
      camera: {
        position: [0, 8, 12] as [number, number, number],
        look: [0, 0, -1] as [number, number, number],
        viewport: [1280, 720] as [number, number],
      },
    })),
  );
}
function assess(
  value: SequenceAcquisition,
  observed = samples(),
  clock: ClockAlignment | null = probeClock(value.clockProbes),
  view: SequencePlan = plan,
) {
  return assessSequence({
    plan: view,
    acquisition: value,
    reports,
    expectedClients: 2,
    transitions: [{ stepId: "activate", context: "left", at: (base + 750) / 1000 }],
    samples: observed,
    stateChanges: [],
    traceComplete: true,
    clock,
  });
}

test("two actor-bound sequences cover the measured action without inventing exposure times", () => {
  const result = assess(acquisition());
  assert.equal(result.status, "sufficient");
  assert.equal(result.transitions[0]?.transitionId, "activation-window");
  assert.deepEqual(
    result.actorFrames.map((row) => row.frameCount),
    [4, 4],
  );
  assert.deepEqual(
    result.transitions.map((row) => [row.covered, row.gapMs]),
    [[true, 400]],
  );
  assertSequenceBytes(acquisition().frames[0]!, image);
  assert.throws(
    () => assertSequenceBytes(acquisition().frames[0]!, Buffer.from("tampered")),
    /hash mismatch/,
  );
});

test("retained live startup timings need recorder readiness before the shared scenario clock", () => {
  // Original first nine acquisition intervals from run-39d589edee278a14508808b2de23b7eb.
  // Keep the historical action insufficient; only a newly scheduled action has pre-roll.
  const timings = [
    {
      capture: "capture-6990ff5a44669a64b85626b1f2078d63",
      origin: "2026-09-30T09:05:59.842Z",
      actionMs: 254,
      intervals: [
        [0, 738],
        [503, 1222],
        [1004, 1698],
        [1504, 2238],
        [2007, 2707],
        [2508, 3238],
        [3009, 3710],
        [3510, 4238],
        [4011, 4721],
      ],
    },
    {
      capture: "capture-290a24729bacb32b4b73e682990ae435",
      origin: "2026-09-30T09:09:40.401Z",
      actionMs: 476,
      intervals: [
        [0, 708],
        [503, 1240],
        [1005, 1672],
        [1507, 2227],
        [2007, 2709],
        [2507, 3222],
        [3007, 3694],
        [3507, 4225],
        [4007, 4689],
      ],
    },
    {
      capture: "capture-9b0fd1ab0c142a05f3eef53bc50bfdba",
      origin: "2026-09-30T09:13:12.265Z",
      actionMs: 454,
      intervals: [
        [0, 747],
        [502, 1204],
        [1003, 1730],
        [1505, 2202],
        [2006, 2714],
        [2509, 3245],
        [3009, 3716],
        [3510, 4245],
        [4011, 4734],
      ],
    },
  ];
  for (const timing of timings) {
    const start = Date.parse(timing.origin);
    const recorded: SequenceAcquisition = {
      ...acquisition(),
      expectedClients: 1,
      startedAt: timing.origin,
      endedAt: new Date(start + timing.intervals.at(-1)![1]!).toISOString(),
      frames: timing.intervals.map(([from, to], index) => ({
        ...frame(-1, index + 1, 0),
        startedAt: new Date(start + from!).toISOString(),
        endedAt: new Date(start + to!).toISOString(),
      })),
    };
    const assessAt = (actionMs: number) =>
      assessSequence({
        plan,
        acquisition: recorded,
        reports: [{ ...reports[0]!, actors: [reports[0]!.actors[0]!] }],
        expectedClients: 1,
        transitions: [{ stepId: "activate", context: "left", at: (start + actionMs) / 1000 }],
        samples: Array.from({ length: 10 }, (_, index) => ({
          ...samples()[0]!,
          at: (start + index * 500) / 1000,
        })),
        stateChanges: [],
        traceComplete: true,
        clock: probeClock(recorded.clockProbes),
      });
    const original = assessAt(timing.actionMs);
    assert.equal(original.status, "insufficient", timing.capture);
    assert.deepEqual(original.reasons, [
      "Actor left has no frame that ends before activation-window starts",
    ]);
    // First frame retained, then the existing two-second lead and authored 500ms action offset.
    const afterReadiness = assessAt(timing.intervals[0]![1]! + 2000 + 500);
    assert.equal(
      afterReadiness.status,
      "sufficient",
      `${timing.capture}: ${afterReadiness.reasons.join("; ")}`,
    );
    assert.equal(afterReadiness.transitions[0]!.covered, true);
    assert.ok(afterReadiness.transitions[0]!.gapMs! <= 1000);
  }
});

test("assessment accepts long retained sequences and five-digit frame ordinals", () => {
  const recorded = acquisition();
  recorded.frames.push(
    ...Array.from({ length: 11000 }, (_, i) => frame(i % 2 ? -2 : -1, i + 9, 1500 + i * 250)),
  );
  recorded.endedAt = recorded.frames.at(-1)!.endedAt;
  const result = assess(recorded);
  assert.equal(result.status, "sufficient", result.reasons.join("; "));
  assert.equal(
    result.actorFrames.reduce((count, actor) => count + actor.frameCount, 0),
    11008,
  );
});

test("sequence references bind measured sources independently of labels, with actionable aggregate errors", () => {
  const studio: StudioCollectionPlan = {
    schema: "basalt-evals/studio-plan",
    clients: 1,
    actors: ["player"],
    roles: [],
    phases: [],
    scenarios: [
      {
        id: "gate-open",
        label: "Gate",
        durationMs: 1000,
        reportContexts: ["server", "player"],
        steps: [
          {
            id: "activate",
            at: { startMs: 0 },
            horizonMs: 1000,
            holdMs: 0,
            action: { kind: "press_key", actor: "player", key: "E" },
            observations: [],
            requirement: null,
          },
          {
            id: "observe-state",
            at: { after: { step: "activate" }, offsetMs: 500 },
            horizonMs: 1000,
            holdMs: 0,
            requirement: null,
            action: { kind: "wait" },
            observations: [
              {
                context: "server",
                fact: {
                  id: "state",
                  kind: "replication_probe",
                  path: "game.Workspace.Gate",
                  attribute: "Open",
                },
              },
            ],
          },
        ],
      },
    ],
  };
  const view = {
    scenarioId: plan.scenarioId,
    camera: null,
    viewport: null,
    maximumGapMs: 1000,
    frameBudget: 64,
    requiredTransitions: [
      ...plan.requiredTransitions,
      {
        id: "gate-closes",
        source: {
          kind: "state",
          context: "server",
          path: "game.Workspace.Gate",
          attribute: "Open",
          from: true,
          to: false,
        },
        effectWindowMs: 500,
        holdMs: 500,
      },
    ],
  };
  assertStudioSequenceView(view, studio);
  assertSequencePlan({ ...plan, ...view }, studio);
  const broken = structuredClone(view);
  Object.assign(broken.requiredTransitions[0]!.source, { stepId: "missing-action" });
  Object.assign(broken.requiredTransitions[1]!.source, { attribute: "NotObserved" });
  assert.throws(
    () => assertStudioSequenceView(broken, studio),
    (error: Error) => {
      assert.match(
        error.message,
        /\/requiredTransitions\/0\/source\/stepId.*missing-action.*declared actions: activate/,
      );
      assert.match(error.message, /\/requiredTransitions\/1\/source.*NotObserved/);
      return true;
    },
  );
  Object.assign(broken.requiredTransitions[0]!.source, { stepId: "observe-state" });
  assert.throws(
    () => assertSequencePlan({ ...plan, ...broken }, studio),
    /must reference a non-wait action/,
  );
  assert.throws(() => assertStudioSequenceView(broken, studio), /must reference a non-wait action/);
  const long = structuredClone(view);
  long.requiredTransitions[1]!.holdMs = 600;
  assert.throws(() => assertStudioSequenceView(long, studio), /must fit in the 1000 ms duration/);
  assert.throws(
    () => assertStudioSequenceView({ ...view, maximumGapMs: 99 }, studio),
    /Invalid Studio sequence/,
  );
  const { maximumGapMs: _, ...withoutGap } = view;
  assert.throws(() => assertStudioSequenceView(withoutGap, studio), /Invalid Studio sequence/);
  // The frame budget is an integer from 1 to the 64-image request limit.
  for (const frameBudget of [0, 65, 2.5])
    assert.throws(
      () => assertStudioSequenceView({ ...view, frameBudget }, studio),
      /Invalid Studio sequence/,
    );
  const { frameBudget: __, ...withoutBudget } = view;
  assert.throws(() => assertStudioSequenceView(withoutBudget, studio), /Invalid Studio sequence/);
  assert.throws(
    () => assertStudioSequenceView({ ...view, scenarioId: "unknown" }, studio),
    /declared scenarios: gate-open/,
  );
  assert.throws(
    () =>
      assertStudioSequenceView(
        {
          ...view,
          requiredTransitions: [view.requiredTransitions[0], view.requiredTransitions[0]],
        },
        studio,
      ),
    /Invalid Studio sequence/,
  );
});

test("static rendered evidence needs complete acquisition without an invented transition", () => {
  const staticPlan: SequencePlan = { ...plan, requiredTransitions: [] };
  assertSequencePlan(staticPlan);
  const result = assessSequence({
    plan: staticPlan,
    acquisition: acquisition(),
    reports,
    expectedClients: 2,
    transitions: [],
    samples: samples(),
    stateChanges: [],
    traceComplete: true,
    clock: probeClock(acquisition().clockProbes),
  });
  assert.equal(result.status, "sufficient");
  assert.deepEqual(result.transitions, []);
  const broken = acquisition();
  broken.frames = [];
  assert.equal(
    assessSequence({
      plan: staticPlan,
      acquisition: broken,
      reports,
      expectedClients: 2,
      transitions: [],
      samples: samples(),
      stateChanges: [],
      traceComplete: true,
      clock: probeClock(broken.clockProbes),
    }).status,
    "insufficient",
  );
});

test("sequence state bindings accept semantic role references", () => {
  assert.equal(
    isSequenceTransitionBinding({
      id: "changed",
      source: {
        kind: "state",
        context: "server",
        path: "role.checkpoint",
        attribute: "Active",
        from: false,
        to: true,
      },
      effectWindowMs: 1000,
      holdMs: 500,
    }),
    true,
  );
});

test("missing transition, actor, native viewport, and ordered acquisition fail closed", () => {
  const sparse = acquisition();
  sparse.frames = sparse.frames.filter(
    (entry) =>
      entry.playerUserId !== -2 || ![450, 900].includes(Date.parse(entry.startedAt) - base),
  );
  assert.equal(assess(sparse).status, "insufficient");
  assert.match(
    assess(sparse).reasons.join(" "),
    /Actor right has a 1300 ms frame gap in activation-window; the view permits 1000 ms/,
  );

  const wrongActor = acquisition();
  wrongActor.frames[0]!.playerUserId = -3;
  assert.match(assess(wrongActor).reasons.join(" "), /Unbound captured player/);

  const wrongViewport = samples();
  wrongViewport[0]!.camera!.viewport = [1279, 720];
  assert.match(assess(acquisition(), wrongViewport).reasons.join(" "), /native game viewport/);

  const reordered = acquisition();
  [reordered.frames[0], reordered.frames[2]] = [reordered.frames[2]!, reordered.frames[0]!];
  assert.match(assess(reordered).reasons.join(" "), /reordered frames/);

  const missing = assessSequence({
    plan,
    acquisition: acquisition(),
    reports,
    expectedClients: 2,
    transitions: [],
    samples: samples(),
    stateChanges: [],
    traceComplete: true,
    clock: probeClock(acquisition().clockProbes),
  });
  assert.match(missing.reasons.join(" "), /lacks one measured action or state change/);
  assert.match(assess(acquisition(), []).reasons.join(" "), /camera\/avatar samples/);
});

test("reset timing binds the observed state change, never the planned wait step", () => {
  const statePlan: SequencePlan = {
    ...plan,
    requiredTransitions: [
      {
        id: "closed",
        source: {
          kind: "state",
          context: "server",
          path: "game.ReplicatedStorage.GateState",
          attribute: "GateOpen",
          from: true,
          to: false,
        },
        effectWindowMs: 0,
        holdMs: 0,
      },
    ],
  };
  const stateChanges = [
    {
      context: "server",
      path: "game.ReplicatedStorage.GateState",
      attribute: "GateOpen",
      at: base / 1000,
      value: true,
    },
    {
      context: "server",
      path: "game.ReplicatedStorage.GateState",
      attribute: "GateOpen",
      at: (base + 750) / 1000,
      value: false,
    },
  ];
  const assessState = (changes: SequenceStateChange[], traceComplete = true) =>
    assessSequence({
      plan: statePlan,
      acquisition: acquisition(),
      reports,
      expectedClients: 2,
      transitions: [{ stepId: "closed", context: "server", at: (base + 750) / 1000 }],
      samples: samples(),
      stateChanges: changes,
      traceComplete,
      clock: probeClock(acquisition().clockProbes),
    });
  const result = assessState(stateChanges);
  assert.equal(result.status, "sufficient", result.reasons.join("; "));
  assert.equal(result.transitions[0]?.at, new Date(base + 750).toISOString());
  // A watched probe without the change is an effect that the recording never observed.
  const withoutChange = assessState(stateChanges.slice(0, 1));
  assert.equal(withoutChange.status, "sufficient", withoutChange.reasons.join("; "));
  assert.deepEqual(withoutChange.transitions[0], {
    transitionId: "closed",
    at: "",
    covered: true,
    gapMs: null,
  });
  // A trace that stopped at its size limit cannot show that the effect did not occur.
  const truncated = assessState(stateChanges.slice(0, 1), false);
  assert.equal(truncated.status, "insufficient");
  assert.match(truncated.reasons.join(" "), /The Studio trace reached its size limit/);
  // A probe without any record, or two changes, cannot anchor the transition.
  assert.match(assessState([]).reasons.join(" "), /Transition closed lacks one measured/);
  const repeated = [
    ...stateChanges,
    { ...stateChanges[0]!, at: (base + 900) / 1000 },
    { ...stateChanges[1]!, at: (base + 1000) / 1000 },
  ];
  assert.match(assessState(repeated).reasons.join(" "), /Transition closed lacks one measured/);
});

test("frame comparisons apply the explicit clock alignment and the authored windows", () => {
  const value = acquisition();
  // The shortest probe takes 100 ms from request to response, so the uncertainty is 50 ms.
  assert.deepEqual(probeClock(value.clockProbes), { offsetMs: 0, uncertaintyMs: 50 });
  // A recording without a probe cannot align its anchors with its frames.
  const unaligned = assess(value, samples(), null);
  assert.equal(unaligned.status, "insufficient");
  assert.equal(unaligned.clock, null);
  assert.match(unaligned.reasons.join(" "), /No clock probe aligns the Studio clock/);
  const sufficient = assess(value, samples(), { offsetMs: 0, uncertaintyMs: 400 });
  assert.equal(sufficient.status, "sufficient", sufficient.reasons.join("; "));
  assert.deepEqual(sufficient.clock, { offsetMs: 0, uncertaintyMs: 400 });
  // A wider uncertainty removes every frame that ends close enough before the action.
  const uncertain = assess(value, samples(), { offsetMs: 0, uncertaintyMs: 800 });
  assert.match(uncertain.reasons.join(" "), /no frame that ends before activation-window/);
  // An offset moves the anchor on the host clock. Here no frame ends before it.
  const offset = assess(value, samples(), { offsetMs: -750, uncertaintyMs: 50 });
  assert.match(offset.reasons.join(" "), /no frame that ends before activation-window/);
  const invalid = assess(value, samples(), { offsetMs: Number.NaN, uncertaintyMs: 50 });
  assert.match(invalid.reasons.join(" "), /Clock alignment between Studio and frames is invalid/);
  // The declared hold must end inside the recording. The last frame starts at 1350 ms.
  const held = structuredClone(plan);
  held.requiredTransitions[0]!.effectWindowMs = 500;
  held.requiredTransitions[0]!.holdMs = 400;
  const result = assess(value, samples(), probeClock(value.clockProbes), held);
  assert.match(result.reasons.join(" "), /no frame after the declared hold of activation-window/);
  const fits = structuredClone(held);
  fits.requiredTransitions[0]!.holdMs = 0;
  assert.equal(assess(value, samples(), probeClock(value.clockProbes), fits).status, "sufficient");
});

test("sequence plans reject arbitrary executable fields and invalid geometry", () => {
  assertSequencePlan(plan);
  assert.throws(() => assertSequencePlan({ ...plan, script: "print('x')" }), /Invalid/);
  assert.throws(
    () =>
      assertSequencePlan({ ...plan, camera: { position: [Infinity, 0, 0], lookAt: [0, 0, 0] } }),
    /Invalid/,
  );
  assert.deepEqual(
    parseSequenceSample({
      context: "left",
      userId: -1,
      at: base / 1000,
      avatarX: 0,
      avatarY: 5,
      avatarZ: 0,
      cameraX: 0,
      cameraY: 8,
      cameraZ: 12,
      lookX: 0,
      lookY: 0,
      lookZ: -1,
      viewportWidth: 1280,
      viewportHeight: 720,
    }),
    {
      context: "left",
      userId: -1,
      at: base / 1000,
      avatar: [0, 5, 0],
      camera: { position: [0, 8, 12], look: [0, 0, -1], viewport: [1280, 720] },
    },
  );
  assert.equal(
    parseSequenceSample({
      context: "left",
      userId: -1,
      at: base / 1000,
      viewportWidth: 0,
      viewportHeight: 0,
    }),
    null,
  );
  assert.equal(
    parseSequenceStateChange({
      context: "left",
      path: "game.ReplicatedStorage.GateState",
      attribute: "GateOpen",
      at: base / 1000,
      value: true,
    })?.value,
    true,
  );
});
