import { assertBarrierTrajectory, type BarrierTrajectory } from "../../contracts/src/index.js";

interface BarrierPassage {
  outcome: "blocked" | "passed" | "incomplete";
  detail: string;
  closestFrontStuds: number | null;
  finalPlaneStuds: number | null;
}

/** Classify measured avatar motion, not a reported gate flag or CanCollide. */
export function classifyBarrierTrajectory(trajectory: BarrierTrajectory): BarrierPassage {
  assertBarrierTrajectory(trajectory);
  const { center, normal, samples, halfDepth, halfHeight, corridorHalfWidth } = trajectory;
  const distance = (sample: (typeof samples)[number]) =>
    (sample.x - center.x) * normal.x + (sample.z - center.z) * normal.z;
  const lateral = (sample: (typeof samples)[number]) =>
    Math.abs((sample.x - center.x) * -normal.z + (sample.z - center.z) * normal.x);
  const result = (outcome: BarrierPassage["outcome"], detail: string): BarrierPassage => ({
    outcome,
    detail,
    closestFrontStuds: samples.length ? Math.min(...samples.map(distance)) - halfDepth : null,
    finalPlaneStuds: samples.length ? distance(samples[samples.length - 1]!) : null,
  });
  if (
    samples.length < 44 ||
    samples[0]!.elapsedMs > 100 ||
    samples[samples.length - 1]!.elapsedMs < 2_450 ||
    samples[samples.length - 1]!.elapsedMs > 2_800 ||
    samples.some(
      (sample, index) => index > 0 && sample.elapsedMs - samples[index - 1]!.elapsedMs > 150,
    )
  )
    return result("incomplete", "The 20 Hz, 2.5 second trajectory is incomplete");
  if (samples.some((sample) => sample.health <= 0))
    return result("incomplete", "The avatar died during the probe");
  if (
    samples.some(
      (sample) =>
        lateral(sample) > corridorHalfWidth + 0.25 ||
        sample.y < center.y - halfHeight + 0.5 ||
        sample.y > center.y + halfHeight - 0.5,
    )
  )
    return result("incomplete", "The avatar left the declared barrier corridor");
  if (
    samples.some(
      (sample, index) =>
        index > 0 &&
        Math.hypot(
          sample.x - samples[index - 1]!.x,
          sample.y - samples[index - 1]!.y,
          sample.z - samples[index - 1]!.z,
        ) > 4,
    )
  )
    return result("incomplete", "The trajectory contains a discontinuous position jump");
  const start = distance(samples[0]!);
  if (Math.abs(start - (halfDepth + 6)) > 1.5)
    return result("incomplete", "The avatar did not start six studs before the barrier");
  const closest = Math.min(...samples.map(distance));
  if (start - closest < 2 || closest > halfDepth + 2.75)
    return result("incomplete", "The avatar did not approach the barrier");
  const backFace = -halfDepth - 2;
  const passed =
    distance(samples[samples.length - 1]!) <= backFace &&
    samples.slice(-3).every((sample) => distance(sample) <= backFace);
  if (!passed && samples.some((sample) => distance(sample) <= backFace))
    return result(
      "incomplete",
      "The avatar crossed transiently but did not remain beyond the barrier",
    );
  if (!passed && distance(samples[samples.length - 1]!) > halfDepth + 2.75)
    return result("incomplete", "The avatar approached but did not remain at the barrier");
  return passed
    ? result("passed", "The avatar crossed the back face and remained beyond it")
    : result("blocked", "The avatar reached the front face but did not cross the barrier");
}
