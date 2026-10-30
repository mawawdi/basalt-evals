export const metadata = { title: "Optional reviews · Basalt" };
import Link from "next/link";
import Form from "next/form";
import { listReviewBatches } from "../../lib/server";
import { reviewerProfile } from "../../lib/server";
import { repositoryRoot } from "../../lib/data";
import {
  ScrollRegion,
  PageHeading,
  EmptyState,
  Status,
  ReadableTime,
  FilterSelect,
} from "../components/ui";
import { Pagination, queryParams, type Search } from "../components/pagination";
import s from "../components/workbench.module.css";
import r from "../components/review-experience.module.css";
export const dynamic = "force-dynamic";
export default async function Reviews({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams,
    page = await listReviewBatches(repositoryRoot(), queryParams(query));
  const filtered = !!(query.q || query.purpose || query.state);
  const stateLabel = (state: string) => (state === "completed" ? "Completed" : "Ready to continue");
  const purposeLabel = (batch: (typeof page.items)[number]) =>
    `${
      batch.purpose === "audit"
        ? "Random review"
        : batch.purpose === "diagnostic"
          ? "Targeted review"
          : batch.purpose === "training"
            ? "Training review"
            : "Registered research"
    }${
      batch.expert?.round === 2
        ? " · Round 2"
        : batch.expert?.role === "second"
          ? " · Second reviewer"
          : ""
    }`;
  const sessionLabel = (batch: (typeof page.items)[number]) =>
    batch.session
      ? `Session ${batch.session.number} · ${Math.floor(batch.activeMs / 60000)} active min total`
      : "Not started";
  const reviewers = new Map(
    await Promise.all(
      [...new Set(page.items.map((batch) => batch.reviewer))].map(
        async (id) => [id, await reviewerProfile(repositoryRoot(), id)] as const,
      ),
    ),
  );
  return (
    <main>
      <PageHeading
        title="Optional reviews"
        description="Reviews you start appear here. Automatic results never need your review, so reviewing a sample is optional."
      />
      <Form
        key={`${query.q ?? ""}:${query.purpose ?? ""}:${query.state ?? ""}`}
        className={s.toolbar}
        action="/reviews"
      >
        <div className={s.field}>
          <label htmlFor="review-search">Search reviews</label>
          <input
            id="review-search"
            name="q"
            type="search"
            defaultValue={typeof query.q === "string" ? query.q : ""}
          />
        </div>
        <div className={s.field}>
          <label htmlFor="review-purpose">Purpose</label>
          <FilterSelect
            id="review-purpose"
            name="purpose"
            defaultValue={typeof query.purpose === "string" ? query.purpose : ""}
          >
            <option value="">All assigned work</option>
            <option value="audit">Random reviews</option>
            <option value="diagnostic">Targeted reviews</option>
            <option value="training">Training reviews</option>
            <option value="protocol">Registered research</option>
          </FilterSelect>
        </div>
        <div className={s.field}>
          <label htmlFor="review-state">Review status</label>
          <FilterSelect
            id="review-state"
            name="state"
            defaultValue={typeof query.state === "string" ? query.state : ""}
          >
            <option value="">All reviews</option>
            <option value="active">Ready to continue</option>
            <option value="completed">Completed</option>
          </FilterSelect>
        </div>
        <button className={s.secondary}>Search</button>
        {filtered && (
          <Link className={s.secondary} href="/reviews">
            Clear filters
          </Link>
        )}
      </Form>
      {!page.items.length ? (
        <EmptyState
          title={filtered ? "No reviews match" : "No assigned reviews"}
          href={filtered ? "/reviews" : "/"}
          label={filtered ? "Clear filters" : "Open runs"}
        >
          {filtered
            ? "Try a different purpose, status or search."
            : "Open a run and use Review a sample to assign a limited set of questions. Viewing results never creates review work."}
        </EmptyState>
      ) : (
        <>
          <p className={s.small} role="status">
            {page.total} {page.total === 1 ? "review" : "reviews"}
            {filtered ? (page.total === 1 ? " matches" : " match") : ""}. Saved answers include
            Cannot tell and reused answers.
          </p>
          <div className={r.sessionCards}>
            {page.items.map((batch) => (
              <article className={`${s.panel} ${s.panelBody}`} key={batch.id}>
                <div className={s.sectionHeading}>
                  <h2>{purposeLabel(batch)}</h2>
                  <Status>{stateLabel(batch.state)}</Status>
                </div>
                <p>{reviewers.get(batch.reviewer)!.displayName}</p>
                <p className={s.small}>
                  Review {batch.id.slice(-10)} · <ReadableTime value={batch.createdAt} />
                </p>
                <p className={s.small}>{sessionLabel(batch)}</p>
                <p className={s.small}>
                  {batch.answered} of {batch.assigned} saved · {batch.remaining} unanswered
                </p>
                <p className={s.small}>
                  {batch.abstained} Cannot tell · {batch.reused} reused answers
                </p>
                <div className={s.row}>
                  {batch.state === "active" && (
                    <Link prefetch={false} className={s.secondary} href={`/reviews/${batch.id}`}>
                      Continue review
                    </Link>
                  )}
                  <Link className={s.textButton} href={`/audits/${batch.id}`}>
                    View report
                  </Link>
                </div>
              </article>
            ))}
          </div>
          <ScrollRegion className={`${s.tableWrap} ${r.sessionTable}`} label="Assigned reviews">
            <table className={s.resultTable}>
              <thead>
                <tr>
                  <th scope="col">Review</th>
                  <th scope="col">Reviewer</th>
                  <th scope="col">Assigned</th>
                  <th scope="col">Saved answers</th>
                  <th scope="col">Cannot tell</th>
                  <th scope="col">Reused</th>
                  <th scope="col">Unanswered</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((batch) => (
                  <tr key={batch.id}>
                    <th scope="row">
                      {purposeLabel(batch)}
                      <span className={s.tableMeta}>Review {batch.id.slice(-10)}</span>
                      <span className={s.tableMeta}>{sessionLabel(batch)}</span>
                      <span className={s.tableMeta}>
                        <ReadableTime value={batch.createdAt} />
                      </span>
                      <Status>{stateLabel(batch.state)}</Status>
                    </th>
                    <td>{reviewers.get(batch.reviewer)!.displayName}</td>
                    <td>{batch.assigned}</td>
                    <td>{batch.answered}</td>
                    <td>{batch.abstained}</td>
                    <td>{batch.reused}</td>
                    <td>{batch.remaining}</td>
                    <td>
                      <div className={s.row}>
                        {batch.state === "active" && (
                          <Link
                            prefetch={false}
                            className={s.textButton}
                            href={`/reviews/${batch.id}`}
                          >
                            Continue review
                          </Link>
                        )}
                        <Link className={s.textButton} href={`/audits/${batch.id}`}>
                          View report
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </>
      )}
      <Pagination path="/reviews" page={page} query={query} />
    </main>
  );
}
