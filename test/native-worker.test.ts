import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  contentHash,
  MAX_STUDIO_SCENARIO_DURATION_MS,
  stableJson,
  type StudioCollectionPlan,
} from "../packages/contracts/src/index.js";
import { ExecutionFault } from "../packages/contracts/src/failure.js";
import {
  nativeCaptureFailure,
  readStepBehavior,
  JOB_LEASE_FILE,
  nativeStepWatchdogMs,
  runNativeStudio,
  startJobLease,
  runNativeProcess,
  prepareWorkerKeyDirectory,
  verifyConfiguredStudioConnector,
  verifyWorkerArtifacts,
  verifyWorkerSignature,
  type SignedWorkerManifest,
} from "../packages/studio-runner/src/native-worker.js";
import { collectStudioStartup } from "../packages/studio-runner/src/studio-startup.js";
import {
  captureStudioPreferences,
  configuredStudioPluginFile,
  preferencesTemplateProblems,
  readGoldenTemplate,
  resetStudioPreferences,
} from "../packages/studio-runner/src/studio-preferences.js";
import {
  publishScreenRecording,
  SCREEN_RECORDING_FILE,
  startScreenRecording,
} from "../packages/studio-runner/src/screen-recording.js";
import { studioRunnerIdentity } from "../packages/studio-runner/src/adapter.js";

test("native identity binds real compiled artifacts and helpers without using Luau inventory", async () => {
  const root = process.cwd();
  const original = await studioRunnerIdentity(root);
  const fixture = await mkdtemp(resolve(tmpdir(), "basalt-runner-identity-"));
  try {
    await cp(
      resolve(root, "dist/packages/studio-runner"),
      resolve(fixture, "dist/packages/studio-runner"),
      { recursive: true },
    );
    await mkdir(resolve(fixture, "packages/studio-runner"), { recursive: true });
    for (const file of ["native-entry.luau", "native-focus.swift", "native-recorder.swift"])
      await cp(
        resolve(root, "packages/studio-runner", file),
        resolve(fixture, "packages/studio-runner", file),
      );
    assert.equal(await studioRunnerIdentity(fixture), original);
    await writeFile(
      resolve(fixture, "packages/studio-runner/native-focus.swift"),
      "changed helper",
    );
    assert.notEqual(await studioRunnerIdentity(fixture), original);
    await cp(
      resolve(root, "packages/studio-runner/native-focus.swift"),
      resolve(fixture, "packages/studio-runner/native-focus.swift"),
    );
    await writeFile(
      resolve(fixture, "dist/packages/studio-runner/src/adapter.js"),
      "changed executable",
    );
    assert.notEqual(await studioRunnerIdentity(fixture), original);
    await symlink(
      resolve(root, "package.json"),
      resolve(fixture, "dist/packages/studio-runner/linked.json"),
    );
    await assert.rejects(studioRunnerIdentity(fixture), /symbolic link/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("native watchdog follows declared observation work rather than a short fixed cutoff", () => {
  const plan: StudioCollectionPlan = {
    schema: "basalt-evals/studio-plan",
    clients: 1,
    actors: [],
    roles: [],
    scenarios: [
      {
        id: "long-route",
        label: "Observe a repeated route",
        durationMs: 125_000,
        reportContexts: ["server"],
        steps: [
          {
            id: "observe",
            at: { startMs: 0 },
            horizonMs: 1000,
            holdMs: 0,
            requirement: null,
            action: { kind: "wait" },
            observations: [],
          },
        ],
      },
    ],
    phases: [
      {
        id: "capture",
        label: "Capture",
        instruction: "Capture the scene",
        driver: { kind: "wait_for_session", timeoutMs: 60_000 },
        facts: [
          {
            id: "motion",
            kind: "part_motion",
            path: "game.Workspace.Ground",
            sampleCount: 240,
            intervalMs: 500,
          },
        ],
        captures: [{ id: "frame", instruction: "Capture after Play starts" }],
      },
    ],
  };
  // The budget, the runner signal slack and the startup allowance.
  assert.equal(nativeStepWatchdogMs(plan, "long-route"), 250_000);
  // A step can start at the end of the budget, so its longest observation window follows it.
  plan.scenarios[0]!.steps[0]!.observations.push({
    context: "server",
    fact: {
      id: "trace",
      kind: "part_physics_trace",
      path: "game.Workspace.Ground",
      durationMs: 10_000,
    },
  });
  assert.equal(nativeStepWatchdogMs(plan, "long-route"), 260_000);
  assert.equal(nativeStepWatchdogMs(plan, "presentation"), 374_500);
  plan.phases[0]!.facts.push({
    id: "physics",
    kind: "part_physics_trace",
    path: "game.Workspace.Ground",
    durationMs: 180_000,
  });
  assert.equal(nativeStepWatchdogMs(plan, "presentation"), 554_500);
  assert.throws(() => nativeStepWatchdogMs(plan, "missing"), /Unknown native Studio step/);
});

test("native launch accepts the watchdog derived from the longest supported scenario", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-native-watchdog-"));
  try {
    const plan: StudioCollectionPlan = {
      schema: "basalt-evals/studio-plan",
      clients: 1,
      actors: [],
      roles: [],
      phases: [],
      scenarios: [
        {
          id: "long-route",
          label: "Full observation window",
          durationMs: MAX_STUDIO_SCENARIO_DURATION_MS,
          reportContexts: ["server"],
          steps: [
            {
              id: "observe",
              at: { startMs: 0 },
              horizonMs: 1000,
              holdMs: 0,
              requirement: null,
              action: { kind: "wait" },
              observations: [],
            },
          ],
        },
      ],
    };
    const timeoutMs = nativeStepWatchdogMs(plan, "long-route");
    assert.equal(timeoutMs, MAX_STUDIO_SCENARIO_DURATION_MS + 125_000);
    const result = await runNativeProcess({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      directory: root,
      timeoutMs,
    });
    assert.equal(result.reason, "exit");
    assert.equal(result.exitCode, 0);
    for (const invalid of [0, Number.POSITIVE_INFINITY, 2_147_483_648])
      await assert.rejects(
        runNativeProcess({
          command: process.execPath,
          args: [],
          directory: root,
          timeoutMs: invalid,
        }),
        /Node timer range/,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native capture attributes a pre-join client crash without masking other failures", () => {
  const crash = "[INFO StudioCrashpadCallback] User callback reports event : clientcrash\n";
  assert.equal(
    nativeCaptureFailure("route-probe", "Scenario players did not join within 60 seconds", crash),
    "A Studio client stopped unexpectedly before it joined step route-probe. Read the signed studio-stderr.log file.",
  );
  assert.equal(
    nativeCaptureFailure("route-probe", "Scenario players did not join within 60 seconds", ""),
    "Studio could not record step route-probe. Cause: Scenario players did not join within 60 seconds",
  );
  assert.equal(
    nativeCaptureFailure("route-probe", "Invalid evidence provenance", crash),
    "Studio could not record step route-probe. Cause: Invalid evidence provenance",
  );
});

test("a step that Studio left without a behavior record is an acquisition fault", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-step-behavior-"));
  try {
    const session = resolve(root, "studio");
    const step = resolve(root, "job/step-02-errors-attempt-01");
    await mkdir(step, { recursive: true });
    await mkdir(resolve(session, "runtime"), { recursive: true });
    const read = () =>
      readStepBehavior({
        sessionDirectory: session,
        stepId: "errors",
        stepDirectory: step,
        dependency: "e".repeat(64),
      });
    const crash = `2026-10-06T23:12:01.123Z,12.3,a1,6 [FLog::Output] RBXCRASH: ${"x".repeat(400)}`;
    const log = `Studio started\n${crash}\nRBXCRASH: a second line\n`;
    await writeFile(resolve(step, "studio-stdout.log"), log);
    // Studio stopped before it made the runtime folder of the step.
    const fault = await read().then(
      () => assert.fail("An absent record must fail"),
      (error: unknown) => error,
    );
    assert.ok(fault instanceof ExecutionFault);
    const { explanation, ...failure } = fault.failure;
    assert.deepEqual(failure, {
      causeCode: "studio_runtime_evidence_missing",
      category: "acquisition",
      dependency: "e".repeat(64),
      unit: { stage: "final_capture", id: "errors" },
      evidenceRefs: [contentHash(log)],
      recoveryActions: ["inspect"],
    });
    const prefix =
      "Studio stopped during step errors before it recorded the behavior. Studio reported: ";
    assert.equal(
      explanation,
      prefix + crash.slice(0, 300),
      "The quote of the first crash line is bounded",
    );
    // Without a crash line, the fault names the signed log.
    await rm(resolve(step, "studio-stdout.log"));
    await mkdir(resolve(session, "runtime/errors"));
    await assert.rejects(read(), {
      name: "ExecutionFault",
      message:
        "Studio stopped during step errors before it recorded the behavior. Read the signed studio-stdout.log file.",
    });
    await writeFile(resolve(session, "runtime/errors/evidence.json"), '{"scenarioId":"errors"}');
    assert.equal((await read()).toString("utf8"), '{"scenarioId":"errors"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "native worker rejects a controller-account session before opening Studio",
  { skip: process.platform !== "darwin" },
  async () => {
    await assert.rejects(
      runNativeStudio({
        sessionDirectory: process.cwd(),
        entryFile: resolve(process.cwd(), "packages/studio-runner/native-entry.luau"),
        keyFile: resolve(process.cwd(), "test-key.pem"),
        resetPreferences: false,
        screenRecording: false,
        mcpAnchorKeeper: { command: "/usr/bin/false", args: [] },
      }),
      /isolated BasaltTrials job/,
    );
  },
);

test("native worker verifies the plugin folder Studio actually configured", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "basalt-studio-plugin-config-"));
  const directory = resolve(home, "RuntimePlugins");
  const plugin = resolve(directory, "BasaltEvalStudioPlugin.rbxmx");
  const settings = resolve(home, "Library/Roblox/GlobalSettings_13.xml");
  try {
    await mkdir(resolve(home, "Library/Roblox"), { recursive: true });
    await mkdir(directory);
    await writeFile(settings, `<QDir name="PluginsDir">${directory}</QDir>`);
    await writeFile(plugin, "current connector");
    assert.equal(configuredStudioPluginFile(await readFile(settings, "utf8"), home), plugin);
    assert.equal(
      await verifyConfiguredStudioConnector(home, contentHash("current connector")),
      plugin,
    );
    await assert.rejects(
      verifyConfiguredStudioConnector(home, contentHash("old connector")),
      /Basalt connector that Studio loads[^.]*not the current version/,
    );
    assert.throws(
      () => configuredStudioPluginFile('<QDir name="PluginsDir">/other/Plugins</QDir>', home),
      /outside the isolated Studio account/,
    );
    await rm(plugin);
    await symlink(settings, plugin);
    await assert.rejects(verifyConfiguredStudioConnector(home, contentHash("current connector")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Studio startup diagnostics distinguish a misrouted client from a joined client", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-studio-startup-"));
  try {
    const now = Date.now();
    const stamp = new Date(now).toISOString().slice(0, 19).replaceAll(/[-:]/g, "") + "Z";
    const place = resolve(root, "candidate.rbxlx");
    const guid = "11111111-2222-3333-4444-555555555555";
    const command = (role: string) =>
      `/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio -task StartClient -localProjectFile ${place} -instanceId ${role} -playTestSessionGuid ${guid}\n`;
    await writeFile(
      resolve(root, `0.739_${stamp}_Studio_joined_last.log`),
      `${command("StudioPlayer_0")}Studio Launch Intent is StartClient\nPlaceManager::createAndShowIDEDoc with task StartClient\nSetting StudioGameStateType to StudioGameStateType_PlayClient\nConnection accepted from 127.0.0.1\n`,
    );
    await writeFile(
      resolve(root, `0.739_${stamp}_Studio_edit_last.log`),
      `${command("StudioPlayer_1")}Studio Launch Intent is StartClient\nPlaceManager::createAndShowIDEDoc with task EditFile\n`,
    );
    await writeFile(
      resolve(root, `0.739_${stamp}_Studio_other_last.log`),
      command("StudioPlayer_2").replace(guid, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    );
    const summary = await collectStudioStartup({
      place,
      startedAtMs: now - 1000,
      finishedAtMs: now + 1000,
      logsDirectory: root,
      playSessionGuid: guid,
    });
    assert.equal(summary.classification, "client_opened_as_edit");
    assert.equal(summary.processes.length, 2);
    assert.deepEqual(
      summary.processes.map((process) => [
        process.role,
        process.playClient,
        process.networkAccepted,
      ]),
      [
        ["StudioPlayer_0", true, true],
        ["StudioPlayer_1", false, false],
      ],
    );
    assert.equal(summary.diagnosticError, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Studio startup diagnostics classify a server opened as an edit place", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-studio-server-startup-"));
  try {
    const now = Date.now();
    const stamp = new Date(now).toISOString().slice(0, 19).replaceAll(/[-:]/g, "") + "Z";
    const place = resolve(root, "candidate.rbxlx");
    await writeFile(
      resolve(root, `0.739_${stamp}_Studio_server_last.log`),
      `/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio -task StartServer -localProjectFile ${place} -instanceId StudioServer -playTestSessionGuid 11111111-2222-3333-4444-555555555555\nStudio Launch Intent is StartServer\nPlaceManager::createAndShowIDEDoc with task EditFile\n`,
    );
    const summary = await collectStudioStartup({
      place,
      startedAtMs: now - 1000,
      finishedAtMs: now + 1000,
      logsDirectory: root,
    });
    assert.equal(summary.classification, "server_opened_as_edit");
    assert.equal(summary.processes.length, 1);
    assert.equal(summary.processes[0]?.role, "StudioServer");
    const solo = await collectStudioStartup({
      place: resolve(root, "solo.rbxlx"),
      startedAtMs: now - 1000,
      finishedAtMs: now + 1000,
      logsDirectory: root,
      expectChildren: false,
    });
    assert.equal(solo.processes.length, 0);
    assert.equal(solo.diagnosticError, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Studio startup diagnostics bind an update exit to the exact trial script", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-studio-update-"));
  try {
    const now = Date.now();
    const stamp = new Date(now).toISOString().slice(0, 19).replaceAll(/[-:]/g, "") + "Z";
    const place = resolve(root, "candidate.rbxlx");
    const scriptFile = resolve(root, "entry.luau");
    const update = "About to exit application due to update.";
    const name = `0.740_${stamp}_Studio_update_last.log`;
    await writeFile(
      resolve(root, name),
      `/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio --task RunScript --localPlaceFile ${place} --runScriptFile ${scriptFile} --quitAfterExecution\n${update}\n`,
    );
    const unrelated = `0.740_${stamp}_Studio_other_last.log`;
    await writeFile(
      resolve(root, unrelated),
      `/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio --task RunScript --localPlaceFile ${place} --runScriptFile ${resolve(root, "other.luau")} --quitAfterExecution\n${update}\n`,
    );
    const summary = await collectStudioStartup({
      place,
      scriptFile,
      startedAtMs: now - 1000,
      finishedAtMs: now + 1000,
      logsDirectory: root,
      expectChildren: false,
    });
    assert.equal(summary.applicationUpdate?.logFile, name);
    assert.match(summary.applicationUpdate?.logHash ?? "", /^[a-f0-9]{64}$/);
    const other = await collectStudioStartup({
      place,
      scriptFile: resolve(root, "absent.luau"),
      startedAtMs: now - 1000,
      finishedAtMs: now + 1000,
      logsDirectory: root,
      expectChildren: false,
    });
    assert.equal(other.applicationUpdate, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Studio startup diagnostics read only the logs of their own job when lanes share the folder", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-studio-shared-logs-"));
  try {
    const now = Date.now();
    const stamp = new Date(now).toISOString().slice(0, 19).replaceAll(/[-:]/g, "") + "Z";
    const place = resolve(root, "lane-0/candidate.rbxlx");
    const otherPlace = resolve(root, "lane-1/candidate.rbxlx");
    const command = (file: string, role: string) =>
      `/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio -task StartClient -localProjectFile ${file} -instanceId ${role} -playTestSessionGuid 11111111-2222-3333-4444-555555555555\nStudio Launch Intent is StartClient\nPlaceManager::createAndShowIDEDoc with task EditFile\n`;
    // The other lane writes 40 logs in the window. The reader examines each log.
    for (let index = 0; index < 40; index++)
      await writeFile(
        resolve(root, `0.741_${stamp}_Studio_z${String(index).padStart(2, "0")}_last.log`),
        command(otherPlace, "StudioPlayer_0") + "About to exit application due to update.\n",
      );
    await writeFile(
      resolve(root, `0.741_${stamp}_Studio_a00_last.log`),
      command(place, "StudioServer").replaceAll("StartClient", "StartServer"),
    );
    const summary = await collectStudioStartup({
      place,
      scriptFile: resolve(root, "lane-0/entry.luau"),
      startedAtMs: now - 1000,
      finishedAtMs: now + 1000,
      logsDirectory: root,
    });
    assert.deepEqual(
      summary.processes.map((process) => process.logFile),
      [`0.741_${stamp}_Studio_a00_last.log`],
    );
    assert.equal(summary.classification, "server_opened_as_edit");
    assert.equal(summary.applicationUpdate, null, "An update exit of the other lane is not ours");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker identity directory is outside the checkout and rejects redirected ancestors", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-worker-identity-"));
  try {
    const home = resolve(root, "home");
    await mkdir(home);
    const expected = resolve(home, ".local/share/basalt-evals/native-worker");
    assert.equal(await prepareWorkerKeyDirectory(home), expected);
    assert.equal(await prepareWorkerKeyDirectory(home), expected);
    const unsafeHome = resolve(root, "unsafe-home");
    await mkdir(unsafeHome);
    await symlink(resolve(home, ".local"), resolve(unsafeHome, ".local"));
    await assert.rejects(prepareWorkerKeyDirectory(unsafeHome), /symbolic|symlink|unsafe/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native subprocess retains logs, limits lifetime, and does not inherit provider credentials", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-native-process-"));
  try {
    const success = resolve(root, "success");
    await mkdir(success);
    const result = await runNativeProcess({
      command: process.execPath,
      args: [
        "-e",
        "console.log('ready');console.log(Object.keys(process.env).filter(k=>/API_KEY|TOKEN|SECRET/.test(k)));",
      ],
      directory: success,
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.reason, "exit");
    assert.match(await readFile(resolve(success, "process.log"), "utf8"), /ready\n\[\]/);
    const hung = resolve(root, "hung");
    await mkdir(hung);
    const timeout = await runNativeProcess({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      directory: hung,
      timeoutMs: 300,
    });
    assert.equal(timeout.reason, "timeout");
    assert.notEqual(timeout.signal, null);
    const orphan = resolve(root, "orphan");
    await mkdir(orphan);
    const inheritedPipe = await runNativeProcess({
      command: process.execPath,
      args: [
        "-e",
        `const { spawn } = require('node:child_process');
         const child = spawn(process.execPath,
           ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
           { stdio: 'inherit' });
         console.log('descendant=' + child.pid);
         child.unref();`,
      ],
      directory: orphan,
      timeoutMs: 300,
    });
    assert.equal(inheritedPipe.reason, "timeout");
    // A stall never ends. The bound allows the fixed cleanup waits and slow process scans.
    assert.ok(inheritedPipe.durationMs < 30_000, "inherited pipes must not stall timeout");
    const inheritedPid = Number(
      /descendant=(\d+)/.exec(await readFile(resolve(orphan, "process.log"), "utf8"))?.[1],
    );
    assert.ok(Number.isSafeInteger(inheritedPid));
    try {
      assert.throws(
        () => process.kill(inheritedPid, 0),
        /ESRCH/,
        "Exiting before the first process scan must not orphan a live entry-group child",
      );
    } finally {
      try {
        process.kill(inheritedPid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    const detached = resolve(root, "detached-grandchild");
    await mkdir(detached);
    const separateGroup = await runNativeProcess({
      command: process.execPath,
      args: [
        "-e",
        `const { spawn } = require('node:child_process');
         const child = spawn(process.execPath,
           ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
           { detached: true, stdio: 'inherit' });
         console.log('separate=' + child.pid);
         child.unref();
         setInterval(()=>{},1000);`,
      ],
      directory: detached,
      timeoutMs: 1000,
    });
    assert.equal(separateGroup.reason, "timeout");
    const logged = await readFile(resolve(detached, "process.log"), "utf8");
    const grandchild = Number(/separate=(\d+)/.exec(logged)?.[1]);
    assert.ok(Number.isSafeInteger(grandchild));
    await assert.rejects(async () => process.kill(grandchild, 0), /ESRCH/);
    const adopted = resolve(root, "adopted-app");
    await mkdir(adopted);
    const marker = resolve(adopted, "unique-run");
    let launches = 0;
    const usage: number[] = [];
    const launched = await runNativeProcess({
      command: process.execPath,
      args: [
        "-e",
        `const { spawn } = require('node:child_process');
         const app = spawn('/bin/sh', ['-c', "trap '' TERM; sleep 30 # ${marker}"],
           { detached: true, stdio: 'ignore' });
         console.log('adopted=' + app.pid);
         app.unref();
         setTimeout(() => process.exit(0), 1200);`,
      ],
      directory: adopted,
      timeoutMs: 5000,
      launchedApp: { executable: "/bin/sh", uniqueArgument: marker },
      onLaunched: () => launches++,
      onUsage: (residentBytes) => usage.push(residentBytes),
    });
    assert.equal(launches, 1, "the launch is reported one time, when the app is first visible");
    assert.ok(
      Math.max(...usage) > 0,
      "the scans measure the resident memory of the owned processes",
    );
    const adoptedPid = Number(
      /adopted=(\d+)/.exec(await readFile(resolve(adopted, "process.log"), "utf8"))?.[1],
    );
    assert.equal(launched.pid, adoptedPid, "receipt identifies the launched app, not its launcher");
    await assert.rejects(async () => process.kill(adoptedPid, 0), /ESRCH/);
    const aborted = resolve(root, "aborted");
    await mkdir(aborted);
    const cancelled = await runNativeProcess({
      command: process.execPath,
      args: ["-e", "process.exit(42)"],
      directory: aborted,
      timeoutMs: 5000,
      signal: AbortSignal.abort(),
    });
    assert.equal(cancelled.reason, "aborted");
    assert.equal(cancelled.pid, null);
    const missing = resolve(root, "missing");
    await mkdir(missing);
    assert.equal(
      (
        await runNativeProcess({
          command: resolve(root, "no-executable"),
          args: [],
          directory: missing,
          timeoutMs: 5000,
        })
      ).reason,
      "spawn_error",
    );
    await assert.rejects(
      runNativeProcess({
        command: process.execPath,
        args: [],
        directory: success,
        timeoutMs: 5000,
      }),
      /EEXIST/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker receipts require a pinned key and exact bounded nonsymlink artifacts", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-native-receipt-"));
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const key = publicKey.export({ type: "spki", format: "pem" }).toString();
    const bytes = Buffer.from("original evidence\n");
    await writeFile(resolve(root, "evidence.json"), bytes);
    const receipt: SignedWorkerManifest = {
      publicKey: key,
      signature: "",
      manifest: {
        schema: "basalt-evals/native-worker",
        jobId: "a".repeat(32),
        sessionId: "studio-test",
        candidateHash: "b".repeat(64),
        collectionPlanHash: "c".repeat(64),
        runnerHash: "d".repeat(64),
        startedAt: "2026-09-20T00:00:00.000Z",
        completedAt: "2026-09-20T00:00:01.000Z",
        status: "incomplete",
        failure: "test",
        failureRecord: null,
        processes: [],
        completion: null,
        artifacts: [{ file: "evidence.json", hash: contentHash(bytes), bytes: bytes.length }],
        preferences: null,
        screenRecording: { status: "off", failure: null, bytes: null, hash: null },
      },
    };
    const seal = () => {
      receipt.signature = sign(
        null,
        Buffer.from(stableJson(receipt.manifest)),
        privateKey,
      ).toString("base64");
    };
    seal();
    await verifyWorkerArtifacts(root, receipt, key);
    const other = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    assert.equal(verifyWorkerSignature(receipt, other), false);
    receipt.manifest.status = "complete";
    await assert.rejects(verifyWorkerArtifacts(root, receipt, key), /signature/);
    seal();
    await writeFile(resolve(root, "evidence.json"), "modified evidence\n");
    await assert.rejects(verifyWorkerArtifacts(root, receipt, key), /hash mismatch/);
    receipt.manifest.artifacts[0]!.file = "../outside";
    seal();
    await assert.rejects(verifyWorkerArtifacts(root, receipt, key), /artifact identity/);
    await symlink(resolve(root, "evidence.json"), resolve(root, "linked"));
    receipt.manifest.artifacts[0]!.file = "linked";
    seal();
    await assert.rejects(verifyWorkerArtifacts(root, receipt, key), /ELOOP/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the isolated worker entry does not load the operation journal or node:sqlite", async () => {
  // The isolated account can have an older Node without node:sqlite. Walk the compiled imports.
  const entries = [
    "../packages/studio-runner/src/native-worker.js",
    "../packages/studio-runner/src/cancellation.js",
  ].map((path) => fileURLToPath(new URL(path, import.meta.url)));
  const seen = new Set<string>();
  const external = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) await visit(resolve(dirname(file), specifier));
      else external.add(specifier);
    }
  };
  for (const entry of entries) await visit(entry);
  assert.ok(seen.size > 5, "The walk follows the relative imports");
  assert.ok(
    [...seen].every((file) => !file.endsWith("/artifact-store/src/journal.js")),
    "The worker graph must not contain journal.js",
  );
  assert.ok(!external.has("node:sqlite"), "The worker graph must not import node:sqlite");
});

/** A fake `defaults` tool. It logs each call and exports or reads fixed values. */
async function fakeDefaults(root: string, plist: string) {
  const tool = resolve(root, "defaults");
  await writeFile(resolve(root, "export.plist"), plist);
  await writeFile(
    tool,
    `#!/bin/sh\necho "$@" >> "${root}/defaults.log"\ncase "$1" in\n  export) cat "${root}/export.plist" ;;\n  read) echo 1 ;;\nesac\n`,
  );
  await chmod(tool, 0o700);
  return tool;
}

const plist = (keys: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${keys}</dict></plist>\n`;

test("the template capture refuses a credential key, a wrong plugin folder and window restoration", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "basalt-template-capture-"));
  try {
    const plugins = resolve(home, ".local/share/basalt-evals/plugins");
    await mkdir(resolve(home, "Library/Roblox"), { recursive: true });
    const settingsFile = resolve(home, "Library/Roblox/GlobalSettings_13.xml");
    await writeFile(settingsFile, `<QDir name="PluginsDir">${plugins}</QDir>`);
    const persistence = "<key>ApplePersistenceIgnoreState</key><true/>";
    const capture = async (keys: string) =>
      captureStudioPreferences(home, await fakeDefaults(home, plist(keys)));
    await assert.rejects(
      capture(`${persistence}<key>RobloxStudioAuthCookie</key><string>secret</string>`),
      /key "RobloxStudioAuthCookie", which looks like a credential/,
    );
    await assert.rejects(capture(""), /Window restoration of Studio is on/);
    await assert.rejects(readFile(resolve(home, ".local/share/basalt-evals/golden/template.json")));
    await writeFile(
      settingsFile,
      `<QDir name="PluginsDir">${home}/Documents/Roblox/Plugins</QDir>`,
    );
    await assert.rejects(capture(persistence), /loads plugins from .*Documents\/Roblox\/Plugins/);
    assert.deepEqual(
      preferencesTemplateProblems({
        settings: `<QDir name="PluginsDir">${plugins}</QDir><string name="SessionToken">x</string>`,
        defaults: plist(persistence),
        home,
      }),
      [
        'The Studio preferences have the key "SessionToken", which looks like a credential. Remove it in the isolated account, then capture the template again.',
      ],
    );
    await writeFile(settingsFile, `<QDir name="PluginsDir">${plugins}</QDir>`);
    const { templateHash } = await capture(`${persistence}<key>Theme</key><string>Dark</string>`);
    const template = await readGoldenTemplate(home);
    assert.equal(template.templateHash, templateHash);
    assert.equal(template.settings.toString(), `<QDir name="PluginsDir">${plugins}</QDir>`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the preference reset is skipped when the account is busy", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "basalt-template-reset-"));
  try {
    const plugins = resolve(home, ".local/share/basalt-evals/plugins");
    await mkdir(resolve(home, "Library/Roblox"), { recursive: true });
    const settingsFile = resolve(home, "Library/Roblox/GlobalSettings_13.xml");
    const golden = `<QDir name="PluginsDir">${plugins}</QDir>`;
    await writeFile(settingsFile, golden);
    const tool = await fakeDefaults(home, plist("<key>ApplePersistenceIgnoreState</key><true/>"));
    await assert.rejects(
      resetStudioPreferences({
        home,
        requested: true,
        studioRunning: async () => false,
        defaultsTool: tool,
      }),
      /no preferences template/,
    );
    const { templateHash } = await captureStudioPreferences(home, tool);
    const changed = `${golden}<bool name="ShowGrid">true</bool>`;
    await writeFile(settingsFile, changed);
    await writeFile(resolve(home, "defaults.log"), "");
    let checks = 0;
    const cases: Array<[boolean, boolean]> = [
      [false, false],
      [true, true],
    ];
    for (const [requested, running] of cases)
      assert.deepEqual(
        await resetStudioPreferences({
          home,
          requested,
          studioRunning: async () => {
            checks++;
            return running;
          },
          defaultsTool: tool,
        }),
        { templateHash, reset: "skipped_busy" },
      );
    assert.equal(checks, 1, "A busy controller needs no process check");
    assert.equal(await readFile(settingsFile, "utf8"), changed, "A skipped reset changes nothing");
    assert.equal(await readFile(resolve(home, "defaults.log"), "utf8"), "");
    assert.deepEqual(
      await resetStudioPreferences({
        home,
        requested: true,
        studioRunning: async () => false,
        defaultsTool: tool,
      }),
      { templateHash, reset: "applied" },
    );
    assert.equal(await readFile(settingsFile, "utf8"), golden);
    const calls = (await readFile(resolve(home, "defaults.log"), "utf8")).trim().split("\n");
    assert.match(calls[0]!, /^import com\.Roblox\.RobloxStudio .*studio-defaults\.plist$/);
    assert.equal(calls[1], "read com.Roblox.RobloxStudio ApplePersistenceIgnoreState");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a recorder failure keeps the job complete, and the recording stays outside the signed artifacts", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-screen-recording-"));
  try {
    const job = resolve(root, "job");
    await mkdir(resolve(job, "studio"), { recursive: true });
    const script = async (name: string, body: string) => {
      const file = resolve(root, name);
      await writeFile(file, `#!/bin/sh\n${body}\n`);
      await chmod(file, 0o700);
      return file;
    };
    const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    // A compiler failure and a recorder that stops at once both become a failed recording.
    const uncompiled = await startScreenRecording({
      jobDirectory: job,
      environment,
      executable: async () => {
        throw new Error("swiftc: error: no such module 'ScreenCaptureKit'");
      },
    });
    uncompiled.update([1]);
    assert.deepEqual(await uncompiled.stop(), {
      status: "failed",
      failure: "swiftc: error: no such module 'ScreenCaptureKit'",
      bytes: null,
      hash: null,
    });
    await rm(resolve(job, "diagnostics"), { recursive: true, force: true });
    const crashed = await startScreenRecording({
      jobDirectory: job,
      environment,
      executable: () => script("crash", "exit 5"),
    });
    crashed.update([10, 11]);
    const failure = await crashed.stop();
    assert.equal(failure.status, "failed");
    assert.match(failure.failure ?? "", /exit code 5/);
    // A signed manifest of a complete job keeps the failed recording beside its artifacts.
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const key = publicKey.export({ type: "spki", format: "pem" }).toString();
    const bytes = Buffer.from("evidence\n");
    await writeFile(resolve(job, "studio/evidence.json"), bytes);
    const receipt: SignedWorkerManifest = {
      publicKey: key,
      signature: "",
      manifest: {
        schema: "basalt-evals/native-worker",
        jobId: "a".repeat(32),
        sessionId: "studio-test",
        candidateHash: "b".repeat(64),
        collectionPlanHash: "c".repeat(64),
        runnerHash: "d".repeat(64),
        startedAt: "2026-10-03T00:00:00.000Z",
        completedAt: "2026-10-03T00:00:01.000Z",
        status: "complete",
        failure: null,
        failureRecord: null,
        processes: [],
        completion: null,
        artifacts: [{ file: "evidence.json", hash: contentHash(bytes), bytes: bytes.length }],
        preferences: { templateHash: "e".repeat(64), reset: "applied" },
        screenRecording: failure,
      },
    };
    receipt.signature = sign(null, Buffer.from(stableJson(receipt.manifest)), privateKey).toString(
      "base64",
    );
    await verifyWorkerArtifacts(resolve(job, "studio"), receipt, key);
    // A recorder that finishes writes its file to the diagnostics folder, beside `studio`.
    await rm(resolve(job, "diagnostics"), { recursive: true, force: true });
    const recorder = await startScreenRecording({
      jobDirectory: job,
      environment,
      executable: () => script("record", 'cat > "$1.pids"\nprintf "mp4 bytes" > "$1"'),
    });
    recorder.update([20, 21]);
    recorder.update([21, 20]);
    recorder.update([22]);
    const recorded = await recorder.stop();
    assert.deepEqual(recorded, {
      status: "recorded",
      failure: null,
      bytes: 9,
      hash: contentHash("mp4 bytes"),
    });
    assert.equal(
      await readFile(resolve(job, `${SCREEN_RECORDING_FILE}.pids`), "utf8"),
      "20 21\n22\n",
      "The recorder gets each new set of Studio processes one time",
    );
    assert.equal(resolve(job, SCREEN_RECORDING_FILE).startsWith(resolve(job, "studio")), false);
    assert.ok(
      receipt.manifest.artifacts.every((artifact) => !artifact.file.includes("diagnostics")),
    );
    // The import checks the signed size and hash, and it publishes beside the session.
    const cell = resolve(root, "cell");
    await mkdir(resolve(cell, "studio"), { recursive: true });
    await assert.rejects(
      publishScreenRecording({
        staged: resolve(job, SCREEN_RECORDING_FILE),
        directory: cell,
        recording: { ...recorded, hash: contentHash("other bytes") },
        lane: 1,
        worker: "evals",
      }),
      /differs from the signed manifest/,
    );
    await publishScreenRecording({
      staged: resolve(job, SCREEN_RECORDING_FILE),
      directory: cell,
      recording: recorded,
      lane: 1,
      worker: "evals",
    });
    assert.equal(await readFile(resolve(cell, "diagnostics/screen.mp4"), "utf8"), "mp4 bytes");
    assert.deepEqual(JSON.parse(await readFile(resolve(cell, "diagnostics/screen.json"), "utf8")), {
      schema: "basalt-evals/screen-recording",
      lane: 1,
      worker: "evals",
      hash: contentHash("mp4 bytes"),
      bytes: 9,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the worker renews its job lease beside the signed studio folder", async () => {
  const job = await mkdtemp(resolve(tmpdir(), "basalt-job-lease-"));
  try {
    let pids = [7];
    const lease = await startJobLease({
      jobDirectory: job,
      placeArgument: resolve(job, "studio/place.rbxl"),
      studioPids: () => pids,
      intervalMs: 20,
    });
    const read = async () => JSON.parse(await readFile(resolve(job, JOB_LEASE_FILE), "utf8"));
    await delay(5);
    const first = await read();
    assert.equal(first.workerPid, process.pid);
    assert.ok(Number.isSafeInteger(first.workerPgid) && first.workerPgid > 0);
    assert.deepEqual(first.studioPids, [7]);
    assert.equal(first.placeArgument, resolve(job, "studio/place.rbxl"));
    pids = [8, 9];
    await delay(80);
    await lease.stop();
    const later = await read();
    assert.deepEqual(later.studioPids, [8, 9]);
    assert.ok(Date.parse(later.renewedAt) > Date.parse(first.renewedAt));
    assert.deepEqual((await readdir(job)).sort(), [JOB_LEASE_FILE]);
  } finally {
    await rm(job, { recursive: true, force: true });
  }
});
