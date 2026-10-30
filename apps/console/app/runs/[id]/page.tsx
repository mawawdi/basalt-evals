export const metadata = { title: "Run progress · Basalt" };
import { OperationConsole } from "./operation-console";
import { Breadcrumb } from "../../components/shell";
import { notFound } from "next/navigation";
import { AssessmentConsole } from "./assessment-console";
import { ComparisonConsole } from "./comparison-console";
import {
  EvalDefinitionStore,
  readCoverageNotes,
  readModelRegistry,
  workflowRecord,
  assessmentProgress,
  exemplarComparisonProgress,
  readAssessmentPreview,
  runArchiveState,
  savedLifecycle,
} from "../../../lib/server";
import { repositoryRoot } from "../../../lib/data";
import { coverageGapCount } from "../../evaluations/[id]/coverage-table";
import { stageTitle } from "../../../../../dist/packages/contracts/src/display.js";

export default async function OperationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const root = repositoryRoot();
  const benchmarks = { href: "/", label: "Benchmarks" };
  try {
    await savedLifecycle(root, id);
  } catch (cause) {
    if (cause instanceof Error && cause.message === "No saved operation") notFound();
    throw cause;
  }
  // Archive and restore refresh this server page, so each console gets the current state.
  const { archived } = await runArchiveState(root, id);
  const assessment = await assessmentProgress(root, id);
  if (assessment) {
    // The frozen selection says whether this is a reassessment or a sensitivity test.
    const { selection } = await readAssessmentPreview(root, assessment.previewId);
    return (
      <>
        <Breadcrumb
          parent={benchmarks}
          detail={selection.conditions.length > 1 ? "Sensitivity test" : "Reassessment"}
        />
        <AssessmentConsole operationId={id} conditions={selection.conditions} archived={archived} />
      </>
    );
  }
  if (await exemplarComparisonProgress(root, id))
    return (
      <>
        <Breadcrumb parent={benchmarks} detail="Anchor build pairs" />
        <ComparisonConsole operationId={id} archived={archived} />
      </>
    );
  // Coverage notes come after preparation. The console reads this page again at each new stage.
  // Each stage of a staged evaluation has its own coverage notes.
  const revisions = [...new Set(Object.values((await workflowRecord(root, id))?.revisions ?? {}))];
  const definitions = new EvalDefinitionStore(root);
  const coverage = (
    await Promise.all(
      revisions.map(async (firstId) =>
        Promise.all(
          (await definitions.readStageRevisions(firstId)).map(async (revision) => ({
            revisionId: revision.id,
            title: stageTitle(revision.publicTask.title, revision.stage),
            href:
              revision.stage.count > 1
                ? `/evaluations/${firstId}#stage-${revision.stage.index}`
                : `/evaluations/${firstId}#coverage-notes`,
            notes: coverageGapCount(await readCoverageNotes(root, revision.id)),
          })),
        ),
      ),
    )
  )
    .flat()
    .filter((item) => item.notes > 0);
  return (
    <>
      <Breadcrumb parent={benchmarks} detail="Run" />
      <OperationConsole
        operationId={id}
        archived={archived}
        coverage={coverage}
        modelNames={Object.fromEntries(
          (await readModelRegistry(root)).models.map((model) => [model.id, model.name]),
        )}
      />
    </>
  );
}
