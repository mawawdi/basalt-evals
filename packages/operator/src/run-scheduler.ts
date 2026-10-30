import { RUN_CONCURRENCY } from "../../contracts/src/execution-limits.js";
import type {
  RunOperationManifest,
  RunOperationStatus,
  RunSubject,
  RunUnit,
} from "../../contracts/src/execution.js";
import type { StudioAdapter } from "../../studio-runner/src/adapter.js";
import { studioLaneConnectorUrl } from "../../studio-runner/src/studio-lanes.js";
import {
  exclusiveStage,
  pausedUnits,
  providerHolds,
  providerPausedUnits,
  unitHold,
} from "./operation.js";
import { generatedSubjects } from "./run-manifest.js";
import { notReachedSubjects, stageReach } from "./stage-reach.js";

export const unitKey = (unit: Pick<RunUnit, "stage" | "unitId">) => `${unit.stage}:${unit.unitId}`;

/**
 * The units that can start now, in priority sequence. Units that an earlier process left in
 * flight continue first. Then checks, observations and seals start before new builds, so the
 * run finishes its available evidence early. Builds and judgments obey their concurrency
 * limits, and new builds start round-robin across the models. A gate or the report starts only
 * when no other unit runs. A provider hold keeps each new or paused build and judgment of its
 * scope from starting. A build of a later stage starts only when the run reached its stage. A
 * build whose stage the run cannot reach is a builder unit too: the driver records it as not
 * reached and starts no model work, so it takes no build slot.
 */
export function dispatchableUnits(
  status: Pick<
    RunOperationStatus,
    | "finished"
    | "stopped"
    | "events"
    | "manifest"
    | "inFlightUnits"
    | "completedUnits"
    | "authorizationHash"
    | "pauseRecords"
    | "criterionOutcomes"
  >,
  input: {
    /** The keys of the units that this driver runs now. */
    running: ReadonlySet<string>;
    /** A pending charge without a live holder exists. No new paid unit can start. */
    unownedPending: boolean;
    limits?: { builder: number; judgment: number };
  },
): RunUnit[] {
  if (status.finished || status.stopped) return [];
  const limits = input.limits ?? RUN_CONCURRENCY;
  const gate = status.inFlightUnits.find((unit) => exclusiveStage(unit.stage));
  if (gate) return input.running.size ? [] : [gate];
  const busy = new Set(input.running);
  const startedBuilds = new Set<string>();
  for (const event of status.events) {
    const key = `${event.stage}:${event.unitId}`;
    if (event.kind === "started") busy.add(key);
    if (event.kind === "not_dispatched") busy.delete(key);
    if (event.kind === "started" && event.stage === "builder") startedBuilds.add(event.unitId!);
  }
  // A build that the run did not reach is final. It never starts.
  for (const id of notReachedSubjects(status.events)) busy.add(`builder:${id}`);
  const active = { builder: 0, judgment: 0 };
  for (const key of input.running) {
    const stage = key.slice(0, key.indexOf(":"));
    if (stage === "builder" || stage === "judgment") active[stage] += 1;
  }
  const units: RunUnit[] = [];
  const admit = (unit: RunUnit) => {
    const key = unitKey(unit);
    if (input.running.has(key) || units.some((item) => unitKey(item) === key)) return;
    if (unit.stage === "builder" || unit.stage === "judgment") {
      if (active[unit.stage] >= limits[unit.stage]) return;
      active[unit.stage] += 1;
    }
    units.push(unit);
    busy.add(key);
  };
  const completed = new Set(status.completedUnits);
  const manifest = status.manifest;
  const holds = providerHolds(status);
  const held = (unit: RunUnit) => unitHold(holds, manifest, unit) !== null;
  // 1. An interrupted unit continues first. Its own code reconciles the saved work. A hold
  // stops it before its next request.
  for (const unit of status.inFlightUnits) admit(unit);
  // 2. A raised limit resumes paused work, and a Resume resumes provider pauses, judgments
  // first. An unchanged limit keeps spending pauses paused. A raised limit never admits a
  // provider pause.
  const paused = pausedUnits(status);
  const raised = paused.filter((event) => event.artifactHashes[0] !== status.authorizationHash);
  const providerPaused = providerPausedUnits(status);
  const resumed = providerPaused
    .filter((pause) => pause.admitted)
    .map(({ event }) => ({ stage: event.stage!, unitId: event.unitId! }))
    .filter((unit) => !held(unit));
  if (!input.unownedPending) {
    for (const event of raised.filter((item) => item.stage === "judgment"))
      admit({ stage: "judgment", unitId: event.unitId! });
    for (const unit of resumed.filter((item) => item.stage === "judgment")) admit(unit);
  }
  // 3. Checks of completed observations.
  if (!input.unownedPending)
    for (const batch of manifest.judgmentBatches)
      if (
        completed.has(`final_capture:${batch.captureCellId}`) &&
        (!batch.substitution?.donorCaptureCellId ||
          completed.has(`final_capture:${batch.substitution.donorCaptureCellId}`)) &&
        !busy.has(`judgment:${batch.id}`) &&
        !held({ stage: "judgment", unitId: batch.id })
      )
        admit({ stage: "judgment", unitId: batch.id });
  for (const cell of manifest.gradingCells)
    if (
      (!input.unownedPending || cell.method === "deterministic") &&
      completed.has(`final_capture:${cell.captureCellId}`) &&
      !busy.has(`grading:${cell.id}`)
    )
      admit({ stage: "grading", unitId: cell.id });
  // 4. Observations of completed builds. They wait in the Studio queue of the run.
  for (const cell of manifest.captureCells)
    if (
      (completed.has(`builder:${cell.treatmentId}`) || completed.has(`seal:${cell.treatmentId}`)) &&
      cell.requires.every((id) => {
        const gate = manifest.gates.find((item) => item.id === id)!;
        return completed.has(`${gate.kind}:${id}`);
      }) &&
      !busy.has(`final_capture:${cell.id}`)
    )
      admit({ stage: "final_capture", unitId: cell.id });
  for (const subject of manifest.subjects)
    if (subject.sourceId && !busy.has(`seal:${subject.id}`))
      admit({ stage: "seal", unitId: subject.id });
  if (input.unownedPending) return units;
  // 5. Paused builds after a raised limit or a Resume, then new builds, round-robin across the
  // models.
  for (const event of raised.filter((item) => item.stage === "builder"))
    admit({ stage: "builder", unitId: event.unitId! });
  for (const unit of resumed.filter((item) => item.stage === "builder")) admit(unit);
  // Work paused at the unchanged limit keeps new builds from starting under it.
  if (raised.length < paused.length) return units;
  const waitingBuilds = generatedSubjects(manifest).filter(
    (subject) => !busy.has(`builder:${subject.id}`),
  );
  const reach = new Map(waitingBuilds.map((subject) => [subject.id, stageReach(status, subject)]));
  // The record of a stage that the run did not reach starts no model work and takes no slot.
  for (const subject of waitingBuilds)
    if (reach.get(subject.id) === "not_reached" && !input.running.has(`builder:${subject.id}`)) {
      units.push({ stage: "builder", unitId: subject.id });
      busy.add(`builder:${subject.id}`);
    }
  const fresh = waitingBuilds.filter(
    (subject) =>
      reach.get(subject.id) === "reached" && !held({ stage: "builder", unitId: subject.id }),
  );
  for (const unit of roundRobinBuilds({
    manifest,
    fresh,
    running: [
      ...input.running,
      ...units
        .filter((unit) => !(unit.stage === "builder" && reach.get(unit.unitId) === "not_reached"))
        .map(unitKey),
    ],
    started: startedBuilds,
    slots: limits.builder - active.builder,
  }))
    admit(unit);
  // 6. The report starts alone, after every build started and every gate completed.
  if (
    !units.length &&
    !input.running.size &&
    !paused.length &&
    !providerPaused.length &&
    generatedSubjects(manifest).every((subject) => busy.has(`builder:${subject.id}`)) &&
    manifest.gates.every((gate) => completed.has(`${gate.kind}:${gate.id}`))
  )
    units.push({ stage: "report", unitId: "final" });
  return units;
}

/**
 * The new builds that start, in their start sequence. Each next build comes from the model with
 * the fewest builds that run now. If models are equal, it comes from the model with the fewest
 * started builds, then from the model that comes first in the run. Thus one model cannot fill
 * all the builder slots.
 */
function roundRobinBuilds(input: {
  manifest: RunOperationManifest;
  /** The builds that can start, in the sequence of the run. */
  fresh: RunSubject[];
  /** The keys of the units that run or that start now. */
  running: string[];
  /** The builds that started in the run. */
  started: ReadonlySet<string>;
  slots: number;
}): RunUnit[] {
  const modelOf = new Map(
    generatedSubjects(input.manifest).map((subject) => [subject.id, subject.builder!.model.id]),
  );
  const lines = new Map<string, { running: number; started: number; builds: string[] }>();
  for (const model of modelOf.values())
    if (!lines.has(model)) lines.set(model, { running: 0, started: 0, builds: [] });
  for (const key of input.running)
    if (key.startsWith("builder:")) lines.get(modelOf.get(key.slice(8))!)!.running += 1;
  for (const id of input.started) lines.get(modelOf.get(id)!)!.started += 1;
  for (const subject of input.fresh) lines.get(modelOf.get(subject.id)!)!.builds.push(subject.id);
  const units: RunUnit[] = [];
  while (units.length < input.slots) {
    let next: { running: number; started: number; builds: string[] } | null = null;
    // The sequence of the map is the sequence of the models in the run.
    for (const line of lines.values())
      if (
        line.builds.length &&
        (!next ||
          line.running < next.running ||
          (line.running === next.running && line.started < next.started))
      )
        next = line;
    if (!next) break;
    units.push({ stage: "builder", unitId: next.builds.shift()! });
    next.running += 1;
    next.started += 1;
  }
  return units;
}

/**
 * The Studio queue of one run. It admits as many Studio jobs at a time as the run has Studio
 * lanes. Development runs of builds and final observations share it. A stop cancels a wait.
 * After `close`, the queue refuses each wait and each new job; a job that runs continues.
 */
export class StudioQueue {
  private active = 0;
  private closed: Error | null = null;
  private readonly waiters: Array<{
    development: boolean;
    admit: () => void;
    refuse: (error: unknown) => void;
  }> = [];

  constructor(private readonly turns = 1) {
    if (!Number.isSafeInteger(turns) || turns < 1)
      throw new Error("A Studio queue needs at least one turn");
  }

  /**
   * Wait for the turn of the caller. The returned function ends the turn. A development run
   * goes before each final capture that waits, because a builder waits for its result. Inside
   * each kind, the first caller goes first.
   */
  async acquire(development: boolean, signal?: AbortSignal): Promise<() => void> {
    if (this.closed) throw this.closed;
    signal?.throwIfAborted();
    if (this.active >= this.turns || this.waiters.length)
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          development,
          admit: () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
          refuse: (error: unknown) => {
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          },
        };
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal!.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const later = development ? this.waiters.findIndex((item) => !item.development) : -1;
        if (later >= 0) this.waiters.splice(later, 0, waiter);
        else this.waiters.push(waiter);
      });
    else this.active += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const next = this.waiters.shift();
      // The turn passes directly to the next waiter, so no new caller can take it first.
      if (next) next.admit();
      else this.active -= 1;
    };
  }

  /** Refuse each wait and each new job. A job that runs continues to its end. */
  close(reason: Error): void {
    this.closed ??= reason;
    for (const waiter of this.waiters.splice(0)) waiter.refuse(this.closed);
  }
}

/** Put the Studio jobs of an adapter through the queue of the run, before the native lanes. */
export function queuedStudioAdapter(adapter: StudioAdapter, queue: StudioQueue): StudioAdapter {
  return {
    ...adapter,
    async admit(input) {
      const queuedAt = input.queuedAt ?? new Date().toISOString();
      const endTurn = await queue.acquire(input.purpose === "development", input.signal);
      try {
        const admission = await adapter.admit?.({ ...input, queuedAt });
        return {
          lane: admission?.lane ?? 0,
          connectorUrl: admission?.connectorUrl ?? studioLaneConnectorUrl(0),
          async release() {
            try {
              await admission?.release();
            } finally {
              endTurn();
            }
          },
        };
      } catch (error) {
        endTurn();
        throw error;
      }
    },
  };
}

/**
 * Run the units of a run concurrently. The loop starts each unit that `dispatchableUnits`
 * allows and reads the status again when a unit ends. A stop aborts all units, and the loop
 * waits for them. If a unit fails in a way that stops the run, no new unit starts, the units
 * that run stop at their next boundary, and the loop then throws that failure.
 */
export async function runConcurrentUnits(input: {
  status(): Promise<RunOperationStatus>;
  /** True if a pending charge without a live holder exists. */
  unownedPending(): Promise<boolean>;
  execute(unit: RunUnit): Promise<void>;
  /** True if the failure of the unit must stop the run. */
  fatal(unit: RunUnit, cause: unknown, before: RunOperationStatus): Promise<boolean>;
  /** Nothing runs and nothing can start. True means that the loop reads the status again. */
  idle(status: RunOperationStatus, unownedPending: boolean): Promise<boolean>;
  /** A stop: the units abort. */
  signal: AbortSignal;
  /** Aborted when a failure stops the run: units send no new work. */
  drain: AbortController;
  limits?: { builder: number; judgment: number };
}): Promise<void> {
  const running = new Map<string, Promise<void>>();
  let failure: { cause: unknown } | null = null;
  let wake = () => {};
  const stopped = new Promise<void>((resolve) => {
    if (input.signal.aborted) resolve();
    else input.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const launch = (unit: RunUnit, before: RunOperationStatus) => {
    const key = unitKey(unit);
    const task = (async () => {
      try {
        await input.execute(unit);
      } catch (cause) {
        // A unit that a stop or a drain ended stays recoverable; that is not a new failure.
        if (
          !input.signal.aborted &&
          !failure &&
          !input.drain.signal.aborted &&
          (await input.fatal(unit, cause, before))
        ) {
          failure ??= { cause };
          input.drain.abort(cause);
        }
      } finally {
        running.delete(key);
        wake();
      }
    })();
    running.set(key, task);
  };
  try {
    for (;;) {
      const woken = new Promise<void>((resolve) => (wake = resolve));
      if (!input.signal.aborted && !input.drain.signal.aborted) {
        const status = await input.status();
        const unowned = await input.unownedPending();
        const units = dispatchableUnits(status, {
          running: new Set(running.keys()),
          unownedPending: unowned,
          ...(input.limits ? { limits: input.limits } : {}),
        });
        for (const unit of units) launch(unit, status);
        if (!running.size) {
          if (await input.idle(status, unowned)) continue;
          break;
        }
      } else if (!running.size) break;
      await Promise.race([woken, stopped]);
      // After a stop, wait for the units: each one sees the abort and ends promptly.
      if (input.signal.aborted) await Promise.allSettled([...running.values()]);
    }
  } catch (error) {
    failure ??= { cause: error };
  } finally {
    // The loop never ends while a unit runs: each unit ends at its next boundary first.
    if (running.size) {
      if (!input.drain.signal.aborted) input.drain.abort(failure?.cause);
      await Promise.allSettled([...running.values()]);
    }
  }
  if (failure) throw (failure as { cause: unknown }).cause;
}
