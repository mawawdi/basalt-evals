export const metadata = { title: "History · Basalt" };
import { listArchives } from "../../lib/server";

import { repositoryRoot } from "../../lib/data";
import { PageHeading } from "../components/ui";
import { CatalogTable } from "../components/catalog-table";
import { queryParams, type Search } from "../components/pagination";
export const dynamic = "force-dynamic";
export default async function History({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams;
  const archives = await listArchives(repositoryRoot(), queryParams(query));
  return (
    <main>
      <PageHeading
        title="Archives"
        description="Archived runs stay exactly as they were saved. Older results may not reflect how Basalt works today."
      />
      <CatalogTable
        key={typeof query.q === "string" ? query.q : ""}
        label="Archives"
        emptyHref="/?view=activity"
        emptyLabel="Open Records"
        page={archives}
        query={query}
        path="/history"
        rows={archives.items.map((item) => ({
          id: item.id,
          title: `Run ${item.source.id}`,
          href: `/history/${item.id}`,
          state: "Historical",
          detail: `${item.files.toLocaleString()} saved ${item.files === 1 ? "file" : "files"}`,
        }))}
      />
    </main>
  );
}
