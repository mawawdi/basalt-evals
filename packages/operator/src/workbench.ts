import type { OperationView } from "../../contracts/src/console.js";
import { registeredModelName, storedModelRegistry } from "./model-registry.js";
import { access, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { runCatalog } from "./discovery.js";
import { readSavedProgress } from "./progress.js";
import { readLifecycle } from "./lifecycle.js";
import type { OperationContext } from "../../contracts/src/launch.js";
import { lineageSpending } from "./lineage.js";
import { recentBuildStop } from "./build-stop.js";
import { preparationProblem } from "./preparation-outcome.js";
import { createPublicKey } from "node:crypto";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { readStudioWorkers, studioSlots } from "../../studio-runner/src/workers.js";
import type { StudioAdapter } from "../../studio-runner/src/adapter.js";
import type { LocalReadinessCheck } from "../../contracts/src/console.js";

export async function runInbox(root: string) {
  const active = await runCatalog(root, new URLSearchParams({ status: "active", limit: "4" }));
  const journal = await OperationJournal.open(root);
  let attentionCount;
  try {
    // The home page summarizes current interruptions, not every retained failure.
    // Stopped and completed runs keep their diagnostics in the run catalog.
    attentionCount = journal.page("runs", { status: "attention", limit: 1 }).total;
  } finally {
    journal.close();
  }
  return {
    attentionCount,
    active,
  };
}

export async function operationView(root: string, id: string): Promise<OperationView> {
  const journal = await OperationJournal.open(root);
  let view: Omit<OperationView, "buildStop">;
  try {
    view = journal.transaction(() => {
      const status = readSavedProgress(journal, id);
      const lifecycle = readLifecycle(journal, id);
      const journey = journal.read<OperationView["journey"]>("journey_progress", id);
      const spending = journal.read<{
        billedUsd: number;
        reservedUsd: number;
        availableUsd: number;
      }>("spending_progress", id);
      return {
        preparationProblem: preparationProblem(journal, id),
        testedModels: (status.workflow?.selection.builderModelIds ?? []).map((id) =>
          registeredModelName(storedModelRegistry(journal), id),
        ),
        journey,
        status,
        context: journal.read<OperationContext>("operation_context", id),
        lineage: lineageSpending(journal, id),
        lifecycle,
        capabilities: lifecycle.capabilities,
        interruption: lifecycle.blocker,
        ceilingUsd:
          journal.read<{ ceilingUsd: number }>("spending_progress", id)?.ceilingUsd ?? null,
        spending: spending ?? {
          billedUsd: 0,
          reservedUsd: 0,
          availableUsd:
            status.workflow?.ceilingUsd ??
            (status.kind === "starting" ? status.request.ceilingUsd : 0),
        },
      };
    });
  } finally {
    journal.close();
  }
  // A build that did not finish says why it stopped. Its saved run records the reason.
  const failure = view.journey?.recentFailure;
  return {
    ...view,
    buildStop: failure?.action === "Build" ? await recentBuildStop(root, id, failure.at) : null,
  };
}

/** The problem of one setup item in words, or null when the item is ready. */
async function setupProblem(check: () => Promise<string | null>): Promise<string | null> {
  try {
    return await check();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const SETUP_GUIDE = "Follow the native execution setup in docs/DEVELOPMENT.md.";

/**
 * The local prerequisites of runs. With a Studio adapter, the isolated account item also runs the
 * read-only Studio preflight, which uses SSH and never starts Studio. Settings runs it.
 */
export async function localReadiness(
  root: string,
  studio?: Pick<StudioAdapter, "preflight">,
): Promise<LocalReadinessCheck[]> {
  const exists = async (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );
  let slots = 0;
  const isolated = await setupProblem(async () => {
    slots = studioSlots(await readStudioWorkers(root)).length;
    if (!studio) return null;
    const problems = await studio.preflight(root);
    return problems.length ? problems.join(" ") : null;
  });
  const keyFile = resolve(root, ".basalt-evals/native-worker/isolated-public-key.pem");
  const signing = await setupProblem(async () => {
    const found = await lstat(keyFile).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (!found)
      return `Basalt cannot find the public key of the isolated Studio account at ${keyFile}.`;
    const bytes = await readBoundedRegularFile(keyFile, 16_384, "worker public key");
    return createPublicKey(bytes).asymmetricKeyType === "ed25519"
      ? null
      : `The public key at ${keyFile} is not an Ed25519 key.`;
  });
  const studioInstalled = await exists("/Applications/RobloxStudio.app");
  const connectorInstalled = await exists(
    resolve(homedir(), "Documents/Roblox/Plugins/BasaltEvalStudioPlugin.rbxmx"),
  );
  // A problem sentence that already names the setup guide needs no second reference to it.
  const help = (problem: string) =>
    problem.includes("docs/DEVELOPMENT.md") ? problem : `${problem} ${SETUP_GUIDE}`;
  return [
    {
      name: "Model provider",
      ready: !!process.env.OPENROUTER_API_KEY?.trim(),
      help: process.env.OPENROUTER_API_KEY?.trim()
        ? "The OpenRouter API key is set."
        : "Set OPENROUTER_API_KEY in the repository .env file and restart the console. A value exported in your shell takes priority over the .env file.",
    },
    {
      name: "Roblox Studio",
      ready: studioInstalled,
      help: studioInstalled
        ? "Roblox Studio is installed."
        : "Install Roblox Studio on this Mac. Basalt uses it to record observations.",
    },
    {
      name: "Basalt connector",
      ready: connectorInstalled,
      help: connectorInstalled
        ? "The connector is installed. Run npm run plugin:build again after you update Basalt."
        : "Run npm run plugin:build in the repository to install the connector.",
    },
    {
      name: "Isolated Studio account",
      ready: isolated === null,
      help:
        isolated === null
          ? `The isolated Studio setup has ${slots} Studio ${slots === 1 ? "slot" : "slots"}${studio ? " and passed its check" : ""}. Each run checks Studio again when it starts.`
          : help(isolated),
    },
    {
      name: "Evidence signing key",
      ready: signing === null,
      help:
        signing === null
          ? "The evidence signing key is in place. Basalt uses it to verify evidence from Studio."
          : help(signing),
    },
  ];
}
