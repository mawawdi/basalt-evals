import { assertExactRecordKeys, fail, isFiniteNumber, isRecord, isText } from "./validation.js";

export interface BarrierTrajectory {
  barrierPath: string;
  center: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  halfDepth: number;
  halfWidth: number;
  halfHeight: number;
  corridorHalfWidth: number;
  samples: Array<{ elapsedMs: number; x: number; y: number; z: number; health: number }>;
}

/** Bound, finite samples only. Passage is classified by the host, never by Studio. */
export function assertBarrierTrajectory(value: unknown): asserts value is BarrierTrajectory {
  if (!isRecord(value)) fail("barrier trajectory");
  assertExactRecordKeys(
    value,
    [
      "barrierPath",
      "center",
      "normal",
      "halfDepth",
      "halfWidth",
      "halfHeight",
      "corridorHalfWidth",
      "samples",
    ],
    "barrier trajectory fields",
  );
  if (
    !isText(value.barrierPath) ||
    !/^(?:game(?:\.[A-Za-z_][A-Za-z0-9_]*)+|role\.[a-z][a-z0-9_-]{0,63})$/.test(value.barrierPath)
  )
    fail("barrier trajectory path");
  for (const name of ["center", "normal"] as const) {
    const vector = value[name];
    if (!isRecord(vector)) fail("barrier vector");
    assertExactRecordKeys(vector, ["x", "y", "z"], "barrier vector fields");
    if (
      ![vector.x, vector.y, vector.z].every(
        (part) => isFiniteNumber(part) && Math.abs(part) <= 1_000_000,
      )
    )
      fail("barrier vector");
  }
  const normal = value.normal as { x: number; y: number; z: number };
  if (Math.abs(Math.hypot(normal.x, normal.y, normal.z) - 1) > 0.01 || Math.abs(normal.y) > 0.01)
    fail("barrier normal");
  if (
    ![value.halfDepth, value.halfWidth, value.halfHeight].every(
      (part) => isFiniteNumber(part) && part >= 0.25 && part <= 100,
    ) ||
    value.corridorHalfWidth !== 3
  )
    fail("barrier dimensions");
  if (!Array.isArray(value.samples) || value.samples.length === 0 || value.samples.length > 51)
    fail("barrier samples");
  let previousMs = -1;
  for (const [index, sample] of value.samples.entries()) {
    if (!isRecord(sample)) fail("barrier sample");
    assertExactRecordKeys(sample, ["elapsedMs", "x", "y", "z", "health"], "barrier sample fields");
    if (
      !isFiniteNumber(sample.elapsedMs) ||
      sample.elapsedMs <= previousMs ||
      sample.elapsedMs > 3_500
    )
      fail(`barrier sample ${index} timestamp ${String(sample.elapsedMs)} after ${previousMs}`);
    if (
      ![sample.x, sample.y, sample.z, sample.health].every(
        (part) => isFiniteNumber(part) && Math.abs(part) <= 1_000_000,
      ) ||
      !isFiniteNumber(sample.health) ||
      sample.health < 0
    )
      fail(`barrier sample ${index} position or health`);
    previousMs = sample.elapsedMs;
  }
}
