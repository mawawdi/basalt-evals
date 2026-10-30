import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { sequenceEvents } from "../packages/operator/src/evidence.js";
import { readHoldoutAccess } from "../packages/operator/src/holdout-access.js";
import { freezeRegisteredEvalRun } from "../packages/operator/src/run-plan.js";
import { subjectEval } from "../packages/operator/src/run-manifest.js";
import { sideBySideEvidence, sideBySideRows } from "../packages/operator/src/side-by-side.js";
import { judgedFrameText } from "../packages/contracts/src/evidence-display.js";
import { savedBuild } from "./judge-fixture.js";

type Pass = Parameters<typeof sideBySideRows>[0][number] & object;

/** An observation with one snapshot and a recording of two players, from its own start time. */
function observation(build: string, start: number, frames: Array<[string, number]>): Pass {
  const at = (ms: number) => new Date(start + ms).toISOString();
  const recorded = frames.map(([actor, ms]) => ({
    id: `${build}-${actor}-${ms}`,
    mediaType: "image/png",
    context: "full-round",
    label: "Full round",
    actor,
    startedAt: at(ms),
    endedAt: at(ms + 8),
  }));
  return {
    id: `${build}-pass`,
    number: 1,
    observations: {
      sequence: { frames: recorded.map(({ startedAt, endedAt }) => ({ startedAt, endedAt })) },
    },
    // The transition comes 500 ms into each recording, on the clock of the frames.
    transitions: [{ id: "round-start", at: at(500) }],
    images: [
      {
        id: `${build}-hud`,
        mediaType: "image/png",
        context: "hud-view",
        label: "HUD",
        actor: null,
        startedAt: at(-1000),
        endedAt: at(9000),
      },
      ...recorded,
    ],
  };
}

test("side-by-side rows pair images by player, recorded phase and time, never by index", () => {
  // Build B starts 3 s later, lists player 2 first and has one more frame of player 1.
  const left = observation("a", 0, [
    ["p1", 0],
    ["p2", 0],
    ["p1", 500],
    ["p2", 500],
    ["p1", 1000],
  ]);
  const right = observation("b", 3000, [
    ["p2", 0],
    ["p2", 500],
    ["p1", 0],
    ["p1", 500],
    ["p1", 1000],
    ["p1", 1500],
  ]);
  const rows = sideBySideRows([left, right], 100);
  assert.deepEqual(
    rows.map((row) => [row.player, row.sides.map((side) => side?.imageId ?? null)]),
    [
      [null, ["a-hud", "b-hud"]],
      ["p1", ["a-p1-0", "b-p1-0"]],
      ["p1", ["a-p1-500", "b-p1-500"]],
      ["p1", ["a-p1-1000", "b-p1-1000"]],
      ["p1", [null, "b-p1-1500"]],
      ["p2", ["a-p2-0", "b-p2-0"]],
      ["p2", ["a-p2-500", "b-p2-500"]],
    ],
  );
  assert.deepEqual(rows[0]!.phase, { kind: "capture", id: "hud-view" });
  assert.deepEqual([rows[0]!.label, rows[1]!.label], ["HUD", "Full round"]);
  assert.deepEqual(rows[1]!.phase, { kind: "transition", id: "round-start" });
  assert.deepEqual(
    rows[1]!.sides.map((side) => side?.offsetMs),
    [-500, -500],
    "each side counts its offset from its own anchor",
  );
});

test("an absent observation keeps its side empty and pairs nothing", () => {
  const left = observation("a", 0, [["p1", 0]]);
  assert.deepEqual(
    sideBySideRows([left, undefined], 100).map((row) =>
      row.sides.map((side) => side?.imageId ?? null),
    ),
    [
      ["a-hud", null],
      ["a-p1-0", null],
    ],
  );
  assert.deepEqual(sideBySideRows([undefined, undefined], 100), []);
});

test("the route compares two builds of one evaluation and records no holdout look", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-side-by-side-"));
  try {
    const { adapters, quote } = await savedBuild(root, [], { builds: 2 });
    const saved = await quote({ samples: 1, grouping: "per_criterion" });
    const manifest = await freezeRegisteredEvalRun({
      root,
      quoteId: saved.id,
      operationId: "run-side-by-side",
      ceilingUsd: 1,
      adapters,
    });
    const [left, right] = manifest.subjects.map((subject) => subject.id) as [string, string];
    const query = (changes: Record<string, string> = {}) =>
      new URLSearchParams({ left, right, criterion: "beacon-blue", pass: "1", ...changes });
    const value = await sideBySideEvidence(root, manifest.id, query());
    assert.deepEqual(
      value.builds.map((build) => [build.candidateId, build.title]),
      [
        [left, "Build 1"],
        [right, "Build 2"],
      ],
    );
    assert.deepEqual(value.observations, [1]);
    assert.equal(value.criterion.method, "visual");
    // Nothing is recorded yet, so each side names its absence and no image pairs.
    assert.deepEqual(
      value.sides.map((side) => [side.candidateId, side.itemId, side.passId, side.absent]),
      [
        [left, null, null, "This observation has no recorded evidence."],
        [right, null, null, "This observation has no recorded evidence."],
      ],
    );
    assert.deepEqual(value.rows, []);
    await assert.rejects(sideBySideEvidence(root, manifest.id, query({ right: left })), {
      message: "Choose two different builds.",
    });
    await assert.rejects(sideBySideEvidence(root, manifest.id, query({ pass: "0" })), {
      message: "Choose an observation.",
    });
    assert.deepEqual(
      (await readHoldoutAccess(root, subjectEval(manifest, left).id)).looks,
      [],
      "A side-by-side view is not a look at the holdout",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recorded events move to the clock of the frames, and need a clock alignment", () => {
  const assessment = {
    clock: { offsetMs: 1500, uncertaintyMs: 4 },
    transitions: [
      { transitionId: "round-start", at: "2026-10-04T09:00:00.000Z", covered: true, gapMs: 0 },
      // A transition with no measured anchor has no time, so it has no event.
      { transitionId: "door-open", at: "", covered: true, gapMs: null },
    ],
    stateChanges: [
      {
        context: "Server",
        path: "Workspace.Beacon",
        attribute: "Lit",
        at: "2026-10-04T09:00:02.000Z",
        value: true,
      },
    ],
  };
  assert.deepEqual(sequenceEvents(assessment), {
    events: [
      { id: "round-start", at: "2026-10-04T09:00:01.500Z" },
      { id: "Server · Lit=true", at: "2026-10-04T09:00:03.500Z" },
    ],
    transitions: [{ id: "round-start", at: "2026-10-04T09:00:01.500Z" }],
  });
  assert.deepEqual(sequenceEvents({ ...assessment, clock: null }), { events: [], transitions: [] });
});

test("a frame that the judge saw keeps the event of its judged role", () => {
  // Events A and B. The one recorded frame of each build is nearer to B.
  const pass = (build: string) => ({
    ...observation(build, 0, [["p1", 1400]]),
    transitions: [
      { id: "A", at: new Date(500).toISOString() },
      { id: "B", at: new Date(1500).toISOString() },
    ],
  });
  const recorded = (roles?: Array<ReadonlyMap<string, string[]>>) =>
    sideBySideRows([pass("a"), pass("b")], 100, roles)
      .filter((row) => row.player)
      .map((row) => [row.phase, row.sides.map((side) => side?.offsetMs ?? null)]);
  assert.deepEqual(recorded(), [[{ kind: "transition", id: "B" }, [-100, -100]]]);
  // The judge saw the frame of build a after the hold of A, so here it stays with A too.
  const roles = [new Map([["a-p1-1400", ["after-hold:A"]]]), new Map()];
  assert.deepEqual(recorded(roles), [
    [{ kind: "transition", id: "A" }, [900, null]],
    [{ kind: "transition", id: "B" }, [null, -100]],
  ]);
  // Each image keeps its roles for the caption. A frame that the judge did not see has none.
  assert.deepEqual(
    sideBySideRows([pass("a"), pass("b")], 100, roles)
      .filter((row) => row.player)
      .map((row) => row.sides.map((side) => side?.roles ?? null)),
    [
      [["after-hold:A"], null],
      [null, []],
    ],
  );
});

test("the caption of a judged frame says why the judge saw it, with no code names", () => {
  assert.equal(judgedFrameText([]), null);
  assert.equal(
    judgedFrameText(["before:door-opens", "effect:door-opens"]),
    "The judge saw this frame: last frame before the door-opens event; during the door-opens event.",
  );
  assert.equal(
    judgedFrameText(["horizon-end:door-opens", "uniform", "uniform"]),
    "The judge saw this frame: last frame, the door-opens event never seen; extra frame spread over the recording.",
  );
  assert.equal(judgedFrameText(["constructor:x", "later-role"]), "The judge saw this frame.");
});
