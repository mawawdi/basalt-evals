import { execFile as callback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { hashJson } from "../packages/contracts/src/index.js";
import { measureBuildIdentity } from "../packages/operator/src/execution-guard.js";

const execFile = promisify(callback);

export async function implementationFixture(root: string) {
  await mkdir(resolve(root, "packages"), { recursive: true });
  await mkdir(resolve(root, "dist/packages"), { recursive: true });
  await writeFile(resolve(root, "packages/fixture.ts"), "export const fixture = true;\n");
  await writeFile(resolve(root, "dist/packages/fixture.js"), "export const fixture = true;\n");
  await writeFile(resolve(root, "package-lock.json"), "{}\n");
  await writeFile(resolve(root, ".gitignore"), ".basalt-evals/\ndist/\n");
  await execFile("git", ["init", "-q"], { cwd: root });
  await execFile("git", ["add", "."], { cwd: root });
  await execFile(
    "git",
    [
      "-c",
      "user.name=Offline Test",
      "-c",
      "user.email=offline@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      "commit",
      "-qm",
      "Freeze offline implementation",
    ],
    { cwd: root },
  );
  const commit = (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const identity = await measureBuildIdentity(root);
  await writeFile(resolve(root, "dist/build-identity.json"), JSON.stringify(identity));
  return { implementationCommit: commit, buildIdentityHash: hashJson(identity) };
}
