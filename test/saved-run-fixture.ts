import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inventoryTree } from "../packages/artifact-store/src/inventory.js";
import { hashJson } from "../packages/contracts/src/index.js";
import {
  DEFAULT_JUDGE_SETTINGS,
  type JudgeSettings,
} from "../packages/contracts/src/judge-settings.js";
import { compileEvalProposal, type EvalRevision } from "../packages/eval-authoring/src/compiler.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import type { PrivateProposal, PublicProposal } from "../packages/eval-authoring/src/proposals.js";
import { registerReadyEvaluation } from "../packages/eval-authoring/src/registration.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import { EvalDefinitionStore } from "../packages/eval-authoring/src/store.js";
import { executeFrozenDeterministicGradingCell } from "../packages/operator/src/run-grade.js";
import { executeFrozenCaptureCell } from "../packages/operator/src/run-capture.js";
import { executeFrozenJudgmentBatch } from "../packages/operator/src/run-judgment.js";
import {
  freezeRegisteredEvalRun,
  quoteRegisteredEvalRun,
} from "../packages/operator/src/run-plan.js";
import { sealRegisteredSubject } from "../packages/operator/src/seal-source.js";
import { registerSource } from "../packages/operator/src/sources.js";
import {
  fixtureAdapters,
  fixtureInput,
  fixturePrivate,
  fixturePublic,
  seedModelRegistry,
} from "./shared-api-fixture.js";
import { implementationFixture } from "./implementation-fixture.js";
import { writeRunConfiguration } from "./builder-fixture.js";

/** The judge of the saved run. A recheck with another model changes the judge. */
export const SAVED_JUDGE = "xiaomi/mimo-v2.6-flash";
export const OTHER_JUDGE = "z-ai/glm-5.3-flash";

/** A writable copy of the fixture proposal. */
function fixtureProposal() {
  return {
    publicProposal: structuredClone(fixturePublic) as PublicProposal,
    privateProposal: structuredClone(fixturePrivate) as PrivateProposal,
  };
}

/**
 * Compile, save and register one revision of the fixture evaluation. A change edits the copy of
 * the proposal before the compiler reads it, so each changed revision has its own identity.
 */
export async function savedRevision(
  root: string,
  change: (proposal: ReturnType<typeof fixtureProposal>) => void = () => {},
  input: typeof fixtureInput = fixtureInput,
): Promise<{ revision: EvalRevision; validationRecordHash: string }> {
  const draft = createEvalDraft(input);
  const proposal = fixtureProposal();
  change(proposal);
  const { publicScene, ...publicProposal } = proposal.publicProposal;
  const compiled = compileEvalProposal(draft, 1, {
    ...publicProposal,
    ...proposal.privateProposal,
    seed: neutralRojoSeed(draft.title, publicScene),
  });
  assert.ok(compiled.revision, JSON.stringify(compiled.validation));
  const store = new EvalDefinitionStore(root);
  await store.writeDraft(draft);
  await store.writeRevision(compiled.revision);
  await registerReadyEvaluation(root, compiled.revision.id);
  const [record] = await readdir(
    resolve(root, `.basalt-evals/eval-validations/${compiled.revision.id}`),
  );
  return { revision: compiled.revision, validationRecordHash: record!.replace(/\.json$/u, "") };
}

/** The workspace, the signing key and the models of a saved run. */
async function savedRunWorkspace(root: string) {
  // The run configuration is execution source, so the fixture commits it.
  await writeRunConfiguration(root);
  await implementationFixture(root);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await mkdir(resolve(root, ".basalt-evals/native-worker"), { recursive: true });
  await writeFile(
    resolve(root, ".basalt-evals/synthetic-private-key.pem"),
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  await writeFile(
    resolve(root, ".basalt-evals/native-worker/isolated-public-key.pem"),
    publicKey.export({ type: "spki", format: "pem" }),
  );
  await seedModelRegistry(root);
}

/** A registered build: the seed of a revision and one Beacon source file. */
async function beaconSource(root: string, revision: EvalRevision) {
  const workspace = resolve(root, ".basalt-evals/saved-build");
  for (const directory of ["src/server", "src/client", "src/shared"])
    await mkdir(resolve(workspace, directory), { recursive: true });
  await writeFile(
    resolve(workspace, "default.project.json"),
    JSON.stringify(revision.seed.project),
  );
  for (const source of revision.seed.sources)
    await writeFile(resolve(workspace, source.path), source.text);
  await writeFile(resolve(workspace, "src/server/Beacon.server.luau"), "-- Beacon\n");
  const files = await inventoryTree(workspace);
  return registerSource({
    root,
    workspace,
    candidate: { projectFile: "default.project.json", files, rootHash: hashJson(files) },
    provenance: {
      kind: "retained",
      evidenceHashes: ["b".repeat(64)],
      originOperationId: null,
      parentSourceId: null,
    },
  });
}

/**
 * One run of a registered build with one observation. The run makes its code check, and its
 * judge check with the fixture judge when the judge is not null. A test can give its own
 * revision and judge settings.
 */
export async function savedRun(
  root: string,
  judge: string | null = SAVED_JUDGE,
  options: {
    change?: Parameters<typeof savedRevision>[1];
    input?: typeof fixtureInput;
    judgeSettings?: JudgeSettings;
  } = {},
) {
  await savedRunWorkspace(root);
  const { revision, validationRecordHash } = await savedRevision(
    root,
    options.change,
    options.input,
  );
  const source = await beaconSource(root, revision);
  const adapters = fixtureAdapters(root);
  const saved = await quoteRegisteredEvalRun({
    root,
    adapters,
    selection: {
      captureScope: "final",
      publicFeedbackId: null,
      sourceIds: [source.id],
      parentSourceId: null,
      gradingMode: judge ? "all" : "code",
      continuingOperationId: null,
      revisionId: revision.id,
      validationRecordHash,
      builderModelIds: [],
      gradingModelId: judge,
      judgeSettings: options.judgeSettings ?? DEFAULT_JUDGE_SETTINGS,
      harnessIds: [],
      repetitions: 0,
      nativeCaptureRepetitions: 1,
    },
  });
  const manifest = await freezeRegisteredEvalRun({
    root,
    quoteId: saved.id,
    operationId: "run-saved-builds",
    ceilingUsd: 1,
    adapters,
  });
  const capture = manifest.captureCells[0]!;
  await sealRegisteredSubject(root, manifest.id, capture.treatmentId);
  await executeFrozenCaptureCell({
    root,
    operationId: manifest.id,
    cellId: capture.id,
    studioAdapter: adapters.studio,
  });
  for (const cell of manifest.gradingCells)
    await executeFrozenDeterministicGradingCell({
      root,
      operationId: manifest.id,
      cellId: cell.id,
    });
  for (const batch of manifest.judgmentBatches)
    await executeFrozenJudgmentBatch({
      root,
      operationId: manifest.id,
      batchId: batch.id,
      adapters,
    });
  return {
    revision,
    operationId: manifest.id,
    subjectId: capture.treatmentId,
    captureId: capture.id,
    sourceId: source.id,
    adapters,
  };
}

/** The model requests that the synthetic adapter received. */
export async function modelCalls(root: string): Promise<number> {
  const file = resolve(root, ".basalt-evals/synthetic-calls.jsonl");
  if (!existsSync(file)) return 0;
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => (JSON.parse(line) as { kind: string }).kind === "model").length;
}
