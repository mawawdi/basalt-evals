import assert from "node:assert/strict";
import test from "node:test";
import { strictToolWireSchema } from "../packages/model-client/src/strict-tool-schema.js";
import type { ModelToolDefinition } from "../packages/model-client/src/contracts.js";
import { compileEvalProposal } from "../packages/eval-authoring/src/compiler.js";
import {
  coveragePlan,
  coverageRequest,
  type CoverageScope,
} from "../packages/eval-authoring/src/coverage-request.js";
import { createEvalDraft } from "../packages/eval-authoring/src/input.js";
import { neutralRojoSeed } from "../packages/eval-authoring/src/seed.js";
import { fixtureInput, fixturePrivate, fixturePublic } from "./shared-api-fixture.js";

const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

test("the strict wire schema keeps the strict subset and removes local constraints", () => {
  const declared = {
    type: "object",
    description: "A plan.",
    properties: {
      name: {
        type: "string",
        description: "A slug.",
        minLength: 1,
        maxLength: 64,
        pattern: "^[a-z]+$",
        format: "hostname",
        default: "plan",
      },
      count: {
        type: "integer",
        minimum: 1,
        maximum: 9,
        exclusiveMinimum: 0,
        exclusiveMaximum: 10,
        multipleOf: 1,
      },
      contexts: {
        type: "array",
        items: { type: "string", enum: ["server", "client"] },
        minItems: 1,
        maxItems: 2,
        uniqueItems: true,
        contains: { const: "server" },
      },
      step: {
        oneOf: [
          object({ kind: { type: "string", const: "wait" } }),
          object({
            kind: { const: "move" },
            target: { type: ["string", "null"] },
            offset: { type: "array", items: { type: "number", minimum: -10 }, minItems: 3 },
          }),
        ],
      },
    },
    required: ["name", "count", "contexts", "step"],
    additionalProperties: false,
  };
  const before = structuredClone(declared);
  const wire = strictToolWireSchema(declared);
  assert.deepEqual(wire, {
    type: "object",
    description: "A plan.",
    // Each removed bound goes into the description of its field. A note such as `default` does not.
    properties: {
      name: {
        type: "string",
        description:
          "A slug. The text has 1 or more characters. The text has 64 or fewer characters. The text matches the regular expression `^[a-z]+$`. The text has the format hostname.",
      },
      count: {
        type: "integer",
        description:
          "The value is 1 or more. The value is more than 0. The value is 9 or less. The value is less than 10. The value is a multiple of 1.",
      },
      contexts: {
        type: "array",
        items: { type: "string", enum: ["server", "client"] },
        description:
          'The list has 1 or more items. The list has 2 or fewer items. All items in the list are different. 1 or more items in the list match this schema: {"const":"server"}.',
      },
      step: {
        anyOf: [
          object({ kind: { type: "string", enum: ["wait"] } }),
          object({
            kind: { enum: ["move"] },
            target: { type: ["string", "null"] },
            offset: {
              type: "array",
              items: { type: "number", description: "The value is -10 or more." },
              description: "The list has 3 or more items.",
            },
          }),
        ],
      },
    },
    required: ["name", "count", "contexts", "step"],
    additionalProperties: false,
  });
  assert.deepEqual(declared, before, "The local validators keep the complete declared schema");
  assert.equal(
    JSON.stringify(strictToolWireSchema(declared)),
    JSON.stringify(wire),
    "The transform is fixed",
  );
});

test("the sentence of contains names its counts, and uniqueItems false adds no sentence", () => {
  const wire = strictToolWireSchema(
    object({
      tags: {
        type: "array",
        items: { type: "string" },
        contains: { const: "a" },
        minContains: 2,
        maxContains: 4,
        uniqueItems: false,
      },
    }),
  );
  assert.deepEqual((wire.properties as Record<string, unknown>).tags, {
    type: "array",
    items: { type: "string" },
    description: 'From 2 to 4 items in the list match this schema: {"const":"a"}.',
  });
});

test("an incompatible strict schema is refused with the location of the problem", () => {
  const cases: Array<[unknown, string]> = [
    [
      { type: "array", items: { type: "string" } },
      "The schema at # is not an object schema. The root of a strict tool schema must be an object.",
    ],
    [
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      "The schema at # is an object without additionalProperties: false.",
    ],
    [
      object({ a: { type: "object", properties: {}, additionalProperties: true } }),
      "The schema at #/properties/a is an object without additionalProperties: false.",
    ],
    [
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        required: ["a"],
        additionalProperties: false,
      },
      "The schema at # is an object whose property b is not in required.",
    ],
    [object({ a: {} }), "The schema at #/properties/a is empty."],
    [
      object({ a: { description: "Free text." } }),
      "The schema at #/properties/a has no type, enum or anyOf.",
    ],
    [
      object({ a: { oneOf: [object({}), { minimum: 1 }] } }),
      "The schema at #/properties/a/oneOf/1 has no type, enum or anyOf.",
    ],
    [
      object({ "a/b": { allOf: [{ type: "string" }] } }),
      "The schema at #/properties/a~1b uses the keyword allOf, which strict mode does not accept.",
    ],
    [object({ a: { type: "array" } }), "The schema at #/properties/a is an array without items."],
    [
      object({ a: { type: "object", additionalProperties: false } }),
      "The schema at #/properties/a is an object without properties.",
    ],
  ];
  for (const [schema, message] of cases)
    assert.throws(() => strictToolWireSchema(schema), { message }, message);
});

test("a strict schema beyond the published OpenAI limits is refused", () => {
  let nested: Record<string, unknown> = object({ leaf: { type: "string" } });
  for (let level = 0; level < 9; level++) nested = object({ child: nested });
  assert.doesNotThrow(() => strictToolWireSchema(nested), "Ten levels of objects are accepted");
  assert.throws(() => strictToolWireSchema(object({ child: nested })), {
    message: `The schema at #${"/properties/child".repeat(10)} is at object level 11. Strict mode accepts 10 levels of object nesting or fewer.`,
  });

  const properties = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`p${index}`, { type: "string" }]),
    );
  assert.doesNotThrow(() => strictToolWireSchema(object(properties(5_000))));
  assert.throws(() => strictToolWireSchema(object(properties(5_001))), {
    message: "The schema at # has 5001 object properties. Strict mode accepts 5000 or fewer.",
  });

  const values = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, index) => `${prefix}${index}`);
  assert.doesNotThrow(() =>
    strictToolWireSchema(
      object({
        a: { type: "string", enum: values(500, "a") },
        b: { type: "string", enum: values(500, "b") },
      }),
    ),
  );
  assert.throws(
    () =>
      strictToolWireSchema(
        object({
          a: { type: "string", enum: values(600, "a") },
          b: { type: "string", enum: values(401, "b") },
        }),
      ),
    { message: "The schema at # has 1001 enum values. Strict mode accepts 1000 or fewer." },
  );
});

test("The coverage tool has a valid strict wire schema.", () => {
  const draft = createEvalDraft(fixtureInput);
  const { publicScene, ...publicProposal } = fixturePublic;
  const { revision } = compileEvalProposal(draft, 1, {
    ...publicProposal,
    ...fixturePrivate,
    seed: neutralRojoSeed(draft.title, publicScene),
  });
  assert.ok(revision);
  const scopes: CoverageScope[] = [
    { kind: "all" },
    { kind: "criterion", criterionId: draft.stages[0]!.criteria[0]!.id },
    { kind: "checks" },
  ];
  for (const scope of scopes) {
    const tool: ModelToolDefinition = coverageRequest(
      { id: "offline", maxOutputTokens: 16_384 },
      1,
      {
        builderPrompt: draft.stages[0]!.prompt,
        rubric: draft.stages[0]!.rubric,
        criteria: draft.stages[0]!.criteria,
        plan: coveragePlan(revision),
      },
      scope,
    ).tools[0]!;
    assert.equal(tool.strict, true);
    const wire = strictToolWireSchema(tool.parameters) as {
      properties: Record<string, { items: { properties: Record<string, unknown> } }>;
    };
    // The model writes the evidence of each entry before its values.
    for (const list of Object.values(wire.properties)) {
      const fields = Object.keys(list.items.properties);
      assert.deepEqual(fields.slice(1, 3), ["evidenceFor", "evidenceAgainst"], scope.kind);
    }
    assert.deepEqual(
      Object.keys(wire.properties),
      scope.kind === "all"
        ? ["criteria", "checks"]
        : [scope.kind === "checks" ? "checks" : "criteria"],
    );
  }
});
