export const metadata = { title: "Research studies · Basalt" };
import Form from "next/form";
import Link from "next/link";
import { researchCatalog } from "../../lib/server";
import { repositoryRoot } from "../../lib/data";
import { PageHeading, EmptyState, ReadableTime } from "../components/ui";
import { WorkloadLaunch } from "../components/workload-launch";
import { Pagination, queryParams, type Search } from "../components/pagination";
import s from "../components/workbench.module.css";
export const dynamic = "force-dynamic";
export default async function Research({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams,
    page = await researchCatalog(repositoryRoot(), queryParams(query));
  const search = typeof query.q === "string" ? query.q : "";
  const studies: Record<string, { title: string; description: string }> = {
    detector_calibration: {
      title: "Detector calibration",
      description: "Compare judge answers with independent human review.",
    },
    repair_discovery: {
      title: "Repair discovery",
      description: "Find development cases that can support a later repair comparison.",
    },
    matched_repair: {
      title: "Matched repair",
      description: "Compare repair approaches on the same initial builds.",
    },
    harness_effectiveness: {
      title: "Tool set comparison",
      description: "Compare builder tools under the study’s fixed test conditions.",
    },
  };
  return (
    <main>
      <PageHeading
        title="Research"
        description="These controlled studies use fixed test conditions and need human review."
      />
      <Form key={search} className={s.toolbar} action="/research">
        <div className={s.field}>
          <label htmlFor="research-search">Search studies</label>
          <input
            id="research-search"
            type="search"
            name="q"
            defaultValue={search}
            maxLength={200}
          />
        </div>
        <button className={s.secondary}>Search</button>
        {search && (
          <Link className={s.textButton} href="/research">
            Clear search
          </Link>
        )}
      </Form>
      {!page.total && (
        <EmptyState
          title={search ? "No studies match this search" : "No planned studies"}
          href={search ? "/research" : "/"}
          label={search ? "Clear search" : "Open benchmarks"}
        >
          {search
            ? "Try another study name or clear the search."
            : "A study appears here after Basalt saves its plan."}
        </EmptyState>
      )}
      <div className={s.stack}>
        {page.items.map((item) => (
          <section key={item.id} className={`${s.panel} ${s.panelBody}`}>
            <h2>{studies[item.kind]?.title ?? item.kind.replaceAll("_", " ")}</h2>
            <p>{studies[item.kind]?.description}</p>
            <p className={s.small}>
              Study {item.id.slice(0, 10)} · registered <ReadableTime value={item.registeredAt} />
            </p>
            <p className={s.small}>
              {item.questions} {item.questions === 1 ? "review group" : "review groups"}. Before you
              start, preview the required human questions and the spending limit.
            </p>
            <WorkloadLaunch kind="research" experimentId={item.id} />
            <details className={s.section}>
              <summary>Study ID</summary>
              <p className={s.tableMeta}>{item.id}</p>
            </details>
          </section>
        ))}
      </div>
      <Pagination page={page} query={query} path="/research" />
    </main>
  );
}
