import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  assertExecutionImplementation,
  bindOperationImplementation,
} from "../packages/operator/src/execution-guard.js";
import { hashJson } from "../packages/contracts/src/index.js";
import { implementationFixture } from "./implementation-fixture.js";
import { createPublicDevelopmentServices } from "../packages/development/src/service.js";
import { loadPublicDevelopmentTask } from "../packages/development/src/index.js";
import { nativeStudioAdapter } from "../packages/studio-runner/src/adapter.js";
import {
  cleanImplementationCommit,
  sameExecutionSource,
} from "../packages/artifact-store/src/implementation.js";

test("execution permits documentation, console and test edits but rejects dirty code, stale builds and changed execution source", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-guard-"));
  try {
    await mkdir(resolve(root, "docs"));
    await mkdir(resolve(root, "design-system/basalt"), { recursive: true });
    const documentation = [
      "README.md",
      "AGENTS.md",
      "docs/ARCHITECTURE.md",
      "design-system/basalt/MASTER.md",
    ];
    for (const file of documentation)
      await writeFile(resolve(root, file), "Original documentation\n");
    const identity = await implementationFixture(root);
    const publicData = await loadPublicDevelopmentTask(
      process.cwd(),
      "tasks/pilot/replicated-checkpoint",
    );
    let studioAdmissions = 0;
    const development = createPublicDevelopmentServices({
      root,
      outputRoot: resolve(root, ".basalt-evals/development"),
      task: publicData.task,
      recipe: publicData.recipe,
      recipeHash: hashJson(publicData.recipe),
      implementationCommit: identity.implementationCommit,
      maxRuns: 1,
      studio: {
        ...nativeStudioAdapter,
        identity: async () => {
          studioAdmissions += 1;
          throw new Error("Synthetic Studio boundary reached");
        },
      },
    });
    const publicRun = () =>
      development.run(
        root,
        { projectFile: "default.project.json", files: [], rootHash: hashJson([]) },
        publicData.recipe.views[0]!.id,
        "development-aaaaaaaaaaaaaaaaaaaaaaaa",
      );
    const preparationGuard = await bindOperationImplementation(
      root,
      "preparation",
      hashJson("draft"),
    );
    await preparationGuard();
    await assert.rejects(
      bindOperationImplementation(root, "preparation", hashJson("another draft")),
      /another frozen context/,
    );
    let dispatches = 0;
    const execute = async () => {
      await assertExecutionImplementation(root, identity);
      dispatches += 1;
    };
    await assertExecutionImplementation(root, identity);
    for (const file of documentation)
      await writeFile(resolve(root, file), "Updated documentation\n");
    await writeFile(resolve(root, "docs/NEW.md"), "New documentation\n");
    await promisify(callback)("git", ["add", "docs/ARCHITECTURE.md"], { cwd: root });
    await assertExecutionImplementation(root, identity);
    await preparationGuard();
    assert.equal(
      await cleanImplementationCommit(root, identity.implementationCommit),
      identity.implementationCommit,
    );
    await assert.rejects(publicRun(), /Synthetic Studio boundary reached/);
    assert.equal(studioAdmissions, 1);
    await promisify(callback)("git", ["mv", "packages/fixture.ts", "docs/fixture.md"], {
      cwd: root,
    });
    await assert.rejects(execute(), /Basalt runs only committed code/);
    await promisify(callback)("git", ["mv", "docs/fixture.md", "packages/fixture.ts"], {
      cwd: root,
    });
    await writeFile(resolve(root, "docs/runner.js"), "throw new Error('unexpected executable');\n");
    await assert.rejects(execute(), /Basalt runs only committed code/);
    await rm(resolve(root, "docs/runner.js"));
    await writeFile(resolve(root, "packages/fixture.ts"), "changed source");
    await assert.rejects(execute(), /Basalt runs only committed code/);
    await assert.rejects(preparationGuard(), /Basalt runs only committed code/);
    // The first bind of an operation measures the implementation, so dirty code stops it.
    await assert.rejects(
      bindOperationImplementation(root, "dirty-preparation", hashJson("draft")),
      /Basalt runs only committed code/,
    );
    await assert.rejects(publicRun(), /Basalt runs only committed code/);
    assert.equal(studioAdmissions, 1, "changed code must not reach Studio");
    await writeFile(resolve(root, "packages/fixture.ts"), "export const fixture = true;\n");
    await writeFile(resolve(root, "dist/packages/fixture.js"), "stale executable");
    await assert.rejects(execute(), /compiled Basalt code/);
    await assert.rejects(
      bindOperationImplementation(root, "stale-preparation", hashJson("draft")),
      /compiled Basalt code/,
    );
    await writeFile(resolve(root, "dist/packages/fixture.js"), "export const fixture = true;\n");
    await assertExecutionImplementation(root, identity);
    // Rechecks reuse unchanged file hashes; a same-size rewrite must still be detected.
    await writeFile(resolve(root, "dist/packages/fixture.js"), "export const fixture = 1234;\n");
    await assert.rejects(execute(), /compiled Basalt code/);
    await writeFile(resolve(root, "dist/packages/fixture.js"), "export const fixture = true;\n");
    const commit = (message: string) =>
      promisify(callback)(
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
          "-qam",
          message,
        ],
        { cwd: root },
      );
    // The console and tests never execute inside an operation: edits and commits to them
    // neither block nor strand a frozen run.
    await mkdir(resolve(root, "apps/console/app"), { recursive: true });
    await mkdir(resolve(root, "test"));
    await writeFile(resolve(root, "apps/console/app/page.tsx"), "export default 1;\n");
    await writeFile(resolve(root, "test/new.test.ts"), "export {};\n");
    await execute();
    await promisify(callback)("git", ["add", "apps", "test", "docs", "README.md"], { cwd: root });
    await commit("Console, test and documentation work");
    const consoleCommit = await cleanImplementationCommit(root, identity.implementationCommit);
    assert.notEqual(consoleCommit, identity.implementationCommit);
    assert.equal(
      await sameExecutionSource(root, identity.implementationCommit, consoleCommit),
      true,
    );
    await execute();
    await writeFile(resolve(root, "packages/other.ts"), "export const other = true;\n");
    await assert.rejects(execute(), /packages\/other\.ts has uncommitted changes/);
    await promisify(callback)("git", ["add", "packages/other.ts"], { cwd: root });
    await commit("Another implementation");
    await assert.rejects(execute(), /The Basalt code changed after this run started/);
    assert.equal(
      await sameExecutionSource(
        root,
        identity.implementationCommit,
        await cleanImplementationCommit(root),
      ),
      false,
    );
    await assert.rejects(
      cleanImplementationCommit(root, "0".repeat(40)),
      /The Basalt code changed after this run started/,
    );
    assert.equal(dispatches, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the implementation commit is HEAD from git status, and each kind of dirty execution source stops it", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-status-"));
  const git = async (...args: string[]) =>
    (
      await promisify(callback)(
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
          ...args,
        ],
        { cwd: root },
      )
    ).stdout;
  const write = async (path: string, text: string) => {
    await mkdir(resolve(root, path, ".."), { recursive: true });
    await writeFile(resolve(root, path), text);
  };
  try {
    await git("init", "-q", "-b", "main");
    await assert.rejects(cleanImplementationCommit(root), /The repository has no commit/);
    for (const path of [
      "packages/a.ts",
      "packages/with space.ts",
      "docs/x.md",
      "packages/sub/f.ts",
    ])
      await write(path, path);
    await write(".gitignore", "packages/cache/\n");
    await git("-C", "packages/sub", "init", "-q");
    await git("-C", "packages/sub", "add", ".");
    await git("-C", "packages/sub", "commit", "-qm", "Submodule");
    await git("add", ".");
    await git("commit", "-qm", "Implementation");
    const head = (await git("rev-parse", "HEAD")).trim();
    assert.equal(await cleanImplementationCommit(root), head);
    const cases: Array<[string, () => Promise<unknown>, string | null]> = [
      ["tracked change", () => write("packages/a.ts", "changed"), "packages/a.ts"],
      [
        "staged change",
        () => write("packages/a.ts", "changed").then(() => git("add", ".")),
        "packages/a.ts",
      ],
      ["deletion", () => rm(resolve(root, "packages/a.ts")), "packages/a.ts"],
      ["untracked file", () => write("packages/new file.ts", "new"), "packages/new file.ts"],
      ["line break", () => write("packages/line\nbreak.ts", "new"), "packages/line\nbreak.ts"],
      [
        "rename",
        () => git("mv", "packages/with space.ts", "docs/moved.md"),
        "packages/with space.ts",
      ],
      // Git lists changes to tracked files before untracked files.
      [
        "order",
        () => write("packages/0.ts", "new").then(() => write("packages/a.ts", "changed")),
        "packages/a.ts",
      ],
      ["ignored file", () => write("packages/cache/x.ts", "cache"), null],
      ["documentation", () => write("docs/x.md", "changed"), null],
      [
        "merge conflict",
        async () => {
          await git("checkout", "-q", "-b", "other");
          await write("packages/a.ts", "other");
          await git("commit", "-qam", "Other");
          await git("checkout", "-q", "main");
          await write("packages/a.ts", "main");
          await git("commit", "-qam", "Main");
          await assert.rejects(git("merge", "-q", "other"));
        },
        "packages/a.ts",
      ],
      [
        "submodule commit",
        async () => {
          await write("packages/sub/f.ts", "changed");
          await git("-C", "packages/sub", "commit", "-qam", "Change");
        },
        "packages/sub",
      ],
    ];
    for (const [kind, change, path] of cases) {
      await change();
      if (path === null) assert.equal(await cleanImplementationCommit(root), head, kind);
      else
        await assert.rejects(
          cleanImplementationCommit(root),
          {
            message: `Basalt runs only committed code. The file ${path} has uncommitted changes. Commit or remove the changes. Then try again.`,
          },
          kind,
        );
      await git("reset", "-q", "--hard", head);
      await git("clean", "-fdq");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
