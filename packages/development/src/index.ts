import { inventoryTree } from "../../artifact-store/src/inventory.js";
import { resolve } from "node:path";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { assertExactRecordKeys } from "../../contracts/src/validation.js";
import {
  assertPublicTask,
  assertStudioSequenceView,
  SEQUENCE_VIEW_FIELDS,
  studioSequenceView,
  type StudioSequenceView,
  assertStudioCollectionPlan,
  hashJson,
  isSafeRelativePath,
  type PublicTask,
  type StudioCollectionPlan,
} from "../../contracts/src/index.js";

export interface PublicDevelopmentRecipe {
  schema: "basalt-evals/public-development";
  task: { slug: string };
  plan: StudioCollectionPlan;
  views: Array<StudioSequenceView & { id: string }>;
}

/** Exact, independent public authoring; no evaluator, rubric or holdout fields. */
export function assertPublicDevelopmentRecipe(
  value: unknown,
  task: PublicTask,
): asserts value is PublicDevelopmentRecipe {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Public development recipe must be an object");
  const recipe = value as Record<string, unknown>;
  assertExactRecordKeys(recipe, ["plan", "schema", "task", "views"], "publicDevelopment fields");
  if (
    recipe.schema !== "basalt-evals/public-development" ||
    !recipe.task ||
    typeof recipe.task !== "object" ||
    Array.isArray(recipe.task)
  )
    throw new Error("Public development recipe requires its current schema and task object");
  const identity = recipe.task as Record<string, unknown>;
  assertExactRecordKeys(identity, ["slug"], "publicDevelopment.task fields");
  if (identity.slug !== task.slug)
    throw new Error("Public development recipe binds a different task");
  assertStudioCollectionPlan(recipe.plan);
  if (hashJson(recipe.plan.roles) !== hashJson(task.roles))
    throw new Error("Public development roles differ from the public task contract");
  if (!Array.isArray(recipe.views) || recipe.views.length < 1 || recipe.views.length > 8)
    throw new Error("Public development recipe needs one to eight views");
  const plan = recipe.plan;
  const ids = new Set<string>();
  for (const raw of recipe.views) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid public development view");
    const view = raw as Record<string, unknown>;
    assertExactRecordKeys(
      view,
      ["id", ...SEQUENCE_VIEW_FIELDS],
      "publicDevelopment.views entry fields",
    );
    if (
      typeof view.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(view.id) ||
      ids.has(view.id) ||
      typeof view.scenarioId !== "string"
    )
      throw new Error("Public development views require distinct registered IDs");
    ids.add(view.id);
    assertStudioSequenceView(studioSequenceView(view as unknown as StudioSequenceView), plan);
  }
}

export async function loadPublicDevelopmentTask(
  root: string,
  directory: string,
): Promise<{
  task: PublicTask;
  recipe: PublicDevelopmentRecipe;
  taskHash: string;
  recipeHash: string;
  seedHash: string;
}> {
  if (!isSafeRelativePath(directory)) throw new Error("Unsafe public task directory");
  const base = resolve(root, directory);
  const task = JSON.parse(
    (await readBoundedRegularFile(resolve(base, "task.json"), 256 * 1024, "public task")).toString(
      "utf8",
    ),
  ) as unknown;
  assertPublicTask(task);
  const recipe = JSON.parse(
    (
      await readBoundedRegularFile(
        resolve(base, "development.json"),
        256 * 1024,
        "public development recipe",
      )
    ).toString("utf8"),
  ) as unknown;
  assertPublicDevelopmentRecipe(recipe, task);
  const seed = await inventoryTree(resolve(base, "seed"));
  if (!seed.some((file) => file.path === task.seed.projectFile))
    throw new Error("Public development seed lacks the declared project");
  return {
    task,
    recipe,
    taskHash: hashJson(task),
    recipeHash: hashJson(recipe),
    seedHash: hashJson(seed),
  };
}
