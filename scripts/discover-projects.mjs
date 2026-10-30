import { lstat, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

async function regularFiles(directory, suffix) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink in fixture tree: ${path}`);
    if (entry.isDirectory()) files.push(...(await regularFiles(path, suffix)));
    else if (entry.isFile() && path.endsWith(suffix)) files.push(path);
  }
  return files.sort();
}

async function existsFile(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Unsafe project file: ${path}`);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function discoverProjectFiles(root) {
  const files = [resolve(root, "plugin/default.project.json")];
  for (const scope of ["studies", "tasks/pilot"])
    files.push(...(await regularFiles(resolve(root, scope), "default.project.json")));
  return files.map((file) => relative(root, file)).sort();
}

export async function discoverFixtureSets(root) {
  const sets = [];
  const pilotRoot = resolve(root, "tasks/pilot");
  for (const entry of await readdir(pilotRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Symlink in pilot tasks: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const seed = resolve(pilotRoot, entry.name, "seed");
    if (await existsFile(resolve(seed, "default.project.json")))
      sets.push({ name: `pilot/${entry.name}`, seed, files: await regularFiles(seed, ".luau") });
  }
  const studyRoot = resolve(root, "studies");
  for (const entry of await readdir(studyRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Symlink in studies: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const directory = resolve(studyRoot, entry.name);
    const files = await regularFiles(directory, ".luau");
    if (!files.length) continue;
    // A study without its own task uses the pilot task of the same name.
    let seed = resolve(directory, "task/seed");
    if (!(await existsFile(resolve(seed, "default.project.json"))))
      seed = resolve(root, "tasks/pilot", entry.name, "seed");
    if (!(await existsFile(resolve(seed, "default.project.json"))))
      throw new Error(`Study fixture has no seed: ${directory}`);
    sets.push({ name: entry.name, seed, files });
  }
  return sets.sort((a, b) => a.name.localeCompare(b.name));
}
