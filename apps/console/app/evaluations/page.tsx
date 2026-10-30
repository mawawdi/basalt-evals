export const metadata = { title: "Evaluations · Basalt" };
import { listRegressionReferences } from "../../lib/server";

import { listSuites } from "../../lib/server";
import { CollectionEditor } from "../components/collection-editor";
import Link from "next/link";
import { evaluationCatalog } from "../../lib/server";
import { repositoryRoot } from "../../lib/data";
import { Tabs, PageHeading } from "../components/ui";
import { CatalogTable } from "../components/catalog-table";
import { queryParams, type Search } from "../components/pagination";
import s from "../components/workbench.module.css";
export const dynamic = "force-dynamic";
export default async function Evaluations({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams;
  if (query.view === "regressions") {
    const page = await listRegressionReferences(repositoryRoot(), queryParams(query));
    return (
      <main>
        <PageHeading
          title="Evaluations"
          description="Saved examples help you check changes to builds and to the judge."
        />
        <Tabs label="Evaluation views">
          <Link href="/evaluations">Evaluations</Link>
          <Link href="/evaluations?view=suites">Suites</Link>
          <Link href="/evaluations?view=regressions" aria-current="page">
            Saved examples
          </Link>
        </Tabs>
        <CatalogTable
          label="Saved examples"
          emptyText="Save an example from a result's evidence to check it again after changes."
          page={page}
          query={query}
          path="/evaluations"
          filters={[]}
          rows={page.items.map((reference) => ({
            id: reference.id,
            title: reference.title,
            href: `/regressions/${reference.id}`,
            state: reference.purpose === "generation" ? "Checks new builds" : "Checks the judge",
            detail: `${reference.criterionIds.length} authored ${reference.criterionIds.length === 1 ? "criterion" : "criteria"}`,
          }))}
        />
      </main>
    );
  }
  if (query.view === "suites") {
    const page = await listSuites(repositoryRoot(), queryParams(query));
    return (
      <main>
        <PageHeading
          title="Evaluations"
          description="A suite is a saved set of evaluations to run as one benchmark."
          action={<CollectionEditor />}
        />
        <Tabs label="Evaluation views">
          <Link href="/evaluations">Evaluations</Link>
          <Link href="/evaluations?view=suites" aria-current="page">
            Suites
          </Link>
          <Link href="/evaluations?view=regressions">Saved examples</Link>
        </Tabs>
        <CatalogTable
          label="Suites"
          emptyText="Create a suite to run several evaluations as one benchmark."
          page={page}
          query={query}
          path="/evaluations"
          filters={[]}
          rows={page.items.map((suite) => ({
            id: suite.id,
            title: suite.title,
            href: `/collections/${suite.id}`,
            state: "Ready to run",
            detail: `${suite.memberCount} ${suite.memberCount === 1 ? "evaluation" : "evaluations"}`,
          }))}
        />
      </main>
    );
  }
  const page = await evaluationCatalog(repositoryRoot(), queryParams(query));
  return (
    <main>
      <PageHeading
        title="Evaluations"
        description="Each evaluation is a prompt for the model and private success criteria that check its build."
        action={
          <Link href="/evaluations/new" className={s.primary}>
            Create evaluation
          </Link>
        }
      />
      <Tabs label="Evaluation views">
        <Link href="/evaluations" aria-current="page">
          Evaluations
        </Link>
        <Link href="/evaluations?view=suites">Suites</Link>
        <Link href="/evaluations?view=regressions">Saved examples</Link>
      </Tabs>
      <CatalogTable
        label="Evaluations"
        emptyText="An evaluation is a prompt for the model and private success criteria that check its build."
        page={page}
        query={query}
        path="/evaluations"
        emptyHref="/evaluations/new"
        emptyLabel="Create evaluation"
        filters={[
          { value: "draft", label: "Saved drafts" },
          { value: "needs_validation", label: "Needs input" },
          { value: "runnable", label: "Ready to run" },
          { value: "checked", label: "Reference tested" },
          { value: "archived", label: "Archived" },
        ]}
        rows={page.items.map((item) => ({
          id: item.evaluationId ?? item.id,
          title: item.title,
          href: `/evaluations/${item.evaluationId ?? item.id}`,
          description: item.description,
          state: item.archived
            ? "Archived"
            : item.readiness === "checked"
              ? "Reference tested"
              : item.readiness === "ready"
                ? "Ready to run"
                : item.readiness === "draft"
                  ? "Draft"
                  : "Needs input",
          detail: item.reason ?? (item.kind === "draft" ? "Prepared when you start" : ""),
          action: item.archived
            ? undefined
            : {
                href: `/runs/new?eval=${item.evaluationId ?? item.id}`,
                label: "Run",
                name: item.title,
              },
        }))}
      />
    </main>
  );
}
