import { requestImageInputs, requestUsage } from "./request-workload.js";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { publishImmutable } from "../../artifact-store/src/atomic.js";
import { resolve } from "node:path";
import { readBoundedRegularFile } from "../../artifact-store/src/regular-file.js";
import { hashJson, stableJson } from "../../contracts/src/index.js";
import type { PauseRecord } from "../../contracts/src/execution.js";
import { maximumUsageCost, type ModelSnapshot } from "./catalog.js";
import {
  modelTurnRequestHash,
  ModelRequestAdmissionError,
  ModelRequestPendingError,
  ModelRequestValidationError,
  MAX_MODEL_RESPONSE_BYTES,
  type ModelClient,
  type ModelTurnRequest,
  type ModelTurnResult,
} from "./contracts.js";
import { SpendingCeilingError, DurableSpendLedger } from "./ledger.js";

/** The waits before the retries of a rate limit. Each retry is the next ordinal. */
export const RATE_LIMIT_WAITS_MS = [20_000, 60_000, 120_000] as const;
/** A Retry-After value can make a wait longer, but not longer than this. */
const MAXIMUM_RATE_LIMIT_WAIT_MS = 300_000;

export type RateLimitPause = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

/**
 * A check before the reservation (`admission`) and again before the network dispatch
 * (`dispatch`). A provider hold applies only at admission: a request that reserved its charge
 * before a pause continues.
 */
export type RequestCheck = (phase: "admission" | "dispatch") => Promise<void>;

/**
 * A permit of the model for one new request. The client waits for it before the reservation and
 * calls the returned function when the result settles. A stop ends the wait.
 */
export type RequestPermit = (signal?: AbortSignal) => Promise<() => void>;

/** One stage of a frozen operation. Its receipts are returned on replay, never re-dispatched. */
export class BoundedModelClient implements ModelClient {
  readonly descriptor;
  /** The wait before a retry of a rate limit. A test can replace it to run without real time. */
  pause: RateLimitPause = waitFor;
  private ordinal = 0;
  private settled = 0;
  private readonly models: Map<string, ModelSnapshot>;
  private readonly receiptDirectory: string;
  private readonly acknowledged: ReadonlySet<number>;

  constructor(
    private readonly client: ModelClient,
    private readonly ledger: DurableSpendLedger,
    snapshots: ModelSnapshot[],
    private readonly stage: string,
    private readonly replayOnly = false,
    private readonly beforeRequest?: RequestCheck,
    completedCalls = 0,
    /**
     * The ordinals of saved failures that paused the stage before a person resumed it. A replay
     * of such an ordinal continues to the next ordinal, which is a new request.
     */
    acknowledged: Iterable<number> = [],
    /** The permit of the model for each new request. A replay of saved files takes no permit. */
    private readonly permit?: RequestPermit,
  ) {
    if (!Number.isSafeInteger(completedCalls) || completedCalls < 0)
      throw new Error("Invalid completed bounded-call count");
    this.acknowledged = new Set(acknowledged);
    if ([...this.acknowledged].some((value) => !Number.isSafeInteger(value) || value < 1))
      throw new Error("Invalid acknowledged request ordinal");
    this.ordinal = completedCalls;
    this.settled = completedCalls;
    if (!/^[a-z][a-z0-9:_-]{0,160}$/u.test(stage)) throw new Error("Invalid bounded model stage");
    this.descriptor = client.descriptor;
    this.models = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    this.receiptDirectory = resolve(ledger.directory, "model-receipts", hashJson(stage));
  }

  /**
   * The ordinals of the calls that returned a result, with their retries. A call that throws
   * does not count. Thus a resume from this number repeats the saved tries of that call.
   */
  get completedCalls(): number {
    return this.settled;
  }

  /**
   * Send the request. If the provider rejects it for its rate limit, try again at most three
   * times. Each try is the next ordinal, so it is a distinct ledger request and receipt. If
   * the next try has saved files, a replay continues to it and does not wait again. A saved
   * failure with an acknowledged ordinal has a known charge. After it, the call starts again
   * at the first try of the next ordinal.
   */
  async complete(request: ModelTurnRequest, signal?: AbortSignal): Promise<ModelTurnResult> {
    for (let retry = 0; ; retry++) {
      const final = retry === RATE_LIMIT_WAITS_MS.length;
      const result = await this.completeOnce(request, signal, final);
      if (this.acknowledged.has(this.ordinal)) {
        if (result.kind !== "provider_error")
          throw new Error("An acknowledged request ordinal has no saved provider failure");
        retry = -1;
        continue;
      }
      if (final || result.kind !== "provider_error" || !isUnchargedRateLimit(result)) {
        this.settled = this.ordinal;
        return result;
      }
      if (this.replayOnly || (await this.started(this.ordinal + 1))) continue;
      try {
        await this.pause(rateLimitWaitMs(retry, result.message), signal);
      } catch (error) {
        // Stop came before the next try. The saved rejection has no charge, so a resume can
        // replay it, wait again and continue.
        throw new ModelRequestAdmissionError(error);
      }
    }
  }

  /** True when an earlier process started this ordinal. Its wait came before it. */
  private async started(ordinal: number): Promise<boolean> {
    return stat(resolve(this.receiptDirectory, `${ordinal}.request.json`)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
  }

  /** One try. Basalt records a failure only for a result that it does not try again. */
  private async completeOnce(
    request: ModelTurnRequest,
    signal: AbortSignal | undefined,
    final: boolean,
  ): Promise<ModelTurnResult> {
    try {
      await this.beforeRequest?.("admission");
    } catch (error) {
      throw new ModelRequestAdmissionError(error);
    }
    try {
      this.client.validateRequest?.(request);
    } catch (error) {
      throw new ModelRequestValidationError(
        error instanceof Error ? error.message : "Local request validation failed",
      );
    }
    signal?.throwIfAborted();
    const snapshot = this.models.get(request.model);
    if (!snapshot) throw new Error("Model has no frozen endpoint snapshot");
    const requestHash = modelTurnRequestHash(request, this.descriptor);
    const ordinal = ++this.ordinal;
    const requestId = DurableSpendLedger.requestId(`${this.stage}:${ordinal}`, requestHash);
    const receiptFile = resolve(this.receiptDirectory, `${ordinal}.json`);
    const responseFile = resolve(this.receiptDirectory, `${ordinal}.response.json`);
    const previous = await readFile(receiptFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (previous !== null) {
      const receipt = JSON.parse(previous) as {
        requestId: string;
        requestHash: string;
        result: ModelTurnResult;
        resultHash: string;
      };
      const state = await this.ledger.read();
      const entry = state.entries.find((item) => item.requestId === requestId);
      const charge = knownChargeUsd(receipt.result);
      if (
        receipt.requestId !== requestId ||
        receipt.requestHash !== requestHash ||
        receipt.resultHash !== hashJson(receipt.result) ||
        receipt.result.requestHash !== requestHash ||
        !entry ||
        charge === null
      )
        throw new Error(
          "Paid call uncertain. A saved response does not match its saved request. Basalt cannot send the request again.",
        );
      if (entry.status !== "billed") await this.ledger.reconcile(requestId, charge);
      else if (entry.billedUsd !== charge)
        throw new Error(
          "Paid call uncertain. The cost in a saved response differs from the confirmed charge.",
        );
      return receipt.result;
    }
    const retainedResponse = await readFile(responseFile, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (retainedResponse !== null) {
      const response = JSON.parse(retainedResponse) as {
        requestId: string;
        requestHash: string;
        result: ModelTurnResult;
        resultHash: string;
        generationId: string | null;
        imageInputs: RequestImageInput[];
      };
      const state = await this.ledger.read();
      const entry = state.entries.find((item) => item.requestId === requestId);
      if (
        response.requestId !== requestId ||
        response.requestHash !== requestHash ||
        response.resultHash !== hashJson(response.result) ||
        response.generationId !== response.result.responseFacts?.responseId ||
        response.result.requestHash !== requestHash ||
        hashJson(response.imageInputs ?? null) !== hashJson(requestImageInputs(request)) ||
        !entry
      )
        throw new Error(
          "Paid call uncertain. A saved provider response does not match its saved request. Basalt cannot send the request again.",
        );
      const cost = knownChargeUsd(response.result);
      if (cost === null)
        throw new ModelRequestPendingError(
          "Paid call uncertain. A saved request has a pending charge. Basalt cannot send it again. Select Check payment status.",
        );
      const receipt = {
        requestId,
        requestHash,
        imageInputs: response.imageInputs,
        result: response.result,
        resultHash: response.resultHash,
      };
      await publishImmutable(receiptFile, stableJson(receipt) + "\n");
      if (entry.status !== "billed") await this.ledger.reconcile(requestId, cost);
      else if (entry.billedUsd !== cost)
        throw new Error(
          "Paid call uncertain. The cost in a saved response differs from the confirmed charge.",
        );
      return response.result;
    }
    if (this.replayOnly)
      throw new Error(
        "Basalt has no saved response for this request. Basalt cannot send a new paid request while it checks saved work.",
      );
    const reservation = {
      request,
      signal,
      snapshot,
      requestId,
      requestHash,
      ordinal,
      receiptFile,
      responseFile,
      final,
    };
    if (!this.permit) return this.reserveAndDispatch(reservation);
    // A held request fails the admission check above before it waits for a permit.
    const endPermit = await this.permit(signal);
    try {
      try {
        // Another unit can pause the run while this request waits for its permit.
        await this.beforeRequest?.("admission");
      } catch (error) {
        throw new ModelRequestAdmissionError(error);
      }
      return await this.reserveAndDispatch(reservation);
    } finally {
      endPermit();
    }
  }

  /** Reserve the full cost of a new request, then dispatch it. */
  private async reserveAndDispatch(input: {
    request: ModelTurnRequest;
    signal: AbortSignal | undefined;
    snapshot: ModelSnapshot;
    requestId: string;
    requestHash: string;
    ordinal: number;
    receiptFile: string;
    responseFile: string;
    final: boolean;
  }): Promise<ModelTurnResult> {
    const { request, signal, snapshot, requestId, requestHash, ordinal } = input;
    await settleSavedRejections(this.ledger);
    const state = await this.ledger.read();
    const reserved = state.entries.find((entry) => entry.requestId === requestId);
    if (reserved) {
      const message =
        "Paid call uncertain. A saved request has no complete response. Basalt cannot send it again.";
      if (reserved.status === "pending") throw new ModelRequestPendingError(message);
      throw new Error(message);
    }
    let maximumUsd: number;
    let imageInputs: RequestImageInput[];
    try {
      maximumUsd = maximumRequestCost(snapshot, request);
      imageInputs = requestImageInputs(request);
    } catch (error) {
      throw new ModelRequestValidationError(
        error instanceof Error ? error.message : "Local request bounds failed",
      );
    }
    await mkdir(this.receiptDirectory, { recursive: true, mode: 0o700 });
    const intentFile = resolve(this.receiptDirectory, `${ordinal}.request.json`);
    const intent =
      stableJson({ requestId, requestHash, request, transport: this.descriptor, maximumUsd }) +
      "\n";
    try {
      await publishImmutable(intentFile, intent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await readFile(intentFile, "utf8")) !== intent)
        throw new Error("Reserved request intent changed");
    }
    try {
      // The client holds its request until the charge is known or the request is given up.
      // Other units of the same run can reserve while this request is held.
      await this.ledger.reserve({
        requestId,
        requestHash,
        stage: this.stage,
        maximumUsd,
        hold: true,
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      if (cause instanceof SpendingCeilingError)
        await this.ledger.recordFailure({
          causeCode: "spending_ceiling",
          category: "budget",
          dependency: this.ledger.operationId,
          unit: {
            stage: this.stage.split(":")[0]!,
            id: this.stage.split(":").slice(1).join(":") || requestId,
          },
          evidenceRefs: [requestHash],
          recoveryActions: ["amend_budget"],
          explanation: cause.message,
        });
      throw cause;
    }
    try {
      return await this.dispatchReserved({ ...input, imageInputs });
    } finally {
      // A request without a known charge stays pending. Without a holder, it blocks new
      // dispatch until Basalt reconciles it.
      this.ledger.release(requestId);
    }
  }

  private async dispatchReserved(input: {
    request: ModelTurnRequest;
    signal: AbortSignal | undefined;
    snapshot: ModelSnapshot;
    requestId: string;
    requestHash: string;
    ordinal: number;
    receiptFile: string;
    responseFile: string;
    imageInputs: RequestImageInput[];
    final: boolean;
  }): Promise<ModelTurnResult> {
    const { request, signal, snapshot, requestId, requestHash, ordinal, receiptFile } = input;
    const { responseFile, imageInputs, final } = input;
    let dispatchStarted = false;
    let dispatchClosed = false;
    let dispatched = false;
    // The error class of a transport result names the local cause, for example a missing tool
    // result. It is a sanitized slug, never provider text.
    const localFailure = async (errorClass: string | null) => {
      // Releasing a reservation also revokes the in-flight durability hook.
      // Stop may win while its dispatch marker is still being flushed to disk.
      dispatchClosed = true;
      await publishImmutable(
        resolve(this.receiptDirectory, `${ordinal}.local-failure.json`),
        stableJson({
          requestId,
          requestHash,
          reason: "Transport stopped before network dispatch",
          errorClass,
          costUsd: 0,
        }) + "\n",
      );
      await this.ledger.reconcile(requestId, 0);
      throw new ModelRequestValidationError(
        `Transport stopped before network dispatch${errorClass ? ` (${errorClass})` : ""}; no charge was incurred`,
      );
    };
    const cancellation = signal ?? new AbortController().signal;
    let removeAbort = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(cancellation.reason);
      cancellation.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => cancellation.removeEventListener("abort", onAbort);
      if (cancellation.aborted) onAbort();
    });
    const pending = this.client
      .complete(request, cancellation, {
        beforeDispatch: async () => {
          if (dispatchStarted || dispatchClosed)
            throw new Error("A reserved model action cannot dispatch twice or after Stop");
          dispatchStarted = true;
          await this.beforeRequest?.("dispatch");
          cancellation.throwIfAborted();
          if (dispatchClosed) throw new Error("Model dispatch permission was withdrawn");
          await publishImmutable(
            resolve(this.receiptDirectory, `${ordinal}.dispatch.json`),
            stableJson({ requestId, requestHash }) + "\n",
          );
          cancellation.throwIfAborted();
          if (dispatchClosed) throw new Error("Model dispatch permission was withdrawn");
          dispatched = true;
        },
        response: async (identity) => {
          await publishImmutable(
            resolve(this.receiptDirectory, `${ordinal}.identity.json`),
            stableJson({ requestId, requestHash, ...identity }) + "\n",
          );
        },
      })
      .then(async (result) => {
        // A late response is retained for explicit reconciliation even after the
        // an explicit stop. It cannot trigger another request or release liability.
        await publishImmutable(
          responseFile,
          stableJson({
            requestId,
            requestHash,
            imageInputs,
            result,
            resultHash: hashJson(result),
            generationId: result.responseFacts?.responseId ?? null,
          }) + "\n",
        );
        return result;
      });
    const result = await Promise.race([pending, aborted])
      .catch(async () => {
        if (this.client.observesDispatch && !dispatched) return localFailure(null);
        await this.ledger.recordFailure({
          causeCode: cancellation.aborted
            ? "model_request_cancelled"
            : "transport_after_reservation",
          category: "provider",
          dependency: null,
          unit: {
            stage: this.stage.split(":")[0]!,
            id: this.stage.split(":").slice(1).join(":") || requestId,
          },
          evidenceRefs: [requestHash],
          recoveryActions: ["inspect", "reconcile"],
          explanation:
            "The model request stopped before Basalt received a response. The request has a pending charge. Select Check payment status.",
        });
        throw new ModelRequestPendingError(
          "Paid call uncertain. The model request stopped before Basalt received a response. Select Check payment status.",
        );
      })
      .finally(() => {
        removeAbort();
      });
    if (this.client.observesDispatch && !dispatched)
      return localFailure(result.kind === "provider_error" ? result.errorClass : null);
    const bound = result.requestHash === requestHash;
    const charge = bound ? knownChargeUsd(result) : null;
    const rejected = bound && isProviderRejection(result);
    // The loop in complete tries a rate limit again, so only the final try records a failure.
    if (
      (result.kind === "provider_error" || result.kind === "invalid_model_response") &&
      !(rejected && !final && isUnchargedRateLimit(result))
    )
      await this.ledger.recordFailure({
        causeCode: result.errorClass,
        category: "provider",
        dependency:
          result.kind === "provider_error" &&
          /^(?:http|provider_response_error)_(?:404|429|5[0-9]{2})$/u.test(result.errorClass)
            ? modelDependency(snapshot)
            : null,
        unit: {
          stage: this.stage.split(":")[0]!,
          id: this.stage.split(":").slice(1).join(":") || requestId,
        },
        evidenceRefs: [requestHash, hashJson(result)],
        recoveryActions: charge === null ? ["inspect", "reconcile"] : ["inspect"],
        explanation: `The provider request failed (${result.errorClass}). ${result.message.slice(0, 500)} ${
          rejected
            ? "The provider rejected the request, so Basalt recorded no charge."
            : "Basalt keeps the request and its charge in the spending record."
        }`,
      });
    if (charge === null) {
      if (result.kind === "assistant" || !bound)
        await this.ledger.recordFailure({
          causeCode: "unbound_billing",
          category: "provider",
          dependency: null,
          unit: {
            stage: this.stage.split(":")[0]!,
            id: this.stage.split(":").slice(1).join(":") || requestId,
          },
          evidenceRefs: [requestHash, hashJson(result)],
          recoveryActions: ["inspect", "reconcile"],
          explanation:
            "Basalt cannot confirm the charge of a saved response. The request has a pending charge for its full amount. Select Check payment status.",
        });
      throw new ModelRequestPendingError(
        "Paid call uncertain. Basalt cannot confirm the charge of the response. Select Check payment status.",
      );
    }
    const receipt = { requestId, requestHash, imageInputs, result, resultHash: hashJson(result) };
    await publishImmutable(receiptFile, stableJson(receipt) + "\n");
    await this.ledger.reconcile(requestId, charge);
    return result;
  }
}

/**
 * A provider rejection is a known zero charge: a 4xx error without a generation ID and without
 * a cost. OpenRouter does not create a generation for a request that it rejects. A 5xx error or
 * a result with a generation ID keeps a pending charge until Basalt knows its cost.
 */
function isProviderRejection(result: ModelTurnResult): boolean {
  return (
    result.kind === "provider_error" &&
    /^(?:http|provider_response_error)_4[0-9]{2}$/u.test(result.errorClass) &&
    (result.responseFacts?.responseId ?? null) === null &&
    result.usage?.costUsd === null
  );
}

/** A rejection for the rate limit. The bounded client tries it again; it has no charge. */
export function isUnchargedRateLimit(result: ModelTurnResult): boolean {
  return (
    result.kind === "provider_error" &&
    /_429$/u.test(result.errorClass) &&
    isProviderRejection(result)
  );
}

/** The charge of a result: its cost, zero for a provider rejection, or null when unknown. */
export function knownChargeUsd(result: ModelTurnResult): number | null {
  const cost = result.usage?.costUsd ?? null;
  if (cost === null) return isProviderRejection(result) ? 0 : null;
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/** The dependency of a model or persistent provider failure: the model and its endpoints. */
export function modelDependency(snapshot: ModelSnapshot): string {
  return hashJson({
    model: snapshot.id,
    endpoints: snapshot.endpoints.map((endpoint) => endpoint.tag),
  });
}

/**
 * The provider pause of another unit holds this stage before its next request. A
 * `beforeRequest` hook throws it, so the client sends and reserves nothing.
 */
export class ProviderHoldError extends Error {
  constructor(readonly record: PauseRecord) {
    super(
      `An earlier provider failure (${record.errorClass}) holds this work. Resume the run to continue it.`,
    );
    this.name = "ProviderHoldError";
  }
}

/** The provider rejected a request for its rate limit after all tries. */
export class ModelRateLimitError extends Error {
  constructor(readonly errorClass: string) {
    super(
      `The provider rejected the request for its rate limit (${errorClass}) after all tries. Basalt recorded no charge.`,
    );
    this.name = "ModelRateLimitError";
  }
}

/**
 * The wait before a retry, from 0 for the first retry. If the closed Retry-After detail of
 * the result asks for a longer wait, Basalt waits that time, to a maximum of 300 s.
 */
function rateLimitWaitMs(retry: number, message: string): number {
  const scheduled = RATE_LIMIT_WAITS_MS[retry];
  if (scheduled === undefined) throw new Error("A rate limit has no more retries");
  const match = / Retry-After: ([0-9]{1,5}) seconds\./u.exec(message);
  const requested = match ? Number(match[1]) * 1_000 : 0;
  return requested > scheduled ? Math.min(requested, MAXIMUM_RATE_LIMIT_WAIT_MS) : scheduled;
}

/** Wait in real time. If the signal aborts, stop the wait at once. */
function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    if (signal?.aborted) return fail(signal.reason);
    const abort = () => {
      clearTimeout(timer);
      fail(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      done();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Settle at zero each pending request whose saved response is a provider rejection. This
 * releases the reservation after an interruption. It sends no request. A request that a live
 * client holds is not examined: its own client settles it.
 */
export async function settleSavedRejections(ledger: DurableSpendLedger): Promise<void> {
  const pending = await ledger.unownedPending();
  for (const entry of pending) {
    const directory = resolve(ledger.directory, "model-receipts", hashJson(entry.stage));
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (names.length > 10_000) throw new Error("Too many retained model receipts");
    const ordinal = names
      .map((name) => /^([1-9][0-9]{0,5})\.response\.json$/u.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)
      .find(
        (number) =>
          DurableSpendLedger.requestId(`${entry.stage}:${number}`, entry.requestHash) ===
          entry.requestId,
      );
    if (ordinal === undefined) continue;
    const response = JSON.parse(
      (
        await readBoundedRegularFile(
          resolve(directory, `${ordinal}.response.json`),
          MAX_MODEL_RESPONSE_BYTES,
          "model response",
        )
      ).toString("utf8"),
    ) as {
      requestId: string;
      requestHash: string;
      result: ModelTurnResult;
      resultHash: string;
      generationId: string | null;
      imageInputs: RequestImageInput[];
    };
    if (
      response.requestId !== entry.requestId ||
      response.requestHash !== entry.requestHash ||
      response.resultHash !== hashJson(response.result) ||
      response.result.requestHash !== entry.requestHash ||
      response.generationId !== null ||
      !validImageInputs(response.imageInputs) ||
      !isProviderRejection(response.result)
    )
      continue;
    const receipt = {
      requestId: entry.requestId,
      requestHash: entry.requestHash,
      imageInputs: response.imageInputs,
      result: response.result,
      resultHash: response.resultHash,
    };
    const receiptFile = resolve(directory, `${ordinal}.json`);
    try {
      await publishImmutable(receiptFile, stableJson(receipt) + "\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (hashJson(JSON.parse(await readFile(receiptFile, "utf8"))) !== hashJson(receipt))
        throw new Error("A saved receipt differs from the saved provider rejection");
    }
    await ledger.reconcile(entry.requestId, 0);
  }
}

export async function reconcileRetainedModelBilling(
  ledger: DurableSpendLedger,
  stage: string,
  ordinal: number,
  lookup: (generationId: string) => Promise<{ generationId: string; costUsd: number }>,
): Promise<ModelTurnResult> {
  if (!/^[a-z][a-z0-9:_-]{0,160}$/u.test(stage)) throw new Error("Invalid bounded model stage");
  if (!Number.isSafeInteger(ordinal) || ordinal < 1)
    throw new Error("Invalid paid request ordinal");
  const receiptDirectory = resolve(ledger.directory, "model-receipts", hashJson(stage));
  const responseFile = resolve(receiptDirectory, `${ordinal}.response.json`);
  const receiptFile = resolve(receiptDirectory, `${ordinal}.json`);
  const billingFile = resolve(receiptDirectory, `${ordinal}.billing.json`);
  const response = JSON.parse(await readFile(responseFile, "utf8")) as {
    requestId: string;
    requestHash: string;
    result: ModelTurnResult;
    resultHash: string;
    generationId: string | null;
    imageInputs: RequestImageInput[];
  };
  const generationId = response.generationId;
  const requestId = DurableSpendLedger.requestId(`${stage}:${ordinal}`, response.requestHash);
  const state = await ledger.read();
  const entry = state.entries.find((item) => item.requestId === requestId);
  if (
    response.requestId !== requestId ||
    !validImageInputs(response.imageInputs) ||
    response.resultHash !== hashJson(response.result) ||
    response.result.requestHash !== response.requestHash ||
    response.result.responseFacts?.responseId !== generationId ||
    !generationId ||
    !entry ||
    entry.requestHash !== response.requestHash
  )
    throw new Error("Retained paid response has no verifiable generation identity");
  const prior = await readFile(billingFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const billing =
    prior === null
      ? await lookup(generationId)
      : (JSON.parse(prior) as {
          generationId: string;
          costUsd: number;
        });
  if (
    billing.generationId !== generationId ||
    !Number.isFinite(billing.costUsd) ||
    billing.costUsd < 0
  )
    throw new Error("Read-only generation billing did not match the retained response");
  if (prior === null) await publishImmutable(billingFile, stableJson(billing) + "\n");
  const result = structuredClone(response.result);
  result.usage.costUsd = billing.costUsd;
  const receipt = {
    requestId,
    requestHash: response.requestHash,
    imageInputs: response.imageInputs,
    result,
    resultHash: hashJson(result),
  };
  try {
    await publishImmutable(receiptFile, stableJson(receipt) + "\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (hashJson(JSON.parse(await readFile(receiptFile, "utf8"))) !== hashJson(receipt))
      throw new Error("Retained billing differs from the saved paid response receipt");
  }
  if (entry.status !== "billed") await ledger.reconcile(requestId, billing.costUsd);
  else if (entry.billedUsd !== billing.costUsd)
    throw new Error("Read-only billing differs from reconciled ledger charge");
  return result;
}

/** One presented image in a receipt: its content hash and its pixel dimensions. */
export interface RequestImageInput {
  hash: string;
  width: number;
  height: number;
}

/** A receipt keeps the images of its request beside the billed prompt tokens. */
export function validImageInputs(value: unknown): value is RequestImageInput[] {
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        Object.keys(item).sort().join(",") === "hash,height,width" &&
        typeof item.hash === "string" &&
        /^[a-f0-9]{64}$/u.test(item.hash) &&
        [item.width, item.height].every(
          (pixels) => Number.isSafeInteger(pixels) && pixels > 0 && pixels <= 65535,
        ),
    )
  );
}

/** Quotation and dispatch use the same executable-request accounting. */
export function maximumRequestCost(snapshot: ModelSnapshot, request: ModelTurnRequest): number {
  return maximumUsageCost(snapshot, requestUsage(snapshot, request).upper);
}
