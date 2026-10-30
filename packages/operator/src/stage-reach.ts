import type {
  RunOperationEvent,
  RunOperationManifest,
  RunOperationStatus,
  RunSubject,
} from "../../contracts/src/execution.js";

/** The reason of the `not_dispatched` event of a build whose stage the run did not reach. */
export const STAGE_NOT_REACHED = "stage_not_reached";

/**
 * The state of the stage of a build.
 * - `reached`: the build can start. Stage 1 is always reached.
 * - `waiting`: the build of the stage before it, or its gate checks, are not finished.
 * - `not_reached`: the build of the stage before it did not complete, it was not reached, or a
 *   gate check did not pass. The build never starts.
 */
type StageReach = "reached" | "waiting" | "not_reached";

/** True when the event records a build whose stage the run did not reach. */
export function isNotReachedEvent(event: RunOperationEvent): boolean {
  return (
    event.kind === "not_dispatched" &&
    event.stage === "builder" &&
    event.reason === STAGE_NOT_REACHED
  );
}

/** The builds that the run recorded as not reached. */
export function notReachedSubjects(events: RunOperationEvent[]): Set<string> {
  return new Set(events.filter(isNotReachedEvent).map((event) => event.unitId!));
}

/**
 * The gate checks of a parent build: each code check of the gate of its stage, on each
 * observation of the build.
 */
export function gateCells(
  manifest: Pick<RunOperationManifest, "evals" | "subjects" | "captureCells" | "gradingCells">,
  parent: RunSubject,
): RunOperationManifest["gradingCells"] {
  const gates = manifest.evals.find((item) => item.id === parent.evalId)?.stage.gateCriterionIds;
  if (!gates?.length) return [];
  const captures = new Set(
    manifest.captureCells.filter((cell) => cell.treatmentId === parent.id).map((cell) => cell.id),
  );
  return manifest.gradingCells.filter(
    (cell) => captures.has(cell.captureCellId) && gates.includes(cell.criterionId),
  );
}

/**
 * Decide if the run reached the stage of a build. A later stage starts from the sealed build of
 * the stage before it, so that build must complete. When that stage has a gate, each gate check
 * must also pass on each observation of that build. A gate check that cannot pass, for example
 * because its observation failed, leaves the later stage not reached.
 */
export function stageReach(
  status: Pick<RunOperationStatus, "manifest" | "events" | "criterionOutcomes">,
  subject: RunSubject,
): StageReach {
  if (subject.parentSubjectId === null) return "reached";
  const manifest = status.manifest;
  const parent = manifest.subjects.find((item) => item.id === subject.parentSubjectId);
  if (!parent) throw new Error("A later stage has no build of the stage before it");
  const latest = latestEvents(status.events);
  const parentEvent = latest.get(`builder:${parent.id}`);
  if (parentEvent && isNotReachedEvent(parentEvent)) return "not_reached";
  if (parentEvent?.kind === "failed" || parentEvent?.kind === "incomplete") return "not_reached";
  if (parentEvent?.kind !== "completed") return "waiting";
  const states = gateStates(status, parent, latest).map(({ state }) => state);
  if (states.includes("failed")) return "not_reached";
  return states.includes("waiting") ? "waiting" : "reached";
}

function latestEvents(events: RunOperationEvent[]) {
  const latest = new Map<string, RunOperationEvent>();
  for (const event of events)
    if (event.stage !== null && event.unitId !== null)
      latest.set(`${event.stage}:${event.unitId}`, event);
  return latest;
}

/**
 * The state of each gate check of a parent build. A check that did not get "met", or whose
 * observation or check failed, has failed. A check without an answer yet is waiting.
 */
function gateStates(
  status: Pick<RunOperationStatus, "manifest" | "criterionOutcomes">,
  parent: RunSubject,
  latest: Map<string, RunOperationEvent>,
) {
  const outcomes = new Map(
    status.criterionOutcomes.map((item) => [`${item.cellId}:${item.criterionId}`, item.outcome]),
  );
  return gateCells(status.manifest, parent).map((cell) => {
    const outcome = outcomes.get(`${cell.id}:${cell.criterionId}`);
    if (outcome !== undefined)
      return { cell, state: outcome === "verified" ? ("passed" as const) : ("failed" as const) };
    const grading = latest.get(`grading:${cell.id}`)?.kind;
    const capture = latest.get(`final_capture:${cell.captureCellId}`)?.kind;
    const failed = [grading, capture].some((kind) => kind === "failed" || kind === "incomplete");
    return { cell, state: failed ? ("failed" as const) : ("waiting" as const) };
  });
}

/**
 * Why the run did not reach the stage of a build: its build of the stage before it, and the
 * gate checks of that build that failed. No failed check means that the build before it did not
 * finish or was not reached itself.
 */
export function notReachedCause(
  status: Pick<RunOperationStatus, "manifest" | "events" | "criterionOutcomes">,
  subject: RunSubject,
) {
  const parent = status.manifest.subjects.find((item) => item.id === subject.parentSubjectId);
  if (!parent) return null;
  return {
    parent,
    failedGateCells: gateStates(status, parent, latestEvents(status.events))
      .filter(({ state }) => state === "failed")
      .map(({ cell }) => cell),
  };
}

/**
 * Record the build of a later stage that the run did not reach, and return true. The build
 * starts no model work. Return false when the run reached the stage or still waits for it.
 */
export async function recordNotReached(
  store: {
    append(
      event: Omit<RunOperationEvent, "schema" | "id" | "sequence" | "previousHash">,
    ): Promise<unknown>;
  },
  status: Pick<RunOperationStatus, "manifest" | "events" | "criterionOutcomes">,
  subject: RunSubject,
): Promise<boolean> {
  if (stageReach(status, subject) !== "not_reached") return false;
  await store.append({
    kind: "not_dispatched",
    stage: "builder",
    unitId: subject.id,
    artifactHashes: [],
    reason: STAGE_NOT_REACHED,
    at: new Date().toISOString(),
  });
  return true;
}
