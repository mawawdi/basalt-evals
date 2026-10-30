import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_JUDGE_SETTINGS } from "../packages/contracts/src/judge-settings.js";
import { compileEvalProposal, type EvalRevision } from "../packages/eval-authoring/src/compiler.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import { registerReadyEvaluation } from "../packages/eval-authoring/src/registration.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import { EvalDefinitionStore } from "../packages/eval-authoring/src/store.js";
import type { ModelTurnRequest } from "../packages/model-client/src/contracts.js";
import { RunOperationStore } from "../packages/operator/src/operation.js";
import type { RunOperationManifest } from "../packages/contracts/src/execution.js";
import { executeFrozenBuilderCell } from "../packages/operator/src/run-builder.js";
import { executeFrozenCaptureCell } from "../packages/operator/src/run-capture.js";
import { executeFrozenDeterministicGradingCell } from "../packages/operator/src/run-grade.js";
import { manifestHash } from "../packages/operator/src/run-manifest.js";
import { freezeSelectionRun, quoteSelectionRun } from "../packages/operator/src/selection-run.js";
import { writeRunConfiguration } from "./builder-fixture.js";
import { implementationFixture } from "./implementation-fixture.js";
import {
  fixtureAdapters,
  fixtureInput,
  fixturePrivate,
  fixturePublic,
  seedModelRegistry,
} from "./shared-api-fixture.js";

/*
 * A staged evaluation for the tests of staged runs and of the actions on their saved builds.
 */

export const BUILDER = "openai/gpt-6-luna";
export const JUDGE = "xiaomi/mimo-v2.6-flash";
export const PROMPTS = [
  "Create a blue Beacon part.",
  "Make the Beacon pulse once each second.",
  "Add a label above the Beacon.",
];
export const MARKER = "src/server/BuilderMarker.server.luau";

/** The draft of a staged evaluation with the first `stages` prompts. */
export function stagedDraft(options: { stages: number; gate?: boolean }) {
  return createEvalDraft({
    schema: "basalt-evals/eval-authoring-input",
    title: "Staged beacon",
    stages: PROMPTS.slice(0, options.stages).map((prompt, index) => ({
      prompt,
      rubric: fixtureInput.stages[0]!.rubric,
      ...(options.gate && index < options.stages - 1 ? { gateCriterionIds: ["criterion-1"] } : {}),
    })),
  });
}

/**
 * A workspace with a staged evaluation and one prepared revision for each stage. Each stage
 * reuses the fixture rubric, so the fixture proposal fits every stage. When `gate` is set, each
 * stage except the last gates the next stage on its required code check. When `failGate` names a
 * stage, the check of that stage expects a name that the synthetic Studio never reports.
 */
export async function stagedEvaluation(
  root: string,
  options: { stages: number; gate?: boolean; failGate?: number },
) {
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
  const draft = stagedDraft(options);
  await new EvalDefinitionStore(root).writeDraft(draft);
  const revisions = await stagedVersion(
    root,
    draft,
    options.failGate ? { [options.failGate]: "Lantern" } : {},
  );
  return { draft, revisions, adapters: fixtureAdapters(root) };
}

/** A staged evaluation, quoted and frozen as one run with one build of each stage. */
export async function stagedRun(
  root: string,
  options: { stages: number; gate?: boolean; failGate?: number },
) {
  const { draft, revisions, adapters } = await stagedEvaluation(root, options);
  const saved = await quoteSelectionRun(
    root,
    {
      revisionIds: [revisions[0]!.id],
      builderModelIds: [BUILDER],
      harnessIds: ["thin"],
      repetitions: 1,
      capturePasses: 1,
      gradingModelId: JUDGE,
      judgeSettings: DEFAULT_JUDGE_SETTINGS,
    },
    adapters,
  );
  const manifest = await freezeSelectionRun({
    root,
    operationId: "staged-run",
    quoteId: saved.id,
    ceilingUsd: 5,
    adapters,
  });
  const operation = new RunOperationStore(
    root,
    manifest.id,
    manifestHash(manifest),
    manifest.inputHash,
  );
  const subjects = revisions.map((revision) =>
    manifest.subjects.find((subject) => subject.evalId === revision.id)!,
  );
  return { draft, revisions, saved, manifest, operation, subjects, adapters };
}

export const build = (
  root: string,
  unitId: string,
  adapters: ReturnType<typeof fixtureAdapters>,
  operationId = "staged-run",
) => executeFrozenBuilderCell({ root, operationId, unitId, adapters });

/** The model requests of the synthetic client, in the sequence that the run sent them. */
export async function loggedRequests(root: string): Promise<ModelTurnRequest[]> {
  const text = await readFile(resolve(root, ".basalt-evals/synthetic-calls.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind: string; request?: ModelTurnRequest })
    .filter((entry) => entry.kind === "model")
    .map((entry) => entry.request!);
}

/**
 * Compile, save and register one version of the staged evaluation of `draft`. `names` gives the
 * Beacon name that the required code check of a stage expects. The other stages expect the name
 * that the synthetic Studio reports.
 */
export async function stagedVersion(
  root: string,
  draft: ReturnType<typeof createEvalDraft>,
  names: Record<number, string>,
): Promise<EvalRevision[]> {
  const { publicScene, ...publicProposal } = fixturePublic;
  const revisions: EvalRevision[] = [];
  let next: string | null = null;
  // Each stage names the revision of the next stage, so the last stage compiles first.
  for (let stage = draft.stages.length; stage >= 1; stage -= 1) {
    const privateProposal = structuredClone(fixturePrivate);
    if (names[stage])
      Object.assign(privateProposal.privateEvaluator.deterministic[0]!.rule, {
        expected: names[stage],
      });
    const compiled = compileEvalProposal(
      draft,
      stage,
      {
        ...publicProposal,
        publicTask: { ...publicProposal.publicTask, prompt: draft.stages[stage - 1]!.prompt },
        ...privateProposal,
        seed: neutralRojoSeed(draft.title, publicScene),
      },
      next,
    );
    assert.ok(compiled.revision, JSON.stringify(compiled.validation));
    revisions.unshift(compiled.revision);
    next = compiled.revision.id;
  }
  const store = new EvalDefinitionStore(root);
  for (const revision of [...revisions].reverse()) await store.writeRevision(revision);
  await registerReadyEvaluation(root, revisions[0]!.id);
  return revisions;
}

/** Observe each pass of a build and run its code checks, so the gate of its stage has answers. */
export async function observeAndCheck(
  root: string,
  manifest: RunOperationManifest,
  subjectId: string,
  adapters: ReturnType<typeof fixtureAdapters>,
) {
  for (const capture of manifest.captureCells.filter((cell) => cell.treatmentId === subjectId)) {
    await executeFrozenCaptureCell({
      root,
      operationId: manifest.id,
      cellId: capture.id,
      studioAdapter: adapters.studio,
    });
    for (const cell of manifest.gradingCells.filter((item) => item.captureCellId === capture.id))
      await executeFrozenDeterministicGradingCell({
        root,
        operationId: manifest.id,
        cellId: cell.id,
      });
  }
}

/**
 * A staged run with sealed builds of stage 1 and stage 2. With `check`, each of the two builds
 * also has checked observations.
 */
export async function twoBuiltStages(
  root: string,
  options: { stages: number; gate?: boolean; failGate?: number; check?: boolean },
) {
  const run = await stagedRun(root, options);
  const [first, second] = run.subjects as [(typeof run.subjects)[0], (typeof run.subjects)[0]];
  for (const subject of [first, second]) {
    await build(root, subject.id, run.adapters);
    if (options.check) await observeAndCheck(root, run.manifest, subject.id, run.adapters);
  }
  return { root, ...run, first, second };
}
