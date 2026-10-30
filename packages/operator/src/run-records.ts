import { OperationJournal } from "../../artifact-store/src/journal.js";
import type { RunSummary } from "../../contracts/src/catalog.js";
import type { RunOperationStatus, SpendLedgerState } from "../../contracts/src/execution.js";
import { frozenRunStore } from "./run-builder.js";

/** A failed read keeps its error, so only the caller that uses the value gets the error. */
type RecordRead<T> = { value: T } | { error: unknown };

/** The value of a record read, or the error of the read. */
export function recordValue<T>(read: RecordRead<T>): T {
  if ("error" in read) throw read.error;
  return read.value;
}

function attempt<T>(read: () => T): RecordRead<T> {
  try {
    return { value: read() };
  } catch (error) {
    return { error };
  }
}

/** The records of one run that its benchmark report reads, from one journal open. */
interface FrozenRunRecords {
  /** The unverified status of frozenRunStatus, with all its checks. */
  status: RunOperationStatus;
  /** The saved spending record, or null. The caller checks it. */
  spending: RecordRead<SpendLedgerState | null>;
  /** The title of the run in the catalog, or null. */
  title: RecordRead<string | null>;
}

async function readFrozenRunRecords(root: string, operationId: string): Promise<FrozenRunRecords> {
  const operation = await frozenRunStore(root, operationId);
  const journal = await OperationJournal.open(root);
  try {
    return {
      status: operation.progressIn(journal),
      spending: attempt(() => journal.read<SpendLedgerState>("spending", operationId)),
      title: attempt(() => journal.read<RunSummary>("catalog_runs", operationId)?.title ?? null),
    };
  } finally {
    journal.close();
  }
}

/** Read the records of a run one time. */
export type FrozenRunReader = (operationId: string) => Promise<FrozenRunRecords>;

/**
 * Keep one read of the records of each run during one read, for example one page render. A
 * failed read stays failed.
 */
export function frozenRunRecords(root: string): FrozenRunReader {
  const reads = new Map<string, Promise<FrozenRunRecords>>();
  return (operationId) => {
    let read = reads.get(operationId);
    if (!read) {
      read = readFrozenRunRecords(root, operationId);
      reads.set(operationId, read);
    }
    return read;
  };
}
