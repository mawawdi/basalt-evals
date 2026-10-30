import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { StudioScenarioReport } from "../packages/contracts/src/index.js";
import {
  isClockAlignment,
  reportActionTransitions,
  SEQUENCE_SETTLE_MARGIN_MS,
  sequenceSettleAtMs,
} from "../packages/studio-runner/src/sequence.js";
import { auditSequenceTiming, probeClock } from "../packages/studio-runner/src/sequence-timing.js";
import type {
  SequenceAcquisition,
  SequenceClockProbe,
  SequenceFrame,
} from "../packages/studio-runner/src/studio-mcp.js";

const base = Date.parse("2026-10-01T12:00:00.000Z");

/** A probe of a client whose Studio clock is aheadMs ahead of the host at the probe. */
function probe(
  userId: number,
  sentMs: number,
  roundTripMs: number,
  aheadMs: number,
  replyFraction = 0.5,
): SequenceClockProbe {
  const replyMs = base + sentMs + roundTripMs * replyFraction;
  return {
    playerUserId: userId,
    studioId: `client-${userId}`,
    hostSentAt: new Date(base + sentMs).toISOString(),
    hostReceivedAt: new Date(base + sentMs + roundTripMs).toISOString(),
    serverTime: (replyMs + aheadMs) / 1000,
    clientTime: replyMs / 1000,
  };
}

function frame(userId: number, index: number, startMs: number, widthMs: number): SequenceFrame {
  return {
    file: `frame-${String(index).padStart(4, "0")}.png`,
    hash: "a".repeat(64),
    bytes: 1,
    mediaType: "image/png",
    width: 16,
    height: 16,
    playerUserId: userId,
    studioId: `client-${userId}`,
    startedAt: new Date(base + startMs).toISOString(),
    endedAt: new Date(base + startMs + widthMs).toISOString(),
  };
}

test("the shortest probe of any client sets the one clock alignment", () => {
  // The Studio clock is 120 ms ahead, so host time is Studio time plus -120 ms. The reply
  // of the slow probe comes late in its round trip, so its center is wrong. Each client
  // reads the replicated server clock, so the probe of another client also counts.
  const clock = probeClock([
    probe(-1, 0, 300, 120, 0.9),
    probe(-2, 5_000, 20, 120),
    probe(-1, 10_000, 60, 120),
  ]);
  assert.deepEqual(clock, { offsetMs: -120, uncertaintyMs: 10 });
  assert.ok(isClockAlignment(clock));
  assert.equal(probeClock([]), null, "Without a probe there is no alignment");
  assert.throws(
    () => probeClock([{ ...probe(-1, 0, 20, 0), hostReceivedAt: "1999-01-01T00:00:00Z" }]),
    /Invalid Studio clock probe/,
  );
});

test("the timing audit reports request widths, uncovered gaps and clock residuals", async () => {
  // Three requests can be in flight. Overlap is coverage; only the 400 ms hole is a gap.
  const acquisition: SequenceAcquisition = {
    schema: "basalt-evals/sequence-acquisition",
    placeFile: "BasaltEval-0123456789abcdef0123.rbxlx",
    startedAt: new Date(base).toISOString(),
    endedAt: new Date(base + 3_000).toISOString(),
    expectedClients: 2,
    status: "complete",
    reason: null,
    frames: [
      frame(-1, 1, 0, 300),
      frame(-1, 2, 200, 500),
      frame(-1, 3, 1_100, 100),
      frame(-1, 4, 1_250, 50),
      frame(-2, 5, 0, 80),
    ],
    // A clock step of 80 ms after the shortest probe leaves a residual of 80 - 30 = 50 ms.
    clockProbes: [
      probe(-1, 0, 20, 120),
      probe(-1, 2_000, 40, 120),
      probe(-1, 2_500, 60, 200),
      probe(-2, 0, 30, -40),
    ],
  };
  const audit = auditSequenceTiming(acquisition);
  assert.equal(audit.schema, "basalt-evals/sequence-timing-audit");
  assert.deepEqual(audit.clock, { offsetMs: -120, uncertaintyMs: 10 });
  const actor = (userId: number) => audit.actors.find((row) => row.playerUserId === userId)!;
  const first = actor(-1);
  const second = actor(-2);
  assert.deepEqual(first.requestWidths, { count: 4, minMs: 50, medianMs: 200, maxMs: 500 });
  assert.deepEqual(first.uncoveredGaps, { count: 2, minMs: 50, medianMs: 225, maxMs: 400 });
  assert.deepEqual(first.clock, { offsetMs: -120, uncertaintyMs: 10 });
  assert.equal(first.localClockOffsetMs, 0);
  assert.equal(first.residualMaxMs, 50);
  assert.deepEqual(
    first.probes.map((row) => [row.roundTripMs, row.offsetMs, row.residualMs]),
    [
      [20, -120, 0],
      [40, -120, 0],
      [60, -200, 50],
    ],
  );
  assert.deepEqual(second.uncoveredGaps, { count: 0, minMs: null, medianMs: null, maxMs: null });
  assert.deepEqual(second.clock, { offsetMs: 40, uncertaintyMs: 15 });

  // The command reads a stored sequence directory and prints the same audit.
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), "basalt-sequence-timing-")));
  try {
    await writeFile(resolve(directory, "index.json"), JSON.stringify(acquisition));
    const { stdout } = await promisify(execFile)(process.execPath, [
      resolve("dist/packages/cli/src/index.js"),
      "sequence",
      "timing",
      directory,
    ]);
    assert.deepEqual(JSON.parse(stdout), audit);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("action transitions come from the actedAt of each signed report", () => {
  const report = (context: string, steps: StudioScenarioReport["steps"]): StudioScenarioReport => ({
    context,
    startAt: 1_790_000_000,
    actors: [],
    steps,
  });
  const timing = { outcome: "observed" as const, dueAt: 1_790_000_001, observations: [] };
  assert.deepEqual(
    reportActionTransitions([
      report("server", [{ stepId: "press", ...timing }]),
      report("alpha", [
        {
          stepId: "press",
          ...timing,
          anchorObservedAt: 1_790_000_001,
          scheduledAt: 1_790_000_001.5,
          actedAt: 1_790_000_001.52,
          action: { kind: "press_key", succeeded: true },
        },
        { stepId: "late", ...timing, outcome: "not_observed_within_horizon" },
      ]),
    ]),
    [{ stepId: "press", context: "alpha", at: 1_790_000_001.52 }],
  );
});

test("Play continues until the hold of the last required transition is recorded", () => {
  const acted = {
    context: "alpha",
    startAt: 1_790_000_000,
    actors: [],
    steps: [
      {
        stepId: "buy",
        outcome: "observed" as const,
        dueAt: 1_790_000_010,
        observations: [],
        actedAt: 1_790_000_010,
        action: { kind: "gui_activate", succeeded: true },
      },
    ],
  } as StudioScenarioReport;
  const completedAtMs = 1_790_000_011_000;
  const action = {
    id: "purchase-effect",
    source: { kind: "action" as const, stepId: "buy" },
    effectWindowMs: 2000,
    holdMs: 1000,
  };
  assert.equal(
    sequenceSettleAtMs({ requiredTransitions: [action] }, [acted], completedAtMs),
    1_790_000_010_000 + 3000 + SEQUENCE_SETTLE_MARGIN_MS,
  );
  const state = {
    id: "door-state",
    source: {
      kind: "state" as const,
      context: "server",
      path: "role.door",
      attribute: "Open",
      from: false,
      to: true,
    },
    effectWindowMs: 4000,
    holdMs: 1000,
  };
  assert.equal(
    sequenceSettleAtMs({ requiredTransitions: [action, state] }, [acted], completedAtMs),
    completedAtMs + 5000 + SEQUENCE_SETTLE_MARGIN_MS,
    "A state change has no reported time, so its window starts at completion",
  );
  assert.equal(
    sequenceSettleAtMs({ requiredTransitions: [] }, [acted], completedAtMs),
    completedAtMs,
  );
});
