import { benchmarkCatalog, benchmarkReport, consoleNotifications } from "./benchmarks.js";
import {
  previewComparison,
  createComparison,
  comparisonReport,
  listComparisons,
} from "./comparisons.js";
import {
  readWorkingCopy,
  saveWorkingCopy,
  publishWorkingCopy,
  WorkingCopyConflict,
} from "./working-copies.js";
import { EvaluationEditConflict, setEvaluationArchived } from "../../eval-authoring/src/library.js";
import { spendingDetails } from "./budget-summary.js";
import {
  saveRegressionReference,
  readRegressionReference,
  listRegressionReferences,
} from "./regressions.js";
import { readHoldoutAccess } from "./holdout-access.js";
import {
  previewOperationLaunch,
  authorizeOperation,
  commandOperation,
  launchAuthorization,
} from "./launch.js";
import { listSuites, readSuite, readSuiteSnapshot, saveSuite } from "./suites.js";
import { assessmentReport } from "./assessment.js";
import { exemplarComparisonReport } from "./exemplar-comparison.js";
import { chooseExemplars, listExemplarChoices } from "./exemplars.js";
import { createReviewSelection, readReviewSelection } from "./review-selections.js";
import { reviewTreatmentCatalog } from "./review-treatments.js";
import { requireBatch } from "./review-store.js";
import { OperationJournal } from "../../artifact-store/src/journal.js";
import { createReviewer, listReviewers, reviewerProfile } from "./reviewers.js";
import { assertLocalRequest } from "./http-origin.js";
import { runInbox, localReadiness, operationView } from "./workbench.js";
import { operatorEvidence } from "./evidence-view.js";
import { launchDefaults } from "./workflow.js";
import { readHarnessRegistry } from "./config.js";
import { authoringClarifications, answerAuthoringClarification } from "./clarification.js";
import { prepareRepairDiscovery, inspectRepairPopulation } from "./repair-discovery.js";
import { experimentAnalysisView } from "./experiment-report.js";
import { sideBySideEvidence } from "./side-by-side.js";
import { liveExecutionAdapters, type ExecutionAdapters } from "./adapters.js";
import { createTextDraft, textDraft } from "./prepare-draft.js";
import { readRegisteredExperiment } from "./experiment-plan.js";
import { submitOperationReview } from "./review-service.js";
import { authoringActionResult } from "./authoring-operation.js";
import {
  evaluationCatalog,
  evaluationSummary,
  currentEvaluationSummaries,
  runCatalog,
  resultCatalog,
} from "./discovery.js";
import { frozenRunStatus } from "./run-builder.js";
import { inspectOperationOutcomes, runOutcomeCauses } from "./run-report.js";
import type { ReviewSelection } from "../../contracts/src/review.js";
import {
  createReviewBatch,
  createRoundTwoBatches,
  createSecondReviewBatch,
  listReviewBatches,
  reviewBatchProgress,
} from "./review-batches.js";
import { previewReviewBatch } from "./review-population.js";
import { reviewAuditReport } from "./review-report.js";
import { ReviewConflict } from "./review-store.js";
import {
  blindReviewProgress,
  blindReviewQuestion,
  claimReviewQuestion,
  saveReviewDraft,
  reviewActivity,
  endReviewSession,
  startReviewSession,
  reviewAsset,
  applyReviewAcrossPasses,
  type ReviewDraftInput,
} from "./review-session.js";
import { evidenceSource, evidenceImage, readOperationEvidence } from "./evidence.js";
import { readArchivedFile, readArchive, listArchives } from "./archive.js";
import { registerSavedPublicFeedback } from "./replay.js";
import { operationSource } from "./sources.js";
import {
  addModel,
  readModelRegistry,
  removeModel,
  searchModelCatalog,
  setModelConcurrency,
  setModelDefaults,
} from "./model-registry.js";
import {
  deleteRun,
  listDeletedRuns,
  setRunArchived,
  RunRetentionConflict,
} from "./run-retention.js";
import { deleteEvaluation } from "./evaluation-retention.js";
import { listScreenRecordings, readScreenRecording } from "./screen-recordings.js";
import { rangeResponse } from "./byte-range.js";
import { readUnitLog } from "./unit-log.js";
import { buildHistoryView, buildImage } from "./build-history.js";
import { comparisonExport, exportScope, exportTar, runExport } from "./export.js";
import { datasetExport } from "./dataset-export.js";
import { operationModelReport } from "./model-report.js";
import { previewRecheck } from "./recheck.js";
import { knownBuildGate } from "./known-build-gate.js";
import { operationActivity } from "./activity.js";
import { listKnownBuilds, markKnownBuild, retireKnownBuild } from "./known-builds.js";

async function body(request: Request, action: string, maximumBytes = 4096): Promise<unknown> {
  const url = new URL(request.url);
  if (
    request.headers.get("origin") !==
      `${url.protocol}//${request.headers.get("host") ?? url.host}` ||
    request.headers.get("x-basalt-action") !== action
  )
    throw new Error("A same-origin console action is required");
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new Error("A JSON request is required");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("A request body is required");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.length;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("The request is too large. Make the input shorter.");
    }
    chunks.push(next.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function fields(value: unknown, names: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...names].sort().join(",")
  )
    throw new Error("Invalid request fields");
  return value as Record<string, unknown>;
}
/** Shared HTTP composition; adapters are application dependencies and never accepted in a request. */
export function createOperationApi(input: {
  root: string;
  adapters?: ExecutionAdapters;
  workerModule?: string;
}) {
  const { root, workerModule } = input;
  const adapters = input.adapters ?? liveExecutionAdapters;
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  return async function handle(request: Request): Promise<Response> {
    try {
      assertLocalRequest(request);
      const url = new URL(request.url),
        parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "api") return json({ error: "Unknown API route" }, 404);
      const [, group, id, action, subaction, detail] = parts;
      const maximumParts = [
        "eval-authoring",
        "evaluations",
        "working-copies",
        "operations",
        "suites",
        "comparisons",
        "regressions",
        "archives",
        "experiments",
      ].includes(group ?? "")
        ? 4
        : ["reviewers", "launch-authorizations", "benchmarks", "exemplars", "models"].includes(
              group ?? "",
            )
          ? 3
          : group === "reviews" || group === "runs"
            ? 6
            : group === "review-batches"
              ? 4
              : 2;
      if (parts.length > maximumParts) return json({ error: "Unknown API route" }, 404);
      if (request.method === "GET") {
        if (group === "benchmarks" && !id) return json(await benchmarkCatalog(root));
        if (group === "benchmarks" && id) return json(await benchmarkReport(root, id));
        if (group === "notifications" && !id) return json(await consoleNotifications(root));
        if (group === "launch-authorizations" && id)
          return json(await launchAuthorization(root, id));
        if (group === "working-copies" && id && !action)
          return json(await readWorkingCopy(root, id));
        if (group === "comparisons" && id && !action) return json(await comparisonReport(root, id));
        if (group === "comparisons" && !id)
          return json(await listComparisons(root, url.searchParams));
        if (group === "regressions" && !id)
          return json(await listRegressionReferences(root, url.searchParams));
        if (group === "regressions" && id === "holdouts" && action)
          return json(await readHoldoutAccess(root, action));
        if (group === "regressions" && id && !action)
          return json(await readRegressionReference(root, id));

        if (group === "suites" && !id) return json(await listSuites(root, url.searchParams));
        if (group === "suites" && id && !action)
          return json(await readSuite(root, id, url.searchParams));
        if (group === "suites" && id === "snapshots" && action)
          return json(await readSuiteSnapshot(root, action));
        if (group === "operations" && id && action === "progress")
          return json(await operationView(root, id));
        if (group === "operations" && id && action === "spending") {
          const journal = await OperationJournal.open(root);
          try {
            return json(spendingDetails(journal, id));
          } finally {
            journal.close();
          }
        }
        if (group === "operations" && id && action === "results") {
          const query = new URLSearchParams(url.searchParams);
          query.set("operation", id);
          return json(await resultCatalog(root, query));
        }
        if (group === "operations" && id && action === "activity")
          return json(await operationActivity(root, id, url.searchParams));
        if (group === "operations" && id && action === "assessment")
          return json(await assessmentReport(root, id));
        if (group === "operations" && id && action === "comparison")
          return json(await exemplarComparisonReport(root, id));
        if (group === "operations" && id && action === "model-report")
          return json(await operationModelReport(root, id));
        if (group === "exemplars" && id) return json(await listExemplarChoices(root, id));
        if (group === "operations" && id && action === "side-by-side")
          return json(await sideBySideEvidence(root, id, url.searchParams));
        if (group === "operations" && id && action === "evidence") {
          const candidate = url.searchParams.get("candidate"),
            criterion = url.searchParams.get("criterion");
          if (!candidate) throw new Error("Select a candidate to inspect its evidence");
          return json(
            await operatorEvidence(root, id, undefined, {
              subjectId: candidate,
              ...(criterion ? { criterionId: criterion } : {}),
            }),
          );
        }

        if (group === "reviewers" && !id) return json(await listReviewers(root, url.searchParams));
        if (group === "reviewers" && id) return json(await reviewerProfile(root, id));
        if (group === "deleted-runs" && !id)
          return json(await listDeletedRuns(root, url.searchParams));
        if (group === "launch-options" && !id) {
          const registry = await readModelRegistry(root);
          const harnesses = await readHarnessRegistry(root);
          return json({
            models: registry.models.map(({ id: modelId, name }) => ({ id: modelId, name })),
            harnesses: harnesses.harnesses,
            defaults: launchDefaults(registry, harnesses),
          });
        }
        if (group === "models" && !id) return json(await readModelRegistry(root));
        if (group === "models" && id === "search")
          return json(await searchModelCatalog(root, url.searchParams.get("q") ?? ""));
        if (group === "run-inbox" && !id) return json(await runInbox(root));
        if (group === "evaluations" && !id)
          return json(await evaluationCatalog(root, url.searchParams));
        if (group === "evaluations" && id === "current" && !action)
          return json(
            await currentEvaluationSummaries(root, (url.searchParams.get("ids") ?? "").split(",")),
          );
        if (group === "evaluations" && id && !action)
          return json(await evaluationSummary(root, id));
        if (group === "runs" && !id) return json(await runCatalog(root, url.searchParams));
        if (group === "runs" && id && action === "units" && subaction && detail === "log")
          return new Response(await readUnitLog(root, id, subaction), {
            headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
          });
        if (group === "results" && !id) return json(await resultCatalog(root, url.searchParams));
        if (group === "readiness" && !id) return json(await localReadiness(root, adapters.studio));
        if (group === "review-batches" && id === "selections" && action)
          return json(await readReviewSelection(root, action, url.searchParams));
        if (group === "reviews" && id && action === "profile") {
          const journal = await OperationJournal.open(root);
          try {
            return json(await reviewerProfile(root, requireBatch(journal, id).reviewer));
          } finally {
            journal.close();
          }
        }
        if (group === "review-batches" && !id)
          return json(await listReviewBatches(root, url.searchParams));
        if (group === "review-batches" && id && !action)
          return json(await reviewBatchProgress(root, id));
        if (group === "review-batches" && id && action === "report")
          return json(await reviewAuditReport(root, id));
        if (group === "experiments" && id && !action)
          return json(await readRegisteredExperiment(root, id));
        if (group === "eval-authoring" && !action)
          return json(
            id ? await textDraft(root, id) : await evaluationCatalog(root, url.searchParams),
          );
        if (group === "operations" && id) {
          if (action === "authoring") return json(await authoringActionResult(root, id));
          if (action === "clarifications") return json(await authoringClarifications(root, id));
          if (action === "outcomes") return json(await inspectOperationOutcomes(root, id));
          if (action === "subjects") {
            const status = await frozenRunStatus(root, id, false);
            const limit = Math.min(
              50,
              Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 20)),
            );
            const total = status.manifest.subjects.length,
              pages = Math.max(1, Math.ceil(total / limit));
            const page = Math.min(
              pages,
              Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1)),
            );
            return json({
              total,
              pages,
              page,
              limit,
              items: await Promise.all(
                status.manifest.subjects
                  .slice((page - 1) * limit, page * limit)
                  .map(async (subject) => {
                    const sealed = status.completedUnits.includes(
                      `${subject.sourceId ? "seal" : "builder"}:${subject.id}`,
                    );
                    return {
                      id: subject.id,
                      kind: subject.kind,
                      sealed,
                      sourceHash: sealed
                        ? (await operationSource(root, status.manifest, subject.id)).candidate
                            .rootHash
                        : null,
                    };
                  }),
              ),
            });
          }
        }
        if (group === "reviews" && id && !action)
          return json(await blindReviewProgress(root, id, url.searchParams.get("reviewer") ?? ""));
        if (group === "reviews" && id && action === "questions" && subaction) {
          if (!detail)
            return json(
              await blindReviewQuestion(
                root,
                id,
                subaction,
                url.searchParams.get("reviewer") ?? "",
              ),
            );
          if (detail === "asset") {
            const asset = await reviewAsset(
              root,
              id,
              subaction,
              url.searchParams.has("source")
                ? { sourceId: url.searchParams.get("source")! }
                : { imageId: url.searchParams.get("image") ?? "" },
              url.searchParams.get("reviewer") ?? "",
            );
            if ("bytes" in asset)
              return new Response(new Uint8Array(asset.bytes), {
                headers: { "Content-Type": asset.mediaType, "Cache-Control": "no-store" },
              });
            return json(asset);
          }
        }
        // A screen recording is a diagnostic of one observation. Only this route serves it.
        if (group === "operations" && id && action === "screen") {
          const unit = url.searchParams.get("unit");
          if (!unit) return json(await listScreenRecordings(root, id));
          return rangeResponse(
            new Uint8Array(await readScreenRecording(root, id, unit)),
            request.headers.get("range"),
            "video/mp4",
          );
        }
        if (group === "operations" && id && action === "asset") {
          const q = url.searchParams;
          const candidate = q.get("candidate");
          if (!candidate) throw new Error("Select the candidate bound to this asset");
          const evidence = await readOperationEvidence(root, id, { subjectId: candidate });
          if (q.has("source"))
            return json(
              await evidenceSource(root, evidence, q.get("item") ?? "", q.get("source")!),
            );
          const image = await evidenceImage(
            root,
            evidence,
            q.get("item") ?? "",
            q.get("pass") ?? "",
            q.get("image") ?? "",
          );
          return new Response(new Uint8Array(image.bytes), {
            headers: { "Content-Type": image.mediaType, "Cache-Control": "no-store" },
          });
        }
        if (group === "archives" && !id) return json(await listArchives(root, url.searchParams));
        if (group === "archives" && id && !action) return json(await readArchive(root, id));
        if (group === "archives" && id && action && !subaction) {
          const asset = await readArchivedFile(root, id, action);
          return new Response(new Uint8Array(asset), {
            headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
          });
        }
        if (group === "operations" && id && action === "build" && !subaction) {
          const candidate = url.searchParams.get("candidate");
          if (!candidate) throw new Error("Select a build to see how it was built");
          return json(
            await buildHistoryView(root, id, candidate, Number(url.searchParams.get("page")) || 1),
          );
        }
        if (group === "operations" && id && action === "causes" && !subaction)
          return json(await runOutcomeCauses(root, id));
        if (group === "operations" && id && action === "build-image") {
          const candidate = url.searchParams.get("candidate");
          if (!candidate) throw new Error("Select the build that saw this image");
          const image = await buildImage(root, id, candidate, url.searchParams.get("hash") ?? "");
          return new Response(new Uint8Array(image.bytes), {
            headers: { "Content-Type": image.mediaType, "Cache-Control": "no-store" },
          });
        }
        if (
          ((group === "operations" || group === "comparisons") && id && action === "export") ||
          (group === "operations" && id && action === "dataset")
        ) {
          const scope = exportScope(url.searchParams.get("scope"));
          const saved =
            action === "dataset"
              ? await datasetExport(root, id, scope)
              : group === "operations"
                ? await runExport(root, id, scope)
                : await comparisonExport(root, id, scope);
          return new Response(new Uint8Array(exportTar(saved)), {
            headers: {
              "Content-Type": "application/x-tar",
              "Content-Disposition": `attachment; filename="${saved.folder}.tar"`,
              "Cache-Control": "no-store",
            },
          });
        }
        // Rechecks and known builds.
        if (group === "evaluations" && id && action === "known-build-gate")
          return json(await knownBuildGate(root, id));
        if (group === "known-builds" && !id)
          return json(await listKnownBuilds(root, url.searchParams.get("evaluation") ?? ""));
      }
      if (request.method === "POST") {
        if (group === "models" && id === "add") {
          const input = fields(await body(request, "add_model"), ["id"]);
          return json(await addModel(root, String(input.id)));
        }
        if (group === "models" && id === "remove") {
          const input = fields(await body(request, "remove_model"), ["id"]);
          return json(await removeModel(root, String(input.id)));
        }
        if (group === "models" && id === "defaults")
          return json(await setModelDefaults(root, await body(request, "save_model_defaults")));
        if (group === "working-copies" && id && action === "publish")
          return json(
            await publishWorkingCopy(root, id, await body(request, "save_evaluation")),
            201,
          );
        if (group === "evaluations" && id && action === "archive") {
          const input = fields(await body(request, "archive_evaluation"), ["archived"]);
          return json(await setEvaluationArchived(root, id, input.archived as boolean));
        }
        if (group === "evaluations" && id && action === "delete") {
          fields(await body(request, "delete_evaluation"), []);
          return json(await deleteEvaluation(root, id));
        }
        if (group === "operations" && id && action === "archive" && !subaction) {
          const input = fields(await body(request, "archive_run"), ["archived"]);
          return json(await setRunArchived(root, id, input.archived as boolean));
        }
        if (group === "operations" && id && action === "delete" && !subaction) {
          fields(await body(request, "delete_run"), []);
          return json(await deleteRun(root, id));
        }
        if (group === "working-copies" && id && !action)
          return json(
            await saveWorkingCopy(root, id, await body(request, "save_working_copy", 140000)),
          );
        if (group === "comparisons" && id === "preview" && !action)
          return json(
            await previewComparison(root, await body(request, "preview_comparison")),
            201,
          );
        if (group === "comparisons" && !id) {
          const value = fields(await body(request, "create_comparison"), ["previewId"]);
          return json(await createComparison(root, value.previewId as string), 201);
        }
        if (group === "regressions" && !id)
          return json(
            await saveRegressionReference(root, await body(request, "save_regression", 16000)),
            201,
          );
        if (group === "exemplars" && !id)
          return json(
            await chooseExemplars(root, await body(request, "choose_exemplars", 16000)),
            201,
          );

        if (group === "launch-previews" && !id)
          return json(
            await previewOperationLaunch(
              root,
              await body(request, "preview_launch", 100000),
              adapters,
            ),
            201,
          );
        if (group === "operations" && !id)
          return json(
            await authorizeOperation(
              root,
              await body(request, "authorize_operation"),
              workerModule,
              adapters,
            ),
            202,
          );
        if (group === "operations" && id && action === "commands")
          return json(
            await commandOperation(
              root,
              id,
              await body(request, "command_operation"),
              workerModule,
              adapters,
            ),
          );
        if (group === "suites" && !action)
          return json(await saveSuite(root, await body(request, "save_suite", 200000), id), 201);

        if (group === "reviewers" && !id) {
          const value = fields(await body(request, "create_reviewer"), ["displayName"]);
          return json(await createReviewer(root, value.displayName as string), 201);
        }
        if (group === "eval-authoring" && id && action === "clarification")
          return json(
            await answerAuthoringClarification(
              root,
              id,
              await body(request, "answer_eval_clarification", 75000),
            ),
            201,
          );
        if (group === "eval-authoring" && !id)
          return json(await createTextDraft(root, await body(request, "create_eval", 70000)), 201);
        if (group === "operations" && id) {
          if (action === "analysis" && !subaction) {
            fields(await body(request, "seal_experiment_analysis"), []);
            return json(await experimentAnalysisView(root, id), 201);
          }
          if (action === "repair-discovery") {
            const value = fields(await body(request, "prepare_repair_discovery"), ["seed"]);
            return json(await prepareRepairDiscovery(root, id, value.seed as number), 201);
          }
          if (action === "repair-population") {
            fields(await body(request, "inspect_repair_population"), []);
            return json(await inspectRepairPopulation(root, id), 201);
          }
          if (action === "public-feedback" && !subaction) {
            const value = fields(await body(request, "register_public_feedback"), ["subjectId"]);
            return json(
              await registerSavedPublicFeedback({
                root,
                operationId: id,
                subjectId: value.subjectId as string,
              }),
              201,
            );
          }
        }
        if (group === "review-batches" && id === "selections" && !action) {
          const value = fields(await body(request, "create_review_selection", 100000), [
            "operationIds",
          ]);
          return json(await createReviewSelection(root, value.operationIds as string[]), 201);
        }
        if (group === "review-batches" && id === "treatments" && !action) {
          const value = fields(await body(request, "review_treatments", 100000), ["operationIds"]);
          return json(await reviewTreatmentCatalog(root, value.operationIds as string[]));
        }
        if (group === "review-batches" && id === "preview" && !action)
          return json(
            await previewReviewBatch(
              root,
              (await body(request, "preview_review_batch", 100000)) as ReviewSelection,
            ),
            201,
          );
        if (group === "review-batches" && id === "create" && !action) {
          const value = fields(await body(request, "create_review_batch"), [
            "previewId",
            "idempotencyKey",
          ]);
          return json(
            await createReviewBatch(
              root,
              value.previewId as string,
              value.idempotencyKey as string,
            ),
            201,
          );
        }
        if (group === "review-batches" && id && action === "second") {
          const value = fields(await body(request, "create_second_review"), [
            "reviewer",
            "idempotencyKey",
          ]);
          return json(
            await createSecondReviewBatch(
              root,
              id,
              value.reviewer as string,
              value.idempotencyKey as string,
            ),
            201,
          );
        }
        if (group === "review-batches" && id && action === "round-two") {
          const value = fields(await body(request, "create_round_two"), ["idempotencyKey"]);
          return json(await createRoundTwoBatches(root, id, value.idempotencyKey as string), 201);
        }
        if (group === "reviews" && id && action === "sessions") {
          const value = fields(await body(request, "start_review_session"), ["reviewer"]);
          return json(await startReviewSession(root, id, value.reviewer as string));
        }
        if (group === "reviews" && id && action === "activity")
          return json(
            await reviewActivity(
              root,
              id,
              (await body(request, "review_activity")) as Parameters<typeof reviewActivity>[2],
            ),
          );
        if (group === "reviews" && id && action === "end") {
          const value = fields(await body(request, "end_review_session"), ["reviewer"]);
          return json(await endReviewSession(root, id, value.reviewer as string));
        }
        if (group === "reviews" && id && action === "questions" && subaction) {
          if (detail === "claim") {
            const value = fields(await body(request, "claim_review_question"), [
              "sessionId",
              "reviewer",
            ]);
            return json(
              await claimReviewQuestion(
                root,
                id,
                subaction,
                value.sessionId as string,
                value.reviewer as string,
              ),
            );
          }
          if (detail === "draft")
            return json(
              await saveReviewDraft(
                root,
                id,
                subaction,
                (await body(request, "save_review_draft", 12000)) as ReviewDraftInput,
              ),
            );
          if (detail === "answer")
            return json(
              await submitOperationReview(
                root,
                id,
                subaction,
                (await body(request, "answer_review_question", 12000)) as ReviewDraftInput,
                workerModule,
              ),
              201,
            );
          if (detail === "apply")
            return json(
              await applyReviewAcrossPasses(
                root,
                id,
                subaction,
                (await body(request, "apply_review_across_passes", 12000)) as Parameters<
                  typeof applyReviewAcrossPasses
                >[3],
              ),
            );
        }
        if (group === "models" && id === "concurrency" && !action)
          return json(
            await setModelConcurrency(root, await body(request, "save_model_concurrency")),
          );
        // Rechecks and known builds. A recheck preview is free; its code checks cost nothing.
        if (group === "evaluations" && id && action === "recheck") {
          const value = fields(await body(request, "preview_recheck", 16000), [
            "operationId",
            "subjectIds",
            "judge",
          ]);
          return json(await previewRecheck(root, { ...value, revisionId: id }, adapters), 201);
        }
        if (group === "known-builds" && !id)
          return json(
            await markKnownBuild(root, await body(request, "mark_known_build", 16000)),
            201,
          );
        if (group === "known-build-retirements" && !id)
          return json(await retireKnownBuild(root, await body(request, "retire_known_build")), 201);
      }
      return json({ error: "Unknown API route" }, 404);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        error instanceof ReviewConflict ||
          error instanceof WorkingCopyConflict ||
          error instanceof EvaluationEditConflict ||
          error instanceof RunRetentionConflict
          ? 409
          : 400,
      );
    }
  };
}
