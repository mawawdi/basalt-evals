import assert from "node:assert/strict";
import test from "node:test";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import {
  authoredAuthorityCatalog,
  privateSubmission,
  resolvePrivateSubmission,
} from "../packages/eval-authoring/src/private-submission.js";
import {
  assembledPrivateSubmission,
  criteriaSubmission,
  preparationRequests,
} from "../packages/eval-authoring/src/preparation-request.js";
import { applyCorrection } from "../packages/eval-authoring/src/proposal-correction.js";
import { assertEvaluatorSpec, hashJson } from "../packages/contracts/src/index.js";
import { fixtureInput, fixturePrivate, fixturePublic, stageSources } from "./shared-api-fixture.js";

const draft = createEvalDraft(fixtureInput);
const sources = stageSources(draft);

test("private submissions select authored identities; the compiler owns wording, spans and requiredness", () => {
  const submitted = privateSubmission(fixturePrivate, sources);
  assert.deepEqual(resolvePrivateSubmission(submitted, sources), fixturePrivate);
  assert.deepEqual(Object.keys(submitted.privateEvaluator.unscaled[0]!).sort(), ["evidence", "id"]);
  assert.equal(submitted.criterionMappings[1]!.authorityId, "rubric-criterion-2");
  const changed = createEvalDraft({
    ...fixtureInput,
    stages: [
      {
        ...fixtureInput.stages[0]!,
        rubric: "- An object exists.\n- Optional: the object looks cyan.",
      },
    ],
  });
  const resolved = resolvePrivateSubmission(submitted, stageSources(changed));
  assert.equal(
    resolved.privateEvaluator.unscaled[0]!.statement,
    changed.stages[0]!.criteria[1]!.text,
  );
  assert.equal(resolved.privateEvaluator.unscaled[0]!.required, false);
  assert.deepEqual(resolved.criterionMappings[1]!.authority, {
    source: "human_rubric",
    start: changed.stages[0]!.criteria[1]!.start,
    end: changed.stages[0]!.criteria[1]!.end,
  });
  const prompt = structuredClone(submitted);
  prompt.criterionMappings[1]!.authorityId = "builder-prompt";
  prompt.criterionMappings[1]!.authoredClauseIds = [];
  assert.throws(() => resolvePrivateSubmission(prompt, sources), /unknown authored authority/);
  for (const field of ["statement", "required"]) {
    const override = structuredClone(submitted);
    Object.assign(override.privateEvaluator.unscaled[0]!, {
      [field]: field === "required" ? false : "invented",
    });
    assert.throws(
      () => resolvePrivateSubmission(override, sources),
      /categorical submission fields/,
    );
  }
  const guessed = structuredClone(submitted);
  Object.assign(guessed.criterionMappings[0]!, {
    authority: { source: "human_rubric", start: 0, end: 0 },
  });
  assert.throws(() => resolvePrivateSubmission(guessed, sources), /mapping submission fields/);
  const invented = structuredClone(submitted);
  invented.criterionMappings[1]!.authorityId = "acceptance-1";
  assert.throws(
    () => resolvePrivateSubmission(invented, sources),
    /generated public summaries are not authored/,
  );
  const missing = structuredClone(submitted);
  missing.criterionMappings.pop();
  assert.throws(() => resolvePrivateSubmission(missing, sources), /exactly one authored passage/);
  const ambiguous = structuredClone(submitted);
  ambiguous.criterionMappings.push({
    ...ambiguous.criterionMappings[1]!,
    authorityId: "builder-prompt",
  });
  assert.throws(() => resolvePrivateSubmission(ambiguous, sources), /unknown authored authority/);
  assert.throws(
    () => resolvePrivateSubmission(fixturePrivate, sources),
    /mapping submission fields/,
  );
  assert.throws(
    () => authoredAuthorityCatalog({ ...sources, rubric: "different bytes" }),
    /original rubric passage/,
  );
});

test("private corrections use the same submission contract and public requests never receive the rubric catalog", () => {
  const requests = preparationRequests({
    publicModel: { id: "planner", maxOutputTokens: 16_384 },
    privateModel: { id: "planner", maxOutputTokens: 16_384 },
    seed: 1,
  });
  const plan = {
    studio: fixturePrivate.privateEvaluator.studio,
    sequence: fixturePrivate.privateEvaluator.sequence,
  };
  const privateRequest = requests.preparePrivateCriteria({
    ...sources,
    publicProposal: fixturePublic,
    plan,
    previousPrivateProposal: fixturePrivate,
    attempt: 2,
    diagnostics: ["Inspect causal coverage"],
  });
  const context = JSON.parse(privateRequest.messages[0]!.content as string);
  assert.deepEqual(context.authoredAuthorityCatalog, authoredAuthorityCatalog(sources));
  assert.deepEqual(context.plan, plan);
  assert.deepEqual(context.previousSubmission, criteriaSubmission(fixturePrivate, sources));
  assert.deepEqual(
    resolvePrivateSubmission(
      assembledPrivateSubmission(
        fixturePrivate.privateEvaluator.task.slug,
        plan,
        context.previousSubmission,
      ),
      sources,
    ),
    fixturePrivate,
  );
  assert.equal(privateRequest.tools[0]!.name, "submit_private_criteria_correction");
  assert.equal(context.correctionBaseHash, hashJson(context.previousSubmission));
  const initial = requests.preparePrivateCriteria({
    ...sources,
    publicProposal: fixturePublic,
    plan,
    previousPrivateProposal: null,
    attempt: 1,
    diagnostics: [],
  });
  assert.equal(initial.tools[0]!.name, "submit_private_criteria");
  // A proposal tool is strict. A correction tool is not, because an edit value can be any JSON.
  assert.equal(initial.tools[0]!.strict, true);
  assert.equal(privateRequest.tools[0]!.strict, undefined);
  assert.deepEqual(context.privateCriteriaSubmissionSchema, initial.tools[0]!.parameters);
  const planRequest = requests.preparePrivatePlan({
    ...sources,
    publicProposal: fixturePublic,
    previousPlan: plan,
    attempt: 2,
    diagnostics: ["Inspect the departed client"],
  });
  const planContext = JSON.parse(planRequest.messages[0]!.content as string);
  assert.equal(planRequest.tools[0]!.name, "submit_private_plan_correction");
  assert.deepEqual(planContext.previousSubmission, plan);
  assert.equal(Object.hasOwn(planContext, "plan"), false);
  const schema = initial.tools[0]!.parameters as {
    properties: {
      criterionMappings: { items: { properties: { authorityId: { enum: string[] } } } };
    };
  };
  assert.deepEqual(
    schema.properties.criterionMappings.items.properties.authorityId.enum,
    authoredAuthorityCatalog(sources).map((item) => item.id),
  );
  for (const request of [
    requests.preparePublic({
      stagePrompts: [sources.builderPrompt],
      title: draft.title,
      slug: draft.slug,
      attempt: 1,
      diagnostics: [],
      previousProposal: null,
    }),
  ]) {
    const publicContext = JSON.parse(request.messages[0]!.content as string);
    assert.equal(Object.hasOwn(publicContext, "authoredAuthorityCatalog"), false);
    assert.equal(Object.hasOwn(publicContext, "rubric"), false);
    assert.equal(JSON.stringify(publicContext).includes(sources.criteria[1]!.text), false);
  }
});

test("private corrections preserve unrelated criteria and reject stale, unsafe or undeclared edits", () => {
  type Criteria = {
    criterionMappings: Array<{ rationale: string }>;
    requiredCapabilities: string[];
  };
  const base = criteriaSubmission(fixturePrivate, sources) as Record<string, unknown> & Criteria;
  const plan = {
    studio: fixturePrivate.privateEvaluator.studio,
    sequence: fixturePrivate.privateEvaluator.sequence,
  };
  const resolve = (criteria: unknown) =>
    resolvePrivateSubmission(
      assembledPrivateSubmission(
        fixturePrivate.privateEvaluator.task.slug,
        plan,
        criteria as Record<string, unknown>,
      ),
      sources,
    );
  const original = structuredClone(base);
  const correction = (edits: unknown[]) => ({ baseHash: hashJson(base), edits });
  const edit = {
    op: "replace",
    path: "/criterionMappings/1/rationale",
    value: "Bind the available evidence",
  };
  const repaired = applyCorrection("PrivateCriteria", base, correction([edit]));
  const resolved = resolve(repaired);
  assert.deepEqual(base, original);
  assert.deepEqual(resolved.privateEvaluator, fixturePrivate.privateEvaluator);
  assert.deepEqual(resolved.criterionMappings[0], fixturePrivate.criterionMappings[0]);
  assert.equal(resolved.criterionMappings[1]!.rationale, edit.value);
  assert.throws(
    () => applyCorrection("PrivateCriteria", base, { ...correction([edit]), baseHash: "changed" }),
    /base changed/,
  );
  for (const path of [
    "/publicTask/prompt",
    "/unscaled/__proto__/x",
    "/unscaled/constructor",
    "/criterionMappings/99",
    "/criterionMappings/01",
    "/unscaled/missing/x",
    "",
  ]) {
    assert.throws(() => applyCorrection("PrivateCriteria", base, correction([{ ...edit, path }])));
  }
  // As in JSON Patch, an add on a present object field sets it.
  assert.equal(
    (
      applyCorrection(
        "PrivateCriteria",
        base,
        correction([{ op: "add", path: edit.path, value: "overwrite" }]),
      ) as Criteria
    ).criterionMappings[1]!.rationale,
    "overwrite",
  );
  assert.throws(
    () =>
      applyCorrection(
        "PrivateCriteria",
        base,
        correction([{ ...edit, path: "/criterionMappings/99/rationale" }]),
      ),
    new RegExp(`that array has ${base.criterionMappings.length} items`),
  );
  assert.throws(
    () =>
      applyCorrection(
        "PrivateCriteria",
        base,
        correction([{ op: "remove", path: edit.path, value: "ignored" }]),
      ),
    /must use the value null/,
  );
  assert.throws(
    () =>
      applyCorrection("PrivateCriteria", base, correction(Array.from({ length: 33 }, () => edit))),
    /one to 32/,
  );
  const override = applyCorrection(
    "PrivateCriteria",
    base,
    correction([{ op: "add", path: "/unscaled/0/required", value: false }]),
  );
  assert.throws(() => resolve(override), /categorical submission fields/);
  const withExtra = applyCorrection(
    "PrivateCriteria",
    base,
    correction([{ op: "add", path: "/requiredCapabilities/-", value: "timing" }]),
  );
  assert.deepEqual((withExtra as Criteria).requiredCapabilities, [
    ...base.requiredCapabilities,
    "timing",
  ]);
  const malformed = { unscaled: { fact: { attributeName: "Status", id: "state" } } };
  // A replace on an absent object field sets it. A remove needs the field.
  assert.deepEqual(
    applyCorrection("PrivateCriteria", malformed, {
      baseHash: hashJson(malformed),
      edits: [{ op: "replace", path: "/unscaled/fact/attribute", value: "Status" }],
    }),
    { unscaled: { fact: { attribute: "Status", attributeName: "Status", id: "state" } } },
  );
  assert.throws(
    () =>
      applyCorrection("PrivateCriteria", malformed, {
        baseHash: hashJson(malformed),
        edits: [{ op: "remove", path: "/unscaled/fact/attribute" }],
      }),
    /remove \/unscaled\/fact\/attribute\): the field to remove is absent; parent fields are \[attributeName, id\]/,
  );
  const renamed = applyCorrection("PrivateCriteria", malformed, {
    baseHash: hashJson(malformed),
    edits: [
      { op: "remove", path: "/unscaled/fact/attributeName" },
      { op: "add", path: "/unscaled/fact/attribute", value: "Status" },
    ],
  });
  assert.deepEqual(renamed, { unscaled: { fact: { attribute: "Status", id: "state" } } });
  assert.equal(malformed.unscaled.fact.attributeName, "Status");
  assert.throws(
    () =>
      applyCorrection(
        "PrivateCriteria",
        base,
        correction([{ ...edit, path: "/criterionMappings/0~2x" }]),
      ),
    /must be a JSON Pointer/,
  );
});

test("every correction edit addresses the base proposal, so edits do not move the targets of other edits", () => {
  const base = {
    studio: { items: ["a", "b", "c", "d", "e"], nested: [{ x: 1 }, { x: 2 }] },
  };
  const apply = (edits: unknown[]) =>
    applyCorrection("PrivatePlan", base, { baseHash: hashJson(base), edits }) as typeof base;
  const remove = (path: string) => ({ op: "remove", path, value: null });
  assert.deepEqual(apply([remove("/studio/items/1"), remove("/studio/items/3")]).studio.items, [
    "a",
    "c",
    "e",
  ]);
  assert.deepEqual(
    apply([
      remove("/studio/items/1"),
      { op: "add", path: "/studio/items/1", value: "B1" },
      { op: "add", path: "/studio/items/1", value: "B2" },
      { op: "add", path: "/studio/items/-", value: "f" },
      { op: "replace", path: "/studio/items/4", value: "E" },
    ]).studio.items,
    ["a", "B1", "B2", "c", "d", "E", "f"],
  );
  assert.deepEqual(
    apply([
      { op: "add", path: "/studio/nested/0", value: { x: 0 } },
      { op: "replace", path: "/studio/nested/1/x", value: 20 },
    ]).studio.nested,
    [{ x: 0 }, { x: 1 }, { x: 20 }],
  );
  assert.throws(
    () => apply([remove("/studio/items/1"), remove("/studio/items/1")]),
    /more than one replace or remove at \/studio\/items\/1/,
  );
  assert.throws(
    () => apply([remove("/studio/items/2"), remove("/studio/items/5")]),
    /edit 1 \(remove \/studio\/items\/5\): the array has 5 items, so the indexes are from 0 to 4/,
  );
  assert.deepEqual(base.studio.items, ["a", "b", "c", "d", "e"]);
});

test("a correction can replace a whole part, remove an extra field and split part fields from an edit", () => {
  const base = { unscaled: { a: 1 }, criterionMappings: [1], unexpected: true };
  const apply = (edits: unknown[]) =>
    applyCorrection("PrivateCriteria", base, { baseHash: hashJson(base), edits });
  assert.deepEqual(
    apply([
      { op: "replace", path: "/unscaled", value: { b: 2 } },
      { op: "remove", path: "/unexpected", value: null },
    ]),
    { unscaled: { b: 2 }, criterionMappings: [1] },
  );
  // The fields criterionMappings and requiredCapabilities name parts of the proposal.
  assert.deepEqual(
    apply([
      {
        op: "replace",
        path: "/unscaled",
        value: { c: 3 },
        criterionMappings: [2],
        requiredCapabilities: ["timing"],
      },
    ]),
    {
      unscaled: { c: 3 },
      criterionMappings: [2],
      requiredCapabilities: ["timing"],
      unexpected: true,
    },
  );
  assert.throws(
    () => apply([{ op: "replace", path: "/unexpected", value: false }]),
    /edit 0 \(replace \/unexpected\): path must stay within deterministic, codeQuality, visual, unscaled, humanReview, criterionMappings, requiredCapabilities/,
  );
  assert.throws(
    () => apply([{ op: "replace", path: "/unscaled/a", note: "x" }]),
    /edit 0 \(replace \/unscaled\/a\): an edit has exactly the fields op, path and value; missing \[value\]; extra \[note\]/,
  );
});

test("the evaluator check and the resolver name the errors of all criteria at once", () => {
  const evaluator = structuredClone(fixturePrivate.privateEvaluator);
  const rule = evaluator.deterministic[0]!.rule;
  if (rule.kind === "fact_equals") rule.factId = "absent-fact";
  evaluator.unscaled[0]!.evidence.facts = [{ phaseId: "scene", factId: "absent-binding" }];
  assert.throws(
    () => assertEvaluatorSpec(evaluator),
    (error: Error) =>
      error.message.startsWith("2 evaluator errors:\n") &&
      /deterministic criterion beacon-exists \(deterministic\/0\): Invalid criterion references an unknown Studio fact/.test(
        error.message,
      ) &&
      /unscaled criterion beacon-blue \(unscaled\/0\): Invalid unscaled beacon-blue references missing Studio observation phase:scene:absent-binding/.test(
        error.message,
      ),
  );
  const submission = privateSubmission(fixturePrivate, sources);
  submission.criterionMappings[0]!.authorityId = "invented-one";
  submission.privateEvaluator.unscaled.push({
    id: "unmapped",
    evidence: submission.privateEvaluator.unscaled[0]!.evidence,
  });
  assert.throws(
    () => resolvePrivateSubmission(submission, sources),
    (error: Error) =>
      error.message.startsWith("2 private submission errors:\n") &&
      /criterionMappings\/0: Criterion beacon-exists selects unknown authored authority invented-one/.test(
        error.message,
      ) &&
      /privateEvaluator\/unscaled\/1: Categorical criterion unmapped must select exactly one authored passage/.test(
        error.message,
      ),
  );
});
