import { contentHash, hashJson } from "../../contracts/src/index.js";
import type { ExecutionFailure, FailureRecord } from "../../contracts/src/failure.js";
import { OperationJournal } from "./journal.js";
import { RepositoryFiles } from "./repository.js";

export async function recordExecutionFailure(
  root: string,
  operationId: string,
  failure: ExecutionFailure,
) {
  const body = { ...failure, operationId, at: new Date().toISOString() };
  const record: FailureRecord = { ...body, id: hashJson(body) };
  const files = new RepositoryFiles(root);
  const path = `.basalt-evals/eval-operations/${operationId}/failures/${record.id}.json`;
  await files.writeJsonOnce(path, record);
  const journal = await OperationJournal.open(root);
  try {
    journal.transaction(() => {
      const heads = journal.read<Record<string, FailureRecord>>("failure_heads", operationId) ?? {};
      heads[`${failure.unit.stage}:${failure.unit.id}`] = record;
      journal.put("failure_heads", operationId, heads);
    });
  } finally {
    journal.close();
  }
  return record;
}
export function resolveExecutionFailures(
  journal: OperationJournal,
  operationId: string,
  stage: string,
  unitId: string,
) {
  const heads = journal.read<Record<string, FailureRecord>>("failure_heads", operationId) ?? {};
  for (const [key, failure] of Object.entries(heads))
    if (
      (failure.unit.stage === stage && failure.unit.id === unitId) ||
      failure.unit.stage === `${stage}:${unitId}`
    )
      delete heads[key];
  journal.put("failure_heads", operationId, heads);
}

/** The last failure record of each unit that has not completed since it failed. */
export function unresolvedFailures(
  journal: OperationJournal,
  operationId: string,
): FailureRecord[] {
  return Object.values(
    journal.read<Record<string, FailureRecord>>("failure_heads", operationId) ?? {},
  );
}

/** The byte limit of one stack file. */
export const MAX_FAILURE_STACK_BYTES = 64 * 1024;
const MAX_CAUSE_LEVELS = 4;
const SECRET_NAME = /KEY|TOKEN|SECRET/u;

/**
 * The text without secrets: the values of environment variables whose names contain KEY,
 * TOKEN or SECRET, the values of authorization headers and OpenRouter keys.
 */
function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let result = text;
  for (const [name, value] of Object.entries(env))
    if (SECRET_NAME.test(name) && value && value.length >= 8)
      result = result.split(value).join("[redacted]");
  return result
    .replace(/(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',;}]+/giu, "$1[redacted]")
    .replace(/sk-or-[A-Za-z0-9_-]+/gu, "[redacted]");
}

/**
 * Save the redacted stack of an unknown or recovery failure once, with at most four levels of
 * its cause, in at most 64 KiB. Returns the content hash of the file for `evidenceRefs`.
 */
export async function recordFailureStack(
  root: string,
  operationId: string,
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const parts: string[] = [];
  let current: unknown = error;
  for (let level = 0; level <= MAX_CAUSE_LEVELS && current !== undefined; level += 1) {
    const text =
      current instanceof Error
        ? (current.stack ?? `${current.name}: ${current.message}`)
        : String(current);
    parts.push(level === 0 ? text : `Cause ${level}: ${text}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  let text = redactSecrets(parts.join("\n"), env) + "\n";
  if (Buffer.byteLength(text, "utf8") > MAX_FAILURE_STACK_BYTES) {
    const notice = "\n[The stack is longer than 64 KiB. Basalt kept its start.]\n";
    text =
      Buffer.from(text, "utf8")
        .subarray(0, MAX_FAILURE_STACK_BYTES - Buffer.byteLength(notice, "utf8") - 4)
        .toString("utf8")
        .replace(/\uFFFD$/u, "") + notice;
  }
  const hash = contentHash(text);
  try {
    await new RepositoryFiles(root).write(
      `.basalt-evals/eval-operations/${operationId}/failures/stacks/${hash}.txt`,
      text,
    );
  } catch (error) {
    // The name is the content hash, so an existing file has the same bytes.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return hash;
}
