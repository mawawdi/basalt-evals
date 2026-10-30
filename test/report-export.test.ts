import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import { toolDefinitions } from "../packages/agent-runtime/src/tools.js";
import { buildHistory, type BuilderMessage } from "../packages/reporting/src/build-history.js";
import {
  exportArchive,
  runExportFiles,
  type ExportFile,
  type ExportManifest,
  type RunExportInput,
} from "../packages/reporting/src/export.js";
import type { BuildHistory } from "../packages/contracts/src/build-history.js";
import { writeExportFolder } from "../packages/operator/src/export.js";
import { checkCapture } from "../packages/operator/src/run-manifest.js";
import { plannedBuild } from "./build-history-fixture.js";
import { testHarness } from "./builder-fixture.js";

const decoder = new TextDecoder();
const SECRET = {
  statement: "SECRET-STATEMENT the beacon glows blue",
  criterionId: "secret-criterion-id",
  scale: "SECRET-SCALE",
  reason: "SECRET-REASON the judge saw a blue glow",
};
const share = (key: string) => ({
  key,
  builds: 1,
  of: 1,
  events: null,
  interval: { lower: 0.025, upper: 1, confidence: 0.95 },
});

function exportInput(history: BuildHistory, subjectId: string): RunExportInput {
  const frame = (name: string): ExportFile => ({
    path: `${subjectId}/${name}.png`,
    bytes: new TextEncoder().encode(`image ${name}`),
  });
  return {
    runId: "run-export",
    title: "Beacon",
    exportedAt: "2026-10-03T00:00:00.000Z",
    chargedUsd: 0.003,
    pendingUsd: 0,
    evaluations: [
      {
        evaluationId: "evaluation",
        title: "Beacon",
        stage: { index: 1, count: 1 },
        criteria: [
          {
            criterionId: SECRET.criterionId,
            statement: SECRET.statement,
            scale: SECRET.scale,
            required: true,
          },
        ],
      },
    ],
    columns: [
      {
        model: "Fake model",
        toolSet: "Local tools",
        cases: [
          {
            evaluationId: "evaluation",
            builds: [
              {
                subjectId,
                number: 1,
                marks: [
                  {
                    criterionId: SECRET.criterionId,
                    pass: 1,
                    outcome: "met",
                    score: null,
                    samples: null,
                    reason: SECRET.reason,
                    withheld: false,
                    frames: [frame("development")],
                  },
                  {
                    criterionId: SECRET.criterionId,
                    pass: 2,
                    outcome: "rejected",
                    score: null,
                    samples: null,
                    reason: SECRET.reason,
                    withheld: true,
                    frames: [frame("withheld")],
                  },
                  {
                    criterionId: SECRET.criterionId,
                    pass: 3,
                    outcome: "split",
                    score: null,
                    samples: { met: 2, of: 3 },
                    reason: null,
                    withheld: true,
                    frames: [],
                  },
                  {
                    criterionId: SECRET.criterionId,
                    pass: 4,
                    outcome: "insufficient",
                    score: null,
                    samples: { met: 1, of: 3 },
                    reason: null,
                    withheld: true,
                    frames: [],
                  },
                ],
                charge: { builderUsd: 0.003, judgeUsd: null, pendingUsd: 0 },
                buildMs: 1200,
                parentSubjectId: null,
                notReached: false,
              },
            ],
          },
        ],
      },
    ],
    histories: [
      {
        subjectId,
        history,
        atif: { agentVersion: "commit", tools: toolDefinitions(testHarness()) },
      },
    ],
    models: {
      operationId: "run-export",
      manifestHash: "manifest",
      title: "Beacon",
      finished: true,
      outcomeRule: { text: { met: "", notMet: "", unresolved: "" }, hash: "rule" },
      alpha: 0.05,
      evaluations: [
        {
          evaluationId: "evaluation",
          title: "Beacon",
          stage: { index: 1, count: 1 },
          criteria: [
            {
              criterionId: SECRET.criterionId,
              number: 1,
              statement: SECRET.statement,
              required: true,
              group: "appearance",
            },
          ],
        },
      ],
      models: [
        {
          rowId: "row",
          modelId: "fake/model",
          modelName: "Fake model",
          harnessId: "local",
          harnessTitle: "Local tools",
          builds: 1,
          judgeFamily: false,
          outcomes: [
            {
              evaluationId: "evaluation",
              criterionId: SECRET.criterionId,
              met: 0,
              notMet: 1,
              unresolved: 0,
            },
          ],
          patterns: {
            builds: 1,
            recordedBuilds: 1,
            stops: [share("delivered")],
            gateFailures: [],
            failedToolCalls: [],
            refusedBatches: { ...share("refused_batches"), builds: 0 },
            causes: [],
            lint: { codes: [{ ...share("LocalUnused"), events: 2 }], analyzed: 1, unanalyzed: 0 },
            scriptErrors: {
              build: share("build"),
              unknown: { ...share("unknown"), builds: 0 },
              measured: 1,
              unmeasured: 0,
            },
          },
        },
      ],
      modelPairs: [],
      toolSetPairs: [],
      issues: [],
    },
  };
}
const everything = (files: ExportFile[]) =>
  files.map((file) => decoder.decode(file.bytes)).join("\n");

test("a public export has no statements, reasons or withheld observations", async () => {
  const { history } = await plannedBuild();
  const input = exportInput(history, history.subjectId);
  const publicFiles = runExportFiles(input, "public");
  const text = everything(publicFiles);
  for (const secret of Object.values(SECRET)) assert.equal(text.includes(secret), false, secret);
  assert.equal(
    publicFiles.some((file) => file.path.startsWith("frames/")),
    false,
  );
  assert.match(text, /Criterion 1/u);
  const report = JSON.parse(
    decoder.decode(publicFiles.find((file) => file.path === "report.json")!.bytes),
  );
  assert.deepEqual(
    report.evaluations[0].columns[0].builds[0].answers.map(
      (answer: { answer: string }) => answer.answer,
    ),
    ["met", "not_met", "split", "not_enough_evidence"],
    "The answers stay without their private text",
  );
  assert.match(text, /observation 3: Split: 2 of 3 met/u, "A split answer names its judge samples");
  assert.match(
    text,
    /class="not_enough_evidence">.*observation 4: Not enough evidence: 1 of 3 met/u,
    "Not enough evidence is an answer with its judge samples, apart from a missing answer",
  );
  const privateFiles = runExportFiles(input, "private");
  const privateText = everything(privateFiles);
  assert.ok(privateText.includes(SECRET.statement) && privateText.includes(SECRET.reason));
  assert.deepEqual(
    privateFiles.filter((file) => file.path.startsWith("frames/")).map((file) => file.path),
    [`frames/${history.subjectId}/development.png`],
    "A withheld observation never exports its images",
  );
  assert.ok(
    publicFiles.some((file) => file.path === `atif/${history.subjectId}/agent/trajectory.json`),
  );
});

test("the manifest hashes every file", async () => {
  const { history } = await plannedBuild();
  const files = runExportFiles(exportInput(history, history.subjectId), "public");
  const manifest = JSON.parse(
    decoder.decode(files.find((file) => file.path === "manifest.json")!.bytes),
  ) as ExportManifest;
  const { manifestHash, ...body } = manifest;
  assert.equal(manifestHash, contentHash(stableJson(body)));
  assert.deepEqual(
    manifest.files.map((file) => file.path).sort(),
    files
      .map((file) => file.path)
      .filter((path) => path !== "manifest.json")
      .sort(),
  );
  for (const listed of manifest.files) {
    const file = files.find((item) => item.path === listed.path)!;
    assert.equal(listed.sha256, contentHash(file.bytes));
    assert.equal(listed.bytes, file.bytes.length);
  }
  // The .tar file holds the same bytes under one folder, in 512-byte ustar blocks.
  const tar = exportArchive("basalt-run-export-public", files, new Date(0));
  assert.equal(tar.length % 512, 0);
  const first = decoder.decode(tar.subarray(0, 100)).replace(/\0.*$/su, "");
  assert.equal(first, "basalt-run-export-public/index.html");
  assert.equal(decoder.decode(tar.subarray(257, 262)), "ustar");
  assert.ok(tar.subarray(-1024).every((byte) => byte === 0));
  // A folder export refuses a folder that exists and leaves no temporary folder.
  const parent = await mkdtemp(resolve(tmpdir(), "basalt-export-"));
  try {
    await mkdir(resolve(parent, "taken"));
    await assert.rejects(writeExportFolder(resolve(parent, "taken"), files), /already exists/u);
    await writeExportFolder(resolve(parent, "export"), files);
    assert.deepEqual((await readdir(parent)).sort(), ["export", "taken"]);
    assert.equal(
      contentHash(await readFile(resolve(parent, "export/manifest.json"))),
      contentHash(files.find((file) => file.path === "manifest.json")!.bytes),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("an unverified write shows no content", async () => {
  const { input } = await plannedBuild();
  const changed = "--!strict\nreturn 'CHANGED-AFTER-THE-BUILD'\n";
  const conversation = input.checkpoint.conversation.map((message) =>
    message.role === "assistant" && message.toolCalls[0]?.id === "write-1"
      ? ({
          ...message,
          toolCalls: [
            {
              ...message.toolCalls[0]!,
              arguments: { ...(message.toolCalls[0]!.arguments as object), content: changed },
            },
          ],
        } satisfies BuilderMessage)
      : message,
  );
  const history = buildHistory({ ...input, checkpoint: { ...input.checkpoint, conversation } });
  const text = everything(runExportFiles(exportInput(history, history.subjectId), "private"));
  assert.equal(text.includes("CHANGED-AFTER-THE-BUILD"), false);
  // The patch after it reads unverified text, so its text stays out too.
  assert.equal(text.includes("local jump = 60"), false);
  assert.match(text, /"verified": false/u);
});

test("a mark finds its observation by its grading cell or by its judge sample group", () => {
  const manifest = {
    captureCells: [
      { id: "capture-a", partition: "development" },
      { id: "capture-b", partition: "withheld" },
    ],
    gradingCells: [{ id: "grading-1", captureCellId: "capture-a", criterionId: "exists" }],
    // A sample group has its own ID. Each sample is a batch with another ID.
    judgmentBatches: [1, 2].map((sample) => ({
      id: `judgment-${sample}`,
      sampleGroupId: "samples-1",
      sample,
      captureCellId: "capture-b",
      criterionIds: ["blue"],
    })),
  } as unknown as import("../packages/contracts/src/execution.js").RunOperationManifest;
  assert.equal(checkCapture(manifest, "grading-1", "exists")?.id, "capture-a");
  assert.equal(checkCapture(manifest, "samples-1:blue", "blue")?.id, "capture-b");
  assert.equal(
    checkCapture(manifest, "judgment-1:blue", "blue"),
    null,
    "A judge mark names its sample group, never one of its batches",
  );
});
