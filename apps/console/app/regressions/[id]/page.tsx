export const metadata = { title: "Saved example · Basalt" };
import Link from "next/link";
import { notFound } from "next/navigation";
import { readRegressionReference } from "../../../lib/server";
import { repositoryRoot } from "../../../lib/data";
import { PageHeading } from "../../components/ui";
import { WorkloadLaunch } from "../../components/workload-launch";
import s from "../../components/workbench.module.css";
export const dynamic = "force-dynamic";
export default async function RegressionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-f0-9]{64}$/u.test(id)) notFound();
  const reference = await readRegressionReference(repositoryRoot(), id);
  const evidenceQuery = new URLSearchParams({ tab: "evidence", candidate: reference.subjectId });
  if (reference.criterionIds[0]) evidenceQuery.set("criterion", reference.criterionIds[0]);
  return (
    <main>
      <PageHeading
        title={reference.title}
        description={
          reference.purpose === "generation"
            ? "A saved example that tests new builds against the original evaluation."
            : "A saved example that checks a judge against the original evidence and success criteria."
        }
        action={<WorkloadLaunch kind="regression" reference={reference} />}
      />
      <section className={`${s.panel} ${s.panelBody}`}>
        <h2>Saved example</h2>
        <p>
          {reference.criterionIds.length}{" "}
          {reference.criterionIds.length === 1 ? "criterion" : "criteria"} ·{" "}
          {reference.evidenceSetIds.length} saved{" "}
          {reference.evidenceSetIds.length === 1 ? "observation" : "observations"}
        </p>
        <div className={s.actions}>
          <Link className={s.secondary} href={`/runs/${reference.operationId}?${evidenceQuery}`}>
            Open saved evidence
          </Link>
          <Link className={s.action} href={`/runs/${reference.operationId}`}>
            Open source run
          </Link>
          <Link className={s.action} href={`/evaluations/${reference.evaluationId}`}>
            Read the original evaluation
          </Link>
        </div>
        <p className={s.small}>
          Saving an example is free. Checking it starts a separate run with its own spending limit.
          A saved example does not mean new builds must meet the criteria.
        </p>
        <details>
          <summary>Saved example details</summary>
          <p className={s.small}>
            Saved at{" "}
            <time dateTime={reference.createdAt}>
              {new Intl.DateTimeFormat("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: "UTC",
              }).format(new Date(reference.createdAt))}{" "}
              UTC
            </time>
          </p>
          <p className={s.tableMeta}>Example identity: {reference.id}</p>
          <p className={s.tableMeta}>Source run: {reference.operationId}</p>
          <p className={s.tableMeta}>Original evaluation: {reference.evaluationId}</p>
        </details>
      </section>
    </main>
  );
}
