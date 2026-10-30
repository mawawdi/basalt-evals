import Link from "next/link";
import s from "./workbench.module.css";
export type Search = Record<string, string | string[] | undefined>;
export function queryParams(input: Search) {
  return new URLSearchParams(
    Object.entries(input).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    ),
  );
}
export function Pagination({
  page,
  query,
  path,
}: {
  page: { page: number; pages: number; total: number; limit: number };
  query: Search;
  path: string;
}) {
  if (!page.total) return null;
  const href = (number: number) => {
    const params = queryParams(query);
    params.set("page", String(number));
    return `${path}?${params}`;
  };
  return (
    <nav className={s.pagination} aria-label="Pagination">
      <p className={s.small}>
        {page.total ? (page.page - 1) * page.limit + 1 : 0}–
        {Math.min(page.total, page.page * page.limit)} of {page.total}
      </p>
      <div className={s.row}>
        {page.page > 1 && (
          <Link className={s.secondary} href={href(page.page - 1)}>
            Previous page
          </Link>
        )}
        <span className={s.small}>
          Page {page.page} of {page.pages}
        </span>
        {page.page < page.pages && (
          <Link className={s.secondary} href={href(page.page + 1)}>
            Next page
          </Link>
        )}
      </div>
    </nav>
  );
}
