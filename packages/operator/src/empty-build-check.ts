import { cleanImplementationCommit } from "../../artifact-store/src/implementation.js";
import { RepositoryFiles } from "../../artifact-store/src/repository.js";
import type { CriterionResult } from "../../contracts/src/index.js";
import { EvalDefinitionStore } from "../../eval-authoring/src/store.js";
import type { StudioAdapter } from "../../studio-runner/src/adapter.js";
import { readOperatorStudy } from "./config.js";
import { ownedComputation } from "./owned-computation.js";
import { observeFixedSource } from "./source-observation.js";

/**
 * One observation of the unchanged seed with the private Studio plan of a revision, and the code
 * checks of the revision on it. A required code check that the empty build satisfies cannot tell
 * a build from no build, so a person reads it as a plan warning. The record never changes an
 * answer, the plan or the registration of the evaluation.
 */
export interface EmptyBuildCheckRecord {
  schema: "basalt-evals/empty-build-check";
  revisionId: string;
  /** The run that observed the empty build. */
  operationId: string;
  /** Null when the check stopped before it read the identity. */
  implementationCommit: string | null;
  connectorArtifactHash: string | null;
  state: "complete" | "incomplete";
  /** The hash of the signed Studio receipt. Null when Studio did not complete an observation. */
  receiptHash: string | null;
  /** The code checks of the revision on the empty build. */
  results: CriterionResult[];
  /** The required code checks that the empty build satisfies. */
  hollow: string[];
  reason: string | null;
}

const idPattern = /^[a-f0-9]{64}$/u;
const directory = (revisionId: string) =>
  `.basalt-evals/authoring/empty-build-checks/${revisionId}`;

/** A required code check with the outcome verified on the empty build. */
export function hollowChecks(
  required: Array<{ id: string; required: boolean }>,
  results: CriterionResult[],
): string[] {
  const ids = new Set(required.filter((criterion) => criterion.required).map(({ id }) => id));
  return results
    .filter((result) => result.outcome === "verified" && ids.has(result.criterionId))
    .map((result) => result.criterionId);
}

/**
 * Observe the empty build one time for each revision. The check sends no model request, and a
 * person cannot turn it off. Each error gives an incomplete record. Only a stop is an error of
 * the caller.
 */
export async function prepareEmptyBuildCheck(input: {
  root: string;
  operationId: string;
  revisionId: string;
  studio: StudioAdapter;
  signal: AbortSignal;
  /** Runs before Studio starts, for example the implementation guard of the run. */
  beforeObservation?: () => Promise<void>;
}): Promise<EmptyBuildCheckRecord> {
  if (!idPattern.test(input.revisionId)) throw new Error("Invalid evaluation ID");
  const incomplete = (
    reason: string,
    identity: Pick<EmptyBuildCheckRecord, "implementationCommit" | "connectorArtifactHash">,
  ): EmptyBuildCheckRecord => ({
    schema: "basalt-evals/empty-build-check",
    revisionId: input.revisionId,
    operationId: input.operationId,
    ...identity,
    state: "incomplete",
    receiptHash: null,
    results: [],
    hollow: [],
    reason,
  });
  try {
    return await ownedComputation({
      root: input.root,
      operationId: input.operationId,
      namespace: "empty_build_checks",
      key: input.revisionId,
      signal: input.signal,
      run: async () => {
        let identity: Pick<
          EmptyBuildCheckRecord,
          "implementationCommit" | "connectorArtifactHash"
        > = { implementationCommit: null, connectorArtifactHash: null };
        let record: EmptyBuildCheckRecord;
        try {
          await input.beforeObservation?.();
          const revision = await new EvalDefinitionStore(input.root).readExecutableRevision(
            input.revisionId,
          );
          identity = {
            implementationCommit: await cleanImplementationCommit(input.root),
            connectorArtifactHash: (await input.studio.identity(input.root)).connectorArtifactHash,
          };
          const { studioVersion: _studioVersion, ...environment } = (
            await readOperatorStudy(input.root, [`.basalt-evals/eval-staging/${revision.id}`])
          ).environment;
          const observation = await observeFixedSource({
            root: input.root,
            revisionId: revision.id,
            base: `${directory(revision.id)}/observation`,
            purpose: "empty_build",
            source: { files: [] },
            treatmentId: `empty-build-${revision.id.slice(0, 12)}`,
            implementationCommit: identity.implementationCommit!,
            connectorArtifactHash: identity.connectorArtifactHash!,
            environment,
            signal: input.signal,
            studio: input.studio,
          });
          record =
            observation.status === "rejected"
              ? incomplete(
                  "The local check refused the seed: " + observation.diagnostics.join("; "),
                  identity,
                )
              : {
                  schema: "basalt-evals/empty-build-check",
                  revisionId: input.revisionId,
                  operationId: input.operationId,
                  ...identity,
                  state: "complete",
                  receiptHash: observation.receiptHash,
                  results: observation.results,
                  hollow: hollowChecks(
                    revision.privateEvaluator.deterministic,
                    observation.results,
                  ),
                  reason: null,
                };
        } catch (error) {
          if (input.signal.aborted) throw error;
          record = incomplete(error instanceof Error ? error.message : String(error), identity);
        }
        await new RepositoryFiles(input.root).writeJsonOnce(
          `${directory(input.revisionId)}/record.json`,
          record,
        );
        return record;
      },
    });
  } catch (error) {
    // Another run owns the check, or an earlier attempt failed. The receipt says incomplete.
    if (input.signal.aborted) throw error;
    return incomplete(error instanceof Error ? error.message : String(error), {
      implementationCommit: null,
      connectorArtifactHash: null,
    });
  }
}

/** The saved check of one revision, or null when no run saved it yet. */
export async function readEmptyBuildCheck(
  root: string,
  revisionId: string,
): Promise<EmptyBuildCheckRecord | null> {
  if (!idPattern.test(revisionId)) throw new Error("Invalid evaluation ID");
  const record = await new RepositoryFiles(root).optional<EmptyBuildCheckRecord>(
    `${directory(revisionId)}/record.json`,
  );
  if (
    record &&
    (record.schema !== "basalt-evals/empty-build-check" || record.revisionId !== revisionId)
  )
    throw new Error("The saved empty build check does not match its evaluation");
  return record;
}
