export const metadata = { title: "Run issue · Basalt" };
import Link from "next/link";
import { notFound } from "next/navigation";
import { OperationJournal } from "../../../../../dist/packages/artifact-store/src/journal.js";
import { repositoryRoot } from "../../../lib/data";
import { PageHeading, EmptyState, Status, ProblemText } from "../../components/ui";
import { Pagination, type Search } from "../../components/pagination";
import s from "../../components/workbench.module.css";
export const dynamic = "force-dynamic";
export default async function Issue({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const { id } = await params,
    query = await searchParams;
  if (!/^[a-f0-9]{64}$/u.test(id)) notFound();
  const journal = await OperationJournal.open(repositoryRoot());
  let page;
  try {
    page = journal.issueOperations(id, Number(query.page ?? 1));
  } finally {
    journal.close();
  }
  return (
    <main>
      <PageHeading
        title="Affected runs"
        description="These runs stopped for the same reason. Open a run to see its results and what you can do."
      />
      {!page.total && (
        <EmptyState
          title="No runs listed for this issue"
          href="/?view=activity&status=attention"
          label="See runs that need attention"
        >
          Each run’s activity still shows what failed.
        </EmptyState>
      )}
      <div className={s.stack}>
        {page.items.map((item) => (
          <article key={item.operationId} className={`${s.panel} ${s.panelBody}`}>
            <h2>{item.run?.title ?? `Run ${item.operationId}`}</h2>
            {item.run && (
              <Status tone={item.run.state === "attention" ? "warning" : "neutral"}>
                {item.run.state}
              </Status>
            )}
            <div>
              <ProblemText text={item.explanation} />
            </div>
            <p className={s.small}>
              Affects {item.captures} {item.captures === 1 ? "observation" : "observations"} ·{" "}
              {item.candidates} {item.candidates === 1 ? "build" : "builds"}
            </p>
            <Link className={s.secondary} href={`/runs/${item.operationId}`}>
              Open run
            </Link>
          </article>
        ))}
      </div>
      <Pagination page={page} query={query} path={`/issues/${id}`} />
    </main>
  );
}
