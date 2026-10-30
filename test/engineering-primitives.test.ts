import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  confirmFileContents,
  readBoundedRegularFile,
} from "../packages/artifact-store/src/regular-file.js";
import { cachedSwiftHelper } from "../packages/studio-runner/src/swift-cache.js";
import { showPublicTask, validateRegisteredTasks } from "../packages/task-registry/src/commands.js";

test("bounded regular-file reads reject oversize, symlinks and FIFOs without waiting for a writer", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-regular-file-"));
  try {
    await mkdir(resolve(root, "data"));
    await writeFile(resolve(root, "data/value"), "exact");
    assert.equal(
      (await readBoundedRegularFile(resolve(root, "data/value"), 5, "test")).toString(),
      "exact",
    );
    await assert.rejects(
      readBoundedRegularFile(resolve(root, "data/value"), 4, "test"),
      /oversized/,
    );
    await symlink(resolve(root, "data/value"), resolve(root, "linked"));
    await assert.rejects(readBoundedRegularFile(resolve(root, "linked"), 5, "test"));
    await symlink(resolve(root, "data"), resolve(root, "linked-dir"));
    await assert.rejects(readBoundedRegularFile(resolve(root, "linked-dir/value"), 5, "test"));
    const fifo = resolve(root, "pipe");
    const exec = promisify(execFile);
    await exec("mkfifo", [fifo]);
    // A separate process makes a blocking-open regression fail. Its bound catches only that
    // hang. The bound includes the start of Node, which can take seconds on a loaded machine.
    await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { readBoundedRegularFile } from ${JSON.stringify(new URL("../packages/artifact-store/src/regular-file.js", import.meta.url).href)};
      await assert.rejects(readBoundedRegularFile(process.argv[1], 5, "pipe"), /Unsafe or oversized/);
    `,
        fifo,
      ],
      { timeout: 30_000 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a confirmed file content is checked again after any change to its file identity", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-confirmed-content-"));
  try {
    const file = resolve(root, "frame.jpg"),
      linked = resolve(root, "linked.jpg");
    await writeFile(file, "frame");
    let checks = 0;
    const confirm = (path: string, hash: string, check: () => Promise<void> = async () => {}) =>
      confirmFileContents([
        {
          file: path,
          hash,
          bytes: 5,
          check: async () => {
            checks++;
            await check();
          },
        },
      ]);
    await confirm(file, "a");
    await confirm(file, "a");
    assert.equal(checks, 1, "An unchanged file is not read again");
    await confirm(file, "b");
    assert.equal(checks, 2, "Another expected hash is a separate check");
    await writeFile(file, "frame");
    await confirm(file, "a");
    assert.equal(checks, 3, "A rewrite with the same bytes changes the file identity");
    await writeFile(resolve(root, "replacement"), "frame");
    await rename(resolve(root, "replacement"), file);
    await confirm(file, "a");
    assert.equal(checks, 4, "A replacement file is checked");
    const mismatch = async () => {
      throw new Error("hash mismatch");
    };
    await assert.rejects(confirm(file, "c", mismatch), /hash mismatch/);
    await assert.rejects(confirm(file, "c", mismatch), /hash mismatch/);
    assert.equal(checks, 6, "A failed check is not recorded");
    await confirm(file, "d", () => writeFile(file, "frame"));
    await confirm(file, "d");
    assert.equal(checks, 8, "A change during the check is not recorded");
    await symlink(file, linked);
    await confirm(linked, "a");
    await confirm(linked, "a");
    assert.equal(checks, 10, "A symbolic link is never recorded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Swift helper cache binds exact source and compiler identity", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-swift-cache-"));
  try {
    const compiler = resolve(root, "fake-compiler");
    const version = resolve(root, "version");
    const log = resolve(root, "compile.log");
    await writeFile(version, "fake compiler 1\n");
    await writeFile(
      compiler,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then cat "$FAKE_VERSION"; else cp "$1" "$3"; chmod +x "$3"; echo compile >> "$FAKE_LOG"; fi\n`,
    );
    await chmod(compiler, 0o700);
    const input = {
      name: "focus-guard",
      source: Buffer.from("#!/bin/sh\nexit 0\n"),
      compiler,
      cacheDirectory: resolve(root, "cache"),
      environment: { ...process.env, FAKE_VERSION: version, FAKE_LOG: log },
    };
    const first = await cachedSwiftHelper(input);
    const second = await cachedSwiftHelper(input);
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(second.executable, first.executable);
    assert.equal(await readFile(log, "utf8"), "compile\n");
    await cachedSwiftHelper({ ...input, source: Buffer.from("#!/bin/sh\nexit 1\n") });
    await writeFile(version, "fake compiler 2\n");
    await cachedSwiftHelper(input);
    assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry command services expose public tasks without evaluator material or CLI IO", async () => {
  const root = process.cwd();
  const [task] = await validateRegisteredTasks(root, ["tasks/pilot/moving-platform"]);
  assert.ok(task?.publicTaskHash);
  assert.equal("evaluator" in (await showPublicTask(root, "tasks/pilot/moving-platform")), false);
});
