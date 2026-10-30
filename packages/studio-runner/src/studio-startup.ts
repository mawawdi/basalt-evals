import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { compareCodeUnits, contentHash } from "../../contracts/src/index.js";

const LOG_NAME = /_(\d{8}T\d{6}Z)_Studio_[^/]+_last\.log$/;
const MAX_PROCESS_LOG = 8 * 1024 * 1024;
/** The command line of a Studio process is in the first lines of its log. */
const LOG_HEAD_BYTES = 64 * 1024;

interface StudioStartupProcess {
  logFile: string;
  logHash: string;
  role: string;
  launchIntent: string | null;
  placeTask: string | null;
  playClient: boolean;
  networkAccepted: boolean;
}

interface StudioStartupSummary {
  checkedAt: string;
  classification: "server_opened_as_edit" | "client_opened_as_edit" | null;
  applicationUpdate: { logFile: string; logHash: string } | null;
  processes: StudioStartupProcess[];
  diagnosticError: string | null;
}

/** Preserve each child process's requested role and actual DataModel task. */
function parseStudioStartupLog(
  name: string,
  bytes: Buffer,
  place: string,
  playSessionGuid?: string,
): StudioStartupProcess | null {
  const text = bytes.toString("utf8");
  const command = text.split("\n", 12).find((line) => line.includes("/RobloxStudio "));
  if (!command || !command.includes(`-localProjectFile ${place} `)) return null;
  if (playSessionGuid && !command.includes(`-playTestSessionGuid ${playSessionGuid}`)) return null;
  const role = /-instanceId (StudioServer|StudioPlayer_\d+)/.exec(command)?.[1];
  if (!role) return null;
  return {
    logFile: basename(name),
    logHash: contentHash(bytes),
    role,
    launchIntent: /Studio Launch Intent is (\w+)/.exec(text)?.[1] ?? null,
    placeTask: /PlaceManager::createAndShowIDEDoc with task (\w+)/.exec(text)?.[1] ?? null,
    playClient: text.includes("Setting StudioGameStateType to StudioGameStateType_PlayClient"),
    networkAccepted: text.includes("Connection accepted from 127.0.0.1"),
  };
}

/** Collect bounded, redacted startup facts; raw Roblox logs stay on the Mac. */
export async function collectStudioStartup(input: {
  place: string;
  startedAtMs: number;
  finishedAtMs: number;
  logsDirectory?: string;
  playSessionGuid?: string;
  expectChildren?: boolean;
  scriptFile?: string;
}): Promise<StudioStartupSummary> {
  const summary: StudioStartupSummary = {
    checkedAt: new Date().toISOString(),
    classification: null,
    applicationUpdate: null,
    processes: [],
    diagnosticError: null,
  };
  const directory = input.logsDirectory ?? resolve(homedir(), "Library/Logs/Roblox");
  // Studio lanes share this folder. A log belongs to this job only if its command line names
  // the place file of the job or the entry script of this step. Read only the head of the other
  // logs, and never cap the candidates, so the logs of another lane cannot hide a log of this job.
  const ownMarkers = [
    `-localProjectFile ${input.place} `,
    ...(input.scriptFile ? [`--runScriptFile ${input.scriptFile} `] : []),
  ];
  try {
    const names = await readdir(directory);
    const candidates = names
      .filter((name) => {
        const match = LOG_NAME.exec(name);
        if (!match) return false;
        const timestamp = Date.parse(
          match[1]!.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"),
        );
        return timestamp >= input.startedAtMs - 5000 && timestamp <= input.finishedAtMs + 5000;
      })
      .sort()
      .reverse();
    for (const name of candidates) {
      const file = resolve(directory, name);
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let parsed: StudioStartupProcess | null;
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > MAX_PROCESS_LOG) continue;
        const head = Buffer.alloc(Math.min(LOG_HEAD_BYTES, metadata.size));
        await handle.read(head, 0, head.length, 0);
        const headText = head.toString("utf8");
        if (!ownMarkers.some((marker) => headText.includes(marker))) continue;
        const bytes = await handle.readFile();
        const log = bytes.toString("utf8");
        if (
          input.scriptFile &&
          log.includes(`--runScriptFile ${input.scriptFile} `) &&
          (log.includes("About to exit application due to update") ||
            log.includes("interruptWithApplicationUpdateIfAvailable began update true"))
        )
          summary.applicationUpdate ??= { logFile: name, logHash: contentHash(bytes) };
        parsed = parseStudioStartupLog(name, bytes, input.place, input.playSessionGuid);
      } finally {
        await handle.close();
      }
      if (parsed) summary.processes.push(parsed);
    }
    summary.processes.sort((a, b) => compareCodeUnits(a.role, b.role));
    if (summary.processes.length === 0 && input.expectChildren !== false)
      summary.diagnosticError = "No matching process-specific Studio logs were found";
    if (
      summary.processes.some(
        (item) =>
          item.role === "StudioServer" &&
          item.launchIntent === "StartServer" &&
          item.placeTask === "EditFile",
      )
    )
      summary.classification = "server_opened_as_edit";
    else if (
      summary.processes.some(
        (item) =>
          item.role.startsWith("StudioPlayer_") &&
          item.launchIntent === "StartClient" &&
          item.placeTask === "EditFile",
      )
    )
      summary.classification = "client_opened_as_edit";
  } catch (error) {
    summary.diagnosticError = error instanceof Error ? error.message : String(error);
  }
  return summary;
}
