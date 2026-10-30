import { BenchmarkHome } from "./components/benchmark-home";
export const metadata = { title: "Benchmarks · Basalt" };
import { ComparisonChooser } from "./components/comparison-chooser";
import { HomeRecovery } from "./components/home-recovery";
import { readReviewSelection } from "../lib/server";
import Link from "next/link";
import Form from "next/form";
import {
  runCatalog,
  resultCatalog,
  listComparisons,
  runInbox,
  listDeletedRuns,
  readModelRegistry,
} from "../lib/server";
import { repositoryRoot } from "../lib/data";
import { PageHeading, FilterSelect } from "./components/ui";
import { CatalogTable } from "./components/catalog-table";
import { CrossRunResults } from "./components/cross-run-results";
import { ActiveRuns } from "./components/active-runs";
import { Pagination, queryParams, type Search } from "./components/pagination";
import { formatMoney } from "./components/api";
import { statusLabel } from "../../../dist/packages/contracts/src/catalog.js";
import s from "./components/workbench.module.css";
import { modelList, runDetail } from "./components/result-display";
import { RunArchiveButton } from "./components/run-actions";
export const dynamic = "force-dynamic";
function RunViews({
  query,
  selectionQuery,
  attentionCount,
}: {
  query: Search;
  selectionQuery: string;
  attentionCount: number;
}) {
  const attention = query.view === "activity" && query.status === "attention";
  return (
    <nav className={`${s.tabs} ${s.runViews}`} aria-label="Run views">
      <Link
        aria-current={query.view === "activity" && !attention ? "page" : undefined}
        href={`/?view=activity&${selectionQuery}`}
      >
        All runs
      </Link>
      <Link
        aria-current={!query.view || query.view === "results" ? "page" : undefined}
        href={`/?view=results&${selectionQuery}`}
      >
        Results
      </Link>
      <Link
        aria-current={query.view === "comparisons" ? "page" : undefined}
        href={`/?view=comparisons&${selectionQuery}`}
      >
        Comparisons
      </Link>
      {(attentionCount > 0 || attention) && (
        <Link
          className={s.runAttention}
          aria-current={attention ? "page" : undefined}
          href={`/?view=activity&status=attention&${selectionQuery}`}
        >
          Needs attention ({attentionCount})
        </Link>
      )}
    </nav>
  );
}
export default async function Runs({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams,
    params = queryParams(query),
    results = query.view !== "activity";
  const root = repositoryRoot();
  if (!query.view && !query.selection && !query.q && !query.status && !query.limit && !query.page)
    return <BenchmarkHome campaign={params.get("campaign")} />;
  const [activity, registry] = await Promise.all([runInbox(root), readModelRegistry(root)]);
  const modelNames = Object.fromEntries(registry.models.map((model) => [model.id, model.name]));
  let selection = null,
    selectionError = "";
  if (params.get("selection")) {
    try {
      selection = await readReviewSelection(root, params.get("selection")!);
    } catch (cause) {
      selectionError = cause instanceof Error ? cause.message : "Saved selection unavailable";
    }
  }
  const selectionQuery = params.get("selection")
    ? `selection=${encodeURIComponent(params.get("selection")!)}`
    : "";
  if (query.view === "comparisons") {
    const comparisons = await listComparisons(root, params);
    return (
      <main>
        <HomeRecovery initial={activity} />
        <PageHeading
          title="Records"
          description="Compare separate runs and see exactly where their test conditions differ."
          action={
            <Link className={s.primary} href="/runs/new">
              Run a benchmark
            </Link>
          }
        />
        <RunViews
          query={query}
          selectionQuery={selectionQuery}
          attentionCount={activity.attentionCount}
        />
        <ComparisonChooser />
        <CatalogTable
          label="Saved comparisons"
          emptyText="Choose two runs above to compare their answers and spending."
          page={comparisons}
          query={query}
          path="/"
          filters={[]}
          rows={comparisons.items.map((item) => ({
            id: item.id,
            title: item.title,
            href: `/comparisons/${item.id}`,
            state: item.compatibility,
            detail: `Saved ${new Date(item.createdAt).toLocaleString()}`,
          }))}
        />
      </main>
    );
  }
  if (results) {
    const page = await resultCatalog(root, params);
    return (
      <main>
        <HomeRecovery initial={activity} />
        <PageHeading
          title="Records"
          description="See every model result across all runs. Open a build to examine the evidence for each answer."
          action={
            (page.total > 0 || activity.active.total > 0) && (
              <Link className={s.primary} href="/runs/new">
                Run a benchmark
              </Link>
            )
          }
        />
        <ActiveRuns runs={activity.active} modelNames={modelNames} />
        <RunViews
          query={query}
          selectionQuery={selectionQuery}
          attentionCount={activity.attentionCount}
        />
        {(page.total > 0 || params.get("q") || params.get("status") || params.get("order")) && (
          <Form
            key={`${params.get("q") ?? ""}:${params.get("status") ?? ""}`}
            className={s.toolbar}
            action="/"
          >
            {selectionQuery && (
              <input type="hidden" name="selection" value={params.get("selection")!} />
            )}
            <div className={s.field}>
              <label htmlFor="result-search">Search evaluation or model</label>
              <input
                id="result-search"
                type="search"
                name="q"
                defaultValue={params.get("q") ?? ""}
              />
            </div>
            <div className={s.field}>
              <label htmlFor="result-status">Show</label>
              <FilterSelect
                id="result-status"
                name="status"
                defaultValue={params.get("status") ?? ""}
              >
                <option value="">All results</option>
                <option value="complete">Complete</option>
                <option value="incomplete">Incomplete</option>
                <option value="active">In progress</option>
              </FilterSelect>
            </div>
            <button className={s.secondary}>Search</button>
            {(params.get("q") || params.get("status") || params.get("order")) && (
              <Link className={s.secondary} href={`/?view=results&${selectionQuery}`}>
                Reset filters
              </Link>
            )}
          </Form>
        )}
        <CrossRunResults
          rows={page.items}
          selection={selection}
          selectionError={selectionError}
          filtered={!!(params.get("q") || params.get("status"))}
        />
        <Pagination page={page} query={query} path="/" />
      </main>
    );
  }
  const page = await runCatalog(root, params);
  const archived = query.status === "archived";
  const deleted = archived ? await listDeletedRuns(root, new URLSearchParams()) : null;
  return (
    <main>
      <HomeRecovery initial={activity} />
      <PageHeading
        title="Records"
        description={
          query.status === "attention"
            ? "These runs stopped before they finished. Open a run to see its details and what you can do next."
            : archived
              ? "Archived runs do not show in the other lists. Each run keeps its results, evidence and charges. Restore a run to show it again."
              : "Every run on this Mac, newest first. Each run keeps its exact inputs, charges and evidence."
        }
        action={
          <Link className={s.primary} href="/runs/new">
            Run a benchmark
          </Link>
        }
      />
      <RunViews
        query={query}
        selectionQuery={selectionQuery}
        attentionCount={activity.attentionCount}
      />
      <CatalogTable
        label="Runs"
        emptyText="Each benchmark you start appears here with its spending and results."
        page={page}
        query={query}
        path="/"
        emptyHref="/runs/new"
        emptyLabel="Run a benchmark"
        filters={["active", "attention", "stopped", "partial", "complete", "archived"].map(
          (value) => ({
            value,
            label: statusLabel(value),
          }),
        )}
        rows={page.items.map((item) => ({
          id: item.id,
          title: item.title,
          href: `/runs/${item.id}`,
          state: item.archived ? "archived" : item.state,
          control:
            item.archived || item.state !== "active" ? (
              <RunArchiveButton operationId={item.id} title={item.title} archived={item.archived} />
            ) : undefined,
          detail: runDetail(item),
          at: item.startedAt ?? item.updatedAt,
          meta: [
            modelList(item.models, modelNames),
            item.billedUsd === null
              ? "Charges not known yet"
              : `${formatMoney(item.billedUsd)} charged`,
            item.reservedUsd ? `${formatMoney(item.reservedUsd)} pending` : "",
          ]
            .filter(Boolean)
            .join(", "),
        }))}
      />
      {deleted && deleted.total > 0 && (
        <details className={s.section}>
          <summary>Spending of deleted runs</summary>
          <p>
            {deleted.total === 1 ? "One deleted run" : `${deleted.total} deleted runs`} charged{" "}
            {formatMoney(deleted.billedUsd)} in total. Basalt keeps these charges in the spending
            totals.
          </p>
          <ul>
            {deleted.items.map((item) => (
              <li key={item.operationId}>
                {item.title} · {formatMoney(item.billedUsd)} charged · deleted{" "}
                {new Date(item.deletedAt).toLocaleString()}
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
