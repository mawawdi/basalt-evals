import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const stampPath = "apps/console/.next/basalt-build.json";

async function assertRuntimeBuild(root) {
  // Import lazily: a fresh checkout must be able to rebuild a missing dist tree.
  const { assertCurrentBuild } = await import("../dist/packages/operator/src/execution-guard.js");
  await assertCurrentBuild(root);
}

/** Build inputs only. Local credentials and changing evaluation records never enter a build stamp. */
export async function consoleBuildFingerprint(root) {
  const hash = createHash("sha256").update(process.version);
  async function file(path) {
    hash
      .update(path)
      .update("\0")
      .update(await readFile(resolve(root, path)))
      .update("\0");
  }
  async function tree(path) {
    const entries = await readdir(resolve(root, path), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        [".next", "node_modules", "next-env.d.ts"].includes(entry.name) ||
        entry.name === ".env" ||
        entry.name.startsWith(".env.") ||
        entry.name.endsWith(".tsbuildinfo")
      )
        continue;
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Build input is a symbolic link: ${child}`);
      if (entry.isDirectory()) await tree(child);
      else if (entry.isFile()) await file(child);
    }
  }
  for (const path of ["packages", "apps/console"]) await tree(path);
  for (const path of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "dist/build-identity.json",
    "scripts/stamp-build.mjs",
    "scripts/console-build-state.mjs",
  ])
    await file(path);
  return hash.digest("hex");
}

export async function stampConsoleBuild(root) {
  await assertRuntimeBuild(root);
  await writeFile(
    resolve(root, stampPath),
    JSON.stringify({
      fingerprint: await consoleBuildFingerprint(root),
      buildId: (await readFile(resolve(root, "apps/console/.next/BUILD_ID"), "utf8")).trim(),
    }) + "\n",
  );
}

export async function consoleBuildCurrent(root) {
  try {
    await assertRuntimeBuild(root);
  } catch {
    return false;
  }
  try {
    const stamp = JSON.parse(await readFile(resolve(root, stampPath), "utf8"));
    return (
      stamp.buildId ===
        (await readFile(resolve(root, "apps/console/.next/BUILD_ID"), "utf8")).trim() &&
      stamp.fingerprint === (await consoleBuildFingerprint(root))
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await stampConsoleBuild(resolve(import.meta.dirname, ".."));
}
