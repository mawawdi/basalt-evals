import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import next from "next";
import { createSharedApiFixture } from "../dist/test/shared-api-environment.js";
import { fixtureInput } from "../dist/test/shared-api-fixture.js";

// An isolated, offline workspace for a real first-use participant. It submits no
// answers and performs no navigation on the participant's behalf.
const root = resolve(import.meta.dirname, "..");
const fixture = await createSharedApiFixture();
await writeFile(
  resolve(fixture.root, ".basalt-evals/synthetic-scene"),
  "Synthetic usability evidence",
);
await writeFile(
  resolve(fixture.root, ".basalt-evals/synthetic-failure.json"),
  JSON.stringify({ kind: "malformed_batch" }),
);
process.env.BASALT_REPOSITORY_ROOT = fixture.root;
process.env.NEXT_TELEMETRY_DISABLED = "1";
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  const url = new URL(typeof input === "string" ? input : (input.url ?? input));
  if (!["127.0.0.1", "localhost"].includes(url.hostname))
    throw new Error("External network prohibited in usability workspace");
  return originalFetch(input, ...args);
};
const app = next({ dev: false, dir: resolve(root, "apps/console"), hostname: "127.0.0.1" });
await app.prepare();
const render = app.getRequestHandler();
const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/api/")) return render(req, res);
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const response = await fixture.handle(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const directory = resolve(
  root,
  ".basalt-evals/acceptance",
  "usability-" + new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(directory, { recursive: true });
const record = {
  origin,
  root: fixture.root,
  createdAt: new Date().toISOString(),
  synthetic: true,
  realModelCalls: 0,
  realStudioCalls: 0,
  participant: null,
  firstUse: null,
  tasks: [
    {
      task: "Compare two models using these supplied evaluation inputs and a $5 synthetic spending limit.",
      inputs: fixtureInput,
    },
    { task: "Explain what the spending limit and any displayed charges mean." },
    { task: "Find a failed criterion and inspect the evidence used to judge it." },
    {
      task: "Complete a review with at most three questions using your own assessment, or abstain when evidence is insufficient.",
    },
  ].map((task) => ({
    ...task,
    completed: null,
    activeSeconds: null,
    assistance: [],
    errors: [],
    confusion: [],
  })),
  manualAccessibility: { actualZoom200: null, safariVoiceOver: null, notes: [] },
  limitations:
    "No walkthrough. A coached retry is not an uncoached pass. Synthetic usability labels do not establish calibration or satisfy live/research gates.",
};
await writeFile(resolve(directory, "session.json"), JSON.stringify(record, null, 2) + "\n");
process.stdout.write(
  `Isolated synthetic workspace: ${origin}\nParticipant record: ${directory}/session.json\n`,
);
async function stop() {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await app.close();
  process.stdout.write(`Retained usability evidence: ${fixture.root}\n`);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
