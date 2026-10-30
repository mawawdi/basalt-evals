import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { publishImmutable } from "../../artifact-store/src/atomic.js";
import { cleanImplementationCommit } from "../../artifact-store/src/implementation.js";
import {
  compareCodeUnits,
  contentHash,
  hashJson,
  isSafeRelativePath,
  MAX_NATIVE_ARTIFACTS,
  MAX_NATIVE_MANIFEST_BYTES,
  MAX_NATIVE_TOTAL_BYTES,
} from "../../contracts/src/index.js";
import { ExecutionFault } from "../../contracts/src/failure.js";
import { loadStudioSession } from "./index.js";
import {
  claimNativeLane,
  holdNativeLane,
  LANE_RELEASE_FILE,
  onlyClaimOf,
  releaseNativeLane,
} from "./native-lane.js";
import { studioLaneOfConnectorUrl } from "./studio-lanes.js";
import { JOB_FOOTPRINT_FILE, parseJobFootprint, recordJobFootprint } from "./lane-headroom.js";
import {
  readStudioWorkers,
  shellQuote,
  workerScp as scp,
  workerSsh as ssh,
  workerSshOptions as sshOptions,
  writeTemplateRecord,
  type PreferencesTemplateRecord,
  type StudioWorker,
} from "./workers.js";
import {
  publishScreenRecording,
  SCREEN_RECORDING_FILE,
  SCREEN_RECORDING_LIMITS,
} from "./screen-recording.js";
import { assertSequencePlan, type SequencePlan } from "./sequence.js";
import {
  verifyWorkerArtifacts,
  verifyWorkerSignature,
  type SignedWorkerManifest,
} from "./native-worker.js";

const execFile = promisify(execFileCallback);
const SHARED_ROOT = "/Users/Shared";
const REMOTE_JOB_FILE = "native/remote-job.json";

interface RemoteStudioJob {
  schema: "basalt-evals/remote-studio-job";
  user: string;
  remote: string;
  sessionId: string;
  candidateHash: string;
  collectionPlanHash: string;
  runnerHash: string;
}

/** Content identity of every regular file below a directory, in code-unit path order. */
async function directoryContent(root: string, relative = ""): Promise<string[]> {
  const rows: string[] = [];
  for (const entry of (await readdir(resolve(root, relative), { withFileTypes: true })).sort(
    (a, b) => compareCodeUnits(a.name, b.name),
  )) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("Worker bundle input contains a symbolic link");
    if (entry.isDirectory()) rows.push(...(await directoryContent(root, path)));
    else if (entry.isFile())
      rows.push(`${path}:${contentHash(await readFile(resolve(root, path)))}`);
  }
  return rows;
}

const BUNDLE_FILES = [
  "tsconfig.json",
  "package-lock.json",
  "packages/studio-runner/native-entry.luau",
  "packages/studio-runner/native-focus.swift",
  "packages/studio-runner/native-recorder.swift",
  "scripts/evals-worker-entry.mjs",
];
const BUNDLE_DEPENDENCIES = ["pngjs", "jpeg-js"];

/**
 * Compile the worker once per exact input and reuse it: the bundle is keyed by every compiler
 * input, published by an atomic rename, verified on reuse and never modified afterwards. Only
 * packages are compiled, so console, test or documentation edits cannot affect a Studio job.
 */
async function workerBundle(repositoryRoot: string): Promise<string> {
  const inputs = hashJson({
    packages: (await directoryContent(resolve(repositoryRoot, "packages"))).filter((row) =>
      /\.ts:/u.test(row),
    ),
    files: await Promise.all(
      BUNDLE_FILES.map(async (file) => contentHash(await readFile(resolve(repositoryRoot, file)))),
    ),
  });
  const bundle = resolve(SHARED_ROOT, `basalt-evals-worker-${inputs.slice(0, 32)}`);
  const recorded = await readFile(resolve(bundle, "bundle.json"), "utf8").then(
    (text) => JSON.parse(text) as { inputs: string; content: string },
    () => null,
  );
  if (recorded) {
    const content = hashJson(
      (await directoryContent(bundle)).filter((row) => !row.startsWith("bundle.json:")),
    );
    if (recorded.inputs === inputs && recorded.content === content) return bundle;
    await rm(bundle, { recursive: true, force: true });
  }
  const staging = await mkdtemp(resolve(SHARED_ROOT, "basalt-evals-worker-staging-"));
  try {
    await chmod(staging, 0o755);
    await writeFile(
      resolve(staging, "tsconfig.json"),
      JSON.stringify({
        extends: resolve(repositoryRoot, "tsconfig.json"),
        compilerOptions: {
          rootDir: repositoryRoot,
          outDir: resolve(staging, "dist"),
          declaration: false,
          sourceMap: false,
        },
        include: [resolve(repositoryRoot, "packages/**/*.ts")],
        exclude: [],
      }),
    );
    await execFile(
      process.execPath,
      [resolve(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
      { cwd: staging, maxBuffer: 1024 * 1024 },
    );
    await rm(resolve(staging, "tsconfig.json"));
    await mkdir(resolve(staging, "node_modules"));
    for (const dependency of BUNDLE_DEPENDENCIES)
      await cp(
        resolve(repositoryRoot, "node_modules", dependency),
        resolve(staging, "node_modules", dependency),
        { recursive: true },
      );
    await mkdir(resolve(staging, "packages/studio-runner"), { recursive: true });
    for (const file of ["native-entry.luau", "native-focus.swift", "native-recorder.swift"])
      await copyFile(
        resolve(repositoryRoot, "packages/studio-runner", file),
        resolve(staging, "packages/studio-runner", file),
      );
    await copyFile(
      resolve(repositoryRoot, "scripts/evals-worker-entry.mjs"),
      resolve(staging, "worker-entry.mjs"),
    );
    await writeFile(resolve(staging, "package.json"), '{"type":"module"}\n', { flag: "wx" });
    await writeFile(
      resolve(staging, "bundle.json"),
      JSON.stringify({ inputs, content: hashJson(await directoryContent(staging)) }),
      { flag: "wx" },
    );
    await rename(staging, bundle).catch(async (error: NodeJS.ErrnoException) => {
      // Another admission published the same inputs first; its verified copy is identical.
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code ?? "") || !(await lstat(bundle)))
        throw error;
      await rm(staging, { recursive: true, force: true });
    });
    return bundle;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export function isolatedWorkerArtifactPaths(receipt: SignedWorkerManifest): string[] {
  if (
    receipt.manifest.schema !== "basalt-evals/native-worker" ||
    !Array.isArray(receipt.manifest.artifacts) ||
    receipt.manifest.artifacts.length > MAX_NATIVE_ARTIFACTS
  )
    throw new Error("Invalid isolated worker manifest");
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const artifact of receipt.manifest.artifacts) {
    if (
      !artifact ||
      typeof artifact.file !== "string" ||
      !isSafeRelativePath(artifact.file) ||
      !/^[A-Za-z0-9._/-]+$/.test(artifact.file) ||
      paths.has(artifact.file) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 0 ||
      artifact.bytes > 32 * 1024 * 1024 ||
      typeof artifact.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifact.hash)
    )
      throw new Error("Invalid isolated worker artifact path or identity");
    totalBytes += artifact.bytes;
    if (totalBytes > MAX_NATIVE_TOTAL_BYTES)
      throw new Error("Native evidence exceeds its total byte allowance");
    paths.add(artifact.file);
  }
  return [...paths];
}

/** One connection per bounded group, preserving directories and exact signed membership. */
export function isolatedArtifactBatches(receipt: SignedWorkerManifest) {
  const groups = new Map<string, string[]>();
  for (const file of isolatedWorkerArtifactPaths(receipt)) {
    const directory = dirname(file);
    if (!groups.has(directory)) groups.set(directory, []);
    groups.get(directory)!.push(file);
  }
  return [...groups].flatMap(([directory, files]) =>
    Array.from({ length: Math.ceil(files.length / 64) }, (_, index) => ({
      directory,
      files: files.slice(index * 64, (index + 1) * 64),
    })),
  );
}

export function isolatedBatchScript(files: string[], remote: string, staging: string): string {
  const quote = (value: string) => {
    if (/[\r\n\0]/u.test(value)) throw new Error("Invalid SFTP path");
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  };
  if (
    !files.length ||
    files.length > 64 ||
    files.some((file) => !isSafeRelativePath(file) || !/^[A-Za-z0-9._/-]+$/.test(file))
  )
    throw new Error("Invalid signed transfer batch");
  return (
    files
      .map((file) => `get ${quote(`${remote}/${file}`)} ${quote(resolve(staging, file))}`)
      .join("\n") + "\n"
  );
}

/** Stop cancels execution, not the read-only receipt recovery needed to release its lane. */
export async function awaitNativeCancellation<T>(input: {
  cancel: (signal: AbortSignal) => Promise<void>;
  ready: (signal: AbortSignal) => Promise<boolean>;
  read: (signal: AbortSignal) => Promise<T>;
  recoverySignal?: AbortSignal;
}): Promise<T> {
  const signal = input.recoverySignal ?? AbortSignal.timeout(60_000);
  signal.throwIfAborted();
  let deliveryError: unknown;
  try {
    await input.cancel(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
  } catch (error) {
    deliveryError = error;
  }
  try {
    while (!(await input.ready(signal))) await delay(250, undefined, { signal });
    return await input.read(signal);
  } catch (error) {
    throw new Error(
      `Basalt cannot confirm that Studio stopped. Details: ${String(deliveryError ?? error)}`,
      { cause: error },
    );
  }
}

/** Prepared inputs may also appear in the worker's signed output. Never overwrite them. */
export async function importSignedWorkerArtifact(
  staging: string,
  sessionDirectory: string,
  artifact: SignedWorkerManifest["manifest"]["artifacts"][number],
): Promise<void> {
  const destination = resolve(sessionDirectory, artifact.file);
  await mkdir(dirname(destination), { recursive: true });
  const bytes = await readBoundedRegularFile(
    resolve(staging, artifact.file),
    artifact.bytes,
    "signed worker artifact",
  );
  if (bytes.length !== artifact.bytes || contentHash(bytes) !== artifact.hash)
    throw new Error(`Transferred artifact differs from signed worker output: ${artifact.file}`);
  try {
    await publishImmutable(destination, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readBoundedRegularFile(
      destination,
      artifact.bytes,
      "existing prepared Studio artifact",
    );
    if (existing.length !== artifact.bytes || contentHash(existing) !== artifact.hash)
      throw new Error(
        `Prepared Studio artifact differs from signed worker output: ${artifact.file}`,
      );
  }
}

type IsolatedStudioRunInput = {
  repositoryRoot: string;
  stateRoot: string;
  sessionDirectory: string;
  /** The worker that owns the lane of the session. */
  worker: StudioWorker;
  pinnedPublicKeyFile: string;
  signal?: AbortSignal;
};

/** One job on the native lane of its session, for builder tests, final evaluation and repair. */
export async function runIsolatedStudio(
  input: IsolatedStudioRunInput,
): Promise<SignedWorkerManifest> {
  let settled = false;
  // The connector port of the prepared place selects the lane. An admitted job keeps its claim.
  const session = await loadStudioSession(input.sessionDirectory);
  await claimNativeLane(input.stateRoot, input.sessionDirectory, [
    { lane: studioLaneOfConnectorUrl(session.connectorUrl), worker: input.worker.id },
  ]);
  const lease = holdNativeLane(input.stateRoot, input.sessionDirectory);
  try {
    const receipt = await runIsolatedStudioLocked(input);
    settled = true;
    return receipt;
  } finally {
    await lease.stop();
    const dispatched = await readFile(resolve(input.sessionDirectory, REMOTE_JOB_FILE)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    // A lost SSH connection does not prove the worker stopped. Keep the Studio
    // lane owned until its signed receipt has been imported.
    if (settled || !dispatched) await releaseNativeLane(input.stateRoot, input.sessionDirectory);
  }
}

function assertRemoteStudioJob(
  value: unknown,
  session: Awaited<ReturnType<typeof loadStudioSession>>,
  user: string,
): asserts value is RemoteStudioJob {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid retained isolated Studio job");
  const job = value as Record<string, unknown>;
  if (
    Object.keys(job).sort().join(",") !==
      "candidateHash,collectionPlanHash,remote,runnerHash,schema,sessionId,user" ||
    job.schema !== "basalt-evals/remote-studio-job" ||
    job.user !== user ||
    typeof job.remote !== "string" ||
    !new RegExp(`^/Users/${user}/BasaltTrials/job-[a-f0-9]{32}/studio$`, "u").test(job.remote) ||
    job.sessionId !== session.id ||
    job.candidateHash !== session.candidateHash ||
    job.collectionPlanHash !== session.collectionPlanHash ||
    typeof job.runnerHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(job.runnerHash)
  )
    throw new Error("Retained isolated Studio job differs from the frozen session");
}

/**
 * A lane release proves that the dispatched job stopped without a signed receipt. The
 * observation then has no evidence, and Resume records the loss instead of a wait.
 */
export async function assertStudioJobNotLost(sessionDirectory: string): Promise<void> {
  const file = resolve(dirname(sessionDirectory), LANE_RELEASE_FILE);
  try {
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const release = await readBoundedRegularFile(file, 16_384, "Studio lane release");
  const marker = await readBoundedRegularFile(
    resolve(sessionDirectory, REMOTE_JOB_FILE),
    4096,
    "retained isolated Studio job",
  );
  const record = JSON.parse(release.toString("utf8")) as { remoteJobHash?: unknown };
  if (record.remoteJobHash !== contentHash(marker))
    throw new Error("The Studio lane release belongs to a different job");
  throw new ExecutionFault({
    causeCode: "studio_job_lost",
    category: "recovery",
    dependency: contentHash(release),
    unit: { stage: "final_capture", id: contentHash(marker) },
    evidenceRefs: [contentHash(release)],
    recoveryActions: ["inspect"],
    explanation:
      "Studio stopped this observation without signed evidence, and its run process was gone. Basalt freed the Studio slot. Start a new run to observe this build again.",
  });
}

/** Read-only remote reconciliation. This never starts another Studio process. */
export async function reconcileIsolatedStudio(
  input: IsolatedStudioRunInput,
): Promise<SignedWorkerManifest> {
  const session = await loadStudioSession(input.sessionDirectory);
  const job: unknown = JSON.parse(
    (
      await readBoundedRegularFile(
        resolve(input.sessionDirectory, REMOTE_JOB_FILE),
        4096,
        "retained isolated Studio job",
      )
    ).toString("utf8"),
  );
  assertRemoteStudioJob(job, session, input.worker.user);
  const pinnedKey = (
    await readBoundedRegularFile(input.pinnedPublicKeyFile, 16_384, "pinned isolated worker key")
  ).toString("utf8");
  const local = await readBoundedRegularFile(
    resolve(input.sessionDirectory, "native/manifest.json"),
    MAX_NATIVE_MANIFEST_BYTES,
    "retained worker receipt",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (local) {
    const receipt = JSON.parse(local.toString("utf8")) as SignedWorkerManifest;
    assertReceiptBinding(receipt, session, job);
    await verifyWorkerArtifacts(input.sessionDirectory, receipt, pinnedKey);
    await releaseNativeLane(input.stateRoot, input.sessionDirectory);
    return receipt;
  }
  await assertStudioJobNotLost(input.sessionDirectory);
  const staging = await mkdtemp(resolve(input.stateRoot, "native-transfer-"));
  try {
    const receipt = await importRemoteStudioResult(input, job, session, staging, pinnedKey);
    await releaseNativeLane(input.stateRoot, input.sessionDirectory);
    return receipt;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Run one trial in the other user's GUI session and import its signed bytes. */
async function runIsolatedStudioLocked(
  input: IsolatedStudioRunInput,
): Promise<SignedWorkerManifest> {
  if (process.platform !== "darwin")
    throw new Error("Basalt can start Studio only on macOS. Use a Mac for this run.");
  const session = await loadStudioSession(input.sessionDirectory);
  const sequenceFile = resolve(input.sessionDirectory, "sequence.json");
  const sequenceBytes = await readBoundedRegularFile(sequenceFile, 8192, "sequence plan").catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    },
  );
  if (sequenceBytes) {
    const plan = JSON.parse(sequenceBytes.toString("utf8")) as SequencePlan;
    assertSequencePlan(plan);
    if (plan.sourceHash !== session.candidateHash)
      throw new Error("Sequence plan source does not match the frozen candidate");
    await cleanImplementationCommit(input.repositoryRoot, plan.implementationCommit);
  }
  if (!/^[A-Za-z0-9._-]+\.rbxlx?$/.test(session.place.file))
    throw new Error("The prepared place must have a safe basename");
  const pinnedKey = (
    await readBoundedRegularFile(input.pinnedPublicKeyFile, 16_384, "pinned isolated worker key")
  ).toString("utf8");
  const bundle = await workerBundle(input.repositoryRoot);
  const jobId = randomBytes(16).toString("hex");
  const remote = `/Users/${input.worker.user}/BasaltTrials/job-${jobId}/studio`;
  const remoteHost = `${input.worker.user}@127.0.0.1`;
  const staging = await mkdtemp(resolve(input.stateRoot, "native-transfer-"));
  let remoteFailure: string | null = null;
  try {
    const { stdout: account } = await ssh(input.worker, "id -un", input.signal);
    if (account.trim() !== input.worker.user)
      throw new Error(
        "SSH connected to a different macOS account, not the isolated Studio account. Correct the configuration with the steps in docs/DEVELOPMENT.md.",
      );
    await ssh(input.worker, `${shellQuote(input.worker.nodeExecutable)} --version`, input.signal);
    await ssh(
      input.worker,
      `mkdir -m 700 ${shellQuote(dirname(remote))} && mkdir -m 700 ${shellQuote(remote)}`,
      input.signal,
    );
    for (const file of [
      "session.json",
      session.place.file,
      ...(sequenceBytes ? ["sequence.json"] : []),
    ])
      await scp(
        input.worker,
        resolve(input.sessionDirectory, file),
        `${remoteHost}:${remote}/${file}`,
        input.signal,
      );
    const runnerHash = hashJson({
      entry: contentHash(
        await readFile(resolve(bundle, "packages/studio-runner/native-entry.luau")),
      ),
      focusGuard: contentHash(
        await readFile(resolve(bundle, "packages/studio-runner/native-focus.swift")),
      ),
      recorder: contentHash(
        await readFile(resolve(bundle, "packages/studio-runner/native-recorder.swift")),
      ),
    });
    // The preferences go back to the golden template only if this job holds the only claim on
    // the slots of its worker. The worker also checks that no Studio process of the account runs.
    const reset = await onlyClaimOf(input.stateRoot, input.sessionDirectory, input.worker.lanes);
    const job: RemoteStudioJob = {
      schema: "basalt-evals/remote-studio-job",
      user: input.worker.user,
      remote,
      sessionId: session.id,
      candidateHash: session.candidateHash,
      collectionPlanHash: session.collectionPlanHash,
      runnerHash,
    };
    await mkdir(resolve(input.sessionDirectory, "native"), { recursive: true });
    await publishImmutable(
      resolve(input.sessionDirectory, REMOTE_JOB_FILE),
      `${JSON.stringify(job)}\n`,
    );
    try {
      await ssh(
        input.worker,
        `${shellQuote(input.worker.nodeExecutable)} ${shellQuote(resolve(bundle, "worker-entry.mjs"))} ${shellQuote(input.worker.user)} run ${shellQuote(remote)} ${reset ? "reset" : "keep"} ${input.worker.screenRecording ? "record" : "plain"}`,
        input.signal,
      );
    } catch (error) {
      remoteFailure = error instanceof Error ? error.message : String(error);
    }
    try {
      const receipt = input.signal?.aborted
        ? await awaitNativeCancellation({
            cancel: (signal) =>
              ssh(
                input.worker,
                `${shellQuote(input.worker.nodeExecutable)} ${shellQuote(resolve(bundle, "worker-entry.mjs"))} ${shellQuote(input.worker.user)} cancel ${shellQuote(remote)}`,
                signal,
              ).then(() => {}),
            ready: async (signal) =>
              (
                await ssh(
                  input.worker,
                  `if test -f ${shellQuote(`${remote}/native/manifest.json`)}; then echo ready; else echo waiting; fi`,
                  signal,
                )
              ).stdout.trim() === "ready",
            read: (signal) =>
              importRemoteStudioResult({ ...input, signal }, job, session, staging, pinnedKey),
          })
        : await importRemoteStudioResult(input, job, session, staging, pinnedKey);
      return receipt;
    } catch (error) {
      throw new Error(
        `Basalt did not get the signed evidence of this observation from the isolated Studio account. To collect it, resume the run later. Details: ${String(error)}${remoteFailure ? `; connection: ${remoteFailure}` : ""}`,
        { cause: error },
      );
    }
  } finally {
    // The verified bundle is shared by later jobs with the same inputs and is never removed here.
    // Transfer files are expendable copies; the remote job and local imported evidence remain authoritative.
    await rm(staging, { recursive: true, force: true });
    process.stdout.write(
      `Isolated Studio job: ${remote}\nLocal evidence: ${input.sessionDirectory}\n`,
    );
  }
}

async function copyMatching(source: string, destination: string): Promise<void> {
  const bytes = await readBoundedRegularFile(source, MAX_NATIVE_MANIFEST_BYTES, "worker result");
  const sourceHash = contentHash(bytes);
  try {
    await publishImmutable(destination, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (
      sourceHash !==
      contentHash(
        await readBoundedRegularFile(destination, MAX_NATIVE_MANIFEST_BYTES, "saved worker result"),
      )
    )
      throw new Error("Existing isolated Studio result differs from the retained signed bytes");
  }
}

async function importRemoteStudioResult(
  input: IsolatedStudioRunInput,
  job: RemoteStudioJob,
  session: Awaited<ReturnType<typeof loadStudioSession>>,
  staging: string,
  pinnedKey: string,
): Promise<SignedWorkerManifest> {
  const remoteHost = `${input.worker.user}@127.0.0.1`;
  const manifestFile = resolve(staging, "native/manifest.json");
  await mkdir(dirname(manifestFile), { recursive: true });
  await scp(
    input.worker,
    `${remoteHost}:${job.remote}/native/manifest.json`,
    manifestFile,
    input.signal,
  );
  const receipt = JSON.parse(
    (
      await readBoundedRegularFile(
        manifestFile,
        MAX_NATIVE_MANIFEST_BYTES,
        "isolated worker receipt",
      )
    ).toString("utf8"),
  ) as SignedWorkerManifest;
  if (!verifyWorkerSignature(receipt, pinnedKey))
    throw new Error("Isolated Studio returned an untrusted worker receipt");
  assertReceiptBinding(receipt, session, job);
  for (const batch of isolatedArtifactBatches(receipt)) {
    const destination = resolve(staging, batch.directory);
    await mkdir(destination, { recursive: true });
    const batchFile = resolve(
      dirname(staging),
      `.transfer-${randomBytes(16).toString("hex")}.sftp`,
    );
    await writeFile(batchFile, isolatedBatchScript(batch.files, job.remote, staging), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      await execFile(
        "/usr/bin/sftp",
        ["-q", "-b", batchFile, ...sshOptions(input.worker), remoteHost],
        { maxBuffer: 1024 * 1024, signal: input.signal },
      );
    } finally {
      await rm(batchFile, { force: true });
    }
  }
  await verifyWorkerArtifacts(staging, receipt, pinnedKey);
  for (const artifact of receipt.manifest.artifacts)
    await importSignedWorkerArtifact(staging, input.sessionDirectory, artifact);
  const reportFile = resolve(staging, "native/report.md");
  await scp(input.worker, `${remoteHost}:${job.remote}/native/report.md`, reportFile, input.signal);
  await copyMatching(reportFile, resolve(input.sessionDirectory, "native/report.md"));
  await copyMatching(manifestFile, resolve(input.sessionDirectory, "native/manifest.json"));
  await verifyWorkerArtifacts(input.sessionDirectory, receipt, pinnedKey);
  await importScreenRecording(input, job, session, receipt, staging);
  await importJobFootprint(input, job, receipt, staging);
  await rm(staging, { recursive: true, force: true });
  return receipt;
}

/**
 * Keep the measured footprint of the job for the headroom admission of later lanes. The file is
 * outside the signed tree. An absent or bad file leaves the job without a measured footprint.
 */
async function importJobFootprint(
  input: IsolatedStudioRunInput,
  job: RemoteStudioJob,
  receipt: SignedWorkerManifest,
  staging: string,
): Promise<void> {
  const staged = resolve(staging, JOB_FOOTPRINT_FILE);
  try {
    await scp(
      input.worker,
      `${input.worker.user}@127.0.0.1:${dirname(job.remote)}/${JOB_FOOTPRINT_FILE}`,
      staged,
      input.signal,
    );
    const footprint = parseJobFootprint(
      (await readBoundedRegularFile(staged, 64 * 1024, "job footprint")).toString("utf8"),
      receipt.manifest.jobId,
    );
    if (footprint) await recordJobFootprint(input.stateRoot, footprint);
  } catch {
    // The footprint is optional: a later lane then waits for headroom from other jobs.
  } finally {
    await rm(staged, { force: true });
  }
}

/**
 * Import the screen recording beside the session, outside the signed tree. The signed manifest
 * gives its size and hash. A failure keeps the evidence and only leaves the recording out.
 */
async function importScreenRecording(
  input: IsolatedStudioRunInput,
  job: RemoteStudioJob,
  session: Awaited<ReturnType<typeof loadStudioSession>>,
  receipt: SignedWorkerManifest,
  staging: string,
): Promise<void> {
  const recording = receipt.manifest.screenRecording;
  if (
    recording.status !== "recorded" ||
    !recording.bytes ||
    recording.bytes > SCREEN_RECORDING_LIMITS.maxBytes
  )
    return;
  const staged = resolve(staging, "screen.mp4");
  try {
    await scp(
      input.worker,
      `${input.worker.user}@127.0.0.1:${dirname(job.remote)}/${SCREEN_RECORDING_FILE}`,
      staged,
      input.signal,
    );
    await publishScreenRecording({
      staged,
      directory: dirname(input.sessionDirectory),
      recording,
      lane: studioLaneOfConnectorUrl(session.connectorUrl),
      worker: input.worker.id,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    process.stderr.write(`Basalt did not import the screen recording: ${String(error)}\n`);
  } finally {
    await rm(staged, { force: true });
  }
}

/**
 * Capture the golden preferences template of one worker. The worker reads its own settings and
 * checks them. Basalt then records the template hash for the setup checks and the capabilities.
 */
export async function captureWorkerTemplate(
  repositoryRoot: string,
  workerId: string,
): Promise<PreferencesTemplateRecord> {
  const worker = (await readStudioWorkers(repositoryRoot)).find((entry) => entry.id === workerId);
  if (!worker)
    throw new Error(
      `The Studio workers file has no worker ${workerId}. Use an id from the Studio workers file.`,
    );
  const bundle = await workerBundle(repositoryRoot);
  const { stdout } = await ssh(
    worker,
    `${shellQuote(worker.nodeExecutable)} ${shellQuote(resolve(bundle, "worker-entry.mjs"))} ${shellQuote(worker.user)} template-capture`,
  );
  const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as { templateHash?: unknown };
  if (typeof result.templateHash !== "string" || !/^[a-f0-9]{64}$/u.test(result.templateHash))
    throw new Error("The worker did not report a valid template hash");
  const record: PreferencesTemplateRecord = {
    schema: "basalt-evals/studio-preferences-template-record",
    worker: worker.id,
    user: worker.user,
    templateHash: result.templateHash,
    capturedAt: new Date().toISOString(),
  };
  await writeTemplateRecord(repositoryRoot, record);
  return record;
}

function assertReceiptBinding(
  receipt: SignedWorkerManifest,
  session: Awaited<ReturnType<typeof loadStudioSession>>,
  job: RemoteStudioJob,
): void {
  if (
    receipt.manifest.sessionId !== session.id ||
    receipt.manifest.candidateHash !== session.candidateHash ||
    receipt.manifest.collectionPlanHash !== session.collectionPlanHash ||
    receipt.manifest.runnerHash !== job.runnerHash
  )
    throw new Error("Isolated worker receipt differs from the frozen session or runner");
}
