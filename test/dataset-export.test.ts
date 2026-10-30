import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { contentHash, hashJson, stableJson } from "../packages/contracts/src/index.js";
import type { RunOperationStatus } from "../packages/contracts/src/execution.js";
import { toolDefinitions } from "../packages/agent-runtime/src/tools.js";
import {
  datasetExportFiles,
  type DatasetBuild,
  type DatasetDescription,
  type DatasetExportInput,
} from "../packages/reporting/src/dataset.js";
import type { ExportFile, ExportManifest } from "../packages/reporting/src/export.js";
import type { BuildHistory } from "../packages/contracts/src/build-history.js";
import { sealedBuildSource } from "../packages/operator/src/dataset-export.js";
import { writeExportFolder } from "../packages/operator/src/export.js";
import { plannedBuild, SOURCE_PATH, WRITTEN_SOURCE } from "./build-history-fixture.js";
import { testHarness } from "./builder-fixture.js";

const decoder = new TextDecoder();
const SECRET = {
  statement: "SECRET-STATEMENT the beacon glows blue",
  criterionId: "secret-criterion-id",
  reason: "SECRET-REASON the judge saw a blue glow",
};
const SOURCE = [{ path: "src/a.luau", sha256: contentHash("return 1\n"), content: "return 1\n" }];

type Build = DatasetExportInput["builds"][number];
const build = (
  revisionId: string,
  model: string,
  harness: string,
  number: number,
  subjectId: string,
): Build => ({
  revisionId,
  model: { id: model, revision: `${model}-revision` },
  harness,
  number,
  subjectId,
  parentSubjectId: null,
  notReached: false,
  delivered: true,
  stopReason: "finished",
  source: SOURCE,
  marks: [
    {
      criterionId: SECRET.criterionId,
      pass: 2,
      outcome: "insufficient",
      score: null,
      samples: { met: 1, of: 3 },
      reason: SECRET.reason,
    },
    {
      criterionId: SECRET.criterionId,
      pass: 1,
      outcome: "met",
      score: null,
      samples: null,
      reason: SECRET.reason,
    },
    {
      criterionId: SECRET.criterionId,
      pass: 3,
      outcome: "missing",
      score: null,
      samples: null,
      reason: null,
    },
  ],
  charge: { builderUsd: 0.002, judgeUsd: null, pendingUsd: 0 },
  buildMs: 900,
  lint: { status: "absent", counts: null },
  buildErrors: null,
});

function datasetInput(history: BuildHistory, builds?: Build[]): DatasetExportInput {
  const evaluation = (revisionId: string, title: string) => ({
    evaluationId: `${revisionId}-first`,
    revisionId,
    title,
    stage: { index: 1, count: 1 },
    prompt: `Build the ${title.toLowerCase()}.`,
    criteria: [
      {
        criterionId: SECRET.criterionId,
        statement: SECRET.statement,
        required: true,
        evidenceClass: "appearance" as const,
      },
    ],
  });
  return {
    runId: "run-dataset",
    title: "Beacon",
    // The plan order of the evaluations is "beacon", then "anvil".
    evaluations: [evaluation("beacon", "Beacon"), evaluation("anvil", "Anvil")],
    builds: builds ?? [
      build("anvil", "model-b", "tools-1", 1, "subject-5"),
      build("beacon", "model-b", "tools-1", 2, "subject-4"),
      build("beacon", "model-a", "tools-2", 1, "subject-3"),
      {
        ...build("beacon", "model-a", "tools-1", 2, history.subjectId),
        lint: { status: "complete", counts: { LocalUnused: 2, DeprecatedApi: 1 } },
        buildErrors: { build: 1, unknown: 0, external: 3, truncated: true },
      },
      {
        ...build("beacon", "model-a", "tools-1", 1, "subject-1"),
        lint: { status: "unavailable", counts: null },
      },
    ],
    histories: [
      {
        subjectId: history.subjectId,
        history,
        atif: { agentVersion: "commit", tools: toolDefinitions(testHarness()) },
      },
    ],
  };
}
const file = (files: ExportFile[], path: string) =>
  decoder.decode(files.find((item) => item.path === path)!.bytes);
const lines = (files: ExportFile[]) =>
  file(files, "builds.jsonl")
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ line, build: JSON.parse(line) as DatasetBuild }));

test("a dataset has one line for each build in a stable order", async () => {
  const { history } = await plannedBuild();
  const input = datasetInput(history);
  const files = datasetExportFiles(input, "public");
  const parsed = lines(files);
  assert.equal(parsed.length, input.builds.length, "One line for each build");
  assert.deepEqual(
    parsed.map(({ build }) => [
      build.evaluation.revisionId,
      build.model.id,
      build.harness,
      build.buildNumber,
    ]),
    [
      ["beacon", "model-a", "tools-1", 1],
      ["beacon", "model-a", "tools-1", 2],
      ["beacon", "model-a", "tools-2", 1],
      ["beacon", "model-b", "tools-1", 2],
      ["anvil", "model-b", "tools-1", 1],
    ],
  );
  for (const { line, build } of parsed) assert.equal(line, stableJson(build), "Sorted keys");
  const traced = parsed.find(({ build }) => build.subjectId === history.subjectId)!.build;
  assert.equal(traced.trajectory, `atif/${history.subjectId}/agent/trajectory.json`);
  assert.ok(files.some((item) => item.path === traced.trajectory));
  assert.equal(parsed[0]!.build.trajectory, null, "A build without saved turns has no trajectory");
  assert.equal(traced.evaluation.id, "beacon-first");
  assert.equal(traced.prompt, "Build the beacon.");
  assert.deepEqual(traced.model, { id: "model-a", revision: "model-a-revision" });
  // The analysis keeps counts by code and origin. An absent analysis is not zero findings.
  assert.deepEqual(traced.lint, {
    status: "complete",
    counts: { DeprecatedApi: 1, LocalUnused: 2 },
  });
  assert.deepEqual(traced.buildErrors, { build: 1, unknown: 0, external: 3, truncated: true });
  assert.deepEqual(parsed[0]!.build.lint, { status: "unavailable", counts: null });
  assert.equal(parsed[0]!.build.buildErrors, null);
  assert.deepEqual(parsed[2]!.build.lint, { status: "absent", counts: null });
  // Another input order of the same builds gives the same bytes and the same manifest.
  const again = datasetExportFiles(datasetInput(history, [...input.builds].reverse()), "public");
  assert.deepEqual(
    again.map((item) => [item.path, contentHash(item.bytes)]),
    files.map((item) => [item.path, contentHash(item.bytes)]),
  );
});

test("a public dataset has no statements or reasons, and a private dataset adds them", async () => {
  const { history } = await plannedBuild();
  const input = datasetInput(history);
  const publicFiles = datasetExportFiles(input, "public");
  const publicText = publicFiles.map((item) => decoder.decode(item.bytes)).join("\n");
  for (const secret of Object.values(SECRET))
    assert.equal(publicText.includes(secret), false, secret);
  for (const { build } of lines(publicFiles))
    for (const answer of build.answers) {
      assert.equal("statement" in answer, false);
      assert.equal("reason" in answer, false);
      assert.equal(answer.criterion, 1);
    }
  const privateFiles = datasetExportFiles(input, "private");
  const answers = lines(privateFiles)[0]!.build.answers;
  assert.deepEqual(
    answers.map((answer) => [answer.observation, answer.statement, answer.reason]),
    [
      [1, SECRET.statement, SECRET.reason],
      [2, SECRET.statement, SECRET.reason],
      [3, SECRET.statement, null],
    ],
  );
  const privateText = privateFiles.map((item) => decoder.decode(item.bytes)).join("\n");
  assert.equal(privateText.includes(SECRET.criterionId), false, "No scope has criterion IDs");
  assert.equal(
    (JSON.parse(file(privateFiles, "dataset.json")) as DatasetDescription).scope,
    "private",
  );
});

test("not enough evidence and a missing answer stay their own answers", async () => {
  const { history } = await plannedBuild();
  const files = datasetExportFiles(datasetInput(history), "public");
  const answers = lines(files)[0]!.build.answers;
  assert.deepEqual(
    answers.map(({ observation, answer, score, samples }) => ({
      observation,
      answer,
      score,
      samples,
    })),
    [
      { observation: 1, answer: "met", score: null, samples: null },
      { observation: 2, answer: "not_enough_evidence", score: null, samples: { met: 1, of: 3 } },
      { observation: 3, answer: "missing", score: null, samples: null },
    ],
  );
  assert.ok(answers.every((answer) => answer.required && answer.evidenceClass === "appearance"));
  const description = JSON.parse(file(files, "dataset.json")) as DatasetDescription;
  assert.equal(description.builds, 5);
  assert.ok(
    description.rules.some((rule) => rule.startsWith("not_enough_evidence is not a failure")),
  );
  // The description says that each error counts one time and names the limit of a context.
  assert.match(description.fields.buildErrors!, /each error counts one time/u);
  assert.match(description.fields.buildErrors!, /truncated is true .* limit of 100 errors/u);
});

test("the dataset manifest hashes every file", async () => {
  const { history } = await plannedBuild();
  const files = datasetExportFiles(datasetInput(history), "public");
  const manifest = JSON.parse(file(files, "manifest.json")) as ExportManifest;
  const { manifestHash, ...body } = manifest;
  assert.equal(manifest.kind, "dataset");
  assert.equal(manifestHash, contentHash(stableJson(body)));
  assert.deepEqual(
    manifest.files.map((item) => item.path).sort(),
    files
      .map((item) => item.path)
      .filter((path) => path !== "manifest.json")
      .sort(),
  );
  for (const listed of manifest.files) {
    const bytes = files.find((item) => item.path === listed.path)!.bytes;
    assert.equal(listed.sha256, contentHash(bytes));
    assert.equal(listed.bytes, bytes.length);
  }
  const parent = await mkdtemp(resolve(tmpdir(), "basalt-dataset-"));
  try {
    await writeExportFolder(resolve(parent, "dataset"), files);
    assert.deepEqual(await readdir(parent), ["dataset"]);
    assert.equal(
      contentHash(await readFile(resolve(parent, "dataset/builds.jsonl"))),
      manifest.files.find((item) => item.path === "builds.jsonl")!.sha256,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a dataset line has the sealed code of its build with the SHA-256 of each file", async () => {
  const { run, history } = await plannedBuild();
  const root = await mkdtemp(resolve(tmpdir(), "basalt-dataset-source-"));
  try {
    const base = resolve(
      root,
      ".basalt-evals/eval-operations/run-dataset/builder",
      run.treatmentId,
    );
    const contents: Record<string, string> = {
      "default.project.json": '{"tree":{}}\n',
      [SOURCE_PATH]: WRITTEN_SOURCE.replace("jump = 50", "jump = 60"),
    };
    for (const [path, text] of Object.entries(contents)) {
      await mkdir(dirname(resolve(base, "candidate", path)), { recursive: true });
      await writeFile(resolve(base, "candidate", path), text);
    }
    await writeFile(resolve(base, "agent-run.json"), JSON.stringify(run));
    const status = (artifactHashes: string[]) =>
      ({
        manifest: { id: "run-dataset" },
        events: [
          { stage: "builder", unitId: run.treatmentId, kind: "started", artifactHashes: [] },
          { stage: "builder", unitId: run.treatmentId, kind: "completed", artifactHashes },
        ],
      }) as unknown as Pick<RunOperationStatus, "manifest" | "events">;
    const bound = status([hashJson(run), run.candidate.rootHash]);
    const sealed = await sealedBuildSource(root, bound, run.treatmentId);
    assert.deepEqual(
      sealed?.files,
      Object.entries(contents).map(([path, content]) => ({
        path,
        sha256: contentHash(content),
        content,
      })),
    );
    assert.equal(sealed?.run.stopReason, "finished");
    assert.equal(await sealedBuildSource(root, status([]), run.treatmentId), null);
    const input = datasetInput(history, [
      {
        ...build("beacon", "model-a", "tools-1", 1, history.subjectId),
        stopReason: sealed!.run.stopReason,
        source: sealed!.files,
      },
    ]);
    const line = lines(datasetExportFiles(input, "public"))[0]!.build;
    assert.deepEqual(line.source, sealed!.files);
    // A sealed file that changed after the build stops the export.
    await writeFile(resolve(base, "candidate", SOURCE_PATH), "return 'CHANGED'\n");
    await assert.rejects(sealedBuildSource(root, bound, run.treatmentId), /changed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
