import { OperationJournal } from "../../artifact-store/src/journal.js";
import { hashJson } from "../../contracts/src/index.js";
import { fields, identity, text, identifiers, hash } from "../../contracts/src/validation.js";
import type { RegressionReference } from "../../contracts/src/comparisons.js";
import { frozenRunStatus } from "./run-builder.js";
import { subjectEval, manifestHash } from "./run-manifest.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import { resolveAssessmentEvidence, saveEvidenceSet } from "./assessment-evidence.js";
import { recordHoldoutLook } from "./holdout-access.js";

/**
 * A reproducible reference to human-authored authority, never a new oracle or a repair hint.
 * A grader reference uses only development evidence. A generation reference records each
 * withheld capture that it binds as a look at the holdout of its evaluation.
 */
export async function saveRegressionReference(
  root: string,
  value: unknown,
): Promise<RegressionReference> {
  const row = fields(
    value,
    ["title", "purpose", "operationId", "subjectId", "criterionIds"],
    "Regression reference",
  );
  const operationId = identity(row.operationId),
    subjectId = identity(row.subjectId),
    title = text(row.title, 160, "Reference title");
  if (row.purpose !== "generation" && row.purpose !== "grader")
    throw new Error("Select generation or grader regression");
  const criterionIds = identifiers(row.criterionIds, 200, "Criteria").sort();
  const status = await frozenRunStatus(root, operationId, false),
    evaluation = subjectEval(status.manifest, subjectId);
  const revision = await new EvalDefinitionStore(root).readExecutableRevision(evaluation.id);
  const all = [
    ...revision.privateEvaluator.deterministic,
    ...revision.privateEvaluator.codeQuality,
    ...revision.privateEvaluator.visual,
    ...revision.privateEvaluator.unscaled,
  ];
  if (criterionIds.some((id) => !all.some((criterion) => criterion.id === id)))
    throw new Error("Reference must use unchanged human-authored criteria");
  if (
    row.purpose === "grader" &&
    criterionIds.some((id) =>
      revision.privateEvaluator.deterministic.some((criterion) => criterion.id === id),
    )
  )
    throw new Error(
      "Deterministic criteria require a generation regression; they are not model grading treatments",
    );
  const captures = status.manifest.captureCells.filter((cell) => cell.treatmentId === subjectId);
  const withheldCaptureIds = captures
    .filter((cell) => cell.partition !== "development")
    .map((cell) => cell.id)
    .sort();
  // A grader regression launch judges every capture of the subject again.
  if (row.purpose === "grader" && withheldCaptureIds.length)
    throw new Error(
      "This build has withheld observations, and a saved example for a judge cannot use them. Choose a build with only development observations.",
    );
  const evidenceSetIds: string[] = [];
  for (const capture of captures) {
    const view = evaluation.views.find(
      (view) => view.id === capture.viewId && view.partition === capture.partition,
    )!;
    const id = `regression-${hashJson([capture.id, criterionIds]).slice(0, 24)}`;
    const resolved = await resolveAssessmentEvidence(root, operationId, {
      id,
      captureCellId: capture.id,
      revisionId: evaluation.id,
      sampleGroupId: id,
      sample: 1,
      grouping: "shared",
      criterionIds,
      presentation: view.sequence ? "sequence" : "still",
      substitution: null,
    });
    await saveEvidenceSet(root, resolved.set);
    evidenceSetIds.push(resolved.set.id);
  }
  if (!evidenceSetIds.length)
    throw new Error("This build has no observations. Choose a build with recorded evidence.");
  const body: Omit<RegressionReference, "id"> = {
    title,
    purpose: row.purpose,
    operationId,
    manifestHash: manifestHash(status.manifest),
    subjectId,
    evaluationId: evaluation.id,
    validationRecordHash: evaluation.validationRecordHash,
    criterionIds,
    evidenceSetIds,
    withheldCaptureIds,
    createdAt: new Date().toISOString(),
  };
  const reference: RegressionReference = { ...body, id: hashJson(body) };
  const journal = await OperationJournal.open(root);
  try {
    journal.transaction(() => {
      journal.put("regressions", reference.id, reference);
      journal.project("regressions", reference.id, {
        body: reference,
        search: title,
        status: reference.purpose,
        sort: reference.createdAt,
      });
      if (withheldCaptureIds.length)
        recordHoldoutLook(journal, reference.evaluationId, {
          at: reference.createdAt,
          purpose: "generation_regression",
          recordId: reference.id,
          operationId,
          subjectIds: [subjectId],
          captureIds: withheldCaptureIds,
        });
    });
  } finally {
    journal.close();
  }
  return reference;
}

export async function readRegressionReference(root: string, id: string) {
  hash(id);
  const journal = await OperationJournal.open(root);
  try {
    const reference = journal.read<RegressionReference>("regressions", id);
    if (!reference) throw new Error("Basalt cannot find this saved example.");
    const { id: savedId, ...body } = reference;
    if (id !== savedId || hashJson(body) !== id) throw new Error("Regression reference changed");
    return reference;
  } finally {
    journal.close();
  }
}

export async function listRegressionReferences(root: string, params = new URLSearchParams()) {
  const journal = await OperationJournal.open(root);
  try {
    return journal.page<RegressionReference>("regressions", {
      q: params.get("q") ?? "",
      status: params.get("status") ?? "",
      page: Number(params.get("page")),
      limit: Number(params.get("limit")),
    });
  } finally {
    journal.close();
  }
}
