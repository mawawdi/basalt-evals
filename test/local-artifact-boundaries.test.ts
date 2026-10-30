import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { RepositoryFiles } from "../packages/artifact-store/src/repository.js";
import { assertLocalRequest } from "../packages/operator/src/http-origin.js";
import { decodeCapture } from "../packages/studio-runner/src/images.js";
import { PNG } from "pngjs";

test("local artifact reader rejects escapes, directory and file symlinks, oversize and replacement", async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "basalt-artifacts-")));
  try {
    const files = new RepositoryFiles(root);
    await files.write("value.json", "{}");
    assert.deepEqual(await files.json("value.json"), {});
    assert.throws(() => files.path("../outside"), /inside/);
    await assert.rejects(files.write("value.json", "new"), { code: "EEXIST" });
    await symlink(resolve(root, "value.json"), resolve(root, "linked.json"));
    await assert.rejects(files.bytes("linked.json"));
    await mkdir(resolve(root, "real"));
    await symlink(resolve(root, "real"), resolve(root, "linked"));
    await assert.rejects(files.write("linked/file.json", "{}"), /Unsafe/);
    await assert.rejects(files.bytes("real"), /regular/);
    await assert.rejects(files.bytes("value.json", 1), /bounded/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("console access rejects DNS rebinding, cross-origin and forwarded external hosts", () => {
  assertLocalRequest(new Request("http://127.0.0.1:43127/api/experiments"));
  for (const headers of [
    { host: "evil.example" },
    { "x-forwarded-host": "evil.example" },
    { origin: "https://evil.example" },
  ])
    assert.throws(
      () => assertLocalRequest(new Request("http://127.0.0.1:43127/", { headers })),
      /local requests|another origin/,
    );
  assert.throws(() => assertLocalRequest(new Request("http://evil.example/")), /local requests/);
});

test("corrupt and incorrectly sized PNGs cannot pass the native evidence boundary", () => {
  const valid = PNG.sync.write(new PNG({ width: 320, height: 180 }));
  assert.equal(decodeCapture(valid, { width: 320, height: 180 }).width, 320);
  const corrupt = Buffer.from(valid);
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  assert.throws(() => decodeCapture(corrupt, { width: 320, height: 180 }));
  assert.throws(() => decodeCapture(valid, { width: 240, height: 135 }), /dimensions/);
  const fake = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000500000002d00802000000000000000000000049454e44ae426082",
    "hex",
  );
  assert.throws(() => decodeCapture(fake, { width: 320, height: 180 }));
});
