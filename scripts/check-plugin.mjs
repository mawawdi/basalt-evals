import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(root, "plugin/src");
await import("./check-capability-catalog.mjs");
const files = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && entry.name.endsWith(".luau")) files.push(relative(root, path));
  }
}

await collect(sourceRoot);
files.sort();
const temporary = await mkdtemp(join(tmpdir(), "basalt-evals-plugin-"));
try {
  for (const file of files) {
    await execFile("luau-compile", ["--only-parse", file], {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  await execFile("luau-compile", ["--only-parse", "packages/studio-runner/native-entry.luau"], {
    cwd: root,
  });
  const sourcemap = join(temporary, "sourcemap.json");
  await execFile("rojo", ["sourcemap", "plugin/default.project.json", "-o", sourcemap], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  });
  const sourcemapDocument = JSON.parse(await readFile(sourcemap, "utf8"));
  if (
    sourcemapDocument.name !== "BasaltEvalStudioPlugin" ||
    sourcemapDocument.className !== "Script" ||
    !sourcemapDocument.filePaths?.includes("src/init.plugin.luau")
  ) {
    throw new Error(
      "Plugin project must build BasaltEvalStudioPlugin as a top-level plugin Script",
    );
  }
  const artifact = join(temporary, "BasaltEvalStudioPlugin.rbxmx");
  await execFile("rojo", ["build", "plugin/default.project.json", "-o", artifact], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  });
  const artifactXml = await readFile(artifact, "utf8");
  if (!/^<roblox version="4">\s*<Item class="Script"/u.test(artifactXml)) {
    throw new Error("Plugin artifact must have a top-level Script, not a DataModel");
  }
  if (!/<token name="RunContext">3<\/token>/u.test(artifactXml)) {
    throw new Error("Plugin entry Script must use RunContext.Plugin");
  }
  await execFile(
    "luau-lsp",
    [
      "analyze",
      "--no-strict-dm-types",
      "--definitions",
      resolve(root, "packages/luau-toolchain/roblox/globalTypes.d.luau"),
      "--sourcemap",
      sourcemap,
      ...files.map((file) => file.replace(/^plugin\//, "")),
    ],
    { cwd: resolve(root, "plugin"), maxBuffer: 8 * 1024 * 1024 },
  );
  const test = await execFile("lune", ["run", "scripts/test-plugin-modules.luau"], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  });
  process.stdout.write(test.stdout);
  process.stdout.write(`Plugin check passed: ${files.length} parsed and analyzed modules\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
