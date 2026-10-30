import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { explainFailures } from "../packages/agent-runtime/src/failure-explanation.js";
import type { PreparationDispatcher } from "../packages/agent-runtime/src/preparation-models.js";
import { compileEvalProposal } from "../packages/eval-authoring/src/compiler.js";
import {
  FAILURE_QUESTION_IDS,
  failureExplanationRequest,
  failureHypotheses,
  parseFailureQuestions,
  type ExplainedCriterion,
} from "../packages/eval-authoring/src/failure-explanation-request.js";
import { strictToolWireSchema } from "../packages/model-client/src/strict-tool-schema.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import { registerReadyEvaluation } from "../packages/eval-authoring/src/registration.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import { EvalDefinitionStore } from "../packages/eval-authoring/src/store.js";
import type { ModelTurnResult } from "../packages/model-client/src/contracts.js";
import { queueAuthoringAction } from "../packages/operator/src/authoring-operation.js";
import { driveOperation } from "../packages/operator/src/driver.js";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import {
  prepareEmptyBuildCheck,
  readEmptyBuildCheck,
} from "../packages/operator/src/empty-build-check.js";
import {
  readFailureExplanationMaterial,
  readFailureExplanations,
} from "../packages/operator/src/failure-explanation.js";
import { previewOperationLaunch } from "../packages/operator/src/launch.js";
import {
  fixtureAdapters,
  fixtureInput,
  fixturePrivate,
  fixturePublic,
  seedModelRegistry,
} from "./shared-api-fixture.js";
import { implementationFixture } from "./implementation-fixture.js";
import { writeRunConfiguration } from "./builder-fixture.js";

function criterion(criterionId: string, ids: string[]): ExplainedCriterion {
  return {
    criterionId,
    statement: `The ${criterionId} works.`,
    authoredPassages: [`The ${criterionId} works.`],
    required: true,
    polarity: "presence",
    evidenceClass: null,
    check: null,
    warnings: ["every_build_fails"],
    observations: ids.map((id) => ({
      id,
      build: "Build 1",
      answer: "rejected",
      observed: [false],
      reasons: ["Synthetic reason."],
    })),
  };
}
const answer = (questionId: string, observationIds: string[]) => ({
  questionId,
  evidenceFor: "The observation shows the value false.",
  evidenceAgainst: "",
  value: "yes",
  observationIds,
});

test("An unknown observation ID stays incomplete.", async () => {
  const material = {
    criteria: [criterion("door", ["b1-o1", "b2-o1"]), criterion("beacon", ["empty-o1"])],
  };
  const submitted = {
    criteria: [
      {
        criterionId: "door",
        answers: [
          answer("prompt_gap", ["b1-o1"]),
          answer("observation_gap", ["b9-o1"]),
          // An observation of another criterion is unknown for this criterion.
          answer("gaming", ["empty-o1"]),
          answer("infrastructure", []),
        ],
      },
    ],
  };
  const hypotheses = failureHypotheses(submitted, material);
  assert.deepEqual(
    hypotheses.map((item) => [item.criterionId, item.questionId, item.state, item.value]),
    [
      ["door", "prompt_gap", "complete", "yes"],
      ["door", "observation_gap", "incomplete", null],
      ["door", "gaming", "incomplete", null],
      ["door", "infrastructure", "complete", "yes"],
      ...FAILURE_QUESTION_IDS.map((id) => ["beacon", id, "incomplete", null]),
    ],
  );
  assert.match(hypotheses[1]!.reason!, /did not contain for this criterion: b9-o1/);
  assert.equal(hypotheses[4]!.reason, "The model gave no answer to this question.");
  // The runtime keeps the incomplete answers. It sends no second request.
  const requests: string[] = [];
  const response: ModelTurnResult = {
    kind: "assistant",
    requestHash: "a".repeat(64),
    responseHash: "b".repeat(64),
    stopReason: "tool_calls",
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "one", name: "submit_failure_hypotheses", arguments: submitted }],
    },
    responseFacts: null as never,
    usage: null as never,
  };
  const result = await explainFailures({
    dispatcher: {
      async complete(stage: string) {
        requests.push(stage);
        return response;
      },
    } as unknown as PreparationDispatcher,
    model: { id: "test/model", maxOutputTokens: 131072 },
    seed: 1,
    material: {
      questions: FAILURE_QUESTION_IDS.map((id) => ({ id, text: `Question ${id}?` })),
      builderPrompt: "Open the door.",
      publicRoles: [],
      plan: null,
      ...material,
    },
  });
  assert.deepEqual(requests, ["explanation"]);
  assert.equal(result.state, "incomplete");
  assert.equal(result.reason, "6 of 8 answers are incomplete.");
});

test("The hypotheses tool has a valid strict wire schema and a bounded answer.", () => {
  const request = failureExplanationRequest({ id: "test/model", maxOutputTokens: 131072 }, 1, {
    questions: FAILURE_QUESTION_IDS.map((id) => ({ id, text: `Question ${id}?` })),
    builderPrompt: "Open the door.",
    publicRoles: [],
    plan: null,
    criteria: [criterion("door", ["b1-o1", "b2-o1"]), criterion("beacon", ["empty-o1"])],
  });
  const [tool] = request.tools;
  assert.equal(tool!.name, "submit_failure_hypotheses");
  assert.equal(tool!.strict, true);
  const wire = JSON.stringify(strictToolWireSchema(tool!.parameters));
  assert.doesNotMatch(wire, /maxLength|maxItems/, "Local bounds stay off the wire");
  // An output limit that cannot hold the longest answer refuses the request before spend.
  assert.throws(
    () =>
      failureExplanationRequest({ id: "test/model", maxOutputTokens: 1000 }, 1, {
        questions: [],
        builderPrompt: "",
        publicRoles: [],
        plan: null,
        criteria: [criterion("door", ["b1-o1"])],
      }),
    /can need \d+ characters\. Select a model with a larger output limit/,
  );
});

test("The authored questions keep their IDs, their sequence and a status line.", async () => {
  const authored = await readFile(resolve("studies/failure-questions.md"), "utf8");
  const questions = parseFailureQuestions(authored);
  assert.equal(questions.status, "draft", "A person has not reviewed the first draft yet");
  assert.deepEqual(
    questions.questions.map((question) => question.id),
    [...FAILURE_QUESTION_IDS],
  );
  assert.throws(
    () => parseFailureQuestions(authored.replace("## gaming", "## shortcut")),
    /needs one section for each question/,
  );
  assert.throws(() => parseFailureQuestions(authored.replace("Status: draft", "")), /status line/);
});

test("The request contains only the flagged criteria.", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-explain-"));
  try {
    // The questions and the run configuration are execution source, so the fixture commits them.
    await writeRunConfiguration(root);
    await writeFile(
      resolve(root, "studies/failure-questions.md"),
      await readFile(resolve("studies/failure-questions.md")),
    );
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
    const draft = createEvalDraft(fixtureInput);
    const { publicScene, ...publicProposal } = fixturePublic;
    const compiled = compileEvalProposal(draft, 1, {
      ...publicProposal,
      ...fixturePrivate,
      seed: neutralRojoSeed(draft.title, publicScene),
    });
    const revision = compiled.revision!;
    const store = new EvalDefinitionStore(root);
    await store.writeDraft(draft);
    await store.writeRevision(revision);
    await registerReadyEvaluation(root, revision.id);
    const adapters = fixtureAdapters(root);
    // The synthetic Studio reports a Beacon in the seed, so the code check passes on the empty
    // build. The judge criterion beacon-blue has no warning.
    await prepareEmptyBuildCheck({
      root,
      operationId: "empty-build",
      revisionId: revision.id,
      studio: adapters.studio,
      signal: new AbortController().signal,
    });
    const emptyBuild = await readEmptyBuildCheck(root, revision.id);
    assert.deepEqual(emptyBuild!.hollow, ["beacon-exists"]);

    const selection = { revisionId: revision.id, modelId: "xiaomi/mimo-v2.6-flash" };
    const preview = await previewOperationLaunch(
      root,
      { kind: "explain_failures", selection },
      adapters,
    );
    assert.equal(preview.binding.kind, "explanation");
    assert.deepEqual(
      preview.quote!.workload.modelWork.map((work) => [work.stage, work.calls]),
      [["explanation", 1]],
      "One request, and the preview sends nothing",
    );
    const material = await readFailureExplanationMaterial(root, preview.quote!.subjectId!);
    assert.deepEqual(
      material.input.criteria.map((item) => [item.criterionId, item.warnings]),
      [["beacon-exists", ["passes_empty_build"]]],
    );
    assert.deepEqual(
      material.input.criteria[0]!.observations.map((item) => [item.id, item.answer]),
      [["empty-o1", "met"]],
    );
    assert.equal(material.questions.status, "draft");

    const progress = await queueAuthoringAction(root, {
      operationId: "explanation-test",
      stage: "explanation",
      revisionId: revision.id,
      quoteId: preview.binding.id,
      ceilingUsd: 1,
    });
    // The driver runs the request without Studio: a Studio readiness check here would fail.
    await writeFile(resolve(root, ".basalt-evals/synthetic-readiness-failure"), "");
    const journal = await OperationJournal.open(root);
    try {
      journal.put("drivers", progress.action.operationId, {
        token: "owner",
        pid: process.pid,
        active: true,
        error: null,
        waiting: null,
      });
    } finally {
      journal.close();
    }
    await driveOperation(root, progress.action.operationId, "owner", adapters);
    const records = await OperationJournal.open(root);
    try {
      assert.equal(records.read("readiness_progress", progress.action.operationId), null);
    } finally {
      records.close();
    }
    const [record] = await readFailureExplanations(root, revision.id);
    assert.equal(record!.state, "complete");
    assert.deepEqual(
      record!.hypotheses.map((item) => [item.criterionId, item.questionId, item.value]),
      FAILURE_QUESTION_IDS.map((id) => ["beacon-exists", id, id === "gaming" ? "yes" : "unclear"]),
    );
    const requests = (await readFile(resolve(root, ".basalt-evals/synthetic-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((call) => call.kind === "model");
    assert.equal(requests.length, 1);
    const sent = JSON.parse(requests[0].request.messages[0].content);
    assert.deepEqual(
      sent.criteria.map((item: { criterionId: string }) => item.criterionId),
      ["beacon-exists"],
      "The judge criterion without a warning is not in the request",
    );
    assert.doesNotMatch(requests[0].request.messages[0].content, /beacon-blue/);
    assert.deepEqual(
      await readEmptyBuildCheck(root, revision.id),
      emptyBuild,
      "A hypothesis never changes an answer",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
