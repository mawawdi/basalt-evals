import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_JUDGE_SETTINGS } from "../packages/contracts/src/judge-settings.js";
import type { EvalRunSelection } from "../packages/contracts/src/execution.js";
import { compileEvalProposal } from "../packages/eval-authoring/src/compiler.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import { registerReadyEvaluation } from "../packages/eval-authoring/src/registration.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import { EvalDefinitionStore } from "../packages/eval-authoring/src/store.js";
import { writeRunConfiguration } from "./builder-fixture.js";
import { implementationFixture } from "./implementation-fixture.js";
import {
  fixtureInput,
  fixturePrivate,
  fixturePublic,
  seedModelRegistry,
} from "./shared-api-fixture.js";

/**
 * A repository with the run configuration of this checkout, the extra execution source that
 * `writeSource` adds, a clean implementation commit and one ready fixture evaluation.
 */
export async function readyRunProject(root: string, writeSource: () => Promise<void>) {
  await writeRunConfiguration(root);
  await writeSource();
  // The run configuration is execution source, so the fixture commits it.
  await implementationFixture(root);
  await seedModelRegistry(root);
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
  const draft = createEvalDraft(fixtureInput);
  const { publicScene, ...publicProposal } = fixturePublic;
  const revision = compileEvalProposal(draft, 1, {
    ...publicProposal,
    ...fixturePrivate,
    seed: neutralRojoSeed(draft.title, publicScene),
  }).revision!;
  const store = new EvalDefinitionStore(root);
  await store.writeDraft(draft);
  await store.writeRevision(revision);
  const { validationRecordHash } = await registerReadyEvaluation(root, revision.id);
  /** A selection of one build of one model with code checks only. */
  const selection = (harnessIds: string[]): EvalRunSelection => ({
    captureScope: "final",
    publicFeedbackId: null,
    sourceIds: [],
    parentSourceId: null,
    gradingMode: "code",
    continuingOperationId: null,
    revisionId: revision.id,
    validationRecordHash,
    builderModelIds: ["openai/gpt-6-luna"],
    gradingModelId: null,
    judgeSettings: DEFAULT_JUDGE_SETTINGS,
    harnessIds,
    repetitions: 1,
    nativeCaptureRepetitions: 1,
  });
  return { revision, selection };
}
