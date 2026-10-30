import { execFile as callback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { discoverFixtureSets } from "./discover-projects.mjs";

const execFile = promisify(callback);
const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "basalt-study-fixtures-"));
const options = { cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 };

/** Parse and analyze one fixture set. The sets are independent, so they run at the same time. */
async function checkSet({ seed, files }, index) {
  await execFile("luau-compile", ["--only-parse", ...files], options);
  const sourcemap = join(temporary, `${index}.json`);
  await execFile(
    "rojo",
    ["sourcemap", resolve(seed, "default.project.json"), "-o", sourcemap],
    options,
  );
  await execFile(
    "luau-lsp",
    [
      "analyze",
      "--no-strict-dm-types",
      "--definitions",
      resolve(root, "packages/luau-toolchain/roblox/globalTypes.d.luau"),
      "--sourcemap",
      sourcemap,
      ...files.map((file) => relative(seed, file)),
    ],
    { ...options, cwd: seed },
  );
}

function report(error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
}

try {
  const sets = await discoverFixtureSets(root);
  // Each set finishes before the next one starts in its lane, and every set ends before the
  // folder of the sourcemaps goes away.
  const outcomes = new Array(sets.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(sets.length, availableParallelism()) }, async () => {
      while (next < sets.length) {
        const index = next++;
        outcomes[index] = await checkSet(sets[index], index).then(
          () => null,
          (error) => error,
        );
      }
    }),
  );
  const failure = outcomes.find((outcome) => outcome !== null);
  if (failure) {
    report(failure);
    throw failure;
  }
  for (const { name, files } of sets) process.stdout.write(`${name}: ${files.length} modules\n`);
  const tests = await execFile("lune", ["run", "scripts/test-study-fixtures.luau"], options).catch(
    (error) => {
      report(error);
      throw error;
    },
  );
  process.stdout.write(tests.stdout);
  const count = sets.reduce((sum, set) => sum + set.files.length, 0);
  process.stdout.write(`Study fixtures passed: ${count} parsed and analyzed modules\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
