import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertHarnessDefinition,
  assertStudyDefinition,
  compareCodeUnits,
  hashJson,
  isHarnessId,
  type HarnessDefinition,
  type StudyDefinition,
} from "../../contracts/src/index.js";
import { isRecord } from "../../contracts/src/validation.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { loadNotesPack } from "../../agent-runtime/src/notes.js";
import { openRouterModelClientDescriptor } from "../../model-client/src/openrouter-ai-sdk.js";

type OperatorConfig = Pick<StudyDefinition, "models" | "seed" | "environment"> & {
  schema: "basalt-evals/operator-config";
  /** The tool set of a new run and of a repair. A person changes it in this file. */
  defaultHarnessId: string;
};

/** The registered harnesses of `studies/harnesses/`, in file-name order. */
export interface HarnessRegistry {
  harnesses: HarnessDefinition[];
  defaultHarnessId: string;
}

const HARNESS_DIRECTORY = "studies/harnesses";

function operatorConfig(input: unknown): OperatorConfig {
  if (!isRecord(input)) throw new Error("Invalid operator configuration");
  if (Object.keys(input).sort().join(",") !== "defaultHarnessId,environment,models,schema,seed")
    throw new Error("Invalid operator configuration fields");
  if (
    input.schema !== "basalt-evals/operator-config" ||
    !Array.isArray(input.models) ||
    !isHarnessId(input.defaultHarnessId)
  )
    throw new Error("Invalid operator configuration");
  return input as OperatorConfig;
}

/**
 * Read each harness file. A file is a harness definition whose `notesPack` names a pack of
 * `studies/notes/`. The registry replaces the name with the content hash of that pack.
 */
export async function readHarnessRegistry(root: string): Promise<HarnessRegistry> {
  const files = new RepositoryFiles(root);
  const config = operatorConfig(await files.json("studies/operator-config.json"));
  const names = (await readdir(resolve(files.root, HARNESS_DIRECTORY), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort(compareCodeUnits);
  const harnesses: HarnessDefinition[] = [];
  for (const name of names) {
    const value = await files.json<unknown>(`${HARNESS_DIRECTORY}/${name}`);
    if (!isRecord(value) || `${String(value.id)}.json` !== name)
      throw new Error(`The harness file ${name} must hold the harness with the ID of its name`);
    if (value.notesPack !== null && !isHarnessId(value.notesPack))
      throw new Error(`The harness ${name} must name an API notes pack, or use null`);
    const pack = value.notesPack === null ? null : await loadNotesPack(root, value.notesPack);
    const harness = {
      ...value,
      notesPack: pack ? { id: pack.manifest.id, hash: pack.hash } : null,
    };
    assertHarnessDefinition(harness);
    harnesses.push(harness);
  }
  if (!harnesses.some((harness) => harness.id === config.defaultHarnessId))
    throw new Error("The default harness of the operator configuration is not registered");
  return { harnesses, defaultHarnessId: config.defaultHarnessId };
}

/** The registered harnesses of a selection, in the order of the selection. */
export function selectedHarnesses(registry: HarnessRegistry, ids: string[]): HarnessDefinition[] {
  return ids.map((id) => {
    const harness = registry.harnesses.find((item) => item.id === id);
    if (!harness)
      throw new Error(
        `The tool set ${id} is not registered. Choose a tool set from the run setup.`,
      );
    return harness;
  });
}

/** Turn the declarative model configuration and the harness registry into a frozen study. */
export function operatorStudyTemplate(
  input: unknown,
  harnesses: HarnessDefinition[],
  taskDirectories: string[],
): StudyDefinition {
  const config = operatorConfig(input);
  const study: StudyDefinition = {
    schema: "basalt-evals/study",
    id: "operator-template",
    title: "Registered evals",
    hypothesis: "Registered tasks compare builder harnesses before independent Studio evaluation.",
    taskDirectories,
    models: config.models,
    transportConfigurationHash: hashJson(
      openRouterModelClientDescriptor(config.models.map((model) => model.id)),
    ),
    harnesses,
    repetitions: 3,
    seed: config.seed,
    environment: config.environment,
  };
  assertStudyDefinition(study);
  return study;
}

/** Read the operator configuration and the harness registry of a repository. */
export async function readOperatorStudy(
  root: string,
  taskDirectories: string[],
): Promise<StudyDefinition> {
  return operatorStudyTemplate(
    await new RepositoryFiles(root).json("studies/operator-config.json"),
    (await readHarnessRegistry(root)).harnesses,
    taskDirectories,
  );
}

/** The default harness of the operator configuration: the tool set of new runs and repairs. */
export async function defaultHarness(root: string): Promise<HarnessDefinition> {
  const registry = await readHarnessRegistry(root);
  return selectedHarnesses(registry, [registry.defaultHarnessId])[0]!;
}
