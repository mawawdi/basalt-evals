export const metadata = { title: "Suite · Basalt" };
import Link from "next/link";
import { readSuite } from "../../../lib/server";
import { repositoryRoot } from "../../../lib/data";
import { PageHeading } from "../../components/ui";
import { CollectionEditor } from "../../components/collection-editor";
import { Pagination, queryParams, type Search } from "../../components/pagination";
import s from "../../components/workbench.module.css";
export const dynamic = "force-dynamic";
export default async function SuitePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const { id } = await params,
    query = await searchParams,
    data = await readSuite(repositoryRoot(), id, queryParams(query));
  return (
    <main>
      <PageHeading
        title={data.suite.title}
        description={
          data.description ||
          `${data.members.total} ready ${data.members.total === 1 ? "evaluation" : "evaluations"}. Each benchmark uses these saved inputs.`
        }
        action={
          <div className={s.row}>
            <CollectionEditor suite={data.suite} memberNames={data.memberNames} />
            <Link className={s.primary} href={"/runs/new?collection=" + data.suite.snapshotId}>
              Run a benchmark
            </Link>
          </div>
        }
      />
      <section aria-labelledby="suite-members">
        <div className={s.sectionHeading}>
          <h2 id="suite-members">Evaluations</h2>
          {data.suite.baselineOperationId && (
            <Link className={s.action} href={`/runs/${data.suite.baselineOperationId}`}>
              Open baseline run
            </Link>
          )}
        </div>
        <ul className={s.modelList}>
          {data.members.items.map((member) => (
            <li key={member.revisionId}>
              <div>
                <Link className={s.tableTitle} href={`/evaluations/${member.revisionId}`}>
                  {member.evaluation?.title ?? "Saved evaluation"}
                </Link>
                {member.evaluation?.description && (
                  <p className={s.small}>{member.evaluation.description}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
      <Pagination page={data.members} query={query} path={`/collections/${id}`} />
    </main>
  );
}
