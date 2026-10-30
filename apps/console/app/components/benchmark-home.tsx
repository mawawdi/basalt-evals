import Link from "next/link";
import { benchmarkCatalog, benchmarkReport, readModelRegistry, runInbox } from "../../lib/server";
import { repositoryRoot } from "../../lib/data";
import { BenchmarkDashboard } from "./benchmark-dashboard";
import { ActiveRuns } from "./active-runs";
import { HomeRecovery } from "./home-recovery";
import { PageHeading } from "./ui";
import s from "./workbench.module.css";
export async function BenchmarkHome({ campaign }: { campaign: string | null }) {
  const root = repositoryRoot(),
    [catalog, inbox, registry] = await Promise.all([
      benchmarkCatalog(root),
      runInbox(root),
      readModelRegistry(root),
    ]),
    models = registry.models.map(({ id, name }) => ({ id, name }));
  // A deep link selects its own benchmark; otherwise show the newest frozen one.
  const selected = campaign
    ? catalog.find((row) => row.id === campaign && row.frozen)
    : catalog.find((row) => row.frozen);
  let report = null,
    error = "";
  if (selected)
    try {
      report = await benchmarkReport(root, selected.id);
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "Basalt could not read the saved benchmark results.";
    }
  return (
    <main>
      <PageHeading
        title="Benchmarks"
        description="Compare models on the same evaluations and inspect the evidence for each answer."
        action={
          // A first visit has one action, carried by the empty state below.
          (catalog.length > 0 || inbox.active.total > 0) && (
            <Link href="/runs/new" className={s.primary}>
              Run a benchmark
            </Link>
          )
        }
      />
      <HomeRecovery initial={inbox} models={models} resume />
      <ActiveRuns
        runs={inbox.active}
        modelNames={Object.fromEntries(models.map((model) => [model.id, model.name]))}
      />
      <BenchmarkDashboard initialCatalog={catalog} initialReport={report} initialError={error} />
    </main>
  );
}
