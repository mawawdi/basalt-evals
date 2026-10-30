import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createOperationApi } from "../packages/operator/src/api.js";
import { fixtureAdapters, seedModelRegistry } from "./shared-api-fixture.js";
import { implementationFixture } from "./implementation-fixture.js";
import { OperationJournal } from "../packages/artifact-store/src/journal.js";
import { processAlive } from "../packages/operator/src/process-owner.js";
import { stopSavedOperation } from "../packages/operator/src/service.js";
import { setTimeout as delay } from "node:timers/promises";

/** Real immutable files, clean fixture implementation, journal and owned child; external work is synthetic. */
export async function createSharedApiFixture() {
  const project = process.cwd();
  const compiled = resolve(import.meta.dirname, "..");
  // Fixtures live outside the repository so an interrupted run cannot leave copies in its
  // workspace data; the copied code resolves dependencies through a link to the real install.
  const root = await mkdtemp(resolve(tmpdir(), "basalt-offline-api-"));
  try {
    await symlink(resolve(project, "node_modules"), resolve(root, "node_modules"), "dir");
    await cp(resolve(project, "packages"), resolve(root, "packages"), { recursive: true });
    await cp(resolve(compiled, "packages"), resolve(root, "dist/packages"), { recursive: true });
    await mkdir(resolve(root, "studies"));
    await cp(
      resolve(project, "studies/operator-config.json"),
      resolve(root, "studies/operator-config.json"),
    );
    await cp(resolve(project, "studies/harnesses"), resolve(root, "studies/harnesses"), {
      recursive: true,
    });
    // Explain failures reads the authored questions.
    await cp(
      resolve(project, "studies/failure-questions.md"),
      resolve(root, "studies/failure-questions.md"),
    );
    await writeFile(resolve(root, "package.json"), JSON.stringify({ type: "module" }));
    await mkdir(resolve(root, "dist/packages/offline"), { recursive: true });
    const fixture = (
      await readFile(resolve(compiled, "test/shared-api-fixture.js"), "utf8")
    ).replaceAll('"../packages/', '"../');
    await writeFile(resolve(root, "dist/packages/offline/fixture.js"), fixture);
    await writeFile(
      resolve(root, "dist/packages/offline/worker.js"),
      'import {driveOperation} from "../operator/src/driver.js"; import {fixtureAdapters} from "./fixture.js";\n' +
        'globalThis.fetch=async()=>{throw new Error("External network prohibited in offline integration");};\n' +
        "const [root,id,token]=process.argv.slice(2); await driveOperation(root,id,token,fixtureAdapters(root));\n",
    );
    await implementationFixture(root);
    await mkdir(resolve(root, ".basalt-evals/native-worker"), { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    await writeFile(
      resolve(root, ".basalt-evals/synthetic-private-key.pem"),
      privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    await writeFile(
      resolve(root, ".basalt-evals/native-worker/isolated-public-key.pem"),
      publicKey.export({ type: "spki", format: "pem" }),
    );
    await seedModelRegistry(root);
    const handle = createOperationApi({
      root,
      adapters: fixtureAdapters(root),
      workerModule: "dist/packages/offline/worker.js",
    });
    let disposed = false;
    return {
      root,
      handle,
      async dispose() {
        if (disposed) return;
        const stopping = new Set<string>();
        // A loaded machine makes a driver slow to stop. Only a stall fails: the set of active
        // drivers stays the same for 60 s.
        let last = "";
        let changedAt = performance.now();
        for (;;) {
          const journal = await OperationJournal.open(root);
          const active: string[] = [];
          let cursor = "";
          for (;;) {
            const owners = journal.recordPage("drivers", cursor);
            if (!owners.length) break;
            for (const { id, value } of owners) {
              const owner = value as { active: boolean; pid: number };
              if (owner.active && processAlive(owner.pid)) active.push(id);
            }
            cursor = owners.at(-1)!.id;
          }
          journal.close();
          if (!active.length) {
            await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            disposed = true;
            return;
          }
          const current = active.sort().join(",");
          if (current !== last) {
            last = current;
            changedAt = performance.now();
          } else if (performance.now() - changedAt > 60_000)
            throw new Error("Synthetic driver is still active; retaining its owned fixture");
          for (const id of active) {
            if (stopping.has(id)) continue;
            stopping.add(id);
            // A failed assertion must not leave a synthetic worker or its copied checkout behind.
            // Completion can race this request; the next ownership read is authoritative.
            await stopSavedOperation(root, id, "Synthetic fixture teardown").catch(() => {});
          }
          await delay(100);
        }
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
