import assert from "node:assert/strict";
import test from "node:test";
import { hashJson } from "../packages/contracts/src/index.js";
import { compileEvalProposal } from "../packages/eval-authoring/src/compiler.js";
import { controlSourceRequest } from "../packages/eval-authoring/src/control-request.js";
import { controlSpecs } from "../packages/eval-authoring/src/control-specs.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import { quoteControlPreparation } from "../packages/eval-authoring/src/quote.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import type { ModelSnapshot } from "../packages/model-client/src/catalog.js";
import { fixtureInput, fixturePrivate, fixturePublic } from "./shared-api-fixture.js";

/*
 * A stored reference test is verifiable only while Basalt builds each of its requests and its
 * quote again with the same bytes. These hashes pin the control-source requests and the quote of
 * an evaluation without stages. Change them only with a change that a person approved, because
 * the change makes each stored paid reference test unverifiable.
 */

const snapshot: ModelSnapshot = {
  id: "openai/gpt-6-luna",
  name: "GPT-6 Luna",
  revision: "openai/gpt-6-luna-test",
  capturedAt: "2026-09-23T00:00:00.000Z",
  inputModalities: ["text", "image"],
  reasoning: null,
  recommendedSampling: {
    temperature: null,
    top_p: null,
    top_k: null,
    frequency_penalty: null,
    presence_penalty: null,
    repetition_penalty: null,
  },
  endpoints: [
    {
      tag: "test",
      provider: "test",
      quantization: "unknown",
      contextLength: 100_000,
      maxPromptTokens: null,
      rawPricing: {},
      maxOutputTokens: 32768,
      supportedParameters: ["tools"],
      tiers: [
        {
          minPromptTokens: 0,
          temporal: null,
          inputPerTokenUsd: 0.000001,
          outputPerTokenUsd: 0.000002,
          imagePerImageUsd: 0,
          requestUsd: 0,
          cacheReadPerTokenUsd: null,
          cacheWritePerTokenUsd: null,
        },
      ],
    },
  ],
  hash: "f".repeat(64),
};

function unstagedRevision() {
  const draft = createEvalDraft(fixtureInput);
  const { publicScene, ...publicProposal } = fixturePublic;
  const compiled = compileEvalProposal(
    draft,
    1,
    { ...publicProposal, ...fixturePrivate, seed: neutralRojoSeed(draft.title, publicScene) },
    null,
  );
  assert.ok(compiled.revision, JSON.stringify(compiled.validation));
  return compiled.revision;
}

test("the control-source requests of an evaluation without stages keep their exact bytes", () => {
  const revision = unstagedRevision();
  const [working, other] = controlSpecs(revision);
  const configuration = { model: "openai/gpt-6-luna", seed: 7, maxOutputTokens: 32_000 };
  const request = (spec: typeof working, workingFiles: Array<{ path: string; text: string }>) =>
    controlSourceRequest(configuration, {
      revision,
      spec: spec!,
      attempt: 2,
      diagnostics: ["beacon-exists: expected verified, got rejected"],
      workingFiles,
      startingFiles: null,
    });
  const files = [{ path: "src/server/Beacon.server.luau", text: "-- working control\n" }];
  assert.equal(
    hashJson(request(working, files)),
    "2bb0a305a710deec718a097b537f36f057d83cd260f245e41d475d4932799293",
  );
  assert.equal(
    hashJson(request(other, files)),
    "8da6418bec5616ae3a3f16cf236b023b78eda12d3cd294f71729cb6b9a6642a9",
  );
});

test("the reference quote of an evaluation without stages keeps its exact bytes", () => {
  const quote = quoteControlPreparation([unstagedRevision()], snapshot, snapshot);
  assert.equal(hashJson(quote), "5de59d25c28e28c0ef48498961ec6d74cd5b07e1db39b380e695e570c450a55d");
});
