export const metadata = { title: "History details · Basalt" };
import { notFound } from "next/navigation";
import { readArchive } from "../../../lib/server";
import { repositoryRoot } from "../../../lib/data";
import { PageHeading, Notice } from "../../components/ui";
import { CatalogTable } from "../../components/catalog-table";
import type { Search } from "../../components/pagination";
export const dynamic = "force-dynamic";
export default async function Archive({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const { id } = await params;
  if (!/^[a-f0-9]{64}$/u.test(id)) notFound();
  const archive = await readArchive(repositoryRoot(), id).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") notFound();
    throw error;
  });
  const query = await searchParams;
  const search = (typeof query.q === "string" ? query.q : "").trim().toLowerCase().slice(0, 200);
  const prefix = `.basalt-evals/eval-operations/${archive.source.id}/`;
  const matches = archive.files.filter((file) =>
    file.path.slice(prefix.length).toLowerCase().includes(search),
  );
  const limit = 20;
  const pages = Math.max(1, Math.ceil(matches.length / limit));
  const requested = typeof query.page === "string" ? Number(query.page) : 1;
  const page = Math.min(pages, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 1));
  const files = matches.slice((page - 1) * limit, page * limit);
  return (
    <main>
      <PageHeading
        title={`Run ${archive.source.id}`}
        description={`${archive.files.length.toLocaleString()} saved ${archive.files.length === 1 ? "file" : "files"}. Basalt checks each download against the file’s saved fingerprint.`}
      />
      <Notice kind="info">
        These checks confirm that the files have not changed since Basalt archived them. They do not
        verify the original results or show that a build still works in Studio.
      </Notice>
      <CatalogTable
        key={typeof query.q === "string" ? query.q : ""}
        label="Files"
        page={{ page, pages, total: matches.length, limit }}
        query={query}
        path={`/history/${archive.id}`}
        rows={files.map((file) => ({
          id: file.id,
          title: file.path.slice(prefix.length),
          href: `/api/archives/${archive.id}/${file.id}`,
          download: file.path.split("/").at(-1),
          detail: `${file.bytes.toLocaleString()} bytes`,
          meta: `Fingerprint ${file.hash.slice(0, 16)}…`,
        }))}
      />
    </main>
  );
}
