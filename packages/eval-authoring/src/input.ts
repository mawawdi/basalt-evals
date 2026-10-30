import { hashJson, type EvidenceClass, type Polarity } from "../../contracts/src/index.js";
import { MAX_EVAL_STAGES } from "../../contracts/src/working-copy.js";
import {
  authoredEvidenceClass,
  authoredPolarity,
  rubricDocument,
  rubricContext,
  authoredClauses,
  type AuthoredClause,
  type RubricNode,
} from "./rubric-document.js";

/**
 * One stage as a person writes it: the prompt that the builder sees, the private success
 * criteria and the authored gate. A gate names criteria of this stage. The next stage starts
 * only when the build passes the code checks of these criteria.
 */
interface EvalStageInput {
  prompt: string;
  rubric: string;
  gateCriterionIds?: string[];
}

export interface EvalAuthoringInput {
  schema: "basalt-evals/eval-authoring-input";
  /** One to six stages in their order. An evaluation without stages has one stage. */
  stages: EvalStageInput[];
  title?: string;
}

export interface AuthoredCriterion {
  id: string;
  text: string;
  start: number;
  end: number;
  required: boolean;
  /** Set only by an `Evidence class:` metadata line of the human author. */
  evidenceClass: EvidenceClass | null;
  /** Set only by a `Polarity:` metadata line of the human author. Without a line, presence. */
  polarity: Polarity;
  contextNodeIds: string[];
  clauses: AuthoredClause[];
}

/** One authored stage with its exact hashes and its parsed criteria. */
export interface EvalDraftStage {
  prompt: string;
  rubric: string;
  promptHash: string;
  rubricHash: string;
  criteria: AuthoredCriterion[];
  document: RubricNode[];
  /** Authored criterion IDs of this stage. The last stage has none. */
  gateCriterionIds: string[];
}

export interface EvalDraft {
  schema: "basalt-evals/eval-draft";
  id: string;
  title: string;
  slug: string;
  input: EvalAuthoringInput;
  stages: EvalDraftStage[];
  status: "needs_preparation";
}

function assertText(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > 32_768 ||
    value.includes("\0")
  )
    throw new Error(label + " must contain 1 to 32,768 bytes of text.");
}

function assertEvalAuthoringInput(value: unknown): asserts value is EvalAuthoringInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Provide one or more stages, each with a prompt and success criteria.");
  const input = value as Record<string, unknown>;
  if (!["schema,stages", "schema,stages,title"].includes(Object.keys(input).sort().join(",")))
    throw new Error("Eval authoring accepts only stages and an optional title");
  if (input.schema !== "basalt-evals/eval-authoring-input")
    throw new Error("Unsupported eval authoring schema");
  if (
    !Array.isArray(input.stages) ||
    input.stages.length < 1 ||
    input.stages.length > MAX_EVAL_STAGES
  )
    throw new Error(`An evaluation needs 1 to ${MAX_EVAL_STAGES} stages.`);
  for (const [index, stage] of (input.stages as unknown[]).entries()) {
    const label = input.stages.length > 1 ? `Stage ${index + 1}: ` : "";
    if (!stage || typeof stage !== "object" || Array.isArray(stage))
      throw new Error(`${label}Provide a prompt and success criteria.`);
    const fields = stage as Record<string, unknown>;
    if (
      !["prompt,rubric", "gateCriterionIds,prompt,rubric"].includes(
        Object.keys(fields).sort().join(","),
      )
    )
      throw new Error(`${label}A stage accepts only a prompt, success criteria and a gate.`);
    assertText(fields.prompt, label + "The prompt");
    assertText(fields.rubric, label + "The success criteria");
    if (
      fields.gateCriterionIds !== undefined &&
      (!Array.isArray(fields.gateCriterionIds) ||
        fields.gateCriterionIds.some((id) => typeof id !== "string") ||
        new Set(fields.gateCriterionIds).size !== fields.gateCriterionIds.length)
    )
      throw new Error(`${label}The gate must list each criterion one time.`);
  }
  const prompts = (input.stages as EvalStageInput[]).map((stage) => stage.prompt);
  if (new Set(prompts).size !== prompts.length)
    throw new Error("Each stage needs its own prompt. Two stages have the same prompt.");
  if (
    input.title !== undefined &&
    (typeof input.title !== "string" || !input.title.trim() || input.title.length > 120)
  )
    throw new Error("The title must contain 1 to 120 characters.");
}

/** Keep exact source spans. No model is allowed to silently rewrite this authority. */
export function authoredCriteria(rubric: string): AuthoredCriterion[] {
  assertText(rubric, "The success criteria");
  const document = rubricDocument(rubric);
  const criteria = document
    .filter((node) => node.role === "requirement")
    .map((node, index) => {
      const id = "criterion-" + (index + 1);
      const contextNodeIds = rubricContext(document, node);
      // Scoped metadata applies to every requirement below it. One requirement has one value.
      const scoped = <T>(read: (text: string) => T | null) =>
        new Set(
          contextNodeIds.flatMap((contextId) => {
            const context = document.find((candidate) => candidate.id === contextId)!;
            const value = context.role === "grading_metadata" ? read(context.text) : null;
            return value ? [value] : [];
          }),
        );
      const classes = scoped(authoredEvidenceClass);
      if (classes.size > 1)
        throw new Error(
          `The criterion at characters ${node.start}–${node.end} has more than one evidence class. Keep one evidence class for each criterion.`,
        );
      const polarities = scoped(authoredPolarity);
      if (polarities.size > 1)
        throw new Error(
          `The criterion at characters ${node.start}–${node.end} has more than one polarity. Keep one polarity for each criterion.`,
        );
      return {
        id,
        text: node.text,
        start: node.start,
        end: node.end,
        required: node.required,
        evidenceClass: [...classes][0] ?? null,
        polarity: [...polarities][0] ?? "presence",
        contextNodeIds,
        clauses: authoredClauses(node.text, node.start, id),
      };
    });
  if (criteria.length > 64)
    throw new Error(
      "The success criteria contain more than 64 criteria. Use 64 criteria or fewer.",
    );
  return criteria;
}

/**
 * A gate names authored criteria of its own stage. Each one must be a required criterion, and
 * the last stage has no gate, because no stage follows it. The compiler checks later that each
 * gate criterion has a required code check.
 */
function gateCriterionIds(
  stage: EvalStageInput,
  criteria: AuthoredCriterion[],
  index: number,
  count: number,
): string[] {
  const ids = stage.gateCriterionIds ?? [];
  if (!ids.length) return [];
  const label = count > 1 ? `Stage ${index + 1}: ` : "";
  if (index === count - 1)
    throw new Error(
      `${label}The last stage cannot have a gate, because no stage comes after it. Remove the gate.`,
    );
  for (const id of ids) {
    const criterion = criteria.find((item) => item.id === id);
    if (!criterion)
      throw new Error(
        `${label}The gate names ${id}, but the success criteria of this stage have no such criterion.`,
      );
    if (!criterion.required)
      throw new Error(
        `${label}The gate names ${id}, which is optional. A gate can name only required criteria.`,
      );
  }
  // The authored order of the criteria keeps one gate list for one meaning.
  return criteria.filter((item) => ids.includes(item.id)).map((item) => item.id);
}

export function createEvalDraft(input: unknown): EvalDraft {
  assertEvalAuthoringInput(input);
  const id = hashJson(input);
  const stages = input.stages.map((stage, index): EvalDraftStage => {
    const label = input.stages.length > 1 ? `Stage ${index + 1}: ` : "";
    let criteria: AuthoredCriterion[];
    try {
      criteria = authoredCriteria(stage.rubric);
    } catch (error) {
      throw new Error(label + (error instanceof Error ? error.message : String(error)));
    }
    return {
      prompt: stage.prompt,
      rubric: stage.rubric,
      promptHash: hashJson(stage.prompt),
      rubricHash: hashJson(stage.rubric),
      criteria,
      document: rubricDocument(stage.rubric),
      gateCriterionIds: gateCriterionIds(stage, criteria, index, input.stages.length),
    };
  });
  const firstLine = stages[0]!.prompt
    .split(/\r?\n/u)
    .find((line) => line.trim())!
    .trim();
  const title = (input.title?.trim() || firstLine).slice(0, 120);
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 35)
    .replace(/-$/u, "");
  return {
    schema: "basalt-evals/eval-draft",
    id,
    title,
    slug:
      (base || "eval") +
      "-" +
      hashJson({ prompts: stages.map((stage) => stage.prompt), title }).slice(0, 8),
    input: structuredClone(input),
    stages,
    status: "needs_preparation",
  };
}
