import assert from "node:assert/strict";
import test from "node:test";
import { contentHash } from "../packages/contracts/src/index.js";
import {
  publicRepairContext,
  type PublicRepairFrames,
} from "../packages/development/src/repair-context.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9R6ZkAAAAASUVORK5CYII=",
  "base64",
);

function developmentFrames(): PublicRepairFrames {
  return {
    presentation: {
      treatment: "sequence",
      status: "sufficient",
      reasons: [],
      frameBudget: 4,
      requiredFrameCount: 0,
      frames: [
        {
          id: "frame-1",
          actor: "player-1",
          file: "frame.png",
          hash: contentHash(png),
          playerUserId: 123,
          startedAt: "2026-09-23T12:00:00.000Z",
          endedAt: "2026-09-23T12:00:00.100Z",
          mediaType: "image/png",
          roles: ["uniform"],
        },
      ],
      context: { actors: ["player-1"], intervals: [] },
    },
    images: [{ id: "frame-1", mediaType: "image/png", bytes: png }],
  };
}

test("public repair context contains only verified development frames", () => {
  const frames = developmentFrames();
  const privateCanary = "HIDDEN-RUBRIC-ORACLE-DO-NOT-DISCLOSE";
  const input = {
    ...frames,
    privateRationale: privateCanary,
    presentation: { ...frames.presentation, privateRationale: privateCanary },
  } as PublicRepairFrames;
  const context = publicRepairContext(input);
  assert.equal(context.images[0]?.hash, contentHash(png));
  assert.equal(JSON.parse(context.summary).frames[0].id, "frame-1");
  assert.equal(JSON.stringify(context).includes(privateCanary), false);
  const altered = developmentFrames();
  altered.images[0]!.bytes = Buffer.from("different");
  assert.throws(() => publicRepairContext(altered), /differ from verified/);
});
