import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  hostFacts,
  preflightStudioWorkers,
  studioCapabilities,
  writeTemplateRecord,
  type StudioWorker,
} from "../packages/studio-runner/src/workers.js";

const connectorHash = "c".repeat(64);
const templateHash = "d".repeat(64);

async function workspace(root: string, workers: Array<Partial<StudioWorker>>) {
  const key = resolve(root, "key");
  await writeFile(key, "test key");
  await mkdir(resolve(root, ".basalt-evals/native-worker"), { recursive: true });
  await writeFile(
    resolve(root, ".basalt-evals/native-worker/workers.json"),
    JSON.stringify({
      schema: "basalt-evals/studio-workers",
      workers: workers.map((worker, index) => ({
        id: `worker-${index + 1}`,
        user: `basalt-preflight-${index + 1}`,
        sshKeyFile: key,
        nodeExecutable: "/opt/node/bin/node",
        lanes: [index],
        maxClients: 2,
        screenRecording: false,
        ...worker,
      })),
    }),
  );
}

/** A worker account that answers each read-only check. `broken` changes one answer. */
function account(user: string, broken: Set<string>) {
  const home = `/Users/${user}`;
  const plugins = broken.has("plugins")
    ? `${home}/Documents/Roblox/Plugins`
    : `${home}/.local/share/basalt-evals/plugins`;
  return (command: string): string => {
    if (command === "id -un && id -u") return `${user}\n501\n`;
    if (command.endsWith(" --version"))
      return broken.has("node") ? "command not found" : "v22.13.0";
    if (command.includes("GlobalSettings_13.xml"))
      return `<Settings><QDir name="PluginsDir">${plugins}</QDir></Settings>`;
    if (command.startsWith("/usr/bin/shasum"))
      return `${broken.has("connector") ? "0".repeat(64) : connectorHash}  file\n`;
    if (command.includes("ApplePersistenceIgnoreState"))
      return broken.has("persistence") ? "0\n" : "1\n";
    if (command.includes("golden/template.json"))
      return JSON.stringify({
        templateHash: broken.has("template") ? "e".repeat(64) : templateHash,
      });
    if (command.startsWith("/bin/launchctl print gui/501"))
      return broken.has("session") ? "absent\n" : "present\n";
    throw new Error(`Unexpected command: ${command}`);
  };
}

test("preflight reports each failed check and starts no Studio", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-studio-preflight-"));
  try {
    const commands: string[] = [];
    let broken = new Map<string, Set<string>>();
    const tools = {
      async remote(worker: StudioWorker, command: string) {
        commands.push(command);
        if (worker.id === "worker-3") throw new Error("ssh: connect to host 127.0.0.1: refused");
        return account(worker.user, broken.get(worker.id) ?? new Set())(command);
      },
      studioVersion: async () => "0.700.0.7000000",
      connectorHash: async () => connectorHash,
    };
    assert.deepEqual(await preflightStudioWorkers(root, tools), [
      `Basalt cannot find the Studio workers file at ${resolve(root, ".basalt-evals/native-worker/workers.json")}. Basalt does not start Studio in this macOS account. Create the file with the steps in docs/DEVELOPMENT.md.`,
    ]);
    await workspace(root, [{}, {}]);
    for (const id of ["worker-1", "worker-2"])
      await writeTemplateRecord(root, {
        schema: "basalt-evals/studio-preferences-template-record",
        worker: id,
        user: `basalt-preflight-${id.at(-1)}`,
        templateHash,
        capturedAt: new Date().toISOString(),
      });
    assert.deepEqual(await preflightStudioWorkers(root, tools), [], "A complete setup passes");
    const passingCommands = commands.length;
    broken = new Map([
      ["worker-1", new Set(["node", "persistence", "template", "session", "connector"])],
      ["worker-2", new Set(["plugins"])],
    ]);
    await workspace(root, [{}, {}, {}]);
    await mkdir(resolve(root, ".basalt-evals/native-worker/lanes"), { recursive: true });
    await writeFile(resolve(root, ".basalt-evals/native-worker/lanes/1"), "not a folder");
    const problems = await preflightStudioWorkers(root, {
      ...tools,
      studioVersion: async () => {
        throw new Error("Studio is not installed");
      },
    });
    assert.deepEqual(problems, [
      "Basalt cannot read the version of Studio on this Mac. Studio is not installed",
      `The folder of Studio slot 2 at ${resolve(root, ".basalt-evals/native-worker/lanes")}/1 is not a folder.`,
      "The Studio worker worker-1 cannot run Node at /opt/node/bin/node.",
      "The Basalt connector of the worker worker-1 at /Users/basalt-preflight-1/.local/share/basalt-evals/plugins/BasaltEvalStudioPlugin.rbxmx is not the current version. Copy the current connector there with the steps in docs/DEVELOPMENT.md.",
      "Window restoration of Studio is on for the worker worker-1. Set ApplePersistenceIgnoreState to YES with the steps in docs/DEVELOPMENT.md.",
      "The preferences template of the worker worker-1 differs from the one that Basalt recorded. Run studio template capture worker-1 again.",
      "The account basalt-preflight-1 of the Studio worker worker-1 has no GUI login session. Log in to that account on this Mac, then switch back.",
      "Studio of the worker worker-2 loads plugins from /Users/basalt-preflight-2/Documents/Roblox/Plugins, not from /Users/basalt-preflight-2/.local/share/basalt-evals/plugins. Set Studio.PluginsDir with the steps in docs/DEVELOPMENT.md.",
      "Basalt cannot connect to the Studio worker worker-3 with SSH as basalt-preflight-3. ssh: connect to host 127.0.0.1: refused",
    ]);
    assert.ok(commands.length > passingCommands);
    for (const command of commands) {
      assert.doesNotMatch(command, /\bopen\b|MacOS\/RobloxStudio|RobloxStudio\.app/u);
      assert.doesNotMatch(
        command,
        /defaults (?:write|import|delete)|\brm\b|\bmv\b|\bcp\b|>\s*\/(?!dev\/null)/u,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the capabilities use the captured template and the GPU list of one boot", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "basalt-studio-capabilities-"));
  try {
    await workspace(root, [{ screenRecording: true }]);
    let profiles = 0;
    let boot = "{ sec = 1700000000, usec = 5 } Mon Oct  2 10:00:00 2026";
    const run = async (file: string, args: string[]) => {
      if (file === "/usr/sbin/system_profiler") {
        profiles++;
        return JSON.stringify({
          SPDisplaysDataType: [{ sppci_model: "Apple M4", sppci_cores: "10" }],
        });
      }
      if (args.includes("kern.boottime")) return boot;
      return args.includes("-productVersion")
        ? "26.1\n"
        : args.includes("-buildVersion")
          ? "25B1\n"
          : "Mac16,1\n";
    };
    const host = await hostFacts(root, run);
    assert.deepEqual(host, {
      osVersion: "26.1",
      osBuild: "25B1",
      hardwareModel: "Mac16,1",
      gpus: ["Apple M4, 10 cores"],
    });
    await hostFacts(root, run);
    assert.equal(profiles, 1, "The GPU list is read one time for each boot");
    boot = "{ sec = 1700009999, usec = 5 } Mon Oct  2 12:00:00 2026";
    await hostFacts(root, run);
    assert.equal(profiles, 2);
    const workers = [
      {
        id: "worker-1",
        user: "basalt-preflight-1",
        sshKeyFile: resolve(root, "key"),
        nodeExecutable: "/opt/node/bin/node",
        lanes: [2, 0],
        maxClients: 4,
        screenRecording: true,
      },
    ];
    const before = await studioCapabilities(root, workers, host);
    assert.deepEqual(before.workers, [
      {
        id: "worker-1",
        lanes: [0, 2],
        maxClients: 4,
        captureMethod: "studio_mcp_screenshot",
        screenRecording: true,
        templateHash: null,
      },
    ]);
    await writeTemplateRecord(root, {
      schema: "basalt-evals/studio-preferences-template-record",
      worker: "worker-1",
      user: "basalt-preflight-1",
      templateHash,
      capturedAt: new Date().toISOString(),
    });
    const after = await studioCapabilities(root, workers, host);
    assert.equal(after.workers[0]!.templateHash, templateHash);
    assert.deepEqual(await studioCapabilities(root, workers, host), after, "The value is stable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
