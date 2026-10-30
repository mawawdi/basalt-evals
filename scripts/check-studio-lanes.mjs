// Read-only check of the live proof of two Studio lanes. It writes nothing.
//
// Usage, from the checkout that ran the replays:
//   node scripts/check-studio-lanes.mjs <baseline-a> <baseline-b> <pair-a> <pair-b>
//
// The baselines are replays of two saved builds on one lane. The pair is the same two replays
// on two lanes at the same time. The check passes only if the pair overlapped on two lanes,
// each receipt is complete and verified, and each pair job has the evidence of its baseline.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const ids = process.argv.slice(2);
if (ids.length !== 4 || ids.some((id) => !/^[a-z]+-[a-f0-9]{32}$/u.test(id))) {
  console.error(
    "Usage: node scripts/check-studio-lanes.mjs <baseline-a> <baseline-b> <pair-a> <pair-b>",
  );
  process.exit(2);
}
const { verifyWorkerArtifacts } = await import(
  resolve(root, "dist/packages/studio-runner/src/native-worker.js")
);
const pinnedKey = readFileSync(
  resolve(root, ".basalt-evals/native-worker/isolated-public-key.pem"),
  "utf8",
);
const json = (file) => JSON.parse(readFileSync(file, "utf8"));

/** The single Studio observation of a replay run. */
async function observation(operationId) {
  const capture = resolve(root, ".basalt-evals/eval-operations", operationId, "capture");
  const cells = existsSync(capture) ? readdirSync(capture) : [];
  if (cells.length !== 1) return { operationId, problem: "has no single observation" };
  const cell = resolve(capture, cells[0]);
  const studio = resolve(cell, "studio");
  const admissions = existsSync(resolve(cell, "admissions.jsonl"))
    ? readFileSync(resolve(cell, "admissions.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
    : [];
  const receiptFile = resolve(studio, "native/manifest.json");
  if (!existsSync(receiptFile)) return { operationId, problem: "has no signed receipt" };
  const receipt = json(receiptFile);
  const { manifest } = receipt;
  let integrity = null;
  try {
    await verifyWorkerArtifacts(studio, receipt, pinnedKey);
  } catch (error) {
    integrity = error.message;
  }
  const sequenceRoot = resolve(studio, "native/sequence");
  const sequences = existsSync(sequenceRoot)
    ? readdirSync(sequenceRoot).map((name) => {
        const file = resolve(sequenceRoot, name, "assessment.json");
        const assessment = existsSync(file) ? json(file) : null;
        return {
          name,
          status: assessment?.status ?? "no assessment",
          frames: Object.fromEntries(
            (assessment?.actorFrames ?? []).map((actor) => [actor.actor, actor.frameCount]),
          ),
        };
      })
    : [];
  const frameFiles = sequences.reduce(
    (sum, sequence) => sum + Object.values(sequence.frames).reduce((a, b) => a + b, 0),
    0,
  );
  return {
    operationId,
    lane: admissions.at(-1)?.lane ?? null,
    status: manifest.status,
    failure: manifest.failure,
    integrity,
    start: Date.parse(manifest.startedAt),
    end: Date.parse(manifest.completedAt),
    otherArtifacts: manifest.artifacts.length - frameFiles,
    steps: manifest.processes.length,
    sequences,
  };
}

const [baseA, baseB, pairA, pairB] = await Promise.all(ids.map(observation));
const problems = [];
for (const job of [baseA, baseB, pairA, pairB]) {
  if (job.problem) problems.push(`${job.operationId} ${job.problem}.`);
  else {
    if (job.status !== "complete")
      problems.push(`${job.operationId} is ${job.status}: ${job.failure ?? "no failure text"}`);
    if (job.integrity) problems.push(`${job.operationId} failed verification: ${job.integrity}`);
  }
}
if (!problems.length) {
  const overlap = (Math.min(pairA.end, pairB.end) - Math.max(pairA.start, pairB.start)) / 1000;
  const shorter = Math.min(pairA.end - pairA.start, pairB.end - pairB.start) / 1000;
  console.log(
    `Pair lanes ${pairA.lane} and ${pairB.lane}, overlap ${Math.round(overlap)} s of ${Math.round(shorter)} s.`,
  );
  if (pairA.lane === pairB.lane) problems.push("The pair ran on one lane.");
  if (overlap < shorter / 2)
    problems.push("The pair overlapped for less than half the shorter job.");
  for (const [base, pair] of [
    [baseA, pairA],
    [baseB, pairB],
  ]) {
    const name = `${pair.operationId} against ${base.operationId}`;
    if (pair.otherArtifacts !== base.otherArtifacts)
      problems.push(
        `${name}: ${pair.otherArtifacts} artifacts other than frames, not ${base.otherArtifacts}.`,
      );
    if (pair.steps !== base.steps)
      problems.push(`${name}: ${pair.steps} steps, not ${base.steps}.`);
    for (const sequence of base.sequences) {
      const other = pair.sequences.find((item) => item.name === sequence.name);
      if (!other) {
        problems.push(`${name}: sequence ${sequence.name} is missing.`);
        continue;
      }
      if (other.status !== sequence.status)
        problems.push(
          `${name}: sequence ${sequence.name} is ${other.status}, not ${sequence.status}.`,
        );
      for (const [actor, frames] of Object.entries(sequence.frames)) {
        const count = other.frames[actor] ?? 0;
        if (Math.abs(count - frames) > frames / 10)
          problems.push(`${name}: ${actor} has ${count} frames, not ${frames} ± 10 %.`);
      }
    }
  }
}
if (problems.length) {
  console.log(`The two-lane proof failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("The two-lane proof passed.");
