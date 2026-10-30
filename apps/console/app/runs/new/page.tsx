export const metadata = { title: "Run a benchmark · Basalt" };
import {
  launchCatalog,
  listSuites,
  launchDefaults,
  readModelRegistry,
  readHarnessRegistry,
  evaluationSummary,
  selectedEvaluationSummary,
  readSuiteSnapshot,
  workflowRecord,
  localReadiness,
} from "../../../lib/server";
import { repositoryRoot } from "../../../lib/data";
import { RunSetup } from "../../components/run-setup";
import { evaluationLaunchSource } from "../../../../../dist/packages/contracts/src/catalog.js";
export const dynamic = "force-dynamic";
export default async function NewRun({
  searchParams,
}: {
  searchParams: Promise<{
    eval?: string;
    add?: string;
    collection?: string;
    amend?: string;
    replace?: string;
    library?: string;
  }>;
}) {
  const params = await searchParams,
    root = repositoryRoot();
  const amendment = params.amend ? await workflowRecord(root, params.amend) : null;
  const ids = amendment
    ? [
        ...amendment.selection.sources
          .filter((source) => source.id !== params.replace)
          .map((source) => source.id),
        ...(params.add ? [params.add] : []),
      ]
    : params.collection
      ? (await readSuiteSnapshot(root, params.collection)).members.map((m) => m.revisionId)
      : [params.eval, params.add].filter((id): id is string => !!id);
  const sources = await Promise.all(
    ids.map(async (id) => {
      const item =
        params.add === id && params.library
          ? await selectedEvaluationSummary(root, id, params.library)
          : await evaluationSummary(root, id);
      return item && (id.startsWith("eval-") || params.add === id)
        ? evaluationLaunchSource(item)
        : item;
    }),
  );
  const initial = sources.filter((item): item is NonNullable<typeof item> => !!item);
  if (initial.length !== ids.length)
    throw new Error(
      "A selected evaluation is no longer available. Go back to the library and choose again.",
    );
  return (
    <RunSetup
      catalog={await launchCatalog(root)}
      suites={(await listSuites(root, new URLSearchParams({ limit: "50" }))).items}
      defaults={
        amendment?.selection ??
        launchDefaults(await readModelRegistry(root), await readHarnessRegistry(root))
      }
      initial={initial}
      added={params.add ? (sources[ids.indexOf(params.add)] ?? undefined) : undefined}
      amendment={amendment}
      prerequisites={await localReadiness(root)}
    />
  );
}
