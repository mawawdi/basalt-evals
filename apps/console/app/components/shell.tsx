"use client";

import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { List, CaretLeft, CaretDown } from "@phosphor-icons/react";
import { Notifications } from "./notifications";
import { ThemeToggle } from "./theme-toggle";
import { Dialog } from "./ui";
import s from "./workbench.module.css";

const main = [
  { href: "/", label: "Benchmarks" },
  { href: "/evaluations", label: "Evaluations" },
  { href: "/models", label: "Models" },
];
const secondary = [
  { href: "/reviews", label: "Optional reviews" },
  { href: "/research", label: "Research" },
  { href: "/history", label: "Archives" },
  { href: "/settings", label: "Settings" },
];
const records = { href: "/?view=activity", label: "Records" };

// Three basalt columns: the cooled-lava jointing the product is named after.
function BrandMark() {
  return (
    <svg className={s.brandMark} viewBox="0 0 24 24" aria-hidden focusable="false">
      <path d="M2 9.5 5 8l3 1.5V22H2Z" />
      <path d="M9 3.5 12 2l3 1.5V22H9Z" />
      <path d="M16 12.5 19 11l3 1.5V22h-6Z" />
      <path
        className={s.brandFacet}
        d="M2 9.5 5 8l3 1.5L5 11ZM9 3.5 12 2l3 1.5L12 5Zm7 9L19 11l3 1.5-3 1.5Z"
      />
    </svg>
  );
}

/** One back link to the real parent and the name of the current page. */
export function Breadcrumb({
  parent,
  detail,
}: {
  parent: { href: string; label: string };
  detail: string;
}) {
  return (
    <nav className={s.breadcrumb} aria-label="Breadcrumb">
      <Link href={parent.href}>
        <CaretLeft size={14} aria-hidden />
        {parent.label}
      </Link>
      <span aria-current="page">{detail}</span>
    </nav>
  );
}

export default function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const params = useSearchParams();
  // Comparisons and affected runs are records; their back links lead into Records too.
  const viewingRecords =
    (path === "/" &&
      ["view", "selection", "q", "status", "limit", "page"].some((key) => params.has(key))) ||
    ["/comparisons/", "/issues/"].some((prefix) => path.startsWith(prefix));
  const [menu, setMenu] = useState(false);
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDetailsElement>(null);
  const blind = /^\/reviews\/[^/]+/.test(path);
  const active = (href: string) =>
    href === records.href
      ? viewingRecords
      : href === "/"
        ? (path === "/" && !viewingRecords) || path.startsWith("/runs/")
        : path.startsWith(href) ||
          (href === "/reviews" && path.startsWith("/audits/")) ||
          (href === "/evaluations" &&
            ["/collections/", "/regressions/"].some((prefix) => path.startsWith(prefix)));
  const section = [...main, records, ...secondary].find((item) => active(item.href)) ?? main[0]!;
  const atSection = path === section.href.split("?")[0];
  const secondaryActive = secondary.find((item) => active(item.href));
  useEffect(() => {
    if (!more) return;
    const outside = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMore(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [more]);
  const runPage = /^\/runs\/(?!new$)[^/]+$/.test(path);
  // Each detail page names its real parent, so one back link replaces per-page links.
  const run = path.match(/^\/runs\/([^/]+)\/requests\//)?.[1];
  const parent = run
    ? { href: `/runs/${run}?tab=details`, label: "Run" }
    : path.startsWith("/comparisons/")
      ? { href: "/?view=comparisons", label: "Comparisons" }
      : path.startsWith("/collections/")
        ? { href: "/evaluations?view=suites", label: "Suites" }
        : path.startsWith("/regressions/")
          ? { href: "/evaluations?view=regressions", label: "Saved examples" }
          : path.startsWith("/issues/")
            ? { href: "/?view=activity&status=attention", label: "Needs attention" }
            : { href: section.href, label: section.label };
  const detail =
    path === "/runs/new"
      ? "Run a benchmark"
      : path === "/evaluations/new"
        ? "Evaluation editor"
        : run
          ? "Request spending"
          : path.startsWith("/runs/")
            ? "Run"
            : path.startsWith("/comparisons/")
              ? "Comparison"
              : path.startsWith("/collections/")
                ? "Suite"
                : path.startsWith("/regressions/")
                  ? "Saved example"
                  : path.startsWith("/audits/")
                    ? "Review report"
                    : path.startsWith("/issues/")
                      ? "Affected runs"
                      : path.startsWith("/history/")
                        ? "Historical record"
                        : path.startsWith("/evaluations/")
                          ? "Evaluation"
                          : null;
  const brand = (
    <Link href="/" className={s.brand} onClick={() => setMenu(false)}>
      <BrandMark />
      <span>
        Basalt <span className={s.brandCaption}>Evals</span>
      </span>
    </Link>
  );
  if (blind)
    return (
      <>
        <a className={s.skip} href="#main">
          Skip to content
        </a>
        <header className={s.reviewHeader}>
          <Link href="/reviews" prefetch={false}>
            <CaretLeft size={18} aria-hidden />
            Optional reviews
          </Link>
          <span className={s.reviewBrand}>
            <BrandMark />
            Independent review
          </span>
          <span className={s.reviewPrivacy}>Blind review</span>
          <ThemeToggle />
        </header>
        <div id="main" tabIndex={-1} className={s.focusMain}>
          {children}
        </div>
      </>
    );
  return (
    <div className={s.shell}>
      <a className={s.skip} href="#main">
        Skip to content
      </a>
      <header className={s.band}>
        {brand}
        <nav aria-label="Main navigation" className={s.primaryNav}>
          {main.map(({ href, label }) => (
            <Link key={href} href={href} aria-current={active(href) ? "page" : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        <nav aria-label="Workspace utilities" className={s.utilityNav}>
          <Link href={records.href} aria-current={viewingRecords ? "page" : undefined}>
            Records
          </Link>
          <details
            ref={moreRef}
            className={s.utilityMenu}
            open={more}
            onToggle={(event) => setMore(event.currentTarget.open)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // An open menu uses this Escape, so the page under it does not.
                if (event.currentTarget.open) event.preventDefault();
                setMore(false);
                event.currentTarget.querySelector("summary")?.focus();
              }
            }}
          >
            <summary data-active={secondaryActive ? "true" : undefined}>
              {secondaryActive?.label ?? "More"}
              <CaretDown size={14} aria-hidden />
            </summary>
            <div className={s.utilityPanel}>
              {secondary.map(({ href, label }) => (
                <Link
                  key={href}
                  href={href}
                  aria-current={active(href) ? "page" : undefined}
                  onClick={() => setMore(false)}
                >
                  {label}
                </Link>
              ))}
              <p className={s.localLabel}>Everything stays on this Mac.</p>
            </div>
          </details>
        </nav>
        <div className={s.bandEnd}>
          <ThemeToggle />
          <Notifications />
          <button
            className={s.menuButton}
            aria-label="Menu · open navigation"
            onClick={() => setMenu(true)}
          >
            <List size={22} aria-hidden />
            <span>Menu</span>
          </button>
        </div>
      </header>
      <div id="main" tabIndex={-1} className={s.main}>
        {/* A run page knows its kind on the server, so it draws its own breadcrumb. */}
        {!atSection && !runPage && detail && <Breadcrumb parent={parent} detail={detail} />}
        {children}
      </div>
      <Dialog title="Navigation" open={menu} onClose={() => setMenu(false)}>
        <nav aria-label="Main navigation" className={s.mobileNavigation}>
          {[...main, records].map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              aria-current={active(href) ? "page" : undefined}
              onClick={() => setMenu(false)}
            >
              {label}
            </Link>
          ))}
          <p className={s.mobileGroup}>More</p>
          {secondary.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              aria-current={active(href) ? "page" : undefined}
              onClick={() => setMenu(false)}
            >
              {label}
            </Link>
          ))}
          <p className={s.localLabel}>Everything stays on this Mac.</p>
        </nav>
      </Dialog>
    </div>
  );
}
