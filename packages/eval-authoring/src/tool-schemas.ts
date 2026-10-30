import {
  EVALUATOR_SCHEMA,
  FACT_FIELD_NAMES,
  MAX_STUDIO_SCENARIO_DURATION_MS,
  NUMBER_FIELD_NAMES,
} from "../../contracts/src/index.js";
import {
  HUMANOID_STATES,
  SOURCE_LINT_CODES,
  STUDIO_CAPABILITY_CATALOG,
} from "../../contracts/src/capabilities.js";

type Schema = Record<string, unknown>;
const string = { type: "string" };
const integer = { type: "integer" };
const number = { type: "number" };
const boolean = { type: "boolean" };
const scoreRangeSchema = {
  anyOf: [
    {
      type: "object",
      properties: { minimum: number, maximum: number, step: { anyOf: [number, { type: "null" }] } },
      required: ["minimum", "maximum", "step"],
      additionalProperties: false,
    },
    { type: "null" },
  ],
};
const factField = { type: "string", enum: [...FACT_FIELD_NAMES] };
const numberField = { type: "string", enum: [...NUMBER_FIELD_NAMES] };
const primitive = { anyOf: [string, number, boolean, { type: "null" }] };
const transitionId = {
  type: "string",
  pattern: "^[a-z][a-z0-9-]{0,63}$",
  description:
    "Unique capture-anchor label, independent of scenario step IDs. The source binds the measured event.",
};
const strings = { type: "array", items: string };
const variant = (kind: string, fields: Record<string, Schema> = {}) => ({
  type: "object",
  properties: { kind: { type: "string", enum: [kind] }, ...fields },
  required: ["kind", ...Object.keys(fields)],
  additionalProperties: false,
});
const variants = (...members: Schema[]) => ({ oneOf: members });
const array = (items: Schema, bounds: { minItems?: number; maxItems?: number } = {}) => ({
  type: "array",
  items,
  ...bounds,
});

export const roleSchema = {
  type: "object",
  properties: {
    id: string,
    className: {
      type: "string",
      enum: [...STUDIO_CAPABILITY_CATALOG.roleClasses],
    },
    scope: { type: "string", enum: ["workspace", "replicated_storage", "local_player_gui"] },
    cardinality: { type: "string", enum: ["exactly_one", "zero_or_one"] },
  },
  required: ["id", "className", "scope", "cardinality"],
  additionalProperties: false,
};

export const studioFactSchema = variants(
  ...[
    "instance",
    "instance_name",
    "instance_value",
    "gui_text",
    "gui_geometry",
    "part_position",
    "part_physics",
    "particle_state",
  ].map((kind) => variant(kind, { id: string, path: string })),
  variant("part_motion", {
    id: string,
    path: string,
    sampleCount: { type: "integer", minimum: 1, maximum: 480 },
    intervalMs: { type: "integer", minimum: 1, maximum: 60_000 },
  }),
  variant("actor_part_motion", {
    id: string,
    actor: string,
    path: string,
    sampleCount: { type: "integer", minimum: 1, maximum: 480 },
    intervalMs: { type: "integer", minimum: 1, maximum: 60_000 },
  }),
  variant("actor_part_support", { id: string, actor: string, path: string }),
  variant("part_physics_trace", {
    id: string,
    path: string,
    durationMs: { type: "integer", minimum: 1, maximum: 600_000 },
  }),
  variant("part_route_trace", {
    id: string,
    path: string,
    startPath: string,
    endPath: string,
    durationMs: { type: "integer", minimum: 1, maximum: 600_000 },
    proximityStuds: { type: "number", minimum: 0.1, maximum: 50 },
  }),
  variant("replication_probe", { id: string, path: string, attribute: string }),
  variant("actor_health", { id: string, actor: string }),
  variant("player_count", { id: string }),
  variant("diagnostics", { id: string }),
  variant("performance_trace", {
    id: string,
    sampleCount: { type: "integer", minimum: 1, maximum: 480 },
    intervalMs: { type: "integer", minimum: 250, maximum: 60_000 },
  }),
  variant("gui_layout", { id: string, path: string }),
);

export const studioActionSchema = variants(
  variant("wait"),
  variant("move_to", { actor: string, targetPath: string }),
  variant("place_on_part", { actor: string, targetPath: string }),
  variant("place_relative_to_part", {
    actor: string,
    targetPath: string,
    offsetStuds: {
      type: "array",
      items: { type: "number", minimum: -10000, maximum: 10000 },
      minItems: 3,
      maxItems: 3,
    },
  }),
  variant("move_relative_to_part", {
    actor: string,
    targetPath: string,
    offsetStuds: {
      type: "array",
      items: { type: "number", minimum: -10000, maximum: 10000 },
      minItems: 3,
      maxItems: 3,
    },
  }),
  variant("probe_barrier", { actor: string, barrierPath: string }),
  variant("press_key", { actor: string, key: { type: "string", enum: ["E"] } }),
  variant("hold_key", {
    actor: string,
    key: { type: "string", enum: ["E", "F", "Space"] },
    durationMs: { type: "integer", minimum: 50, maximum: 5000 },
  }),
  variant("gui_activate", { actor: string, path: string }),
  variant("gui_text_entry", { actor: string, path: string, text: string }),
  variant("fire_remote", {
    actor: string,
    path: string,
    arguments: array(
      variants(
        variant("literal", { value: { anyOf: [string, number, boolean] } }),
        variant("actor_user_id", { actor: string }),
      ),
    ),
  }),
  variant("disconnect", { actor: string }),
);

/** Platform-observable anchors only. No kind reads a candidate attribute or value. */
const studioAnchorFactSchema = variants(
  variant("humanoid_state", {
    actor: string,
    state: { type: "string", enum: [...HUMANOID_STATES] },
  }),
  variant("character_on_part", { actor: string, path: string }),
  variant("character_near_part", {
    actor: string,
    path: string,
    radiusStuds: { type: "number", minimum: 0.1, maximum: 50 },
  }),
  variant("gui_visible", { path: string, visible: boolean }),
  variant("instance_present", { path: string, present: boolean }),
  variant("part_can_collide", { path: string, value: boolean }),
  variant("part_anchored", { path: string, value: boolean }),
);

const studioStepTimingSchema = variants(
  {
    type: "object",
    properties: {
      startMs: {
        type: "integer",
        minimum: 0,
        description:
          "Offset from the shared scenario start. Use it only for a rubric claim about time from that start.",
      },
    },
    required: ["startMs"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      after: variants(
        {
          type: "object",
          properties: {
            step: {
              ...string,
              description: "ID of an earlier step. Its completion is the anchor.",
            },
          },
          required: ["step"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            fact: studioAnchorFactSchema,
            scope: {
              ...string,
              description:
                "server or an actor in reportContexts. The first sighting in that context schedules the step.",
            },
          },
          required: ["fact", "scope"],
          additionalProperties: false,
        },
      ),
      offsetMs: {
        type: "integer",
        minimum: 0,
        description: "Delay from the anchor to the step. Use 0 unless the plan needs a pause.",
      },
    },
    required: ["after", "offsetMs"],
    additionalProperties: false,
  },
);

const studioDriverSchema = variants(
  variant("manual"),
  variant("wait_for_session", { timeoutMs: { type: "integer", minimum: 1, maximum: 60_000 } }),
  variant("wait_for_fact", { readyFactId: string, readyValue: string, timeoutMs: integer }),
  variant("wait_for_exists", { readyFactId: string, timeoutMs: integer }),
  variant("observe_from_actor", { targetPath: string, timeoutMs: integer }),
  variant("gui_button", {
    path: string,
    readyFactId: string,
    readyValue: string,
    timeoutMs: integer,
  }),
  variant("character_move_to", {
    targetPath: string,
    readyFactId: string,
    readyValue: string,
    timeoutMs: integer,
  }),
  variant("character_reach_part", { targetPath: string, timeoutMs: integer }),
);

export const studioPlanSchema = {
  type: "object",
  properties: {
    schema: { type: "string", enum: [STUDIO_CAPABILITY_CATALOG.planSchema] },
    clients: { type: "integer", minimum: 1, maximum: 8 },
    actors: { ...strings, minItems: 1, maxItems: 8, uniqueItems: true },
    roles: array(roleSchema, { maxItems: 64 }),
    scenarios: array(
      {
        type: "object",
        properties: {
          id: string,
          label: string,
          durationMs: {
            type: "integer",
            minimum: 1,
            maximum: MAX_STUDIO_SCENARIO_DURATION_MS,
            description: "Outer observation budget. No step starts after it ends.",
          },
          reportContexts: {
            ...strings,
            minItems: 1,
            maxItems: 9,
            uniqueItems: true,
            contains: { const: "server" },
          },
          steps: array(
            {
              type: "object",
              properties: {
                id: string,
                at: studioStepTimingSchema,
                horizonMs: {
                  type: "integer",
                  minimum: 1,
                  maximum: 60_000,
                  description:
                    "How long the runner looks for the anchor. Expiry means not observed, not failure.",
                },
                holdMs: {
                  type: "integer",
                  minimum: 0,
                  maximum: 59_999,
                  description:
                    "How long a fact anchor must hold before it counts. Use 0 for other anchors.",
                },
                action: studioActionSchema,
                observations: array(
                  {
                    type: "object",
                    properties: { context: string, fact: studioFactSchema },
                    required: ["context", "fact"],
                    additionalProperties: false,
                  },
                  { maxItems: 64 },
                ),
                requirement: {
                  type: "null",
                  description:
                    "Always null. Only a person adds a pass/fail time bound from rubric text.",
                },
              },
              required: [
                "id",
                "at",
                "horizonMs",
                "holdMs",
                "action",
                "observations",
                "requirement",
              ],
              additionalProperties: false,
            },
            { minItems: 1, maxItems: 256 },
          ),
        },
        required: ["id", "label", "durationMs", "reportContexts", "steps"],
        additionalProperties: false,
      },
      { maxItems: 32 },
    ),
    phases: array(
      {
        type: "object",
        properties: {
          id: string,
          label: string,
          instruction: string,
          driver: studioDriverSchema,
          facts: array(studioFactSchema),
          captures: array({
            type: "object",
            properties: { id: string, instruction: string },
            required: ["id", "instruction"],
            additionalProperties: false,
          }),
        },
        required: ["id", "label", "instruction", "driver", "facts", "captures"],
        additionalProperties: false,
      },
      { minItems: 1 },
    ),
  },
  required: ["schema", "clients", "actors", "roles", "scenarios", "phases"],
  additionalProperties: false,
};

const transitionWindows = {
  effectWindowMs: {
    ...integer,
    description: "Milliseconds over which the effect plays after the anchor.",
  },
  holdMs: {
    ...integer,
    description: "Milliseconds that the result must hold after the effect window.",
  },
};
const transitionSchema = variants(
  {
    type: "object",
    properties: {
      id: transitionId,
      source: variant("state", {
        context: string,
        path: string,
        attribute: string,
        from: primitive,
        to: primitive,
      }),
      ...transitionWindows,
    },
    required: ["id", "source", "effectWindowMs", "holdMs"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      id: transitionId,
      source: variant("action", {
        stepId: {
          ...string,
          description: "Exact ID of a non-wait action in this view's scenario.",
        },
      }),
      ...transitionWindows,
    },
    required: ["id", "source", "effectWindowMs", "holdMs"],
    additionalProperties: false,
  },
);

const vector = { type: "array", items: number, minItems: 3, maxItems: 3 };
const camera = {
  type: "object",
  properties: { position: vector, lookAt: vector },
  required: ["position", "lookAt"],
  additionalProperties: false,
};
const viewport = {
  type: "object",
  properties: { width: integer, height: integer },
  required: ["width", "height"],
  additionalProperties: false,
};
export const sequenceViewSchema = {
  type: "object",
  properties: {
    scenarioId: string,
    requiredTransitions: array(transitionSchema, { maxItems: 16 }),
    camera: { anyOf: [camera, { type: "null" }] },
    viewport: { anyOf: [viewport, { type: "null" }] },
    maximumGapMs: {
      ...integer,
      description: "Largest unrecorded interval between consecutive frames of a transition.",
    },
    frameBudget: {
      ...integer,
      description:
        "Largest number of sequence frames in one judgment, at most 64. The transition frames must fit.",
    },
  },
  required: [
    "scenarioId",
    "requiredTransitions",
    "camera",
    "viewport",
    "maximumGapMs",
    "frameBudget",
  ],
  additionalProperties: false,
};
export const developmentViewSchema = {
  ...sequenceViewSchema,
  properties: { id: string, ...sequenceViewSchema.properties },
  required: ["id", ...sequenceViewSchema.required],
};

const anchorSchema = {
  type: "object",
  properties: { score: number, label: string, description: string },
  required: ["score", "label", "description"],
  additionalProperties: false,
};
const sourceSelectionSchema = variants(
  variant("all_luau_in_roots", { roots: strings }),
  variant("exact_files", { paths: strings }),
);
const criterion = (fields: Record<string, Schema>) => ({
  type: "object",
  properties: { id: string, statement: string, required: boolean, ...fields },
  required: ["id", "statement", "required", ...Object.keys(fields)],
  additionalProperties: false,
});

const observationBindingSchema = variants(
  {
    type: "object",
    properties: { phaseId: string, factId: string },
    required: ["phaseId", "factId"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: {
      scenarioId: string,
      stepId: string,
      context: string,
      factId: string,
    },
    required: ["scenarioId", "stepId", "context", "factId"],
    additionalProperties: false,
  },
);

const rule = (kind: string, fields: Record<string, Schema>) => variant(kind, fields);
const deterministicRuleSchema = variants(
  rule("path_exists", { path: string }),
  rule("source_contains", { path: string, text: string, caseSensitive: boolean }),
  rule("fact_equals", { phaseId: string, factId: string, field: factField, expected: primitive }),
  rule("fact_contains", {
    phaseId: string,
    factId: string,
    field: { type: "string", enum: ["text"] },
    text: string,
    caseSensitive: boolean,
  }),
  rule("number_in_range", {
    phaseId: string,
    factId: string,
    field: numberField,
    minimum: number,
    maximum: number,
  }),
  rule("diagnostics_empty", { phaseId: string, factId: string }),
  rule("capture_present", { phaseId: string, captureId: string }),
  rule("scenario_action_succeeded", { scenarioId: string, stepId: string, actor: string }),
  rule("scenario_barrier_passage", {
    scenarioId: string,
    stepId: string,
    actor: string,
    expected: { type: "string", enum: ["blocked", "passed"] },
  }),
  rule("scenario_fact_equals", {
    scenarioId: string,
    stepId: string,
    context: string,
    factId: string,
    field: factField,
    expected: primitive,
  }),
  rule("scenario_fact_supports_value", {
    scenarioId: string,
    stepId: string,
    context: string,
    factId: string,
    field: factField,
    expected: primitive,
  }),
  rule("scenario_fact_equals_actor_user_id", {
    scenarioId: string,
    stepId: string,
    context: string,
    factId: string,
    actor: string,
  }),
  rule("scenario_number_delta_in_range", {
    scenarioId: string,
    context: string,
    fromStepId: string,
    fromFactId: string,
    toStepId: string,
    toFactId: string,
    field: numberField,
    minimum: number,
    maximum: number,
  }),
  rule("scenario_cross_context_equals", {
    scenarioId: string,
    stepId: string,
    factId: string,
    field: factField,
    contexts: strings,
  }),
  rule("source_lint_absent", {
    codes: array(
      { type: "string", enum: [...SOURCE_LINT_CODES] },
      {
        minItems: 1,
        maxItems: 16,
      },
    ),
  }),
  rule("build_errors_absent", {
    facts: array(observationBindingSchema, { minItems: 1, maxItems: 16 }),
  }),
);

export const privateEvaluatorSchema = {
  type: "object",
  properties: {
    schema: { type: "string", enum: [EVALUATOR_SCHEMA] },
    task: {
      type: "object",
      properties: { slug: string },
      required: ["slug"],
      additionalProperties: false,
    },
    studio: studioPlanSchema,
    sequence: { anyOf: [sequenceViewSchema, { type: "null" }] },
    deterministic: array({
      type: "object",
      properties: {
        id: string,
        layer: { type: "string", enum: ["static", "engine"] },
        statement: string,
        required: boolean,
        rule: deterministicRuleSchema,
      },
      required: ["id", "layer", "statement", "required", "rule"],
      additionalProperties: false,
    }),
    codeQuality: array(
      criterion({
        sourceSelection: sourceSelectionSchema,
        scoreRange: scoreRangeSchema,
        anchors: array(anchorSchema),
        minimumPassingScore: { anyOf: [number, { type: "null" }] },
      }),
    ),
    visual: array(
      criterion({
        captureIds: strings,
        sequence: boolean,
        scoreRange: scoreRangeSchema,
        anchors: array(anchorSchema),
        minimumPassingScore: { anyOf: [number, { type: "null" }] },
      }),
    ),
    unscaled: array({
      type: "object",
      properties: {
        id: string,
        evidence: {
          type: "object",
          properties: {
            sourceSelection: { anyOf: [sourceSelectionSchema, { type: "null" }] },
            actions: array({
              type: "object",
              properties: { scenarioId: string, stepId: string, context: string },
              required: ["scenarioId", "stepId", "context"],
              additionalProperties: false,
            }),
            facts: array(observationBindingSchema),
            captureIds: strings,
            sequence: boolean,
          },
          required: ["sourceSelection", "facts", "actions", "captureIds", "sequence"],
          additionalProperties: false,
        },
      },
      required: ["id", "evidence"],
      additionalProperties: false,
    }),
    humanReview: strings,
  },
  required: [
    "schema",
    "task",
    "studio",
    "sequence",
    "deterministic",
    "codeQuality",
    "visual",
    "unscaled",
    "humanReview",
  ],
  additionalProperties: false,
};

export const criterionMappingsSchema = (authorityIds: string[]) =>
  array({
    type: "object",
    properties: {
      authorityId: { type: "string", enum: authorityIds },
      authoredClauseIds: array(string),
      method: { type: "string", enum: ["deterministic", "code", "visual", "unscaled", "human"] },
      executableCriterionId: { anyOf: [string, { type: "null" }] },
      rationale: string,
    },
    required: ["authorityId", "authoredClauseIds", "method", "executableCriterionId", "rationale"],
    additionalProperties: false,
  });

export const capabilitiesSchema = array({
  type: "string",
  enum: [...STUDIO_CAPABILITY_CATALOG.supported, ...STUDIO_CAPABILITY_CATALOG.unavailable],
});
