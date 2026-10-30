import { OperationJournal } from "../../artifact-store/src/journal.js";
import { projectRun } from "./catalog-projection.js";
import { evaluationSuite } from "../../contracts/src/suites.js";
import type { EvaluationLibraryEntry } from "../../contracts/src/catalog.js";
import { evaluationIdentity, projectLibraryEntry } from "../../eval-authoring/src/library.js";
import type { RunOperationStatus } from "../../contracts/src/execution.js";
import { hashJson } from "../../contracts/src/index.js";
import type { RegressionReference, RunComparison } from "../../contracts/src/comparisons.js";
import type { ReviewBatch } from "../../contracts/src/review.js";
import { projectReviewProgress } from "./review-store.js";
import { requireReviewer } from "./reviewers.js";
import { authoringActionResult } from "./authoring-operation.js";
import { comparisonProjection } from "./comparisons.js";
import { projectPreparationOutcome } from "./preparation-outcome.js";
import { projectOperationProgress } from "./operation.js";

/** Explicit local maintenance. Rebuilds disposable read indexes from authoritative journal records. */
export async function rebuildCatalogProjections(root: string) {
  const journal = await OperationJournal.open(root);
  try {
    const authoringResults: Awaited<ReturnType<typeof authoringActionResult>>[] = [];
    let afterAuthoring = "";
    for (;;) {
      const page = journal.recordPage("authoring_progress", afterAuthoring);
      if (!page.length) break;
      for (const { id } of page) authoringResults.push(await authoringActionResult(root, id));
      afterAuthoring = page.at(-1)!.id;
    }
    return journal.transaction(() => {
      for (const saved of authoringResults) projectPreparationOutcome(journal, saved, saved.result);
      const counts = {
        evaluations: 0,
        runs: 0,
        suites: 0,
        comparisons: 0,
        regressions: 0,
        reviews: 0,
        reviewers: 0,
      };
      for (const namespace of [
        "evaluations",
        "runs",
        "results",
        "suites",
        "comparisons",
        "regressions",
        "review_progress",
        "reviewers",
      ])
        journal.clearProjection(namespace);
      const visit = (namespace: string, consume: (id: string, value: unknown) => void) => {
        let after = "";
        for (;;) {
          const page = journal.recordPage(namespace, after);
          if (!page.length) break;
          for (const row of page) consume(row.id, row.value);
          after = page.at(-1)!.id;
        }
      };
      visit("evaluation_library", (id, value) => {
        const row = value as EvaluationLibraryEntry;
        evaluationIdentity(id);
        if (row.id !== id || typeof row.archived !== "boolean")
          throw new Error("Evaluation projection source is invalid");
        projectLibraryEntry(journal, row);
        counts.evaluations++;
      });
      // The progress of each run comes first, because the catalog rows read it.
      visit("operations", (_, value) =>
        projectOperationProgress(journal, value as RunOperationStatus),
      );
      const seen = new Set<string>();
      for (const namespace of [
        "workflows",
        "operations",
        "authoring_progress",
        "assessment_progress",
        "comparison_progress",
        "run_starts",
      ])
        visit(namespace, (id) => {
          if (!seen.has(id)) {
            seen.add(id);
            projectRun(journal, id);
            counts.runs++;
          }
        });
      visit("operations", (id, value) => {
        journal.clearProjection(`activity:${id}`);
        for (const event of (value as RunOperationStatus).events)
          journal.project(`activity:${id}`, event.id, {
            search: `${event.kind} ${event.stage ?? ""} ${event.reason ?? ""}`,
            status: event.kind,
            sort: String(event.sequence).padStart(12, "0"),
            body: event,
          });
      });
      visit("suites", (id, value) => {
        const row = evaluationSuite(value);
        journal.project("suites", id, {
          body: row,
          search: row.title,
          status: "ready",
          sort: row.updatedAt,
        });
        counts.suites++;
      });
      visit("comparisons", (id, value) => {
        const row = value as RunComparison;
        const { id: storedId, ...body } = row;
        if (storedId !== id || hashJson(body) !== id)
          throw new Error("Comparison projection source changed");
        journal.project("comparisons", id, comparisonProjection(row));
        counts.comparisons++;
      });
      visit("regressions", (id, value) => {
        const row = value as RegressionReference;
        const { id: storedId, ...body } = row;
        if (storedId !== id || hashJson(body) !== id)
          throw new Error("Regression projection source changed");
        journal.project("regressions", id, {
          body: row,
          search: row.title,
          status: row.purpose,
          sort: row.createdAt,
        });
        counts.regressions++;
      });
      visit("review_batches", (_, value) => {
        projectReviewProgress(journal, value as ReviewBatch);
        counts.reviews++;
      });
      visit("reviewers", (id) => {
        const row = requireReviewer(journal, id);
        journal.project("reviewers", id, {
          body: row,
          search: row.displayName,
          status: "",
          sort: row.createdAt,
        });
        counts.reviewers++;
      });
      return counts;
    });
  } finally {
    journal.close();
  }
}
