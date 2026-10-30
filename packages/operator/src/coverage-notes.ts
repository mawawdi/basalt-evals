import { readdir } from "node:fs/promises";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import { hashJson } from "../../contracts/src/index.js";
import type { EvalRevision } from "../../eval-authoring/src/compiler.js";
import type {
  CheckCoverage,
  CriterionCoverage,
} from "../../eval-authoring/src/coverage-request.js";
import { modelTreatmentIdentity, type ModelSnapshot } from "../../model-client/src/catalog.js";
import { modelLimits } from "../../model-client/src/model-limits.js";
import {
  writeCoverageNotes,
  type CoverageRequestResult,
  type CoverageResult,
} from "../../agent-runtime/src/coverage-notes.js";
import type { PreparationDispatcher } from "../../agent-runtime/src/preparation-models.js";
import { ownedComputation } from "./owned-computation.js";

/** Notes of a second model about one revision. A person reads them. Nothing else uses them. */
export interface CoverageNotesRecord {
  schema: "basalt-evals/coverage-notes";
  revisionId: string;
  operationId: string;
  model: { id: string; identityHash: string };
  /** Complete only when each request is complete. */
  state: "complete" | "incomplete";
  /** The entries of the complete requests, in the authored sequence. */
  criteria: CriterionCoverage[];
  /** The entries of the complete requests, in the sequence of the plan. */
  checks: CheckCoverage[];
  requests: CoverageRequestResult[];
  /** The reasons of the incomplete requests. */
  reason: string | null;
}

const idPattern = /^[a-f0-9]{64}$/u;
const directory = (revisionId: string) => `.basalt-evals/authoring/coverage-notes/${revisionId}`;

/** Write the notes one time for each pair of revision and coverage model. Stop is the only error. */
export async function prepareCoverageNotes(input: {
  root: string;
  operationId: string;
  revision: EvalRevision;
  model: ModelSnapshot;
  dispatcher: PreparationDispatcher;
  signal: AbortSignal;
}): Promise<CoverageNotesRecord> {
  const identityHash = hashJson(modelTreatmentIdentity(input.model));
  const file = `${directory(input.revision.id)}/${identityHash}.json`;
  return ownedComputation({
    root: input.root,
    operationId: input.operationId,
    namespace: "coverage_notes",
    key: hashJson({ revisionId: input.revision.id, identityHash }),
    signal: input.signal,
    run: async () => {
      let result: CoverageResult;
      try {
        result = await writeCoverageNotes({
          dispatcher: input.dispatcher,
          model: { id: input.model.id, maxOutputTokens: modelLimits(input.model).maxOutputTokens },
          revision: input.revision,
        });
      } catch (error) {
        if (input.signal.aborted) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        result = {
          criteria: [],
          checks: [],
          requests: [
            { scope: "all", criterionId: null, state: "incomplete", requestHash: null, reason },
          ],
        };
      }
      // A stopped request is not a result. The next attempt of this run continues it.
      input.signal.throwIfAborted();
      const incomplete = result.requests.filter((request) => request.state === "incomplete");
      const record: CoverageNotesRecord = {
        schema: "basalt-evals/coverage-notes",
        revisionId: input.revision.id,
        operationId: input.operationId,
        model: { id: input.model.id, identityHash },
        state: incomplete.length ? "incomplete" : "complete",
        criteria: result.criteria,
        checks: result.checks,
        requests: result.requests,
        reason: incomplete.length
          ? incomplete
              .map((request) =>
                request.criterionId
                  ? `${request.criterionId}: ${request.reason}`
                  : request.scope === "checks"
                    ? `Private checks: ${request.reason}`
                    : String(request.reason),
              )
              .join(" ")
          : null,
      };
      await new RepositoryFiles(input.root).writeJsonOnce(file, record);
      return record;
    },
  });
}

/** All notes of one revision, one record for each coverage model. */
export async function readCoverageNotes(
  root: string,
  revisionId: string,
): Promise<CoverageNotesRecord[]> {
  if (!idPattern.test(revisionId)) throw new Error("Invalid evaluation ID");
  const files = new RepositoryFiles(root);
  const names = await readdir(files.path(directory(revisionId))).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const records = await Promise.all(
    names
      .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
      .sort()
      .map((name) => files.json<CoverageNotesRecord>(`${directory(revisionId)}/${name}`)),
  );
  for (const record of records)
    if (record.schema !== "basalt-evals/coverage-notes" || record.revisionId !== revisionId)
      throw new Error("Saved coverage notes do not match their evaluation");
  return records;
}
