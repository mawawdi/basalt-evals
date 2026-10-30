import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { consoleBuildCurrent } from "./console-build-state.mjs";
import { loadLocalEnvironment } from "./local-environment.mjs";

async function assertIdleBeforeBuild(root) {
  const path = resolve(root, ".basalt-evals/journal/operations.sqlite");
  if (!existsSync(path)) return;
  const { DatabaseSync } = await import("node:sqlite");
  const journal = new DatabaseSync(path, { readOnly: true });
  try {
    for (const row of journal
      .prepare("SELECT body FROM records WHERE namespace = ?")
      .all("drivers")) {
      const owner = JSON.parse(row.body);
      if (!owner.active) continue;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") continue;
        throw error;
      }
      throw new Error(
        "The console needs a rebuild, but a run is still active. Stop the run or wait for it to finish before rebuilding.",
      );
    }
  } finally {
    journal.close();
  }
}

/** The console port. The CLI has the same value for its console links, and a test compares them. */
export const DEFAULT_CONSOLE_PORT = 43127;

export async function runConsole(root, { development = false, port = DEFAULT_CONSOLE_PORT } = {}) {
  // Reserve the port before building, so a second launch cannot overwrite a running app.
  const reservation = createServer((socket) => socket.destroy());
  try {
    await new Promise((done, fail) => {
      reservation.once("error", fail);
      reservation.listen(port, "127.0.0.1", done);
    });
  } catch (error) {
    if (error.code === "EADDRINUSE")
      throw new Error(
        `Port ${port} is already in use. Open http://127.0.0.1:${port}/ if Basalt is already running, or stop that server before starting another.`,
        { cause: error },
      );
    throw error;
  }
  const selectedPort = reservation.address().port;
  const releasePort = () => new Promise((done) => reservation.close(done));
  let child;
  let interrupted = false;
  const interrupt = (signal) => {
    interrupted = true;
    child?.kill(signal);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  async function run(command, args, env = process.env) {
    if (interrupted) throw new Error("Console startup stopped.");
    child = spawn(command, args, { cwd: root, stdio: "inherit", env });
    const code = await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("exit", (code) => done(code ?? 1));
    });
    child = undefined;
    if (code !== 0) throw new Error(`Console ${args[0]} exited with status ${code}.`);
  }
  try {
    if (development) {
      await assertIdleBeforeBuild(root);
      await run("npm", ["run", "build"]);
      console.log("Development mode: pages compile on demand. Use npm run console for normal use.");
    } else if (!(await consoleBuildCurrent(root))) {
      await assertIdleBeforeBuild(root);
      console.log(
        "Building Basalt for normal use. Later starts reuse this build until the source changes.",
      );
      await run("npm", ["run", "console:build"]);
      if (!(await consoleBuildCurrent(root)))
        throw new Error("Console build did not produce a current build stamp.");
    }
    loadLocalEnvironment(root);
    await releasePort();
    await run(
      process.execPath,
      [
        resolve(root, "node_modules/next/dist/bin/next"),
        development ? "dev" : "start",
        "apps/console",
        ...(development ? ["--webpack"] : []),
        "--hostname",
        "127.0.0.1",
        "--port",
        String(selectedPort),
      ],
      { ...process.env, BASALT_REPOSITORY_ROOT: root, NEXT_TELEMETRY_DISABLED: "1" },
    );
  } finally {
    if (reservation.listening) await releasePort();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== "--dev"))
      throw new Error("Use npm run console, or npm run console:dev for development.");
    await runConsole(resolve(import.meta.dirname, ".."), {
      development: process.argv.includes("--dev"),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
