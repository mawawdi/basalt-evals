import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createEvalDraft } from "../packages/eval-authoring/src/index.js";
import type { EvalAuthoringInput } from "../packages/eval-authoring/src/input.js";
import type { EvalRevision } from "../packages/eval-authoring/src/compiler.js";
import { prepareEvalDraft } from "../packages/agent-runtime/src/eval-preparation.js";
import {
  modelPreparationRoles,
  type PreparationDispatcher,
} from "../packages/agent-runtime/src/preparation-models.js";
import { writeCoverageNotes } from "../packages/agent-runtime/src/coverage-notes.js";
import {
  COVERAGE_TOOL,
  coverageCheckIds,
  coveragePlan,
} from "../packages/eval-authoring/src/coverage-request.js";
import { coverageModelWork } from "../packages/eval-authoring/src/quote.js";
import {
  prepareCoverageNotes,
  readCoverageNotes,
} from "../packages/operator/src/coverage-notes.js";
import type { ModelTurnRequest, ModelTurnResult } from "../packages/model-client/src/contracts.js";
import { fixtureSnapshots } from "./shared-api-fixture.js";

let compiled: Promise<EvalRevision> | null = null;
/** The retained moving-platform responses give a real compiled revision without a model. */
function revision(): Promise<EvalRevision> {
  compiled ??= (async () => {
    const fixture = JSON.parse(
      await readFile(resolve("test/fixtures/preparation/moving-platform.json"), "utf8"),
    ) as {
      input: EvalAuthoringInput;
      publicSubmissions: Record<string, unknown>[];
      privatePlanSubmissions: Record<string, unknown>[];
      privateCriteriaSubmissions: Record<string, unknown>[];
    };
    const answers = {
      prepare_public: fixture.publicSubmissions,
      prepare_private_plan: fixture.privatePlanSubmissions,
      prepare_private_criteria: fixture.privateCriteriaSubmissions,
    };
    const counts = { prepare_public: 0, prepare_private_plan: 0, prepare_private_criteria: 0 };
    const dispatcher = {
      async complete(stage: keyof typeof counts, request: ModelTurnRequest) {
        const index = counts[stage]++;
        return answer(request.tools[0]!.name, answers[stage][index]!);
      },
    } as unknown as PreparationDispatcher;
    const result = await prepareEvalDraft(
      createEvalDraft(fixture.input),
      modelPreparationRoles({
        dispatcher,
        publicModel: { id: "offline", maxOutputTokens: 16_384 },
        privateModel: { id: "offline", maxOutputTokens: 16_384 },
        seed: 1,
      }),
    );
    assert.ok(result.revisions[0]);
    return result.revisions[0];
  })();
  return compiled;
}

function answer(name: string, value: unknown): ModelTurnResult {
  return {
    kind: "assistant",
    requestHash: "a".repeat(64),
    stopReason: "tool_calls",
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "offline", name, arguments: structuredClone(value) }],
    },
  } as unknown as ModelTurnResult;
}

function dispatcher(
  reply: (request: ModelTurnRequest, stage: string) => ModelTurnResult | Promise<ModelTurnResult>,
) {
  const requests: ModelTurnRequest[] = [];
  const stages: string[] = [];
  return {
    requests,
    stages,
    dispatcher: {
      async complete(stage: string, request: ModelTurnRequest) {
        stages.push(stage);
        requests.push(request);
        return reply(request, stage);
      },
    } as unknown as PreparationDispatcher,
  };
}

const model = { id: "offline", maxOutputTokens: 16_384 };

/** The lists that the tool of one request asks for, with the IDs of each list. */
function requested(request: ModelTurnRequest) {
  const lists = (
    request.tools[0]!.parameters as {
      properties: Record<string, { items: { properties: Record<string, { enum: string[] }> } }>;
    }
  ).properties;
  return {
    criteria: lists.criteria?.items.properties.criterionId!.enum ?? null,
    checks: lists.checks?.items.properties.checkId!.enum ?? null,
  };
}

const criterionEntry = (criterionId: string, coverage = "matches") => ({
  criterionId,
  evidenceFor: " Phase scene, fact beacon. ",
  evidenceAgainst: "",
  coverage,
  promptSupport: "stated",
  mixesClasses: false,
  note: " Offline note. ",
});

const checkEntry = (checkId: string, criterionIds: string[], support = "supports") => ({
  checkId,
  evidenceFor: "The mapping names it.",
  evidenceAgainst: "",
  support,
  criterionIds,
  note: "Offline check note.",
});

/** Answer every requested ID: each criterion matches, and each check supports its mapping. */
function complete(revision: EvalRevision) {
  return (request: ModelTurnRequest) => {
    const { criteria, checks } = requested(request);
    return answer(COVERAGE_TOOL, {
      ...(criteria && { criteria: criteria.map((id) => criterionEntry(id)) }),
      ...(checks && {
        checks: checks.map((id) =>
          checkEntry(
            id,
            revision.criterionMappings
              .filter((mapping) => mapping.executableCriterionId === id)
              .map((mapping) => mapping.authoredCriterionId!),
          ),
        ),
      }),
    });
  };
}

test("coverage notes keep one entry for each authored criterion and private check in sequence", async () => {
  const value = await revision();
  const ids = value.authored.criteria.map((criterion) => criterion.id);
  const checkIds = coverageCheckIds(coveragePlan(value));
  const fake = dispatcher(() =>
    answer(COVERAGE_TOOL, {
      criteria: [...ids]
        .reverse()
        .map((criterionId, index) =>
          criterionEntry(criterionId, index === 0 ? "stricter" : "matches"),
        ),
      checks: [...checkIds]
        .reverse()
        .map((checkId, index) => checkEntry(checkId, [ids[2 - index]!])),
    }),
  );
  const result = await writeCoverageNotes({ ...fake, model, revision: value });
  assert.deepEqual(result.requests, [
    {
      scope: "all",
      criterionId: null,
      state: "complete",
      requestHash: "a".repeat(64),
      reason: null,
    },
  ]);
  assert.deepEqual(fake.stages, ["coverage"], "Eight criteria or fewer share one request");
  assert.deepEqual(
    result.criteria.map((item) => item.criterionId),
    ids,
  );
  assert.equal(result.criteria.at(-1)!.coverage, "stricter");
  assert.equal(result.criteria[0]!.note, "Offline note.");
  assert.equal(result.criteria[0]!.evidenceFor, "Phase scene, fact beacon.");
  assert.deepEqual(
    result.checks.map((item) => [item.checkId, item.criterionIds]),
    checkIds.map((id, index) => [id, [ids[index]]]),
  );
  const [request] = fake.requests;
  const context = JSON.parse(request!.messages[0]!.content);
  assert.deepEqual(Object.keys(context.plan).sort(), [
    "criterionMappings",
    "privateEvaluator",
    "requiredCapabilities",
    "roles",
  ]);
  assert.deepEqual(
    context.authoredCriteria.map((item: { polarity: string }) => item.polarity),
    ["presence", "presence", "presence"],
  );
  assert.deepEqual(requested(request!), { criteria: ids, checks: checkIds });
  assert.equal(request!.tools[0]!.strict, true);
});

test("a coverage answer with a missing, repeated or unknown entry stays incomplete", async () => {
  const value = await revision();
  const [first, ...rest] = value.authored.criteria.map((criterion) => criterion.id);
  const checkIds = coverageCheckIds(coveragePlan(value));
  const checks = checkIds.map((id) => checkEntry(id, [first!]));
  for (const [criteria, answered] of [
    [rest.map((id) => criterionEntry(id)), checks],
    [
      [criterionEntry(first!), criterionEntry(first!), ...rest.map((id) => criterionEntry(id))],
      checks,
    ],
    [[criterionEntry(first!, "excellent"), ...rest.map((id) => criterionEntry(id))], checks],
    [[{ ...criterionEntry(first!), note: "" }, ...rest.map((id) => criterionEntry(id))], checks],
    [
      [{ ...criterionEntry(first!), mixesClasses: "no" }, ...rest.map((id) => criterionEntry(id))],
      checks,
    ],
    [[criterionEntry(first!), ...rest.map((id) => criterionEntry(id))], checks.slice(1)],
  ] as const) {
    const result = await writeCoverageNotes({
      ...dispatcher(() => answer(COVERAGE_TOOL, { criteria, checks: answered })),
      model,
      revision: value,
    });
    assert.equal(result.requests[0]!.state, "incomplete");
    assert.deepEqual([result.criteria, result.checks], [[], []]);
  }
  const truncated = await writeCoverageNotes({
    ...dispatcher(
      () =>
        ({
          ...answer(COVERAGE_TOOL, { criteria: [], checks: [] }),
          stopReason: "max_tokens",
        }) as ModelTurnResult,
    ),
    model,
    revision: value,
  });
  assert.match(truncated.requests[0]!.reason!, /output limit/);
});

test("Each private check supports a criterion, has none, or tests something outside the public contract.", async () => {
  const value = await revision();
  const ids = value.authored.criteria.map((criterion) => criterion.id);
  const [route, smooth, errors] = coverageCheckIds(coveragePlan(value));
  const criteria = ids.map((id) => criterionEntry(id));
  const notes = (checks: unknown[]) =>
    writeCoverageNotes({
      ...dispatcher(() => answer(COVERAGE_TOOL, { criteria, checks })),
      model,
      revision: value,
    });
  const result = await notes([
    checkEntry(route!, [ids[0]!]),
    checkEntry(smooth!, [], "orphan"),
    checkEntry(errors!, [ids[2]!, ids[0]!], "unstated_in_public_contract"),
  ]);
  assert.deepEqual(
    result.checks.map((item) => [item.checkId, item.support, item.criterionIds]),
    [
      [route, "supports", [ids[0]]],
      [smooth, "orphan", []],
      // The authored sequence keeps equal answers equal.
      [errors, "unstated_in_public_contract", [ids[0], ids[2]]],
    ],
  );
  // A supporting check names a criterion, and an orphan check names none.
  for (const checks of [
    [checkEntry(route!, []), checkEntry(smooth!, [], "orphan"), checkEntry(errors!, [ids[2]!])],
    [
      checkEntry(route!, [ids[0]!]),
      checkEntry(smooth!, [ids[1]!], "orphan"),
      checkEntry(errors!, [ids[2]!]),
    ],
    [
      checkEntry(route!, ["criterion-9"]),
      checkEntry(smooth!, [ids[1]!]),
      checkEntry(errors!, [ids[2]!]),
    ],
  ])
    assert.equal((await notes(checks)).requests[0]!.state, "incomplete");
});

test("More than eight criteria use one request for each criterion and one for the checks.", async () => {
  const value = await revision();
  const authoring = (rubric: string) =>
    createEvalDraft({
      schema: "basalt-evals/eval-authoring-input",
      stages: [{ prompt: value.authored.builderPrompt, rubric: rubric }],
    });
  const draft = authoring(
    Array.from({ length: 9 }, (_, index) => `- Platform rule ${index + 1} holds.`).join("\n"),
  );
  // The plan of the fixture keeps its three checks. Each one maps to one of the new criteria.
  const nine = {
    ...value,
    authored: {
      ...value.authored,
      rubric: draft.stages[0]!.rubric,
      criteria: draft.stages[0]!.criteria,
    },
    criterionMappings: value.criterionMappings.map((mapping, index) => ({
      ...mapping,
      authoredCriterionId: draft.stages[0]!.criteria[index]!.id,
    })),
  } as EvalRevision;
  let active = 0;
  let most = 0;
  const reply = complete(nine);
  const fake = dispatcher(async (request) => {
    most = Math.max(most, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return reply(request);
  });
  const result = await writeCoverageNotes({ ...fake, model, revision: nine });
  const ids = draft.stages[0]!.criteria.map((criterion) => criterion.id);
  assert.deepEqual(fake.stages, [...ids.map((id) => `coverage:${id}`), "coverage:checks"]);
  assert.equal(most, 10, "The requests run in parallel");
  for (const [index, request] of fake.requests.entries()) {
    const content = JSON.parse(request.messages[0]!.content);
    if (index < 9) {
      assert.deepEqual(requested(request), { criteria: [ids[index]], checks: null });
      assert.deepEqual(
        content.authoredCriteria.map((item: { id: string }) => item.id),
        [ids[index]],
      );
    } else {
      assert.deepEqual(requested(request), {
        criteria: null,
        checks: coverageCheckIds(coveragePlan(nine)),
      });
      assert.equal(content.authoredCriteria.length, 9);
    }
  }
  assert.deepEqual(
    result.criteria.map((item) => item.criterionId),
    ids,
  );
  assert.equal(result.checks.length, 3);
  assert.ok(result.requests.every((request) => request.state === "complete"));
  // The quote has one bounded request for each request that preparation sends.
  const snapshot = fixtureSnapshots.find((item) => item.id === "xiaomi/mimo-v2.6-flash")!;
  assert.deepEqual(
    coverageModelWork(draft, snapshot).map((work) => [work.stage, work.calls]),
    Array.from({ length: 10 }, () => ["coverage", 1]),
  );
  assert.equal(coverageModelWork(authoring("- One.\n- Two."), snapshot).length, 1);
});

test("a failed coverage request keeps the preparation and saves an incomplete record one time", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-coverage-"));
  try {
    const value = await revision();
    const snapshot = fixtureSnapshots.find((item) => item.id === "xiaomi/mimo-v2.6-flash")!;
    const failing = dispatcher(() => {
      throw new Error("Paid call uncertain.");
    });
    const record = await prepareCoverageNotes({
      root,
      operationId: "coverage-test",
      revision: value,
      model: snapshot,
      dispatcher: failing.dispatcher,
      signal: new AbortController().signal,
    });
    assert.equal(record.state, "incomplete");
    assert.match(record.reason!, /Paid call uncertain/);
    assert.deepEqual([record.criteria, record.checks], [[], []]);
    // The owned computation returns the saved record. It does not send the request again.
    const again = await prepareCoverageNotes({
      root,
      operationId: "coverage-test",
      revision: value,
      model: snapshot,
      dispatcher: failing.dispatcher,
      signal: new AbortController().signal,
    });
    assert.deepEqual(again, record);
    assert.equal(failing.requests.length, 1);
    assert.deepEqual(await readCoverageNotes(root, value.id), [record]);
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(
      prepareCoverageNotes({
        root,
        operationId: "coverage-test",
        revision: { ...value, id: "b".repeat(64) },
        model: snapshot,
        dispatcher: failing.dispatcher,
        signal: stopped.signal,
      }),
    );
    assert.deepEqual(await readCoverageNotes(root, "b".repeat(64)), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
