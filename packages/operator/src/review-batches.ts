import { reviewerProfile } from "./reviewers.js";
import { readRegisteredExperiment } from "./experiment-plan.js";
import { hashJson } from "../../contracts/src/index.js";
import type {
  ReviewAnswer,
  ReviewAssignment,
  ReviewBatch,
  ReviewExpertLink,
  ReviewPair,
  ReviewPopulation,
  ReviewPreview,
  ReviewProgress,
} from "../../contracts/src/review.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { reviewSequence, sameDecision } from "../../experiments/src/audit.js";
import { frozenRunStatus } from "./run-builder.js";
import { releasedEvidenceItems } from "./evidence.js";
import { previewReviewBatch } from "./review-population.js";
import {
  ReviewConflict,
  readReviewAnswer,
  readReviewPair,
  readReviewPopulation,
  readReviewPreview,
  requireAssignment,
  requireBatch,
  reviewBinding,
  saveReviewArtifact,
  projectReviewProgress,
} from "./review-store.js";

function creationKey(idempotencyKey: string) {
  if (typeof idempotencyKey !== "string" || !/^[a-zA-Z0-9-]{8,160}$/u.test(idempotencyKey))
    throw new Error("A stable review creation identity is required");
  return hashJson({ idempotencyKey });
}

/** Earlier creation with the same key gives the same batches. Another request conflicts. */
function earlierCreation(journal: OperationJournal, identity: string, request: string) {
  const existing = journal.read<{ request: string; batchIds: string[] }>(
    "review_creation",
    identity,
  );
  if (!existing) return null;
  if (existing.request !== request)
    throw new ReviewConflict("This creation identity was already used for another selection");
  return existing.batchIds.map((id) => projectReviewProgress(journal, requireBatch(journal, id)));
}

/**
 * Release receipts and assignments for one reviewer. The order and the repeats come from the
 * seed of this batch. A delayed repeat never reuses an answer.
 */
async function prepareAssignments(
  root: string,
  journal: OperationJournal,
  input: {
    batchId: string;
    population: ReviewPopulation;
    unitIds: string[];
    reviewer: string;
    purpose: ReviewBatch["purpose"];
    orderSeed: string;
    repeats: boolean;
    reuse: boolean;
    peers: ReadonlyMap<string, string> | null;
  },
): Promise<ReviewAssignment[]> {
  const { batchId, population, reviewer } = input;
  const releases = new Map<string, Awaited<ReturnType<typeof releasedEvidenceItems>>>();
  const statuses = new Map<string, Awaited<ReturnType<typeof frozenRunStatus>>>();
  const receipts = new Map<string, string>(),
    reused = new Map<string, ReviewAnswer>();
  for (const unitId of input.unitIds) {
    const { unit, evidence, item } = reviewBinding(population, unitId);
    const released =
      releases.get(item.id) ?? (await releasedEvidenceItems(root, evidence, item.id));
    releases.set(item.id, released);
    if (!released.length) throw new Error("Selected evidence has not been released");
    const status =
      statuses.get(unit.operationId) ?? (await frozenRunStatus(root, unit.operationId, false));
    statuses.set(unit.operationId, status);
    const releaseBody = {
      batchId,
      unitId,
      binding: unit.binding,
      manifestHash: unit.manifestHash,
      gateReceiptHashes: item.releaseGateIds.map((gateId) => {
        const event = status.events.find(
          (event) =>
            event.kind === "completed" &&
            event.unitId === gateId &&
            ["selection", "review"].includes(event.stage ?? ""),
        );
        if (!event?.artifactHashes[0])
          throw new Error("Release lacks an authoritative gate receipt");
        return event.artifactHashes[0];
      }),
    };
    const release = { ...releaseBody, id: hashJson(releaseBody) };
    await saveReviewArtifact(root, "releases", release);
    receipts.set(unitId, release.id);
    if (!input.reuse) continue;
    const previous = journal.read<{ id: string }>(
      "review_labels",
      hashJson({ reviewer, binding: unit.binding }),
    );
    const answer = previous ? await readReviewAnswer(root, previous.id) : null;
    if (
      answer &&
      answer.reviewer === reviewer &&
      answer.binding === unit.binding &&
      (input.purpose !== "protocol" || answer.purpose === "protocol")
    )
      reused.set(unitId, answer);
  }
  const sequence = reviewSequence(
    input.unitIds,
    input.orderSeed,
    input.repeats ? new Set(input.unitIds.filter((id) => !reused.has(id))) : null,
  );
  const firstIds = new Map<string, string>();
  return sequence.map(({ unitId, repeat }, ordinal) => {
    const answer = repeat ? null : (reused.get(unitId) ?? null);
    const id = hashJson({ batchId, unitId, repeat });
    if (!repeat) firstIds.set(unitId, id);
    return {
      id,
      batchId,
      unitId,
      reviewer,
      ordinal,
      releaseHash: receipts.get(unitId)!,
      acknowledged: answer !== null,
      claim: null,
      draft: {
        revision: 0,
        decision: answer?.decision ?? null,
        reason: answer?.reason ?? null,
        blindingIssue: answer?.blindingIssue ?? null,
      },
      answerId: answer?.id ?? null,
      submittedVerdict: answer?.verdict ?? null,
      reusedFrom: answer?.id ?? null,
      repeatOf: repeat ? firstIds.get(unitId)! : null,
      peerAnswerId: input.peers?.get(unitId) ?? null,
      sessionNumber: null,
    };
  });
}

/** Store new batches and their assignments in one transaction. */
function storeBatches(
  journal: OperationJournal,
  identity: string,
  request: string,
  batches: Array<{ batch: ReviewBatch; assignments: ReviewAssignment[] }>,
  pair: ReviewPair | null,
  population: ReviewPopulation,
) {
  return journal.transaction(() => {
    const raced = earlierCreation(journal, identity, request);
    if (raced) return raced;
    for (const { batch, assignments } of batches) {
      // Training and the reviews that count never share an item.
      const own = batch.purpose === "training" ? "training" : "labelling",
        other = batch.purpose === "training" ? "labelling" : "training";
      const bindings = [
        ...new Set(assignments.map((item) => reviewBinding(population, item.unitId).unit.binding)),
      ];
      if (bindings.some((binding) => journal.read(`review_${other}_bindings`, binding)))
        throw new ReviewConflict(
          "Another review used one of these items for a different purpose. Preview the sample again.",
        );
      for (const binding of bindings)
        if (!journal.read(`review_${own}_bindings`, binding))
          journal.put(`review_${own}_bindings`, binding, { batchId: batch.id });
      for (const assignment of assignments)
        journal.put("review_assignments", assignment.id, assignment);
      journal.put("review_batches", batch.id, batch);
      for (const operationId of batch.operationIds) {
        const refs = journal.read<string[]>("operation_review_batches", operationId) ?? [];
        journal.put("operation_review_batches", operationId, [...refs, batch.id]);
      }
    }
    if (pair) journal.put("review_pairs", pair.id, pair);
    journal.put("review_creation", identity, {
      request,
      batchIds: batches.map(({ batch }) => batch.id),
    });
    return batches.map(({ batch }) => projectReviewProgress(journal, batch));
  });
}

function newBatch(input: {
  id: string;
  preview: ReviewPreview;
  reviewer: string;
  orderSeed: string;
  assignments: ReviewAssignment[];
  expert: ReviewExpertLink | null;
}): ReviewBatch {
  return {
    id: input.id,
    previewId: input.preview.id,
    populationId: input.preview.populationId,
    purpose: input.preview.selection.purpose,
    reviewer: input.reviewer,
    orderSeed: input.orderSeed,
    assignmentIds: input.assignments.map((item) => item.id),
    state: input.assignments.every((item) => item.answerId !== null) ? "completed" : "active",
    sessions: [],
    expert: input.expert,
    createdAt: new Date().toISOString(),
    operationIds: [...input.preview.selection.operationIds],
  };
}

export async function createReviewBatch(
  root: string,
  previewId: string,
  idempotencyKey: string,
): Promise<ReviewProgress> {
  const identity = creationKey(idempotencyKey);
  const preview = await readReviewPreview(root, previewId);
  const population = await readReviewPopulation(root, preview.populationId);
  await reviewerProfile(root, preview.selection.reviewer);
  const id = hashJson({ previewId, identity }),
    request = hashJson({ previewId });
  const journal = await OperationJournal.open(root);
  try {
    const existing = earlierCreation(journal, identity, request);
    if (existing) return existing[0]!;
    const purpose = preview.selection.purpose;
    const orderSeed = hashJson({ seed: preview.seed, batchId: id });
    const assignments = await prepareAssignments(root, journal, {
      batchId: id,
      population,
      unitIds: preview.selectedUnitIds,
      reviewer: preview.selection.reviewer,
      purpose,
      orderSeed,
      // A frozen protocol fixes its workload, so it has no repeats.
      repeats: purpose === "audit" || purpose === "diagnostic",
      reuse: purpose !== "training",
      peers: null,
    });
    const paired = purpose === "audit" || purpose === "diagnostic";
    const batch = newBatch({
      id,
      preview,
      reviewer: preview.selection.reviewer,
      orderSeed,
      assignments,
      expert: paired ? { pairId: id, role: "first", round: 1 } : null,
    });
    return storeBatches(
      journal,
      identity,
      request,
      [{ batch, assignments }],
      paired ? { id, first: id, second: null, roundTwo: null } : null,
      population,
    )[0]!;
  } finally {
    journal.close();
  }
}

/** The first answer of round 1 for each unit of a batch. */
async function firstAnswers(root: string, journal: OperationJournal, batch: ReviewBatch) {
  const answers = new Map<string, ReviewAnswer | null>();
  for (const id of batch.assignmentIds) {
    const assignment = requireAssignment(journal, batch, id);
    if (assignment.repeatOf !== null) continue;
    answers.set(
      assignment.unitId,
      assignment.answerId ? await readReviewAnswer(root, assignment.answerId) : null,
    );
  }
  return answers;
}

/**
 * A second, independent reviewer answers the same questions in a separate blind batch. The
 * batch has its own order and its own delayed repeats.
 */
export async function createSecondReviewBatch(
  root: string,
  firstBatchId: string,
  reviewer: string,
  idempotencyKey: string,
): Promise<ReviewProgress> {
  const identity = creationKey(idempotencyKey);
  await reviewerProfile(root, reviewer);
  const request = hashJson({ second: firstBatchId, reviewer });
  const journal = await OperationJournal.open(root);
  try {
    const existing = earlierCreation(journal, identity, request);
    if (existing) return existing[0]!;
    const first = requireBatch(journal, firstBatchId);
    if (first.expert?.role !== "first" || first.expert.round !== 1)
      throw new Error("Only a random or a targeted review can have a second reviewer.");
    if (first.reviewer === reviewer)
      throw new ReviewConflict("Choose a different person for the second review.");
    const pair = readReviewPair(journal, first.expert.pairId);
    if (!pair) throw new Error("The review pair is unavailable");
    if (pair.second) throw new ReviewConflict("This review already has a second reviewer.");
    const preview = await readReviewPreview(root, first.previewId);
    const population = await readReviewPopulation(root, first.populationId);
    const firstUnits = new Set(
      first.assignmentIds
        .map((id) => requireAssignment(journal, first, id))
        .filter((assignment) => assignment.repeatOf === null)
        .map((assignment) => assignment.unitId),
    );
    const unitIds = preview.selectedUnitIds.filter((unitId) => firstUnits.has(unitId));
    const id = hashJson({ firstBatchId, reviewer, identity });
    const orderSeed = hashJson({ seed: preview.seed, batchId: id });
    const assignments = await prepareAssignments(root, journal, {
      batchId: id,
      population,
      unitIds,
      reviewer,
      purpose: first.purpose,
      orderSeed,
      repeats: true,
      reuse: true,
      peers: null,
    });
    const batch = newBatch({
      id,
      preview,
      reviewer,
      orderSeed,
      assignments,
      expert: { pairId: pair.id, role: "second", round: 1 },
    });
    return storeBatches(
      journal,
      identity,
      request,
      [{ batch, assignments }],
      { ...pair, second: id },
      population,
    )[0]!;
  } finally {
    journal.close();
  }
}

/**
 * Round 2 starts after both reviewers finish round 1. Each reviewer sees only the other
 * answer and reason for each question where the two answers differ, never a judge answer.
 */
export async function createRoundTwoBatches(
  root: string,
  batchId: string,
  idempotencyKey: string,
): Promise<ReviewProgress[]> {
  const identity = creationKey(idempotencyKey);
  const journal = await OperationJournal.open(root);
  try {
    // Any round 1 batch of the pair identifies the pair.
    const pairId = requireBatch(journal, batchId).expert?.pairId;
    if (!pairId) throw new ReviewConflict("Round 2 needs a review with a second reviewer.");
    const request = hashJson({ roundTwo: pairId });
    const existing = earlierCreation(journal, identity, request);
    if (existing) return existing;
    const pair = readReviewPair(journal, pairId);
    if (!pair?.second) throw new ReviewConflict("Round 2 needs a second reviewer.");
    if (pair.roundTwo) throw new ReviewConflict("Round 2 already started.");
    const first = requireBatch(journal, pair.first),
      second = requireBatch(journal, pair.second);
    if (first.state !== "completed" || second.state !== "completed")
      throw new ReviewConflict("Round 2 starts after both reviewers answer all questions.");
    const firstAnswersByUnit = await firstAnswers(root, journal, first),
      secondAnswersByUnit = await firstAnswers(root, journal, second);
    const unitIds = [...firstAnswersByUnit.keys()].filter(
      (unitId) =>
        !sameDecision(
          firstAnswersByUnit.get(unitId)?.decision ?? null,
          secondAnswersByUnit.get(unitId)?.decision ?? null,
        ),
    );
    if (!unitIds.length)
      throw new ReviewConflict(
        "The two reviewers gave the same answer to each question. Round 2 has no questions.",
      );
    const preview = await readReviewPreview(root, first.previewId);
    const population = await readReviewPopulation(root, first.populationId);
    const batches: Array<{ batch: ReviewBatch; assignments: ReviewAssignment[] }> = [];
    for (const [role, own, other] of [
      ["first", first, secondAnswersByUnit],
      ["second", second, firstAnswersByUnit],
    ] as const) {
      const id = hashJson({ pairId, role, identity });
      const orderSeed = hashJson({ seed: preview.seed, batchId: id });
      const assignments = await prepareAssignments(root, journal, {
        batchId: id,
        population,
        unitIds,
        reviewer: own.reviewer,
        purpose: own.purpose,
        orderSeed,
        repeats: false,
        reuse: false,
        peers: new Map(unitIds.map((unitId) => [unitId, other.get(unitId)!.id])),
      });
      batches.push({
        batch: newBatch({
          id,
          preview,
          reviewer: own.reviewer,
          orderSeed,
          assignments,
          expert: { pairId, role, round: 2 },
        }),
        assignments,
      });
    }
    return storeBatches(
      journal,
      identity,
      request,
      batches,
      {
        ...pair,
        roundTwo: { first: batches[0]!.batch.id, second: batches[1]!.batch.id, unitIds },
      },
      population,
    );
  } finally {
    journal.close();
  }
}

export async function reviewBatchProgress(root: string, id: string): Promise<ReviewProgress> {
  const journal = await OperationJournal.open(root);
  try {
    const batch = requireBatch(journal, id);
    const page = journal.read<ReviewProgress>("review_progress_snapshot", id);
    if (!page || page.id !== batch.id) throw new Error("Review progress projection is missing");
    return page;
  } finally {
    journal.close();
  }
}

export async function listReviewBatches(
  root: string,
  params: URLSearchParams = new URLSearchParams(),
) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.page<ReviewProgress>("review_progress", {
      q: params.get("q") ?? "",
      status: params.get("purpose") ?? "",
      state: params.get("state") ?? "",
      page: Number(params.get("page") ?? 1),
      limit: Number(params.get("limit") ?? 20),
    });
  } finally {
    journal.close();
  }
}

/** Only the owned experiment driver creates required research work automatically. */
export async function createProtocolReviewBatch(root: string, operationId: string) {
  const status = await frozenRunStatus(root, operationId, false);
  if (!status.manifest.protocol)
    throw new Error("This operation has no registered review protocol");
  const preview = await previewReviewBatch(root, {
    purpose: "protocol",
    operationIds: [operationId],
    reviewer: (await readRegisteredExperiment(root, status.manifest.protocol.registrationId))
      .reviewer,
    questionLimit: 100000,
    unitIds: [],
    treatments: [],
  });
  if (!preview.selectedUnitIds.length) return null;
  const journal = await OperationJournal.open(root);
  const key = hashJson({ operationId, populationId: preview.populationId, purpose: "protocol" });
  let savedPreview: string;
  try {
    savedPreview = journal.transaction(() => {
      const saved = journal.read<{ previewId: string }>("protocol_review_selection", key);
      if (saved) return saved.previewId;
      journal.put("protocol_review_selection", key, { previewId: preview.id });
      return preview.id;
    });
  } finally {
    journal.close();
  }
  return createReviewBatch(root, savedPreview, key);
}
