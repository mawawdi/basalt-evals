import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, constants, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import type { StudioSession } from "./session.js";
import { isRecord } from "../../contracts/src/validation.js";

type Data = Record<string, string | number | boolean | null>;
interface PluginTraceEvent {
  sequence: number;
  at: string;
  stage: string;
  trialId: string;
  data: Data;
}
/**
 * Eight clients that sample every 500 ms for 30 minutes write about 29,000 sample events of
 * about 700 bytes, or about 20 MB. The sequence assessment reads the samples and the state
 * changes from this trace, so a trace that reaches the limit makes the assessment insufficient.
 */
export const MAX_TRACE_BYTES = 32 * 1024 * 1024;
const TRIAL = /^trial-[a-f0-9]{24}$/;
const CLIENT = /^[a-f0-9]{32}$/;

export function assertTrialId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !TRIAL.test(value)) throw new Error("Invalid trace trial ID");
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Diagnostics only: one bounded append-only file per server start. No request
 * bodies, auth headers, bootstrap Source, model keys or window pixels are logged.
 * Synchronous small appends preserve order and errors across immediate Stop.
 */
export async function createStudioTrace(
  directory: string,
  session: Pick<
    StudioSession,
    | "id"
    | "token"
    | "treatmentId"
    | "candidateHash"
    | "collectionPlanHash"
    | "connectorSourceHash"
    | "connectorArtifactHash"
    | "expectedStudioVersion"
    | "place"
  >,
) {
  await assertSafeAbsoluteDirectory(directory);
  const traces = resolve(directory, "traces");
  await mkdir(traces, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await assertSafeAbsoluteDirectory(traces);
  const file = resolve(
    traces,
    `trace-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomBytes(6).toString("hex")}.jsonl`,
  );
  const fd = openSync(
    file,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_NOFOLLOW,
    0o600,
  );
  let sequence = 0;
  let bytes = 0;
  let closed = false;
  let failed = false;
  let pendingLaunch: { id: string; expires: number } | undefined;
  const clients = new Map<string, number>();
  const redact = (text: string) =>
    text
      .replaceAll(session.token, "[REDACTED]")
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
      .slice(0, 4096);

  function emit(
    source: "host" | "plugin",
    stage: string,
    data: Data = {},
    trialId: string | null = null,
    client?: { id: string; sequence: number; at: string },
  ) {
    if (closed || failed) return false;
    const clean = Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        typeof value === "string" ? redact(value) : value,
      ]),
    );
    const event = {
      schema: "basalt-evals/studio-trace",
      sequence: ++sequence,
      at: new Date().toISOString(),
      source,
      stage,
      trialId,
      ...(client ? { client } : {}),
      data: clean,
    };
    try {
      const line = `${JSON.stringify(event)}\n`;
      if (bytes + Buffer.byteLength(line) > MAX_TRACE_BYTES - 1024) {
        appendFileSync(
          fd,
          `${JSON.stringify({ ...event, source: "host", stage: "trace.limit_reached", data: {} })}\n`,
        );
        throw new Error("The Studio trace reached its size limit of 32 MiB.");
      }
      appendFileSync(fd, line);
      bytes += Buffer.byteLength(line);
      return true;
    } catch (error) {
      failed = true;
      process.stderr.write(`Basalt trace unavailable (${file}): ${redact(String(error))}\n`);
      return false;
    }
  }

  if (
    !emit("host", "server.started", {
      sessionId: session.id,
      placeFile: resolve(directory, session.place.file),
      treatmentId: session.treatmentId,
      candidateHash: session.candidateHash,
      collectionPlanHash: session.collectionPlanHash,
      connectorSourceHash: session.connectorSourceHash,
      connectorArtifactHash: session.connectorArtifactHash,
      expectedStudioVersion: session.expectedStudioVersion,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    })
  ) {
    closeSync(fd);
    throw new Error("Cannot initialize Studio trace");
  }

  return {
    file,
    host: (stage: string, data: Data = {}, trialId: string | null = null) =>
      emit("host", stage, data, trialId),
    begin(body: unknown) {
      if (
        !isRecord(body) ||
        !exact(body, ["clientId", "mode"]) ||
        typeof body.clientId !== "string" ||
        !CLIENT.test(body.clientId) ||
        (body.mode !== "launch" && body.mode !== "capture")
      )
        throw new Error("Invalid trial start");
      const joined = body.mode === "capture" && pendingLaunch && pendingLaunch.expires > Date.now();
      const trialId = joined ? pendingLaunch!.id : `trial-${randomBytes(12).toString("hex")}`;
      pendingLaunch =
        body.mode === "launch" ? { id: trialId, expires: Date.now() + 120_000 } : undefined;
      if (
        !emit(
          "host",
          joined ? "trial.client_attached" : "trial.started",
          { clientId: body.clientId, mode: body.mode },
          trialId,
        )
      )
        throw new Error("Trace is unavailable; restart the local server");
      return trialId;
    },
    continueLaunch(trialId: string, clientId: string) {
      assertTrialId(trialId);
      if (!CLIENT.test(clientId)) throw new Error("Invalid native client ID");
      pendingLaunch = { id: trialId, expires: Date.now() + 120_000 };
      if (!emit("host", "trial.step_started", { clientId }, trialId))
        throw new Error("Trace is unavailable; restart the local server");
      return trialId;
    },
    plugin(body: unknown) {
      if (
        !isRecord(body) ||
        !exact(body, ["clientId", "events"]) ||
        typeof body.clientId !== "string" ||
        !CLIENT.test(body.clientId) ||
        !Array.isArray(body.events) ||
        body.events.length < 1 ||
        body.events.length > 16
      )
        throw new Error("Invalid plugin trace batch");
      let previous = 0;
      for (const event of body.events) {
        if (
          !isRecord(event) ||
          !exact(event, ["sequence", "at", "stage", "trialId", "data"]) ||
          typeof event.sequence !== "number" ||
          !Number.isSafeInteger(event.sequence) ||
          event.sequence <= previous ||
          typeof event.at !== "string" ||
          event.at.length > 32 ||
          !event.at.endsWith("Z") ||
          !Number.isFinite(Date.parse(event.at)) ||
          typeof event.stage !== "string" ||
          !/^[a-z][a-z0-9_.]{0,63}$/.test(event.stage) ||
          !isRecord(event.data) ||
          Object.keys(event.data).length > 16
        )
          throw new Error("Invalid plugin trace event");
        if (event.trialId !== "") assertTrialId(event.trialId);
        for (const [key, value] of Object.entries(event.data)) {
          if (
            !/^[a-zA-Z][a-zA-Z0-9]{0,47}$/.test(key) ||
            !(
              value === null ||
              typeof value === "boolean" ||
              (typeof value === "number" && Number.isFinite(value)) ||
              (typeof value === "string" && value.length <= 4096)
            )
          )
            throw new Error("Invalid trace detail");
        }
        previous = event.sequence;
      }
      if (!clients.has(body.clientId) && clients.size >= 64)
        throw new Error("Trace client limit reached; restart the server");
      const accepted: PluginTraceEvent[] = [];
      for (const event of body.events as PluginTraceEvent[]) {
        if (event.sequence <= (clients.get(body.clientId) ?? 0)) continue;
        if (
          !emit("plugin", event.stage, event.data, event.trialId || null, {
            id: body.clientId,
            sequence: event.sequence,
            at: event.at,
          })
        )
          throw new Error("Trace is unavailable; restart the local server");
        clients.set(body.clientId, event.sequence);
        accepted.push(event);
        if (
          (event.stage === "trial.failed" || event.stage === "play.finished") &&
          pendingLaunch?.id === event.trialId
        )
          pendingLaunch = undefined;
      }
      return accepted;
    },
    close() {
      if (closed) return;
      emit("host", "server.stopped");
      closed = true;
      closeSync(fd);
    },
  };
}
