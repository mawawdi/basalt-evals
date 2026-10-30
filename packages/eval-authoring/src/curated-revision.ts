import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { EvaluatorSpec, PublicTask } from "../../contracts/src/index.js";
import {
  compileEvalProposal,
  type CapabilityName,
  type EvalProposal,
  type EvalRevision,
  type EvalValidation,
  type EvidenceMethod,
} from "./compiler.js";
import { createEvalDraft, type EvalDraft } from "./input.js";
import type { PublicPreparation } from "./proposals.js";
import { assertPublicScene, type PublicScene } from "./seed.js";

type PublicDevelopmentRecipe = EvalProposal["publicDevelopment"];

/*
 * A curated revision for the preparation parity study. A person writes the rubric and the map
 * from each rubric criterion to the executable criteria of a task. The compiler binds the curated
 * task files to that rubric. The curated public part lets each preparation model write only the
 * private stages, so the study compares private plans for one public contract.
 */

/** The first line of a template that a person has not written yet. */
export const CURATED_DRAFT_MARKER = "<!-- basalt: draft for a person -->";

/** The map from the rubric criteria to the executable criteria of the task files. */
interface CuratedCriteriaMap {
  schema: "basalt-evals/curated-criteria-map";
  /** `approved` only after a person wrote and checked the map. */
  status: "draft" | "approved";
  note: string;
  criteria: Array<{
    authoredCriterionId: string;
    /** The exact text of the rubric criterion, without its list marker. */
    text: string;
    executableCriterionId: string;
    rationale: string;
  }>;
  requiredCapabilities: CapabilityName[];
}

/** The files of one curated task. */
export interface CuratedTaskFiles {
  task: PublicTask;
  evaluator: EvaluatorSpec;
  development: PublicDevelopmentRecipe | null;
  seed: EvalProposal["seed"];
  rubric: string;
  criteriaMap: unknown;
}

interface CuratedRevision {
  draft: EvalDraft;
  revision: EvalRevision | null;
  validation: EvalValidation;
  /** The curated public part for the preparation models, or null with the reason. */
  publicProposal: PublicPreparation | null;
  publicReason: string | null;
}

function criteriaMap(value: unknown): CuratedCriteriaMap {
  const map = value as CuratedCriteriaMap;
  if (
    !map ||
    typeof map !== "object" ||
    Array.isArray(map) ||
    Object.keys(map).sort().join(",") !== "criteria,note,requiredCapabilities,schema,status" ||
    map.schema !== "basalt-evals/curated-criteria-map" ||
    !["draft", "approved"].includes(map.status) ||
    !Array.isArray(map.criteria) ||
    !Array.isArray(map.requiredCapabilities) ||
    map.criteria.some(
      (item) =>
        !item ||
        Object.keys(item).sort().join(",") !==
          "authoredCriterionId,executableCriterionId,rationale,text" ||
        [item.authoredCriterionId, item.text, item.executableCriterionId, item.rationale].some(
          (field) => typeof field !== "string",
        ),
    )
  )
    throw new Error("The criteria map has unsupported fields");
  if (map.status !== "approved")
    throw new Error(
      "A person must write and approve the criteria map. Set its status to approved after the check.",
    );
  return map;
}

/** The text of an authored criterion without its list marker. */
function criterionText(text: string): string {
  return text.trim().replace(/^(?:[-*+] |\d+[.)] )/u, "");
}

/**
 * The public scene of a curated seed: each part of the Workspace, except the parts that Basalt
 * supplies. Null when the seed has another instance, a rotation or a property that a public scene
 * cannot hold.
 */
function curatedPublicScene(project: unknown): PublicScene | null {
  const workspace = (project as { tree?: { Workspace?: Record<string, unknown> } })?.tree
    ?.Workspace;
  if (!workspace || typeof workspace !== "object") return null;
  const parts: PublicScene["parts"] = [];
  for (const [name, node] of Object.entries(workspace)) {
    if (name.startsWith("$") || name === "Ground" || name === "EvalSpawn") continue;
    const part = node as { $className?: unknown; $properties?: Record<string, unknown> };
    const properties = part?.$properties ?? {};
    const frame = properties.CFrame,
      size = properties.Size;
    if (
      part?.$className !== "Part" ||
      Object.keys(part).some((key) => key !== "$className" && key !== "$properties") ||
      Object.keys(properties).some(
        (key) => !["Anchored", "CFrame", "Size", "CanCollide", "Transparency"].includes(key),
      ) ||
      !Array.isArray(frame) ||
      frame.length !== 12 ||
      frame.slice(3).join(",") !== "1,0,0,0,1,0,0,0,1" ||
      !Array.isArray(size) ||
      size.length !== 3
    )
      return null;
    parts.push({
      name,
      position: frame.slice(0, 3) as [number, number, number],
      size: size as [number, number, number],
      anchored: properties.Anchored === true,
      canCollide: properties.CanCollide !== false,
      transparency: typeof properties.Transparency === "number" ? properties.Transparency : 0,
    });
  }
  const scene = { parts };
  try {
    assertPublicScene(scene);
  } catch {
    return null;
  }
  return scene;
}

/**
 * Compile the curated task files into a revision. The person-written rubric is the authority of
 * each criterion. The map names the executable criterion of each rubric criterion. The compile
 * copies the exact authored passage, the evidence class and the polarity of each mapped criterion
 * from the rubric. It writes no rubric text.
 */
export function compileCuratedRevision(files: CuratedTaskFiles): CuratedRevision {
  if (files.rubric.includes(CURATED_DRAFT_MARKER))
    throw new Error(
      "A person must write the rubric of this task. Remove the draft line after a person approves the text.",
    );
  const map = criteriaMap(files.criteriaMap);
  if (!files.development)
    throw new Error(
      "The task has no development.json. A person writes the public development recipe first.",
    );
  const draft = createEvalDraft({
    schema: "basalt-evals/eval-authoring-input",
    title: files.task.title,
    stages: [{ prompt: files.task.prompt, rubric: files.rubric }],
  });
  const evaluator = structuredClone(files.evaluator);
  const lists: Array<[EvidenceMethod, Array<{ id: string; statement: string }>]> = [
    ["deterministic", evaluator.deterministic],
    ["code", evaluator.codeQuality],
    ["visual", evaluator.visual],
    ["unscaled", evaluator.unscaled],
  ];
  const criterionMappings = map.criteria.map((entry) => {
    const criterion = draft.stages[0]!.criteria.find(
      (item) => item.id === entry.authoredCriterionId,
    );
    if (!criterion || criterionText(criterion.text) !== entry.text.trim())
      throw new Error(
        `The criteria map names ${entry.authoredCriterionId} with other text than the rubric. Write the exact text of the rubric criterion.`,
      );
    const found = lists.find(([, items]) =>
      items.some((item) => item.id === entry.executableCriterionId),
    );
    if (!found)
      throw new Error(
        `The criteria map names ${entry.executableCriterionId}, which the evaluator does not have.`,
      );
    const [method, items] = found;
    const executable = items.find((item) => item.id === entry.executableCriterionId)!;
    executable.statement = criterion.text;
    if ("evidenceClass" in executable)
      Object.assign(executable, {
        evidenceClass: criterion.evidenceClass,
        polarity: criterion.polarity,
      });
    return {
      authoredCriterionId: criterion.id,
      authoredClauseIds: criterion.clauses.map((clause) => clause.id),
      authority: { source: "human_rubric" as const, start: criterion.start, end: criterion.end },
      method,
      executableCriterionId: executable.id,
      rationale: entry.rationale,
    };
  });
  const compiled = compileEvalProposal(draft, 1, {
    publicTask: files.task,
    publicDevelopment: files.development,
    privateEvaluator: evaluator,
    seed: files.seed,
    criterionMappings,
    requiredCapabilities: map.requiredCapabilities,
  });
  const publicScene = curatedPublicScene(files.seed.project);
  return {
    draft,
    ...compiled,
    publicProposal: publicScene
      ? { publicScene, stages: [{ publicTask: files.task, publicDevelopment: files.development }] }
      : null,
    publicReason: publicScene
      ? null
      : "The seed has an instance that a public scene cannot hold, so each preparation model also writes the public part.",
  };
}

/** Read the files of one curated task directory. */
export async function readCuratedTaskFiles(directory: string): Promise<CuratedTaskFiles> {
  const json = async <T>(file: string) =>
    JSON.parse(await readFile(resolve(directory, file), "utf8")) as T;
  const task = await json<PublicTask>("task.json");
  const development = await json<PublicDevelopmentRecipe>("development.json").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  const seedRoot = resolve(directory, "seed");
  const sources: Array<{ path: string; text: string }> = [];
  for (const entry of await readdir(seedRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.luau?$/u.test(entry.name)) continue;
    const path = relative(seedRoot, resolve(entry.parentPath, entry.name)).split(sep).join("/");
    if (task.seed.sourceRoots.some((root) => path.startsWith(`${root}/`)))
      sources.push({ path, text: await readFile(resolve(seedRoot, path), "utf8") });
  }
  return {
    task,
    evaluator: await json<EvaluatorSpec>("evaluator.json"),
    development,
    seed: {
      project: JSON.parse(await readFile(resolve(seedRoot, task.seed.projectFile), "utf8")),
      sources: sources.sort((a, b) => a.path.localeCompare(b.path)),
    },
    rubric: await readFile(resolve(directory, "rubric.md"), "utf8"),
    criteriaMap: await json<unknown>("criteria-map.json"),
  };
}
