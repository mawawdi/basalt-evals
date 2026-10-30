// The isolated worker loads this module. It must not load the operation journal.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { publishImmutable } from "../../artifact-store/src/atomic.js";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { contentHash } from "../../contracts/src/index.js";

/** The recorder takes 2 frames each second, for at most 30 minutes and 256 MiB. */
export const SCREEN_RECORDING_LIMITS = {
  framesPerSecond: 2,
  maxSeconds: 30 * 60,
  maxBytes: 256 * 1024 * 1024,
} as const;
/** The recording of a job, in its diagnostics folder beside the signed `studio` folder. */
export const SCREEN_RECORDING_FILE = "diagnostics/screen.mp4";

/** The signed manifest records this result. A failed recording never fails the job. */
export interface ScreenRecordingResult {
  status: "recorded" | "failed" | "off";
  failure: string | null;
  bytes: number | null;
  hash: string | null;
}

export const SCREEN_RECORDING_OFF: ScreenRecordingResult = {
  status: "off",
  failure: null,
  bytes: null,
  hash: null,
};

export interface ScreenRecorder {
  /** Give the recorder the Studio processes of the job. It records only their windows. */
  update(pids: readonly number[]): void;
  /** Finish the recording. This never throws. */
  stop(): Promise<ScreenRecordingResult>;
}

const failed = (reason: unknown): ScreenRecordingResult => ({
  status: "failed",
  failure: (reason instanceof Error ? reason.message : String(reason)).slice(0, 500),
  bytes: null,
  hash: null,
});

/** The SHA-256 of a regular file, read as a stream. */
async function fileHash(file: string): Promise<{ hash: string; bytes: number }> {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error("The recording is not a regular file");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file, { flags: "r" }) as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > SCREEN_RECORDING_LIMITS.maxBytes)
      throw new Error("The recording is larger than 256 MiB");
    hash.update(chunk);
  }
  return { hash: hash.digest("hex"), bytes };
}

/**
 * Start the screen recorder of one job. The recorder reads the owned Studio process IDs from its
 * standard input, and it finishes when its standard input closes. Every failure becomes a failed
 * result, so a recording never changes the outcome of the job.
 */
export async function startScreenRecording(input: {
  /** The job folder. The recording goes to its diagnostics folder. */
  jobDirectory: string;
  /** Compiles the recorder and gives its executable. */
  executable: () => Promise<string>;
  environment: NodeJS.ProcessEnv;
}): Promise<ScreenRecorder> {
  const output = resolve(input.jobDirectory, SCREEN_RECORDING_FILE);
  let child: ReturnType<typeof spawn>;
  let exited: Promise<{ code: number | null; error: Error | null }>;
  try {
    await assertSafeAbsoluteDirectory(input.jobDirectory);
    await mkdir(resolve(input.jobDirectory, "diagnostics"), { mode: 0o700 });
    const executable = await input.executable();
    const log = await open(resolve(input.jobDirectory, "diagnostics/recorder.log"), "wx", 0o600);
    child = spawn(
      executable,
      [
        output,
        String(SCREEN_RECORDING_LIMITS.maxSeconds),
        String(SCREEN_RECORDING_LIMITS.maxBytes),
        String(SCREEN_RECORDING_LIMITS.framesPerSecond),
      ],
      { cwd: input.jobDirectory, env: input.environment, stdio: ["pipe", log.fd, log.fd] },
    );
    exited = new Promise((done) => {
      let settled = false;
      // A spawn failure can end without a close event, so each event can settle the wait.
      const settle = (code: number | null, error: Error | null) => {
        if (settled) return;
        settled = true;
        void log.close().finally(() => done({ code, error }));
      };
      child.once("error", (cause) => settle(null, cause));
      child.once("close", (code) => settle(code, null));
    });
    // A recorder that stops early must not end the job with an unhandled pipe error.
    child.stdin!.on("error", () => undefined);
  } catch (error) {
    const result = failed(error);
    return { update() {}, stop: async () => result };
  }
  let last = "";
  return {
    update(pids) {
      const line = [...pids].sort((a, b) => a - b).join(" ");
      if (line === last || !child.stdin!.writable) return;
      last = line;
      child.stdin!.write(`${line}\n`);
    },
    async stop() {
      try {
        child.stdin!.end();
        // The wait timers do not keep the worker process alive after its job.
        const timeout = (milliseconds: number) =>
          delay(milliseconds, "timeout" as const, { ref: false });
        let outcome = await Promise.race([exited, timeout(15_000)]);
        if (outcome === "timeout") {
          child.kill("SIGTERM");
          outcome = await Promise.race([exited, timeout(5_000)]);
          if (outcome === "timeout") {
            child.kill("SIGKILL");
            outcome = await exited;
          }
          return failed("The screen recorder did not finish within 15 seconds");
        }
        if (outcome.error) return failed(outcome.error);
        if (outcome.code !== 0)
          return failed(
            `The screen recorder stopped with exit code ${outcome.code}. Read diagnostics/recorder.log.`,
          );
        return { status: "recorded", failure: null, ...(await fileHash(output)) };
      } catch (error) {
        return failed(error);
      }
    },
  };
}

/**
 * Publish a transferred recording beside the session, outside its signed tree. The bytes must
 * have the size and the hash that the signed manifest recorded.
 */
export async function publishScreenRecording(input: {
  staged: string;
  /** The folder that holds the session folder, for example the folder of a capture cell. */
  directory: string;
  recording: ScreenRecordingResult;
  lane: number;
  worker: string;
}): Promise<void> {
  if (input.recording.status !== "recorded" || !input.recording.hash)
    throw new Error("The signed manifest has no recording");
  const bytes = await readBoundedRegularFile(
    input.staged,
    SCREEN_RECORDING_LIMITS.maxBytes,
    "screen recording",
  );
  const hash = contentHash(bytes);
  if (hash !== input.recording.hash || bytes.length !== input.recording.bytes)
    throw new Error("The transferred screen recording differs from the signed manifest");
  const diagnostics = resolve(input.directory, "diagnostics");
  await mkdir(diagnostics, { recursive: true, mode: 0o700 });
  await assertSafeAbsoluteDirectory(diagnostics);
  await publishImmutable(resolve(diagnostics, "screen.mp4"), bytes);
  await publishImmutable(
    resolve(diagnostics, "screen.json"),
    JSON.stringify({
      schema: "basalt-evals/screen-recording",
      lane: input.lane,
      worker: input.worker,
      hash,
      bytes: bytes.length,
    }) + "\n",
  );
}
