import { requireReviewActor } from "./reviewers.js";
import { criterionAuthoredPassages } from "../../eval-authoring/src/compiler.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { frozenRunStatus } from "./run-builder.js";
import { subjectEval } from "./run-manifest.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { hashJson } from "../../contracts/src/index.js";
import {
  REVIEW_REASON_CODES,
  REVIEW_REASON_SENTENCE_LIMIT,
  REVIEW_SESSION_LIMITS,
  type BlindReviewProgress,
  type BlindReviewQuestion,
  type ReviewAnswer,
  type ReviewAssignment,
  type ReviewBatch,
  type ReviewDecision,
  type ReviewReasonDraft,
  type ReviewSessionState,
} from "../../contracts/src/review.js";
import {
  evidenceView,
  evidenceImage,
  evidenceSource,
  releasedEvidenceItems,
  EvidenceUnavailable,
} from "./evidence.js";
import {
  ReviewConflict,
  decisionVerdict,
  projectReviewProgress,
  reviewProgress,
  readReviewAnswer,
  readReviewArtifact,
  readReviewPopulation,
  requireAssignment,
  requireBatch,
  requireReviewReason,
  reviewBinding,
  saveReviewArtifact,
} from "./review-store.js";

/** The browser tab that holds the current question. It is not a review session. */
interface ReviewLease {
  reviewer: string;
  sessionId: string;
  assignmentId: string;
  at: number;
  active: boolean;
  sequence: number;
}
const leaseMs = 45_000;
function sessionIdentity(id: string) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9-]{8,100}$/u.test(id))
    throw new Error("Invalid review session identity");
}
const currentSession = (batch: ReviewBatch): ReviewSessionState | null =>
  batch.sessions.at(-1) ?? null;
function newSession(batch: ReviewBatch, now: number) {
  batch.sessions.push({
    number: batch.sessions.length + 1,
    state: "open",
    startedAt: new Date(now).toISOString(),
    activeMs: 0,
    answered: 0,
  });
}
function settle(journal: OperationJournal, batch: ReviewBatch, now: number) {
  const lease = journal.read<ReviewLease>("review_lease", batch.id);
  const session = currentSession(batch);
  if (lease?.active && session?.state === "open") {
    session.activeMs += Math.min(30_000, Math.max(0, now - lease.at));
    if (session.activeMs >= REVIEW_SESSION_LIMITS.activeMs) session.state = "time_limit";
  }
  if (lease) journal.put("review_lease", batch.id, { ...lease, at: now });
}
/** Answers of round 1 count. Training, delayed repeats and round 2 never do. */
function countedAnswer(batch: ReviewBatch, assignment: ReviewAssignment) {
  return batch.purpose !== "training" && batch.expert?.round !== 2 && assignment.repeatOf === null;
}
function assignmentsOf(journal: OperationJournal, batch: ReviewBatch) {
  const assignments = batch.assignmentIds.map((id) => requireAssignment(journal, batch, id));
  const repeats = new Map(
    assignments.flatMap((item) => (item.repeatOf ? [[item.repeatOf, item] as const] : [])),
  );
  return { assignments, repeats };
}
/**
 * A reviewer can open an answered question again only in the session of its first answer.
 * After its delayed repeat opens, the first occurrence stays closed.
 */
function reopenable(
  batch: ReviewBatch,
  assignment: ReviewAssignment,
  repeat: ReviewAssignment | undefined,
) {
  const session = currentSession(batch);
  return (
    assignment.answerId !== null &&
    session?.state === "open" &&
    assignment.sessionNumber === session.number &&
    !(repeat && (repeat.claim || repeat.answerId))
  );
}
function own(
  journal: OperationJournal,
  batch: ReviewBatch,
  assignment: ReviewAssignment,
  sessionId: string,
  reviewer: string,
) {
  requireReviewActor(journal, batch, reviewer);
  sessionIdentity(sessionId);
  const lease = journal.read<ReviewLease>("review_lease", batch.id);
  if (
    !lease ||
    lease.reviewer !== reviewer ||
    lease.sessionId !== sessionId ||
    lease.assignmentId !== assignment.id ||
    assignment.claim?.sessionId !== sessionId
  )
    throw new ReviewConflict(
      "This question is open in another tab. Open the question again in this tab before you change the answer.",
    );
  const session = currentSession(batch);
  if (!session || !["open", "time_limit"].includes(session.state))
    throw new ReviewConflict("This review session ended. Start a new session to continue.");
}
async function context(
  root: string,
  batch: ReviewBatch,
  assignment: ReviewAssignment,
  allowUnavailable = false,
) {
  const population = await readReviewPopulation(root, batch.populationId);
  const binding = reviewBinding(population, assignment.unitId);
  const release = await readReviewArtifact<{
    id: string;
    batchId: string;
    unitId: string;
    binding: string;
  }>(root, "releases", assignment.releaseHash);
  if (
    release.batchId !== batch.id ||
    release.unitId !== assignment.unitId ||
    release.binding !== binding.unit.binding
  )
    throw new Error("Question evidence is not released");
  let unavailable: string | null = null;
  try {
    if (
      !(
        await releasedEvidenceItems(
          root,
          { ...binding.evidence, items: [{ ...binding.item, passes: [binding.pass] }] },
          binding.item.id,
        )
      ).length
    )
      throw new Error("Question evidence is not released");
  } catch (cause) {
    if (!allowUnavailable || !(cause instanceof EvidenceUnavailable)) throw cause;
    unavailable = cause.message;
  }
  return { ...binding, unavailable };
}
function blindProgress(journal: OperationJournal, batch: ReviewBatch): BlindReviewProgress {
  const {
    purpose: _purpose,
    createdAt: _createdAt,
    repeats: _repeats,
    expert: _expert,
    ...progress
  } = reviewProgress(journal, batch);
  const { assignments, repeats } = assignmentsOf(journal, batch);
  return {
    ...progress,
    kind:
      batch.purpose === "training"
        ? "training"
        : batch.expert?.round === 2
          ? "round_two"
          : "review",
    questions: assignments.map((assignment) => ({
      id: assignment.id,
      answered: assignment.answerId !== null,
      acknowledged: assignment.acknowledged,
      reopenable: reopenable(batch, assignment, repeats.get(assignment.id)),
    })),
  };
}
export async function blindReviewProgress(root: string, batchId: string, reviewer: string) {
  const journal = await OperationJournal.open(root);
  try {
    const batch = requireBatch(journal, batchId);
    requireReviewActor(journal, batch, reviewer);
    return blindProgress(journal, batch);
  } finally {
    journal.close();
  }
}

/** A new session continues the same sequence. The first session starts at the first question. */
export async function startReviewSession(
  root: string,
  batchId: string,
  reviewer: string,
  now = Date.now(),
) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const batch = requireBatch(journal, batchId);
      requireReviewActor(journal, batch, reviewer);
      settle(journal, batch, now);
      if (batch.state === "completed")
        throw new ReviewConflict(
          "Every question in this review has an answer. You do not need a new session.",
        );
      if (currentSession(batch)?.state !== "open") newSession(batch, now);
      journal.put("review_batches", batchId, batch);
      projectReviewProgress(journal, batch);
      return blindProgress(journal, batch);
    });
  } finally {
    journal.close();
  }
}

export async function claimReviewQuestion(
  root: string,
  batchId: string,
  assignmentId: string,
  sessionId: string,
  reviewer: string,
  now = Date.now(),
) {
  sessionIdentity(sessionId);
  const journal = await OperationJournal.open(root);
  try {
    requireReviewActor(journal, requireBatch(journal, batchId), reviewer);
    const verified = await context(
      root,
      requireBatch(journal, batchId),
      requireAssignment(journal, requireBatch(journal, batchId), assignmentId),
      true,
    );
    journal.transaction(() => {
      const batch = requireBatch(journal, batchId),
        assignment = requireAssignment(journal, batch, assignmentId);
      const previousLease = journal.read<ReviewLease>("review_lease", batchId);
      if (
        previousLease &&
        previousLease.sessionId !== sessionId &&
        now - previousLease.at < leaseMs
      )
        throw new ReviewConflict(
          `This review is open in another tab. Continue in that tab. If you closed that tab, try again after ${leaseMs / 1000} seconds.`,
        );
      settle(journal, batch, now);
      if (!batch.sessions.length && batch.state === "active") newSession(batch, now);
      const session = currentSession(batch);
      const { assignments, repeats } = assignmentsOf(journal, batch);
      const current =
        session?.state === "time_limit" &&
        previousLease?.assignmentId === assignmentId &&
        previousLease.sessionId === sessionId;
      if (session?.state !== "open" && !current)
        throw new ReviewConflict("This review session ended. Start a new session to continue.");
      if (
        assignment.answerId === null
          ? assignments.find((item) => item.answerId === null)?.id !== assignmentId
          : !current && !reopenable(batch, assignment, repeats.get(assignment.id))
      )
        throw new ReviewConflict(
          assignment.answerId === null
            ? "Answer the questions in their order. Open the next unanswered question."
            : "This answer is closed. You can change an answer only in the session in which you saved it.",
        );
      assignment.claim = { sessionId, expiresAt: now + leaseMs };
      journal.put("review_assignments", assignmentId, assignment);
      journal.put("review_lease", batchId, {
        sessionId,
        reviewer,
        assignmentId,
        at: now,
        active: previousLease?.sessionId === sessionId && previousLease.active,
        sequence: previousLease?.sessionId === sessionId ? previousLease.sequence : -1,
      });
      journal.put("review_batches", batchId, batch);
      projectReviewProgress(journal, batch);
    });
    const batch = requireBatch(journal, batchId);
    return await questionView(
      root,
      journal,
      batch,
      requireAssignment(journal, batch, assignmentId),
      verified,
    );
  } finally {
    journal.close();
  }
}

export async function blindReviewQuestion(
  root: string,
  batchId: string,
  assignmentId: string,
  reviewer: string,
): Promise<BlindReviewQuestion> {
  const journal = await OperationJournal.open(root);
  try {
    const batch = requireBatch(journal, batchId),
      assignment = requireAssignment(journal, batch, assignmentId);
    requireReviewActor(journal, batch, reviewer);
    if (!assignment.claim && !assignment.answerId)
      throw new Error("This question is not open. Open the question before you read its evidence.");
    return await questionView(
      root,
      journal,
      batch,
      assignment,
      await context(root, batch, assignment, true),
    );
  } finally {
    journal.close();
  }
}

/** Cross-pass application never reaches a delayed repeat, its first occurrence or round 2. */
function crossPass(journal: OperationJournal, batch: ReviewBatch, assignment: ReviewAssignment) {
  return (
    batch.expert?.round !== 2 &&
    assignment.repeatOf === null &&
    !assignmentsOf(journal, batch).repeats.has(assignment.id)
  );
}

async function questionView(
  root: string,
  journal: OperationJournal,
  batch: ReviewBatch,
  assignment: ReviewAssignment,
  { item, pass, criterion, unit, unavailable }: Awaited<ReturnType<typeof context>>,
): Promise<BlindReviewQuestion> {
  // Read the journal before the first wait.
  const sharesAnswers = crossPass(journal, batch, assignment);
  const view = evidenceView({
    ...item,
    sources: unavailable ? [] : item.sources,
    passes: [unavailable ? { ...pass, images: [], observations: { unavailable: true } } : pass],
  });
  // Display labels are neutral; bound source identities remain opaque.
  view.sources = view.sources.map((source, index) => ({
    ...source,
    path: `Source ${index + 1}.luau`,
  }));
  const answer = assignment.answerId ? await readReviewAnswer(root, assignment.answerId) : null;
  // Round 2 shows the answer and the reason of the other reviewer, and nothing else.
  const peer = assignment.peerAnswerId
    ? await readReviewAnswer(root, assignment.peerAnswerId)
    : null;
  if (peer && (peer.binding !== unit.binding || peer.reviewer === assignment.reviewer))
    throw new Error("The round 2 answer of the other reviewer lost its binding");
  const status = await frozenRunStatus(root, unit.operationId, false);
  const evaluation = subjectEval(status.manifest, item.subjectId);
  const revision = await new EvalDefinitionStore(root).readRevision(evaluation.id);
  return {
    id: assignment.id,
    ordinal: assignment.ordinal,
    criterion,
    governingPassages: criterionAuthoredPassages(revision, criterion.id),
    evidence: view,
    draft: assignment.draft,
    answer: answer
      ? { decision: answer.decision, reason: answer.reason, blindingIssue: answer.blindingIssue }
      : null,
    peer: peer ? { decision: peer.decision, reason: peer.reason } : null,
    crossPass: sharesAnswers,
    acknowledged: assignment.acknowledged,
    unavailable,
    preferredEvidence:
      unit.method === "code"
        ? "source"
        : unit.method === "deterministic" || !pass.images.length
          ? "observations"
          : "images",
  };
}

export async function reviewAsset(
  root: string,
  batchId: string,
  assignmentId: string,
  input: { sourceId: string } | { imageId: string },
  reviewer: string,
) {
  const journal = await OperationJournal.open(root);
  try {
    const batch = requireBatch(journal, batchId),
      assignment = requireAssignment(journal, batch, assignmentId);
    requireReviewActor(journal, batch, reviewer);
    if (!assignment.claim && !assignment.answerId)
      throw new Error("This question is not open. Open the question before you read its evidence.");
    const { evidence, item, pass } = await context(root, batch, assignment);
    const selected = { ...evidence, items: [{ ...item, passes: [pass] }] };
    if ("sourceId" in input) {
      const source = await evidenceSource(root, selected, item.id, input.sourceId);
      return {
        ...source,
        path: `Source ${item.sources.findIndex((source) => source.id === input.sourceId) + 1}.luau`,
      };
    }
    return evidenceImage(root, selected, item.id, pass.id, input.imageId);
  } finally {
    journal.close();
  }
}

export interface ReviewDraftInput {
  reviewer: string;
  sessionId: string;
  revision: number;
  decision: ReviewDecision | null;
  reason: ReviewReasonDraft | null;
  blindingIssue: string | null;
}
function validReasonDraft(reason: unknown): reason is ReviewReasonDraft | null {
  if (reason === null) return true;
  if (!reason || typeof reason !== "object" || Array.isArray(reason)) return false;
  const value = reason as Record<string, unknown>;
  return (
    Object.keys(value).sort().join(",") === "code,sentence" &&
    (value.code === null || REVIEW_REASON_CODES.includes(value.code as never)) &&
    typeof value.sentence === "string" &&
    value.sentence.length <= REVIEW_REASON_SENTENCE_LIMIT * 2
  );
}
function validateDraft(input: ReviewDraftInput) {
  if (
    !input ||
    Object.keys(input).sort().join(",") !==
      "blindingIssue,decision,reason,reviewer,revision,sessionId" ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !validReasonDraft(input.reason) ||
    (input.blindingIssue !== null &&
      (typeof input.blindingIssue !== "string" || input.blindingIssue.length > 2000))
  )
    throw new Error("Invalid review draft");
  sessionIdentity(input.sessionId);
}
export async function saveReviewDraft(
  root: string,
  batchId: string,
  assignmentId: string,
  input: ReviewDraftInput,
) {
  validateDraft(input);
  const journal = await OperationJournal.open(root);
  try {
    const batch = requireBatch(journal, batchId),
      assignment = requireAssignment(journal, batch, assignmentId);
    requireReviewActor(journal, batch, input.reviewer);
    const { criterion } = await context(root, batch, assignment, true);
    if (input.decision !== null) decisionVerdict(criterion, input.decision);
    return journal.transaction(() => {
      const freshBatch = requireBatch(journal, batchId),
        fresh = requireAssignment(journal, freshBatch, assignmentId);
      own(journal, freshBatch, fresh, input.sessionId, input.reviewer);
      if (fresh.draft.revision !== input.revision)
        throw new ReviewConflict(
          "This answer changed in another tab. Reload the saved answer before you make more changes.",
        );
      fresh.draft = {
        revision: input.revision + 1,
        decision: input.decision,
        reason: input.reason,
        blindingIssue: input.blindingIssue,
      };
      journal.put("review_assignments", assignmentId, fresh);
      return fresh.draft;
    });
  } finally {
    journal.close();
  }
}

/** Put a counted answer where later batches of the same reviewer and protocols can find it. */
function recordCountedAnswer(
  journal: OperationJournal,
  batch: ReviewBatch,
  assignment: ReviewAssignment,
  answer: ReviewAnswer,
  operationId: string,
) {
  if (!countedAnswer(batch, assignment)) return;
  journal.put("review_labels", hashJson({ reviewer: batch.reviewer, binding: answer.binding }), {
    id: answer.id,
  });
  if (batch.purpose !== "protocol") return;
  const refs =
    journal.read<Array<{ answerId: string; populationId: string; unitId: string }>>(
      "protocol_answers",
      operationId,
    ) ?? [];
  if (!refs.some((ref) => ref.answerId === answer.id))
    journal.put("protocol_answers", operationId, [
      ...refs,
      { answerId: answer.id, populationId: batch.populationId, unitId: assignment.unitId },
    ]);
}

export async function answerReviewQuestion(
  root: string,
  batchId: string,
  assignmentId: string,
  input: ReviewDraftInput,
  now = Date.now(),
  copiedFrom: string | null = null,
) {
  validateDraft(input);
  if (!input.decision) throw new Error("Choose an answer or Cannot tell.");
  const reason = requireReviewReason(input.decision, input.reason);
  const journal = await OperationJournal.open(root);
  try {
    const batch = requireBatch(journal, batchId),
      assignment = requireAssignment(journal, batch, assignmentId);
    requireReviewActor(journal, batch, input.reviewer);
    own(journal, batch, assignment, input.sessionId, input.reviewer);
    const { unit, criterion } = await context(
      root,
      batch,
      assignment,
      input.decision.kind === "abstain",
    );
    const verdict = decisionVerdict(criterion, input.decision);
    const previousAnswer = assignment.answerId
      ? await readReviewAnswer(root, assignment.answerId)
      : null;
    if (
      previousAnswer &&
      hashJson(previousAnswer.decision) === hashJson(input.decision) &&
      hashJson(previousAnswer.reason) === hashJson(reason) &&
      previousAnswer.blindingIssue === input.blindingIssue
    )
      return { answerId: assignment.answerId!, progress: blindProgress(journal, batch) };
    const body = {
      batchId,
      assignmentId,
      reviewer: batch.reviewer,
      purpose: batch.purpose,
      binding: unit.binding,
      decision: input.decision,
      verdict,
      reason,
      blindingIssue: input.blindingIssue,
      submittedAt: new Date(now).toISOString(),
      previousAnswerId: assignment.answerId,
      copiedFrom,
      repeatOf: assignment.repeatOf,
      peerAnswerId: assignment.peerAnswerId,
    };
    const answer: ReviewAnswer = { ...body, id: hashJson(body) };
    await saveReviewArtifact(root, "answers", answer);
    return journal.transaction(() => {
      const freshBatch = requireBatch(journal, batchId),
        fresh = requireAssignment(journal, freshBatch, assignmentId);
      own(journal, freshBatch, fresh, input.sessionId, input.reviewer);
      if (fresh.draft.revision !== input.revision)
        throw new ReviewConflict(
          "The answer changed in another tab. Basalt did not save this version. Reload the saved answer.",
        );
      settle(journal, freshBatch, now);
      const session = currentSession(freshBatch)!;
      if (fresh.sessionNumber === null) {
        fresh.sessionNumber = session.number;
        session.answered++;
      }
      fresh.answerId = answer.id;
      fresh.submittedVerdict = answer.verdict;
      fresh.acknowledged = true;
      fresh.reusedFrom = null;
      fresh.draft = {
        revision: input.revision + 1,
        decision: input.decision,
        reason,
        blindingIssue: input.blindingIssue,
      };
      journal.put("review_assignments", assignmentId, fresh);
      recordCountedAnswer(journal, freshBatch, fresh, answer, unit.operationId);
      if (
        freshBatch.assignmentIds.every(
          (id) => requireAssignment(journal, freshBatch, id).answerId !== null,
        )
      ) {
        freshBatch.state = "completed";
        session.state = "completed";
      } else if (session.state === "open" && session.answered >= REVIEW_SESSION_LIMITS.questions)
        session.state = "question_limit";
      journal.put("review_batches", batchId, freshBatch);
      projectReviewProgress(journal, freshBatch);
      return { answerId: answer.id, progress: blindProgress(journal, freshBatch) };
    });
  } finally {
    journal.close();
  }
}

export async function reviewActivity(
  root: string,
  batchId: string,
  input: {
    reviewer: string;
    sessionId: string;
    sequence: number;
    visible: boolean;
    focused: boolean;
  },
  now = Date.now(),
) {
  if (
    !input ||
    Object.keys(input).sort().join(",") !== "focused,reviewer,sequence,sessionId,visible" ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0 ||
    typeof input.visible !== "boolean" ||
    typeof input.focused !== "boolean"
  )
    throw new Error("Invalid review activity");
  sessionIdentity(input.sessionId);
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const batch = requireBatch(journal, batchId),
        lease = journal.read<ReviewLease>("review_lease", batchId);
      requireReviewActor(journal, batch, input.reviewer);
      if (!lease || lease.reviewer !== input.reviewer || lease.sessionId !== input.sessionId)
        throw new ReviewConflict("This review is open in another tab. Continue in that tab.");
      if (input.sequence <= lease.sequence) return blindProgress(journal, batch);
      settle(journal, batch, now);
      journal.put("review_lease", batchId, {
        ...lease,
        at: now,
        sequence: input.sequence,
        active: input.visible && input.focused && currentSession(batch)?.state === "open",
      });
      const assignment = requireAssignment(journal, batch, lease.assignmentId);
      assignment.claim = { sessionId: input.sessionId, expiresAt: now + leaseMs };
      journal.put("review_assignments", assignment.id, assignment);
      journal.put("review_batches", batchId, batch);
      projectReviewProgress(journal, batch);
      return blindProgress(journal, batch);
    });
  } finally {
    journal.close();
  }
}
/** Ending a session keeps the batch. The reviewer can continue later in a new session. */
export async function endReviewSession(
  root: string,
  batchId: string,
  reviewer: string,
  now = Date.now(),
) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.transaction(() => {
      const batch = requireBatch(journal, batchId);
      requireReviewActor(journal, batch, reviewer);
      settle(journal, batch, now);
      const session = currentSession(batch);
      if (session && ["open", "time_limit"].includes(session.state)) session.state = "ended";
      const lease = journal.read<ReviewLease>("review_lease", batchId);
      if (lease) journal.put("review_lease", batchId, { ...lease, active: false });
      journal.put("review_batches", batchId, batch);
      projectReviewProgress(journal, batch);
      return blindProgress(journal, batch);
    });
  } finally {
    journal.close();
  }
}

/**
 * An explicit edit of already acknowledged assignments; it can never allocate new work. A
 * delayed repeat, its first occurrence and round 2 questions keep separate answers.
 */
export async function applyReviewAcrossPasses(
  root: string,
  batchId: string,
  sourceId: string,
  input: {
    reviewer: string;
    sessionId: string;
    acknowledged: true;
    targets: Array<{ id: string; revision: number }>;
  },
) {
  if (
    !input ||
    Object.keys(input).sort().join(",") !== "acknowledged,reviewer,sessionId,targets" ||
    input.acknowledged !== true ||
    !Array.isArray(input.targets) ||
    !input.targets.length ||
    input.targets.length > 50 ||
    new Set(input.targets.map((item) => item.id)).size !== input.targets.length ||
    input.targets.some(
      (item) =>
        !item ||
        Object.keys(item).sort().join(",") !== "id,revision" ||
        !Number.isSafeInteger(item.revision) ||
        item.revision < 0,
    )
  )
    throw new Error("Choose 1 to 50 different observations that you answered.");
  const journal = await OperationJournal.open(root);
  try {
    const batch = requireBatch(journal, batchId),
      source = requireAssignment(journal, batch, sourceId);
    own(journal, batch, source, input.sessionId, input.reviewer);
    const separate = (assignment: ReviewAssignment) => !crossPass(journal, batch, assignment);
    if (separate(source)) throw new Error("This answer applies only to its own question.");
    if (!source.answerId || !source.acknowledged)
      throw new Error("Save the answer to this question first.");
    const original = await readReviewAnswer(root, source.answerId),
      sourceBinding = await context(root, batch, source);
    const prepared: Array<{
      assignment: ReviewAssignment;
      answer: ReviewAnswer;
      operationId: string;
    }> = [];
    for (const target of input.targets) {
      const assignment = requireAssignment(journal, batch, target.id);
      if (!assignment.acknowledged || !assignment.answerId || assignment.id === source.id)
        throw new Error("You can apply the answer only to other observations that you answered.");
      if (separate(assignment)) throw new Error("This answer applies only to its own question.");
      const binding = await context(root, batch, assignment);
      if (
        binding.pass.id === sourceBinding.pass.id ||
        hashJson(binding.criterion) !== hashJson(sourceBinding.criterion) ||
        binding.item.rubricHash !== sourceBinding.item.rubricHash ||
        hashJson(binding.item.sources) !== hashJson(sourceBinding.item.sources)
      )
        throw new Error(
          "You can apply the answer only to other observations of the same build and criterion.",
        );
      if (assignment.draft.revision !== target.revision)
        throw new ReviewConflict(
          "The answer to a selected observation changed. Basalt did not apply the answer. Reload the page.",
        );
      const body = {
        batchId,
        assignmentId: assignment.id,
        reviewer: batch.reviewer,
        purpose: batch.purpose,
        binding: binding.unit.binding,
        decision: original.decision,
        verdict: decisionVerdict(binding.criterion, original.decision),
        reason: original.reason,
        blindingIssue: original.blindingIssue,
        submittedAt: new Date().toISOString(),
        previousAnswerId: assignment.answerId,
        copiedFrom: original.id,
        repeatOf: null,
        peerAnswerId: null,
      };
      const answer = { ...body, id: hashJson(body) };
      await saveReviewArtifact(root, "answers", answer);
      prepared.push({ assignment, answer, operationId: binding.unit.operationId });
    }
    return journal.transaction(() => {
      const freshBatch = requireBatch(journal, batchId),
        freshSource = requireAssignment(journal, freshBatch, sourceId);
      own(journal, freshBatch, freshSource, input.sessionId, input.reviewer);
      if (freshSource.answerId !== original.id)
        throw new ReviewConflict(
          "The answer to this question changed. Basalt did not apply it. Reload the page.",
        );
      for (const { assignment, answer, operationId } of prepared) {
        const fresh = requireAssignment(journal, freshBatch, assignment.id);
        if (fresh.draft.revision !== assignment.draft.revision)
          throw new ReviewConflict(
            "The answer to a selected observation changed. Basalt did not apply the answer. Reload the page.",
          );
        fresh.answerId = answer.id;
        fresh.submittedVerdict = answer.verdict;
        fresh.reusedFrom = null;
        fresh.draft = {
          revision: fresh.draft.revision + 1,
          decision: answer.decision,
          reason: answer.reason,
          blindingIssue: answer.blindingIssue,
        };
        journal.put("review_assignments", fresh.id, fresh);
        recordCountedAnswer(journal, freshBatch, fresh, answer, operationId);
      }
      projectReviewProgress(journal, freshBatch);
      return blindProgress(journal, freshBatch);
    });
  } finally {
    journal.close();
  }
}
