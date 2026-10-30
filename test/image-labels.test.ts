import assert from "node:assert/strict";
import test from "node:test";
import {
  evidenceImageLabels,
  imageLabelPrefix,
} from "../packages/studio-runner/src/image-labels.js";

test("image labels state number, frame, player, roles, recording time and anchor offsets", () => {
  const labels = evidenceImageLabels(
    [
      {
        frameId: "frame-1",
        player: "Player1",
        clock: { kind: "scenario", startMs: 900, endMs: 933 },
        roles: ["before:jump"],
      },
      {
        frameId: "frame-2",
        player: "Player2",
        clock: { kind: "scenario", startMs: 2600, endMs: 2650 },
        roles: ["after-effect:door", "effect:door"],
      },
      {
        frameId: "frame-3",
        player: null,
        clock: { kind: "presentation", captureId: "spawn" },
        roles: [],
      },
      { frameId: "frame-12", player: "Player1", clock: { kind: "unstated" }, roles: ["uniform"] },
      {
        frameId: "frame-13",
        player: "Player2",
        clock: { kind: "scenario", startMs: 1800, endMs: 1850 },
        roles: ["uniform"],
      },
      {
        frameId: "frame-14",
        player: "Player2",
        clock: { kind: "scenario", startMs: 5000, endMs: 5050 },
        roles: ["after-hold:jump", "before:door"],
      },
    ],
    [
      { transitionId: "jump", anchor: "action", anchorMs: 1000 },
      { transitionId: "door", anchor: "state", anchorMs: 2500 },
    ],
  );
  assert.deepEqual(labels, [
    "Image 1: frame-1; player Player1; roles before:jump; acquired from 0.900 s to 0.933 s after the scenario recording start; acquisition starts 0.100 s before the action start of transition jump.",
    "Image 2: frame-2; player Player2; roles after-effect:door, effect:door; acquired from 2.600 s to 2.650 s after the scenario recording start; acquisition starts 0.100 s after the observed effect of transition door.",
    "Image 3: frame-3; presentation capture spawn, a separate session that is not on the scenario clock.",
    "Image 4: frame-12; player Player1; roles uniform.",
    // A role that names no transition gives the offset from the nearest anchor.
    "Image 5: frame-13; player Player2; roles uniform; acquired from 1.800 s to 1.850 s after the scenario recording start; acquisition starts 0.700 s before the observed effect of transition door.",
    // A frame that serves two transitions states both offsets in authored order.
    "Image 6: frame-14; player Player2; roles after-hold:jump, before:door; acquired from 5.000 s to 5.050 s after the scenario recording start; acquisition starts 4.000 s after the action start of transition jump; acquisition starts 2.500 s after the observed effect of transition door.",
  ]);
  // A tie keeps the first authored transition.
  assert.match(
    evidenceImageLabels(
      [
        {
          frameId: "frame-1",
          player: "P",
          clock: { kind: "scenario", startMs: 1750, endMs: 1800 },
          roles: [],
        },
      ],
      [
        { transitionId: "jump", anchor: "action", anchorMs: 1000 },
        { transitionId: "door", anchor: "action", anchorMs: 2500 },
      ],
    )[0]!,
    /0\.750 s after the action start of transition jump\.$/,
  );
  assert.equal(imageLabelPrefix(0), "Image 1:");
  assert.throws(() => imageLabelPrefix(-1), /position/);
  assert.throws(
    () =>
      evidenceImageLabels([
        {
          frameId: "frame-1",
          player: "P",
          clock: { kind: "scenario", startMs: 5, endMs: 1 },
          roles: [],
        },
      ]),
    /interval/,
  );
  assert.throws(
    () =>
      evidenceImageLabels([
        { frameId: "frame-1", player: "P", clock: { kind: "unstated" }, roles: ["middle"] },
      ]),
    /role/,
  );
  assert.throws(
    () =>
      evidenceImageLabels(
        [{ frameId: "frame-1", player: "P", clock: { kind: "unstated" }, roles: [] }],
        [{ transitionId: "door", anchor: "state", anchorMs: Number.NaN }],
      ),
    /anchor/,
  );
});
