import { hashJson, stableJson } from "../../contracts/src/index.js";
import type { ModelTurnRequest } from "../../model-client/src/contracts.js";
import type { EvalRevision } from "./compiler.js";
import { controlOutcomeSchema, type ControlSpec } from "./control-specs.js";

/**
 * The request for one control source. A control of a later stage starts from `startingFiles`:
 * the source tree of the working control of the stage before. Only a later stage adds its text,
 * so the request of stage 1 and of an evaluation without stages keeps its bytes.
 */
export function controlSourceRequest(
  configuration: { model: string; seed: number; maxOutputTokens: number },
  input: {
    revision: EvalRevision;
    spec: ControlSpec;
    attempt: number;
    diagnostics: string[];
    workingFiles: Array<{ path: string; text: string }> | null;
    /** Null for stage 1. */
    startingFiles: Array<{ path: string; text: string }> | null;
  },
): ModelTurnRequest {
  const later = input.revision.stage.index > 1;
  if (later !== (input.startingFiles !== null))
    throw new Error("Only a control of a later stage starts from starting files");
  if (
    Buffer.byteLength(stableJson(input.diagnostics), "utf8") > 64 * 1024 ||
    Buffer.byteLength(stableJson(input.workingFiles), "utf8") > 4 * 1024 * 1024 ||
    Buffer.byteLength(stableJson(input.startingFiles), "utf8") > 4 * 1024 * 1024
  )
    throw new Error("Control material exceeds its quoted request bound");
  const expectedSchema = controlOutcomeSchema(input.revision);
  const requiredDeterministicIds = expectedSchema.required;
  return {
    model: configuration.model,
    seed:
      configuration.seed + input.attempt + Number.parseInt(hashJson(input.spec).slice(0, 6), 16),
    system:
      "You implement private Roblox eval controls outside the evaluated builder treatment. " +
      "Return only regular Luau source files under src/server, src/client, or src/shared. " +
      "Implement the exact public task and private human criteria for working and alternative controls. " +
      "For a negative, target the named criterion and declare every coupled deterministic failure or abstention before execution. " +
      "For fact_equals and scenario_fact_equals, a healthy observed field differing from the expectation is rejected. Confirmed missing roles can violate an explicit exists=true requirement; dependent name, false, zero and empty-value comparisons have insufficient evidence. Never turn a missing object into an observed empty name. If a prior signed trial reports a different actual outcome, revise the declared coupled outcome unless the new source changes that behavior. " +
      "Return the complete implementation source tree, not a patch. " +
      "Public semantic roles are executable contracts: tag each required instance with its role id using CollectionService, and satisfy its class, scope, and cardinality. Preserve those bindings in a valid alternative; change one only when a negative specifically targets that binding. " +
      "The alternative must be structurally different yet valid. The supplied working source is a reference for public bindings, not a file to copy unchanged. State the intended semantic contrast and validity basis outside expectedDeterministic. expectedDeterministic must contain only the named required deterministic criterion IDs, each with exactly verified, rejected, or incomplete; when there are none, submit {} even if unscaled human criteria exist. Place all explanations in contrast or basis. Do not add human review, coupled-claim, or observation fields to that map. Do not change the evaluator, seed, rubric, or runner." +
      (later
        ? " This control is for a later stage of a staged evaluation. earlierPrompts list the builder prompts of the earlier stages. startingFiles hold the source tree of the accepted working control of the stage before, which implements every earlier stage. Each control of this stage starts from startingFiles: keep the behavior of the earlier stages, and implement this stage on top of it. A returned file replaces the starting file at the same path, and a starting file that you do not return stays unchanged."
        : ""),
    messages: [
      {
        role: "user",
        content: stableJson({
          builderPrompt: input.revision.authored.builderPrompt,
          humanRubric: input.revision.authored.rubric,
          criteria: input.revision.authored.criteria,
          publicRoles: input.revision.publicTask.roles,
          privateEvaluator: input.revision.privateEvaluator,
          requiredDeterministicCriterionIds: requiredDeterministicIds,
          control: input.spec,
          attempt: input.attempt,
          diagnostics: input.diagnostics,
          ...(input.spec.kind !== "working" ? { workingFiles: input.workingFiles } : {}),
          ...(later
            ? {
                earlierPrompts: input.revision.stage.earlierPrompts,
                startingFiles: input.startingFiles,
              }
            : {}),
        }),
      },
    ],
    tools: [
      {
        name: "submit_control_source",
        description: later
          ? "Submit only the Luau source files for this one private control. Each file replaces the starting file at the same path."
          : "Submit only the Luau source files for this one private control.",
        parameters: {
          type: "object",
          properties: {
            files: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  text: { type: "string" },
                },
                required: ["path", "text"],
                additionalProperties: false,
              },
            },
            contrast: { type: "string" },
            basis: { type: "string" },
            expectedDeterministic: expectedSchema,
          },
          required: ["files", "contrast", "basis", "expectedDeterministic"],
          additionalProperties: false,
        },
      },
    ],
    maxOutputTokens: configuration.maxOutputTokens,
  };
}
