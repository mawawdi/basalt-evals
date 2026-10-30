import assert from "node:assert/strict";
import { execFile as callback } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { consoleBuildCurrent, stampConsoleBuild } from "./console-build-state.mjs";
import { measureBuildIdentity } from "../dist/packages/operator/src/execution-guard.js";

const execFile = promisify(callback);
const repository = resolve(import.meta.dirname, "..");
const launcher = pathToFileURL(resolve(import.meta.dirname, "console.mjs")).href;
const buildState = pathToFileURL(resolve(import.meta.dirname, "console-build-state.mjs")).href;
const executionGuard = pathToFileURL(
  resolve(repository, "dist/packages/operator/src/execution-guard.js"),
).href;

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-console-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    "packages",
    "apps/console/.next",
    "dist/packages",
    "scripts",
    "bin",
    "node_modules/next/dist/bin",
  ])
    await mkdir(resolve(root, path), { recursive: true });
  for (const path of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "dist/build-identity.json",
  ])
    await writeFile(resolve(root, path), "{}");
  await writeFile(resolve(root, "packages/source.ts"), "export const source = true;");
  await writeFile(resolve(root, "dist/packages/source.js"), "export const source = true;");
  await writeFile(resolve(root, "apps/console/page.tsx"), "export default function Page() {}");
  await writeFile(resolve(root, "apps/console/.next/BUILD_ID"), "fixture-build");
  for (const file of ["stamp-build.mjs", "console-build-state.mjs", "local-environment.mjs"])
    await cp(resolve(import.meta.dirname, file), resolve(root, "scripts", file));
  await writeFile(
    resolve(root, "node_modules/next/dist/bin/next"),
    `
    const {execFileSync} = require('node:child_process');
    const {realpathSync} = require('node:fs');
    const credential = process.env.OPENROUTER_API_KEY;
    const inherited = execFileSync(process.execPath, ['-e', 'process.stdout.write(process.env.OPENROUTER_API_KEY || "")'], {encoding:'utf8'});
    console.log(JSON.stringify({
      command: process.argv[2], localCredential: credential === 'fixture-key',
      exportedCredential: credential === 'exported-key', missingCredential: !credential,
      workerInherited: inherited === (credential || ''),
      rootCorrect: realpathSync(process.env.BASALT_REPOSITORY_ROOT) === realpathSync(process.cwd())
    }));
  `,
  );
  await writeFile(
    resolve(root, "bin/npm"),
    `#!/usr/bin/env node
    const {appendFileSync,writeFileSync,readFileSync} = require('node:fs');
    appendFileSync('builds.log', process.argv.slice(2).join(' ') + '\\n');
    import(${JSON.stringify(buildState)}).then(async m => {
      if (process.env.BASALT_TEST_PROBE_PORT) await new Promise((done, fail) => {
        const socket = require('node:net').connect(Number(process.env.BASALT_TEST_PROBE_PORT), '127.0.0.1');
        socket.once('error', fail);
        socket.once('close', done);
      });
      writeFileSync('dist/packages/source.js',readFileSync('packages/source.ts'));
      const guard = await import(${JSON.stringify(executionGuard)});
      writeFileSync('dist/build-identity.json',JSON.stringify(await guard.measureBuildIdentity(process.cwd())));
      await m.stampConsoleBuild(process.cwd());
    });
  `,
    { mode: 0o700 },
  );
  await writeFile(
    resolve(root, "dist/build-identity.json"),
    JSON.stringify(await measureBuildIdentity(root)),
  );
  await stampConsoleBuild(root);
  return root;
}

function launch(root, options = {}, extraEnv = {}) {
  const env = { ...process.env, PATH: `${resolve(root, "bin")}:${process.env.PATH}`, ...extraEnv };
  if (!Object.hasOwn(extraEnv, "OPENROUTER_API_KEY")) delete env.OPENROUTER_API_KEY;
  return execFile(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {runConsole} from ${JSON.stringify(launcher)}; await runConsole(${JSON.stringify(root)}, ${JSON.stringify({ port: 0, ...options })});`,
    ],
    // The limit only stops a hung launcher. On a busy host a start can take more than 10 s.
    { env, cwd: tmpdir(), timeout: 60_000 },
  );
}

test("normal console loads repository .env for server and worker; exported credentials win", async (t) => {
  const root = await fixture(t);
  await writeFile(resolve(root, ".env"), 'OPENROUTER_API_KEY="fixture-key"\n');
  for (const exported of [false, true]) {
    const { stdout } = await launch(
      root,
      {},
      exported ? { OPENROUTER_API_KEY: "exported-key" } : {},
    );
    const result = JSON.parse(stdout);
    assert.equal(result.command, "start");
    assert.equal(result.localCredential, !exported);
    assert.equal(result.exportedCredential, exported);
    assert.equal(result.workerInherited, true);
    assert.equal(result.rootCorrect, true);
    assert.ok(!stdout.includes("fixture-key") && !stdout.includes("exported-key"));
  }
  await assert.rejects(readFile(resolve(root, "builds.log")), { code: "ENOENT" });
});

test("inspection can start without .env; unreadable .env is not silently ignored", async (t) => {
  const root = await fixture(t);
  assert.equal(JSON.parse((await launch(root)).stdout).missingCredential, true);
  await mkdir(resolve(root, ".env"));
  await assert.rejects(launch(root), /EISDIR|ERR_INVALID_ARG_TYPE/);
});

test("source, lock and output changes rebuild once; .env changes do not rebuild", async (t) => {
  const root = await fixture(t);
  assert.equal(await consoleBuildCurrent(root), true);
  const changes = [
    "packages/source.ts",
    "apps/console/page.tsx",
    "package-lock.json",
    "dist/packages/source.js",
    "apps/console/.next/BUILD_ID",
  ];
  for (const path of changes) {
    await writeFile(
      resolve(root, path),
      path.endsWith(".json") ? '{"fixture":"changed"}' : `${path} changed`,
    );
    assert.equal(await consoleBuildCurrent(root), false);
    await launch(root);
    assert.equal(await consoleBuildCurrent(root), true);
    await launch(root);
  }
  await writeFile(resolve(root, ".env"), "OPENROUTER_API_KEY=fixture-key\n");
  await launch(root);
  assert.deepEqual(
    (await readFile(resolve(root, "builds.log"), "utf8")).trim().split("\n"),
    changes.map(() => "run console:build"),
  );
});

test("a UI-only stamp cannot certify stale execution source or a changed worker", async (t) => {
  const root = await fixture(t);
  for (const path of ["packages/source.ts", "dist/packages/source.js"]) {
    await writeFile(resolve(root, path), `export const source = ${JSON.stringify(path)};`);
    await assert.rejects(stampConsoleBuild(root), /compiled Basalt code/);
    assert.equal(await consoleBuildCurrent(root), false);
    await launch(root);
    assert.equal(await consoleBuildCurrent(root), true);
  }
});

test("occupied ports preserve the listener; browser connections during build cannot block startup", async (t) => {
  const root = await fixture(t);
  await rm(resolve(root, "apps/console/.next/basalt-build.json"));
  const listener = createServer();
  await new Promise((done) => listener.listen(0, "127.0.0.1", done));
  t.after(() => listener.listening && new Promise((done) => listener.close(done)));
  const port = listener.address().port;
  await assert.rejects(launch(root, { port }), /already in use/);
  assert.equal(listener.listening, true);
  await assert.rejects(readFile(resolve(root, "builds.log")), { code: "ENOENT" });
  await new Promise((done) => listener.close(done));
  const { stdout } = await launch(root, { port }, { BASALT_TEST_PROBE_PORT: String(port) });
  assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)).command, "start");
});

test("automatic rebuild cannot replace execution code while an owned driver is alive", async (t) => {
  const root = await fixture(t);
  await rm(resolve(root, "apps/console/.next/basalt-build.json"));
  await mkdir(resolve(root, ".basalt-evals/journal"), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(resolve(root, ".basalt-evals/journal/operations.sqlite"));
  t.after(() => db.close());
  db.exec("CREATE TABLE records(namespace TEXT, body TEXT)");
  db.prepare("INSERT INTO records VALUES (?, ?)").run(
    "drivers",
    JSON.stringify({ active: true, pid: process.pid }),
  );
  await assert.rejects(launch(root), /run is still active/);
  await assert.rejects(readFile(resolve(root, "builds.log")), { code: "ENOENT" });
  db.exec("DELETE FROM records");
  await launch(root);
});

test("development mode is explicit and receives the same local credential", async (t) => {
  const root = await fixture(t);
  await writeFile(resolve(root, ".env"), "OPENROUTER_API_KEY=fixture-key\n");
  const { stdout } = await launch(root, { development: true });
  assert.match(stdout, /Development mode/);
  const result = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(result.command, "dev");
  assert.equal(result.localCredential, true);
  assert.equal((await readFile(resolve(root, "builds.log"), "utf8")).trim(), "run build");
});

test("CLI entry loads the same .env independently of the working directory", async (t) => {
  const root = await fixture(t);
  await writeFile(resolve(root, "package.json"), '{"type":"module"}');
  await cp(resolve(repository, "bin/basalt-evals.js"), resolve(root, "bin/basalt-evals.js"));
  await mkdir(resolve(root, "dist/packages/cli/src"), { recursive: true });
  await writeFile(
    resolve(root, "dist/packages/cli/src/index.js"),
    'console.log(process.env.OPENROUTER_API_KEY === "fixture-key");',
  );
  await writeFile(resolve(root, ".env"), "OPENROUTER_API_KEY=fixture-key\n");
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  const result = await execFile(process.execPath, [resolve(root, "bin/basalt-evals.js")], {
    env,
    cwd: tmpdir(),
  });
  assert.equal(result.stdout.trim(), "true");
});
