import { inventoryTree } from "../../artifact-store/src/inventory.js";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import {
  TREATMENT_SCHEMA,
  assertEvaluatorSpec,
  assertFrozenStudy,
  assertPublicTask,
  assertStudyDefinition,
  contentHash,
  hashJson,
  isSafeRelativePath,
  type FrozenStudy,
  type RegisteredTask,
  type StudyDefinition,
  type Treatment,
} from "../../contracts/src/index.js";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_SEED_FILE_BYTES = 2 * 1024 * 1024;

/** Discover registered task directories; fixture/project discovery has different semantics. */
export async function discoverTaskDirectories(repositoryRoot: string): Promise<string[]> {
  const directories: string[] = [];
  for (const entry of await readdir(resolve(repositoryRoot, "tasks/pilot"), {
    withFileTypes: true,
  })) {
    if (entry.isSymbolicLink()) throw new Error(`Symlink in pilot task root: ${entry.name}`);
    if (entry.isDirectory()) directories.push(`tasks/pilot/${entry.name}`);
  }
  for (const entry of await readdir(resolve(repositoryRoot, "studies"), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Symlink in study root: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const directory = `studies/${entry.name}/task`;
    try {
      const metadata = await lstat(resolve(repositoryRoot, directory));
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error(`Invalid study task directory: ${directory}`);
      directories.push(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // Generated evals are checked at registration against their exact compiler
  // and runner inputs. Historical runs remain inspectable but are not active
  // fixture definitions for the default task validation command.
  return directories.sort();
}

export async function loadRegisteredTask(
  repositoryRoot: string,
  taskDirectory: string,
): Promise<RegisteredTask> {
  if (!isSafeRelativePath(taskDirectory)) throw new Error("Task directory must be root-relative");
  const root = resolve(repositoryRoot);
  const directory = within(root, taskDirectory);
  await assertDirectory(directory, "task directory");
  const task = await readJson(`${directory}/task.json`, assertPublicTask);
  const evaluator = await readJson(`${directory}/evaluator.json`, assertEvaluatorSpec);
  if (evaluator.task.slug !== task.slug)
    throw new Error(`Evaluator identity does not match ${task.slug}`);
  if (hashJson(evaluator.studio.roles) !== hashJson(task.roles))
    throw new Error(`Evaluator roles differ from the public contract for ${task.slug}`);
  const seedDirectory = `${directory}/seed`;
  const seedFiles = await inventoryTree(seedDirectory);
  if (seedFiles.length === 0) throw new Error(`Task ${task.slug} has an empty seed tree`);
  if (!seedFiles.some((file) => file.path === task.seed.projectFile))
    throw new Error(`Task ${task.slug} seed is missing ${task.seed.projectFile}`);
  for (const sourceRoot of task.seed.sourceRoots) {
    if (!seedFiles.some((file) => file.path.startsWith(`${sourceRoot}/`)))
      throw new Error(`Task ${task.slug} seed is missing source root ${sourceRoot}`);
  }
  for (const criterion of evaluator.codeQuality) {
    const sourcePaths =
      criterion.sourceSelection.kind === "exact_files"
        ? criterion.sourceSelection.paths
        : criterion.sourceSelection.roots;
    for (const sourcePath of sourcePaths) {
      if (
        !task.seed.sourceRoots.some(
          (sourceRoot) => sourcePath === sourceRoot || sourcePath.startsWith(`${sourceRoot}/`),
        )
      )
        throw new Error(
          `Code-quality criterion ${criterion.id} references source outside declared roots`,
        );
    }
  }
  const publicTaskHash = hashJson(task);
  const evaluatorHash = hashJson(evaluator);
  const seedHash = hashJson(seedFiles);
  const id = `${task.slug}:${publicTaskHash.slice(0, 12)}`;
  return {
    id,
    directory: taskDirectory,
    publicTask: task,
    evaluator,
    publicTaskHash,
    evaluatorHash,
    seedHash,
    collectionPlanHash: hashJson(evaluator.studio),
  };
}

export async function freezeStudy(input: {
  repositoryRoot: string;
  study: StudyDefinition;
  implementationCommit: string;
  dirty: boolean;
  connectorSourceHash: string;
  connectorArtifactHash: string;
  frozenAt?: string;
}): Promise<FrozenStudy> {
  assertStudyDefinition(input.study);
  const tasks: RegisteredTask[] = [];
  for (const directory of input.study.taskDirectories) {
    tasks.push(await loadRegisteredTask(input.repositoryRoot, directory));
  }
  assertUnique(
    tasks.map((task) => task.id),
    "task IDs",
  );
  assertUnique(
    input.study.models.map((model) => model.id),
    "model IDs",
  );
  assertUnique(
    input.study.harnesses.map((harness) => harness.id),
    "harness IDs",
  );

  const studyHash = hashJson(input.study);
  const treatments: Treatment[] = [];
  let ordinal = 0;
  for (const task of tasks) {
    for (const model of input.study.models) {
      for (const harness of input.study.harnesses) {
        for (let repetition = 1; repetition <= input.study.repetitions; repetition += 1) {
          ordinal += 1;
          const treatmentBody = {
            ordinal,
            studyHash,
            task: {
              id: task.id,
              publicTaskHash: task.publicTaskHash,
              evaluatorHash: task.evaluatorHash,
              seedHash: task.seedHash,
              collectionPlanHash: task.collectionPlanHash,
            },
            model,
            transportConfigurationHash: input.study.transportConfigurationHash,
            harness,
            repetition,
            randomSeed: deriveSeed(input.study.seed, `${task.id}:${model.id}:${repetition}`),
            environment: input.study.environment,
          };
          treatments.push({
            schema: TREATMENT_SCHEMA,
            id: `tr-${hashJson(treatmentBody).slice(0, 20)}`,
            ...treatmentBody,
          });
        }
      }
    }
  }
  const frozen: FrozenStudy = {
    schema: "basalt-evals/frozen-study",
    frozenAt: input.frozenAt ?? new Date().toISOString(),
    study: input.study,
    studyHash,
    implementationCommit: input.implementationCommit,
    dirty: input.dirty,
    connectorSourceHash: input.connectorSourceHash,
    connectorArtifactHash: input.connectorArtifactHash,
    tasks: tasks.map((task) => ({
      id: task.id,
      directory: task.directory,
      publicTaskHash: task.publicTaskHash,
      evaluatorHash: task.evaluatorHash,
      seedHash: task.seedHash,
      collectionPlanHash: task.collectionPlanHash,
    })),
    treatments,
  };
  assertFrozenStudy(frozen);
  return frozen;
}

/** The only task view supplied to a builder. */
export function builderTaskView(task: RegisteredTask): {
  task: RegisteredTask["publicTask"];
  publicTaskHash: string;
  seedHash: string;
} {
  return { task: task.publicTask, publicTaskHash: task.publicTaskHash, seedHash: task.seedHash };
}

export async function materializeTaskSeed(
  repositoryRoot: string,
  task: RegisteredTask,
  destination: string,
): Promise<void> {
  const source = within(resolve(repositoryRoot), `${task.directory}/seed`);
  const inventory = await inventoryTree(source);
  if (hashJson(inventory) !== task.seedHash)
    throw new Error(`Task ${task.id} seed no longer matches its registered hash`);
  const materialized: Array<{ file: (typeof inventory)[number]; bytes: Buffer }> = [];
  for (const file of inventory) {
    const sourceFile = within(source, file.path);
    const bytes = await readRegularBytes(sourceFile, MAX_SEED_FILE_BYTES, "seed file");
    if (bytes.byteLength !== file.bytes || contentHash(bytes) !== file.hash)
      throw new Error(`Seed file changed during materialization: ${file.path}`);
    materialized.push({ file, bytes });
  }
  await assertSafeAbsoluteDirectory(dirname(resolve(destination)));
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const { file, bytes } of materialized) {
    const target = within(resolve(destination), file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
  }
}

export async function hashDirectoryTree(directory: string): Promise<string> {
  return hashJson(await inventoryTree(resolve(directory)));
}

async function readJson<T>(
  file: string,
  assertion: (value: unknown) => asserts value is T,
): Promise<T> {
  const bytes = await readRegularBytes(file, MAX_JSON_BYTES, "JSON file");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON: ${file}`, { cause: error });
  }
  assertion(value);
  return value;
}

async function readRegularBytes(file: string, maxBytes: number, label: string): Promise<Buffer> {
  return readBoundedRegularFile(file, maxBytes, label);
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`Expected regular ${label}: ${path}`);
}

function within(root: string, relativePath: string): string {
  const path = resolve(root, relativePath);
  const relation = relative(root, path);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`))
    throw new Error(`Path escapes declared root: ${relativePath}`);
  return path;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Study has duplicate ${label}`);
}

function deriveSeed(studySeed: number, pair: string): number {
  const digest = contentHash(`${studySeed}:${pair}`);
  return Number.parseInt(digest.slice(0, 8), 16);
}
