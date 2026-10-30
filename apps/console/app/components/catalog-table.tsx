import Link from "next/link";
import Form from "next/form";
import type { ReactNode } from "react";
import { ScrollRegion, EmptyState, Status, ReadableTime, FilterSelect } from "./ui";
import { Pagination, queryParams, type Search } from "./pagination";
import type { Page } from "../../../../dist/packages/contracts/src/catalog.js";
import s from "./workbench.module.css";
interface CatalogRow {
  id: string;
  title: string;
  href: string;
  download?: string;
  /** Rows without a state (such as archived files, which are all saved) omit the column. */
  state?: string;
  description?: string;
  detail?: string;
  meta?: string;
  at?: string;
  action?: { href: string; label: string; name: string };
  /** A row control that acts in place, for example Archive. */
  control?: ReactNode;
}
export function CatalogTable({
  rows,
  label,
  emptyHref,
  emptyLabel,
  emptyText = "Saved work will appear here.",
  page,
  query = {},
  path,
  filters = [],
}: {
  rows: CatalogRow[];
  label: string;
  emptyHref?: string;
  emptyLabel?: string;
  emptyText?: string;
  page?: Omit<Page<never>, "items">;
  query?: Search;
  path?: string;
  filters?: Array<{ value: string; label: string }>;
}) {
  const filtered = Boolean(query.q || (query.status && query.status !== "all"));
  const hasDetails = rows.some((row) => row.detail || row.meta);
  const hasStatus = rows.some((row) => row.state);
  const hasActions = rows.some((row) => row.action || row.control);
  const resetQuery = queryParams(query);
  for (const key of ["q", "status", "page"]) resetQuery.delete(key);
  const resetHref = `${path ?? ""}${resetQuery.size ? `?${resetQuery}` : ""}`;
  return (
    <>
      {page && path && (
        <Form
          key={`${path}:${query.q ?? ""}:${query.status ?? ""}`}
          className={s.toolbar}
          action={path}
        >
          {Object.entries(query)
            .filter(
              ([key, value]) => !["q", "status", "page"].includes(key) && typeof value === "string",
            )
            .map(([key, value]) => (
              <input key={key} type="hidden" name={key} value={value as string} />
            ))}
          <div className={s.field}>
            <label htmlFor="catalog-search">Search {label.toLowerCase()}</label>
            <input
              id="catalog-search"
              name="q"
              type="search"
              defaultValue={typeof query.q === "string" ? query.q : ""}
            />
          </div>
          {filters.length > 0 && (
            <div className={s.field}>
              <label htmlFor="catalog-status">Status</label>
              <FilterSelect
                id="catalog-status"
                name="status"
                defaultValue={typeof query.status === "string" ? query.status : ""}
              >
                <option value="">All statuses</option>
                {filters.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </FilterSelect>
            </div>
          )}
          <button className={s.secondary}>Search</button>
          {filtered && (
            <Link className={s.textButton} href={resetHref}>
              Clear filters
            </Link>
          )}
        </Form>
      )}
      {!rows.length ? (
        <EmptyState
          title={
            filtered
              ? `No ${label.toLowerCase()} match this search`
              : `No ${label.toLowerCase()} yet`
          }
          href={filtered && path ? resetHref : emptyHref}
          label={filtered && path ? "Clear filters" : emptyLabel}
        >
          {filtered ? "Try another search or clear the filters." : emptyText}
        </EmptyState>
      ) : (
        <ScrollRegion className={s.tableWrap} label={label}>
          <table className={s.catalog}>
            <thead>
              <tr>
                <th scope="col">{label}</th>
                {hasStatus && <th scope="col">Status</th>}
                {hasDetails && <th scope="col">Details</th>}
                {hasActions && (
                  <th scope="col">
                    <span className={s.visuallyHidden}>Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    {row.download ? (
                      <a className={s.tableTitle} href={row.href} download={row.download}>
                        {row.title}
                      </a>
                    ) : (
                      <Link className={s.tableTitle} href={row.href}>
                        {row.title}
                      </Link>
                    )}
                    {row.description && <span className={s.tableMeta}>{row.description}</span>}
                    {row.at && (
                      <span className={s.tableMeta}>
                        <ReadableTime value={row.at} />
                      </span>
                    )}
                  </th>
                  {hasStatus && (
                    <td className={s.catalogStatus}>
                      {row.state && (
                        <Status
                          tone={
                            ["attention", "partial", "incomplete", "Needs validation"].includes(
                              row.state,
                            )
                              ? "warning"
                              : row.state === "Needs input"
                                ? "warning"
                                : row.state === "active"
                                  ? "active"
                                  : [
                                        "complete",
                                        "ready",
                                        "checked",
                                        "Ready to run",
                                        "Reference tested",
                                      ].includes(row.state)
                                    ? "good"
                                    : "neutral"
                          }
                        >
                          {row.state}
                        </Status>
                      )}
                    </td>
                  )}
                  {hasDetails && (
                    <td>
                      {row.detail}
                      {row.meta && <span className={s.tableMeta}>{row.meta}</span>}
                    </td>
                  )}
                  {hasActions && (
                    <td className={s.rowAction}>
                      {row.control}
                      {row.action && (
                        <Link
                          className={s.secondary}
                          href={row.action.href}
                          aria-label={`${row.action.label}: ${row.action.name}`}
                        >
                          {row.action.label}
                        </Link>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      {page && path && <Pagination page={page} query={query} path={path} />}
    </>
  );
}
