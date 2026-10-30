import type { SpendAuthorization, SpendLedgerState } from "../../contracts/src/execution.js";
import { recordExecutionFailure } from "../../artifact-store/src/failures.js";
import type { ExecutionFailure } from "../../contracts/src/failure.js";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { hashJson } from "../../contracts/src/index.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";

export function spendingProjection(state: SpendLedgerState) {
  const billedUsd = state.entries.reduce((sum, entry) => sum + (entry.billedUsd ?? 0), 0);
  const reservedUsd = state.entries.reduce(
    (sum, entry) => sum + (entry.status === "billed" ? 0 : entry.reservedUsd),
    0,
  );
  return {
    authorizationHash: hashJson(state.authorizations),
    ceilingUsd: state.authorizations.at(-1)!.ceilingUsd,
    pendingBilling: state.entries.some((entry) => entry.status === "pending"),
    uncertainBilling: state.entries.some((entry) => entry.status !== "billed"),
    uncertainRequests: state.entries.filter((entry) => entry.status !== "billed").length,
    billedUsd,
    reservedUsd,
    availableUsd: Math.max(0, state.authorizations.at(-1)!.ceilingUsd - billedUsd - reservedUsd),
  };
}

const operationPattern = /^[a-z0-9][a-z0-9-]{0,80}$/u;
const requestPattern = /^[a-f0-9]{64}$/u;

export class SpendingCeilingError extends Error {
  constructor() {
    super("Spending ceiling prevents another model call");
    this.name = "SpendingCeilingError";
  }
}

/**
 * The requests of one operation that a bounded client of this process holds. A client holds
 * its request from the reservation until it knows the charge or gives the request up. Only
 * one process owns the requests of an operation, so this record is local to the process.
 */
interface OperationHolds {
  held: Set<string>;
  /** Reservations of this process run one at a time, in their arrival sequence. */
  turn: Promise<void>;
  /** Waiters for the settlement of a held request. */
  settled: Set<() => void>;
}

const operationHolds = new Map<string, OperationHolds>();

/**
 * A pending entry blocks new dispatch only when no live client holds it. After a crash, a stop
 * or a lost response, the entry has no holder. Then Basalt must reconcile the charge first.
 * A terminal unknown charge keeps its full reservation.
 */
export class DurableSpendLedger {
  readonly directory: string;
  readonly file: string;
  private readonly files: RepositoryFiles;
  private readonly holds: OperationHolds;

  constructor(
    readonly root: string,
    readonly operationId: string,
    readonly contextHash: string,
  ) {
    if (!operationPattern.test(operationId)) throw new Error("Invalid spending operation identity");
    if (!requestPattern.test(contextHash)) throw new Error("Invalid spending operation context");
    this.files = new RepositoryFiles(root);
    this.directory = resolve(root, ".basalt-evals/eval-operations", operationId);
    this.file = resolve(root, ".basalt-evals/journal/operations.sqlite");
    const key = `${this.file}\0${operationId}`;
    const holds = operationHolds.get(key) ?? {
      held: new Set<string>(),
      turn: Promise.resolve(),
      settled: new Set<() => void>(),
    };
    operationHolds.set(key, holds);
    this.holds = holds;
  }

  /**
   * Pending entries that no client of this process holds. They block new paid dispatch.
   * Basalt reads the ledger and examines the holds in one synchronous step.
   */
  async unownedPending() {
    const journal = await OperationJournal.open(this.root);
    try {
      return this.unownedIn(this.readJournal(journal));
    } finally {
      journal.close();
    }
  }

  /**
   * The unowned pending entries of a state that the caller read in the same synchronous step.
   * A client settles its charge before it releases its hold. Thus an older state can show a
   * settled request as unowned.
   */
  unownedIn(state: SpendLedgerState) {
    return state.entries.filter(
      (entry) => entry.status === "pending" && !this.holds.held.has(entry.requestId),
    );
  }

  /** The client stops to hold the request. A pending entry then needs reconciliation. */
  release(requestId: string): void {
    if (!this.holds.held.delete(requestId)) return;
    for (const wake of this.holds.settled) wake();
  }

  async recordFailure(failure: ExecutionFailure) {
    return recordExecutionFailure(this.root, this.operationId, failure);
  }

  async initialize(
    authorization: SpendAuthorization,
    record?: (journal: OperationJournal) => void,
  ): Promise<void> {
    assertAuthorization(authorization);
    await this.files.directory(`.basalt-evals/eval-operations/${this.operationId}`);
    const state: SpendLedgerState = {
      schema: "basalt-evals/spend-ledger",
      operationId: this.operationId,
      contextHash: this.contextHash,
      authorizations: [authorization],
      entries: [],
    };
    const archived = await stat(resolve(this.directory, "ledger.json")).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (archived)
      throw new Error("Archived spending operation cannot be resumed under the current journal");
    const journal = await OperationJournal.open(this.root);
    try {
      journal.transaction(() => {
        const existing = journal.read<SpendLedgerState>("spending", this.operationId);
        record?.(journal);
        if (existing) {
          this.validate(existing);
          if (hashJson(existing.authorizations[0]) !== hashJson(authorization))
            throw new Error("Operation already has a different initial spending authorization");
        } else {
          journal.put("spending", this.operationId, state);
          journal.put("spending_progress", this.operationId, spendingProjection(state));
        }
      });
    } finally {
      journal.close();
    }
  }

  async read(): Promise<SpendLedgerState> {
    const journal = await OperationJournal.open(this.root);
    try {
      return this.readJournal(journal);
    } finally {
      journal.close();
    }
  }

  private readJournal(journal: OperationJournal): SpendLedgerState {
    const state = journal.read<SpendLedgerState>("spending", this.operationId);
    if (!state)
      throw Object.assign(new Error("Spending operation is not initialized"), { code: "ENOENT" });
    return this.validate(state);
  }

  /** Check a saved ledger state of this operation. */
  validate(state: SpendLedgerState): SpendLedgerState {
    if (
      state.schema !== "basalt-evals/spend-ledger" ||
      state.operationId !== this.operationId ||
      !requestPattern.test(state.contextHash) ||
      !Array.isArray(state.authorizations) ||
      state.authorizations.length === 0 ||
      !Array.isArray(state.entries)
    )
      throw new Error("Invalid durable spending ledger");
    if (state.contextHash !== this.contextHash)
      throw new Error("Spending operation belongs to a different frozen context");
    let previousCeiling = -1;
    const quotes = new Set<string>();
    for (const authorization of state.authorizations) {
      assertAuthorization(authorization);
      if (authorization.ceilingUsd < previousCeiling || quotes.has(authorization.quoteHash))
        throw new Error("Invalid staged spending authorizations");
      previousCeiling = authorization.ceilingUsd;
      quotes.add(authorization.quoteHash);
    }
    const seen = new Set<string>();
    for (const entry of state.entries) {
      if (
        !requestPattern.test(entry.requestId) ||
        seen.has(entry.requestId) ||
        !["pending", "billed"].includes(entry.status) ||
        !Number.isFinite(entry.reservedUsd) ||
        entry.reservedUsd < 0 ||
        !requestPattern.test(entry.requestHash) ||
        (entry.status === "billed" &&
          (entry.billedUsd === null || !Number.isFinite(entry.billedUsd) || entry.billedUsd < 0)) ||
        (entry.status !== "billed" && entry.billedUsd !== null)
      )
        throw new Error("Invalid durable spending receipt");
      seen.add(entry.requestId);
    }
    return state;
  }

  /** A later quote may raise the cumulative ceiling without resetting earlier spend. */
  async authorize(
    authorization: SpendAuthorization,
    record?: (journal: OperationJournal) => void,
  ): Promise<SpendLedgerState> {
    assertAuthorization(authorization);
    return this.update((state) => {
      const prior = state.authorizations.at(-1)!;
      if (state.authorizations.some((item) => item.quoteHash === authorization.quoteHash))
        throw new Error("This quote already has a spending authorization");
      if (authorization.ceilingUsd < prior.ceilingUsd)
        throw new Error("A cumulative spending ceiling cannot decrease");
      state.authorizations.push(authorization);
    }, record);
  }

  private async update(
    action: (state: SpendLedgerState, journal: OperationJournal) => void,
    record?: (journal: OperationJournal) => void,
  ): Promise<SpendLedgerState> {
    const journal = await OperationJournal.open(this.root);
    try {
      return journal.transaction(() => {
        const state = this.readJournal(journal);
        action(state, journal);
        this.validate(state);
        record?.(journal);
        journal.put("spending", this.operationId, state);
        journal.put("spending_progress", this.operationId, spendingProjection(state));
        return state;
      });
    } finally {
      journal.close();
    }
  }

  /**
   * Reserve the maximum cost of one request against the shared limit. The check and the entry
   * are one journal transaction, so concurrent reservations cannot overspend the limit. If the
   * request fits only after held requests settle, the reservation waits for them. If it cannot
   * fit when all held requests settle, the reservation fails with `SpendingCeilingError`.
   */
  async reserve(input: {
    requestId: string;
    requestHash: string;
    stage: string;
    maximumUsd: number;
    /** The caller holds the request until it calls `release` or `reconcile`. */
    hold?: boolean;
    signal?: AbortSignal;
  }): Promise<SpendLedgerState> {
    if (
      !requestPattern.test(input.requestId) ||
      !requestPattern.test(input.requestHash) ||
      !input.stage.trim() ||
      !Number.isFinite(input.maximumUsd) ||
      input.maximumUsd < 0
    )
      throw new Error("Invalid spending reservation");
    // Reservations of this process wait in arrival sequence, so a large request is not starved.
    const previous = this.holds.turn;
    let done!: () => void;
    this.holds.turn = new Promise<void>((resolve) => (done = resolve));
    try {
      await previous;
      for (;;) {
        input.signal?.throwIfAborted();
        // Register the wait before the attempt, so a settlement during the attempt is not lost.
        let wake!: () => void;
        const settled = new Promise<void>((resolve) => (wake = resolve));
        this.holds.settled.add(wake);
        try {
          const reserved = await this.tryReserve(input);
          if (reserved) return reserved;
          await settlement(settled, input.signal);
        } finally {
          this.holds.settled.delete(wake);
        }
      }
    } finally {
      done();
    }
  }

  /** One atomic attempt. Null means that the request fits after held requests settle. */
  private async tryReserve(input: {
    requestId: string;
    requestHash: string;
    stage: string;
    maximumUsd: number;
    hold?: boolean;
  }): Promise<SpendLedgerState | null> {
    const journal = await OperationJournal.open(this.root);
    let added = false;
    try {
      return journal.transaction(() => {
        const state = this.readJournal(journal);
        if (this.unownedIn(state).length)
          throw new Error(
            "Another request has a pending charge. Basalt cannot send a new request. Select Check payment status.",
          );
        if (state.entries.some((entry) => entry.requestId === input.requestId))
          throw new Error("Paid request identity was already used");
        const committed = state.entries.reduce(
          (sum, entry) => sum + (entry.status === "billed" ? entry.billedUsd! : entry.reservedUsd),
          0,
        );
        const ceiling = state.authorizations.at(-1)!.ceilingUsd;
        // Every stage shares one limit; each request reserves only its own maximum.
        if (committed + input.maximumUsd > ceiling + 1e-12) {
          const held = state.entries.reduce(
            (sum, entry) =>
              sum +
              (entry.status === "pending" && this.holds.held.has(entry.requestId)
                ? entry.reservedUsd
                : 0),
            0,
          );
          if (held > 0 && committed - held + input.maximumUsd <= ceiling + 1e-12) return null;
          throw new SpendingCeilingError();
        }
        state.entries.push({
          requestId: input.requestId,
          requestHash: input.requestHash,
          stage: input.stage,
          reservedUsd: input.maximumUsd,
          billedUsd: null,
          status: "pending",
        });
        this.validate(state);
        journal.put("spending", this.operationId, state);
        journal.put("spending_progress", this.operationId, spendingProjection(state));
        // The hold starts in the transaction: no other check can see the entry without it.
        if (input.hold) {
          this.holds.held.add(input.requestId);
          added = true;
        }
        return state;
      });
    } catch (error) {
      if (added) this.holds.held.delete(input.requestId);
      throw error;
    } finally {
      journal.close();
    }
  }

  async reconcile(requestId: string, billedUsd: number): Promise<SpendLedgerState> {
    if (!requestPattern.test(requestId) || !Number.isFinite(billedUsd) || billedUsd < 0)
      throw new Error("Invalid provider billing reconciliation");
    const state = await this.update((state) => {
      const entry = state.entries.find((item) => item.requestId === requestId);
      if (!entry || entry.status === "billed")
        throw new Error("No unresolved paid request has this identity");
      entry.status = "billed";
      entry.billedUsd = billedUsd;
    });
    this.release(requestId);
    return state;
  }

  static requestId(stage: string, request: unknown): string {
    return hashJson({ stage, request });
  }
}

/** Wait for the settlement of a held request. A stop rejects the wait with its reason. */
function settlement(settled: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return settled;
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    void settled.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

function assertAuthorization(authorization: SpendAuthorization): void {
  if (
    !authorization ||
    !requestPattern.test(authorization.quoteHash) ||
    !Number.isFinite(authorization.ceilingUsd) ||
    authorization.ceilingUsd < 0
  )
    throw new Error("Spending authorization needs a quote hash and nonnegative USD ceiling");
}
