import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { assertSafeAbsoluteDirectory } from "../../artifact-store/src/index.js";
import type {
  DeletedRun,
  EvaluationSummary,
  Page,
  RunSummary,
} from "../../contracts/src/catalog.js";
import type { AssessmentProgress } from "../../contracts/src/assessments.js";
import type {
  AuthoringProgress,
  EvaluationWorkflow,
  RunStart,
  SpendLedgerState,
} from "../../contracts/src/execution.js";
import type { OperationContext } from "../../contracts/src/launch.js";
import { formatMoney } from "../../contracts/src/display.js";
import { projectRun } from "./catalog-projection.js";
import { readLifecycle } from "./lifecycle.js";
import { DELETED_RUNS, RUN_ARCHIVE } from "./run-visibility.js";

/** A refusal that a person can resolve. The HTTP API returns it as a conflict. */
export class RunRetentionConflict extends Error {}

const runPattern = /^[a-z0-9][a-z0-9-]{0,80}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;

function runIdentity(id: unknown): string {
  if (typeof id !== "string" || !runPattern.test(id))
    throw new Error("The run identity is not valid.");
  return id;
}

/** In these states no driver works and no work starts without a person. */
const settledStates = new Set(["completed", "stopped", "blocked"]);

function requireSettledRun(journal: OperationJournal, id: string, action: "archive" | "delete") {
  if (journal.read<DeletedRun>(DELETED_RUNS, id))
    throw new RunRetentionConflict("A person deleted this run. Basalt cannot change it.");
  let lifecycle;
  try {
    lifecycle = readLifecycle(journal, id);
  } catch (error) {
    if (error instanceof Error && error.message === "No saved operation")
      throw new Error("Basalt cannot find this run.");
    throw error;
  }
  if (lifecycle.ownerActive || !settledStates.has(lifecycle.state))
    throw new RunRetentionConflict(
      `This run can still start work. Stop the run and wait until it stops. Then ${action} it.`,
    );
}

/** Archive keeps every record and file. It only moves the run out of the default lists. */
export async function setRunArchived(root: string, id: string, archived: boolean) {
  runIdentity(id);
  if (typeof archived !== "boolean") throw new Error("Choose archive or restore.");
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      if (archived) {
        requireSettledRun(journal, id, "archive");
        if (!journal.read(RUN_ARCHIVE, id))
          journal.put(RUN_ARCHIVE, id, { archivedAt: new Date().toISOString() });
      } else {
        if (journal.read<DeletedRun>(DELETED_RUNS, id))
          throw new RunRetentionConflict("A person deleted this run. Basalt cannot restore it.");
        journal.remove(RUN_ARCHIVE, id);
      }
      projectRun(journal, id);
      const row = journal.read<RunSummary>("catalog_runs", id);
      if (!row) throw new Error("Basalt cannot find this run.");
      return row;
    });
  } finally {
    journal.close();
  }
}

/** Shared launch inputs that a run names. Delete removes one only when nothing else names it. */
const inputDirectories = {
  launch: ".basalt-evals/launch-previews",
  runQuote: ".basalt-evals/eval-run-quotes",
  authoringQuote: ".basalt-evals/eval-quotes",
  assessment: ".basalt-evals/assessment-previews",
  comparison: ".basalt-evals/exemplar-comparison-previews",
} as const;
/** Saved work outside the journal that can use a run or a source copied from it. */
const savedWorkDirectories = [
  ".basalt-evals/experiment-plans",
  ".basalt-evals/repair-populations",
  ".basalt-evals/public-feedback",
];
/** Saved files outside the journal that can name a shared launch input. */
const referenceDirectories = [
  ...Object.values(inputDirectories),
  ".basalt-evals/comparison-previews",
  ...savedWorkDirectories,
];
/** A preview of a replay or a repair copies the source of a build of the run to this folder. */
const sourceDirectory = ".basalt-evals/sources";
const referenceFileLimit = 20_000;
const tooManyFiles =
  "The workspace has too many saved files for a safe check. Basalt did not delete the run.";

/** Records that name a deleted run and stay. They are not saved work that uses the run. */
const retainedReferences = new Set([
  // Idempotency records: a replay of the original start request must not make the run again.
  "launch_authorizations",
  "start_keys",
  // The audit of looks at withheld observations stays complete.
  "holdout_access",
  // Immutable selection snapshots show a deleted run as unavailable.
  "review_run_selections",
  DELETED_RUNS,
]);

interface InputCandidate {
  id: string;
  /** The path that delete removes: a file, or the folder of a registered source. */
  path: string;
  /** The saved file that names the candidate and holds its text. */
  file: string;
  text: string;
  /** A source stays only for the journal and for saved work, not for a preview. */
  source: boolean;
}

async function optionalText(files: RepositoryFiles, path: string) {
  try {
    return (await files.bytes(path)).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Read the shared inputs that the run names. Each input can name further inputs. */
async function launchInputs(
  root: string,
  id: string,
): Promise<{ inputs: InputCandidate[]; actionIds: string[] }> {
  const files = new RepositoryFiles(root);
  const journal = await OperationJournal.open(root);
  const pending: Array<{ id: string; path: string }> = [];
  const add = (directory: string, value: unknown) => {
    if (typeof value === "string" && hashPattern.test(value))
      pending.push({ id: value, path: `${directory}/${value}.json` });
  };
  try {
    add(
      inputDirectories.launch,
      journal.read<OperationContext>("operation_context", id)?.previewId,
    );
    add(inputDirectories.launch, journal.read<EvaluationWorkflow>("workflows", id)?.previewId);
    add(inputDirectories.runQuote, journal.read<RunStart>("run_starts", id)?.request.quoteId);
    add(
      inputDirectories.authoringQuote,
      journal.read<AuthoringProgress>("authoring_progress", id)?.action.quoteId,
    );
    add(
      inputDirectories.assessment,
      journal.read<AssessmentProgress>("assessment_progress", id)?.previewId,
    );
    add(
      inputDirectories.comparison,
      journal.read<AssessmentProgress>("comparison_progress", id)?.previewId,
    );
  } finally {
    journal.close();
  }
  // Earlier authoring stages of the run keep their actions in the run folder.
  const actionIds: string[] = [];
  const actions = await readdir(files.path(`.basalt-evals/eval-operations/${id}/authoring`), {
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of actions)
    if (entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name)) {
      actionIds.push(entry.name.slice(0, 64));
      const text = await optionalText(
        files,
        `.basalt-evals/eval-operations/${id}/authoring/${entry.name}`,
      );
      if (text)
        add(inputDirectories.authoringQuote, (JSON.parse(text) as { quoteId?: unknown }).quoteId);
    }
  const found = new Map<string, InputCandidate>();
  while (pending.length) {
    const next = pending.pop()!;
    if (found.has(next.path)) continue;
    const text = await optionalText(files, next.path);
    if (text === null) continue;
    found.set(next.path, { ...next, file: next.path, text, source: false });
    const value = JSON.parse(text) as {
      binding?: { kind: string; id: string };
      run?: { id?: unknown } | null;
      evaluations?: Array<{ preparation?: { id?: unknown } | null }>;
    };
    if (next.path.startsWith(`${inputDirectories.launch}/`)) {
      const binding = value.binding;
      if (binding?.kind === "workflow") add(inputDirectories.launch, binding.id);
      if (binding?.kind === "run") add(inputDirectories.runQuote, binding.id);
      if (binding?.kind === "reference") add(inputDirectories.authoringQuote, binding.id);
      if (binding?.kind === "assessment") add(inputDirectories.assessment, binding.id);
      if (binding?.kind === "exemplar_comparison") add(inputDirectories.comparison, binding.id);
      add(inputDirectories.runQuote, value.run?.id);
      for (const evaluation of value.evaluations ?? [])
        add(inputDirectories.authoringQuote, evaluation.preparation?.id);
    }
  }
  return { inputs: [...found.values()], actionIds };
}

/** Registered sources that a replay or a repair preview copied from a build of the run. */
async function runSources(root: string, id: string): Promise<InputCandidate[]> {
  const files = new RepositoryFiles(root);
  const sources: InputCandidate[] = [];
  const entries = await readdir(files.path(sourceDirectory), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (!entry.isDirectory() || !hashPattern.test(entry.name)) continue;
    if (sources.length >= referenceFileLimit) throw new Error(tooManyFiles);
    const file = `${sourceDirectory}/${entry.name}/source.json`;
    const text = await optionalText(files, file);
    if (text?.includes(`"${id}"`))
      sources.push({
        id: entry.name,
        path: `${sourceDirectory}/${entry.name}`,
        file,
        text,
        source: true,
      });
  }
  return sources;
}

/** The saved files outside the journal that name the run, and the inputs that other files name. */
async function fileReferences(root: string, id: string, candidates: InputCandidate[]) {
  const files = new RepositoryFiles(root);
  const own = new Set(candidates.map((candidate) => candidate.file));
  const runFiles: string[] = [];
  const namedInputs = new Set<string>();
  let count = 0;
  for (const directory of referenceDirectories) {
    const entries = await readdir(files.path(directory), { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const saved = savedWorkDirectories.includes(directory);
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (!entry.isFile() || !entry.name.endsWith(".json") || own.has(path)) continue;
      if (++count > referenceFileLimit) throw new Error(tooManyFiles);
      const text = await optionalText(files, path);
      if (text === null) continue;
      // A preview that nobody started is not saved work. It stays and cannot start later.
      if (saved && text.includes(id)) runFiles.push(path);
      for (const candidate of candidates)
        if ((saved || !candidate.source) && text.includes(candidate.id))
          namedInputs.add(candidate.path);
    }
  }
  // A reference test of an evaluation reads the receipts and the ledger of the run that judged it.
  const list = (directory: string) =>
    readdir(files.path(directory), { withFileTypes: true }).then(
      (entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
  const controls = ".basalt-evals/eval-control-runs";
  for (const revision of await list(controls))
    for (const batch of await list(`${controls}/${revision}`))
      for (const source of await list(`${controls}/${revision}/${batch}`)) {
        const judgments = `${controls}/${revision}/${batch}/${source}/judgments`;
        for (const entry of await readdir(files.path(judgments), { withFileTypes: true }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          },
        )) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          if (++count > referenceFileLimit) throw new Error(tooManyFiles);
          const text = await optionalText(files, `${judgments}/${entry.name}`);
          if (text?.includes(`"${id}"`)) runFiles.push(`${judgments}/${entry.name}`);
        }
      }
  return { runFiles, namedInputs };
}

/** Indexes under a run's identity that list the work of other runs or reviews. */
const reverseIndexes = [
  "operation_review_batches",
  "protocol_answers",
  "exemplar_comparisons",
  "exemplar_comparison_units",
];
/** Shared computations. A run claims one while it works, and the claim names the run. */
const sharedComputations = [
  "evaluation_compilations",
  "studio_canaries",
  "coverage_notes",
  "empty_build_checks",
];
/**
 * Complete computations that belong to a revision, like the revision files. They name the run
 * that wrote them and stay when a person deletes that run.
 */
const revisionComputations = new Set(["coverage_notes", "empty_build_checks"]);

function reverseIndexNames(journal: OperationJournal, id: string) {
  const references: Array<{ namespace: string; id: string }> = [];
  for (const batch of journal.read<string[]>("operation_review_batches", id) ?? [])
    references.push({ namespace: "review_batches", id: batch });
  if (journal.read<unknown[]>("protocol_answers", id)?.length)
    references.push({ namespace: "protocol_answers", id });
  for (const run of journal.read<{ operationIds: string[] }>("exemplar_comparisons", id)
    ?.operationIds ?? [])
    references.push({ namespace: "comparison_progress", id: run });
  for (const run of Object.values(
    journal.read<Record<string, string>>("exemplar_comparison_units", id) ?? {},
  ))
    references.push({ namespace: "comparison_progress", id: run });
  return references;
}

/** One readable name for each piece of saved work that still names the run. */
function dependentNames(
  journal: OperationJournal,
  references: Array<{ namespace: string; id: string }>,
  files: string[],
  indexed: Array<{ namespace: string; id: string }>,
) {
  const runs = new Map<string, string>(),
    other = new Map<string, string>();
  for (const reference of [...indexed, ...references]) {
    // A record keyed by another run, for example its launch context or its source run.
    const run = journal.read<RunSummary>("catalog_runs", reference.id.split(":")[0]!);
    if (run) {
      runs.set(run.id, `run "${run.title}" (${run.id})`);
      continue;
    }
    const body = journal.read<Record<string, unknown>>(reference.namespace, reference.id);
    const name =
      reference.namespace === "comparisons"
        ? `saved comparison ${reference.id.slice(0, 12)}`
        : reference.namespace === "regressions"
          ? `saved example "${String(body?.title ?? reference.id.slice(0, 12))}"`
          : reference.namespace === "exemplar_choices"
            ? `anchor build choice ${reference.id.slice(0, 12)}`
            : reference.namespace === "suites" || reference.namespace === "collection_save_actions"
              ? `the baseline of a suite`
              : reference.namespace === "protocol_answers"
                ? "the answers of a protocol review"
                : reference.namespace.startsWith("review_")
                  ? `review ${String(body?.batchId ?? body?.id ?? reference.id).slice(0, 12)}`
                  : `saved record ${reference.namespace} ${reference.id.slice(0, 12)}`;
    other.set(name, name);
  }
  for (const file of files) {
    const revision = file.startsWith(".basalt-evals/eval-control-runs/")
      ? file.split("/")[2]!
      : null;
    const name = revision
      ? `the reference test of evaluation "${journal.read<EvaluationSummary>("catalog_evaluations", revision)?.title ?? revision.slice(0, 12)}"`
      : `saved file ${file}`;
    other.set(name, name);
  }
  return { runs: [...runs.values()], other: [...other.values()] };
}

/** Remove one path inside the workspace. Links are removed, never followed. */
async function removeWorkspacePath(root: string, path: string) {
  const files = new RepositoryFiles(root);
  const target = files.path(path);
  const workspace = resolve(files.root, ".basalt-evals");
  if (!target.startsWith(`${workspace}${sep}`))
    throw new Error("Basalt removes files only inside its workspace.");
  await assertSafeAbsoluteDirectory(files.root);
  let parent = files.root;
  for (const part of relative(files.root, dirname(target)).split(sep).filter(Boolean)) {
    parent = resolve(parent, part);
    const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(
        `Basalt did not remove ${path}, because a folder above it is not a real folder.`,
      );
  }
  const remove = async (absolute: string): Promise<void> => {
    const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return;
    if (info.isDirectory() && !info.isSymbolicLink()) {
      for (const entry of await readdir(absolute)) await remove(resolve(absolute, entry));
      await rmdir(absolute);
    } else await unlink(absolute);
  };
  await remove(target);
}

/**
 * Delete in a crash-safe order. One journal transaction removes the records and writes the
 * tombstone with the files that wait for removal. Then Basalt removes the files. If the
 * process stops between the two steps, the run is absent from all lists, and a repeated
 * delete removes the remaining files.
 */
export async function deleteRun(root: string, id: string): Promise<DeletedRun> {
  runIdentity(id);
  const prior = await readTombstone(root, id);
  if (prior) return finishFileRemoval(root, prior);
  const launch = await launchInputs(root, id);
  const inputs = [...launch.inputs, ...(await runSources(root, id))];
  const actionIds = launch.actionIds;
  const referencedByFiles = await fileReferences(root, id, inputs);
  const journal = await OperationJournal.open(root);
  let record: DeletedRun;
  try {
    record = journal.transaction(() => {
      const existing = journal.read<DeletedRun>(DELETED_RUNS, id);
      if (existing) return existing;
      requireSettledRun(journal, id, "delete");
      const ledger = journal.read<SpendLedgerState>("spending", id);
      const unknown = ledger?.entries.filter((entry) => entry.status !== "billed") ?? [];
      if (unknown.length)
        throw new RunRetentionConflict(
          `This run has ${unknown.length} ${unknown.length === 1 ? "request" : "requests"} without a confirmed charge. Basalt keeps each request until the provider confirms its cost. Select Check payment status on the run page.`,
        );
      const spending = journal.read<{ billedUsd: number; reservedUsd: number }>(
        "spending_progress",
        id,
      );
      if (spending && spending.reservedUsd > 0)
        throw new RunRetentionConflict(
          `This run holds ${formatMoney(spending.reservedUsd)} in pending charges. Select Check payment status on the run page.`,
        );
      const context = journal.read<OperationContext>("operation_context", id);
      const title =
        journal.read<RunSummary>("catalog_runs", id)?.title ?? context?.title ?? "Evaluation run";
      const authoring = journal.read<AuthoringProgress>("authoring_progress", id);
      const comparisonSource = journal.read<AssessmentProgress>(
        "comparison_progress",
        id,
      )?.sourceOperationId;
      // Indexes under this run's identity that list the work of other runs or reviews.
      const indexed = reverseIndexNames(journal, id);
      // The records that belong to the run: its own identity, or "<run>:<unit>".
      for (const owned of journal.recordsKeyedBy(id))
        if (!reverseIndexes.includes(owned.namespace)) journal.remove(owned.namespace, owned.id);
      for (const actionId of new Set([...actionIds, ...(authoring ? [authoring.action.id] : [])]))
        journal.remove("preparation_outcomes", actionId);
      if (context) {
        const samples = journal.read<Record<string, number>>("measured_costs", context.costScope);
        if (samples && id in samples) {
          const { [id]: _removed, ...rest } = samples;
          if (Object.keys(rest).length) journal.put("measured_costs", context.costScope, rest);
          else journal.remove("measured_costs", context.costScope);
        }
      }
      // An anchor build comparison is also listed under the identity of its source run.
      if (comparisonSource) {
        const runs = journal.read<{ operationIds: string[] }>(
          "exemplar_comparisons",
          comparisonSource,
        );
        const others = runs?.operationIds.filter((item) => item !== id) ?? [];
        if (others.length)
          journal.put("exemplar_comparisons", comparisonSource, { operationIds: others });
        else journal.remove("exemplar_comparisons", comparisonSource);
        const units = Object.entries(
          journal.read<Record<string, string>>("exemplar_comparison_units", comparisonSource) ?? {},
        ).filter(([, owner]) => owner !== id);
        if (units.length)
          journal.put("exemplar_comparison_units", comparisonSource, Object.fromEntries(units));
        else journal.remove("exemplar_comparison_units", comparisonSource);
      }
      // Claims that the run holds on shared work. A deleted run cannot complete them.
      for (const reference of journal.recordsContaining(`"${id}"`)) {
        const body = journal.read<{ state?: unknown; operationId?: unknown }>(
          reference.namespace,
          reference.id,
        );
        if (
          body?.operationId === id &&
          (reference.namespace === "repair_discovery_blocks" ||
            (sharedComputations.includes(reference.namespace) && body.state !== "complete"))
        )
          journal.remove(reference.namespace, reference.id);
      }
      const remaining = journal
        .recordsContaining(id, 1000)
        .filter(
          (reference) =>
            !retainedReferences.has(reference.namespace) &&
            !(
              revisionComputations.has(reference.namespace) &&
              journal.read<{ state?: unknown }>(reference.namespace, reference.id)?.state ===
                "complete"
            ),
        );
      if (remaining.length || indexed.length || referencedByFiles.runFiles.length) {
        const names = dependentNames(journal, remaining, referencedByFiles.runFiles, indexed);
        throw new RunRetentionConflict(
          [
            `Other saved work uses this run: ${[...names.runs, ...names.other].join("; ")}.`,
            names.runs.length ? "Delete the runs in this list first." : "",
            names.other.length
              ? "Saved work that is not a run keeps this run. Archive the run to remove it from the lists."
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
      }
      journal.removeProjection("runs", id);
      journal.clearProjection(`activity:${id}`);
      journal.removeOperationProjections("results", id);
      journal.replaceIssues(id, []);
      // A shared input stays if a journal record, another saved file or a kept input names it.
      const kept = new Set(referencedByFiles.namedInputs);
      for (const input of inputs)
        if (
          journal
            .recordsContaining(input.id, 50)
            .some(
              (reference) =>
                !["launch_authorizations", "start_keys", DELETED_RUNS].includes(
                  reference.namespace,
                ) ||
                journal.read<{ operationId?: unknown }>(reference.namespace, reference.id)
                  ?.operationId !== id,
            )
        )
          kept.add(input.path);
      for (let changed = true; changed;) {
        changed = false;
        for (const holder of inputs)
          if (kept.has(holder.path))
            for (const input of inputs)
              if (!kept.has(input.path) && holder.text.includes(input.id)) {
                kept.add(input.path);
                changed = true;
              }
      }
      const deleted: DeletedRun = {
        operationId: id,
        title,
        billedUsd: spending?.billedUsd ?? 0,
        deletedAt: new Date().toISOString(),
        files: [
          `.basalt-evals/eval-operations/${id}`,
          ...inputs.filter((input) => !kept.has(input.path)).map((input) => input.path),
        ],
      };
      journal.put(DELETED_RUNS, id, deleted);
      return deleted;
    });
  } finally {
    journal.close();
  }
  return finishFileRemoval(root, record);
}

async function readTombstone(root: string, id: string) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.read<DeletedRun>(DELETED_RUNS, id);
  } finally {
    journal.close();
  }
}

async function finishFileRemoval(root: string, record: DeletedRun): Promise<DeletedRun> {
  for (const path of record.files)
    await removeWorkspacePath(root, path).catch((error: unknown) => {
      throw new Error(
        `Basalt removed the run from the lists, but it could not remove ${path}. Correct the cause. Then run "node bin/basalt-evals.js operation delete ${record.operationId}" again. Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  if (!record.files.length) return record;
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const current = journal.read<DeletedRun>(DELETED_RUNS, record.operationId)!;
      const next = { ...current, files: [] };
      journal.put(DELETED_RUNS, record.operationId, next);
      return next;
    });
  } finally {
    journal.close();
  }
}

/** The permanent spending records of deleted runs, newest first, with their total charge. */
export async function listDeletedRuns(
  root: string,
  query = new URLSearchParams(),
): Promise<Page<DeletedRun> & { billedUsd: number }> {
  const journal = await OperationJournal.open(root);
  try {
    const items: DeletedRun[] = [];
    let after = "";
    for (;;) {
      const page = journal.recordPage(DELETED_RUNS, after);
      if (!page.length) break;
      items.push(...page.map((row) => row.value as DeletedRun));
      after = page.at(-1)!.id;
    }
    items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    const limit = Math.min(50, Math.max(1, Math.floor(Number(query.get("limit")) || 20)));
    const pages = Math.max(1, Math.ceil(items.length / limit));
    const page = Math.min(pages, Math.max(1, Math.floor(Number(query.get("page")) || 1)));
    return {
      items: items.slice((page - 1) * limit, page * limit),
      total: items.length,
      page,
      pages,
      limit,
      billedUsd: items.reduce((sum, item) => sum + item.billedUsd, 0),
    };
  } finally {
    journal.close();
  }
}

/** The archive state of one run for its page. */
export async function runArchiveState(root: string, id: string) {
  runIdentity(id);
  const journal = await OperationJournal.open(root);
  try {
    return { archived: journal.read(RUN_ARCHIVE, id) !== null };
  } finally {
    journal.close();
  }
}
