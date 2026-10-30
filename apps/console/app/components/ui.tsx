"use client";

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X, WarningCircle, CircleNotch, Info } from "@phosphor-icons/react";
import Link from "next/link";
import { statusLabel } from "../../../../dist/packages/contracts/src/catalog.js";
import { problemSummary } from "./result-display";
import s from "./workbench.module.css";

export function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  useEffect(() => {
    document.title = `${title} · Basalt`;
  }, [title]);
  return (
    <div className={s.pageHeading}>
      <div>
        <h1>{title}</h1>
        {description && <p className={s.lede}>{description}</p>}
      </div>
      {action && <div className={s.headingAction}>{action}</div>}
    </div>
  );
}

export function ScrollRegion({
  children,
  label,
  className = s.tableWrap,
}: {
  children: ReactNode;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflow(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [children]);
  return (
    <div
      ref={ref}
      className={className}
      tabIndex={overflow ? 0 : undefined}
      role="region"
      aria-label={label}
      data-own-keys={overflow ? "" : undefined}
    >
      {children}
    </div>
  );
}

function useZone() {
  const [zone, setZone] = useState("UTC");
  useEffect(() => setZone(Intl.DateTimeFormat().resolvedOptions().timeZone), []);
  return zone;
}

export function ReadableTime({ value }: { value: string }) {
  const zone = useZone();
  return (
    <time dateTime={value} title={`${value} · displayed in ${zone}`}>
      {new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: zone,
      }).format(new Date(value))}
    </time>
  );
}

// Log rows show seconds and repeat the date only when it changes from the row above.
export function LogTime({ value, previous }: { value: string; previous?: string }) {
  const zone = useZone();
  const day = (iso: string) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: zone }).format(
      new Date(iso),
    );
  return (
    <time dateTime={value} title={`${value} · displayed in ${zone}`}>
      {(!previous || day(previous) !== day(value)) && <span>{day(value)}</span>}
      {new Intl.DateTimeFormat(undefined, { timeStyle: "medium", timeZone: zone }).format(
        new Date(value),
      )}
    </time>
  );
}

const arrowTurn = { right: 0, down: 90, left: 180, up: 270 } as const;
/**
 * An arrow drawn as a line. The console fonts have no arrow glyphs, and this shape matches
 * the arrow of an action link.
 */
export function Arrow({ direction = "right" }: { direction?: keyof typeof arrowTurn }) {
  return (
    <svg
      className={s.arrow}
      viewBox="0 0 12 12"
      aria-hidden="true"
      style={{ transform: `rotate(${arrowTurn[direction]}deg)` }}
    >
      <path d="M1 6h9.5M6.5 2 10.5 6l-4 4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function Tabs({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflow(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [children]);
  return (
    <div className={s.tabNavigation}>
      <nav
        ref={ref}
        className={s.tabs}
        aria-label={label}
        tabIndex={overflow ? 0 : undefined}
        data-own-keys={overflow ? "" : undefined}
      >
        {children}
      </nav>
      {overflow && (
        <span className={s.scrollCue} aria-hidden="true">
          Scroll <Arrow />
        </span>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  href,
  label,
}: {
  title: string;
  children: ReactNode;
  href?: string;
  label?: string;
}) {
  return (
    <div className={s.empty}>
      <h2>{title}</h2>
      <p>{children}</p>
      {href && (
        <Link className={s.primary} href={href}>
          {label}
        </Link>
      )}
    </div>
  );
}

export function Notice({
  children,
  kind = "error",
}: {
  children: ReactNode;
  kind?: "error" | "info";
}) {
  const Icon = kind === "error" ? WarningCircle : Info;
  return (
    <div className={`${s.notice} ${s[kind]}`} role={kind === "error" ? "alert" : "status"}>
      <Icon size={20} aria-hidden />
      <div>{children}</div>
    </div>
  );
}

// The filter that just applied takes focus back once the filtered page renders, briefly.
let refocusFilter: { id: string; at: number } | null = null;
/** A filter choice applies as soon as it changes; Search still submits typed text. */
export function FilterSelect(props: ComponentProps<"select">) {
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (!props.id || refocusFilter?.id !== props.id) return;
    const recent = Date.now() - refocusFilter.at < 5000;
    refocusFilter = null;
    if (!recent) return;
    ref.current?.focus();
  }, [props.id]);
  return (
    <select
      {...props}
      ref={ref}
      onChange={(event) => {
        props.onChange?.(event);
        refocusFilter = props.id ? { id: props.id, at: Date.now() } : null;
        event.currentTarget.form?.requestSubmit();
      }}
    />
  );
}

/** A problem in plain words, with the exact text kept in a disclosure; a caller may supply the words. */
export function ProblemText({
  text,
  summary = problemSummary(text),
}: {
  text: string;
  summary?: string;
}) {
  return (
    <>
      {summary}
      {summary.slice(1) !== text.slice(1) && (
        <details className={s.problemDetail}>
          <summary>Full error</summary>
          <code>{text}</code>
        </details>
      )}
    </>
  );
}

export function Status({
  children,
  tone = "neutral",
  live = false,
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warning" | "bad" | "active";
  live?: boolean;
}) {
  return (
    <span className={`${s.status} ${s[tone]}`} role={live ? "status" : undefined}>
      <span aria-hidden />
      {typeof children === "string" ? statusLabel(children) : children}
    </span>
  );
}

// Proportions of recorded answers. Text beside it always carries the counts.
export function OutcomeBar({
  met,
  failed,
  split = 0,
  scored = 0,
  insufficient = 0,
  unavailable,
  pending = 0,
}: {
  met: number;
  failed: number;
  split?: number;
  scored?: number;
  /** Answers of "Not enough evidence". They are answers, not absent results. */
  insufficient?: number;
  unavailable: number;
  pending?: number;
}) {
  if (met + failed + split + scored + insufficient + unavailable + pending === 0) return null;
  const segment = (count: number, className: string | undefined) =>
    count > 0 ? <span className={className} style={{ flexGrow: count }} /> : null;
  return (
    <span className={s.outcomeBar} aria-hidden>
      {segment(met, s.barMet)}
      {segment(failed, s.barFailed)}
      {segment(split, s.barSplit)}
      {segment(scored, s.barScored)}
      {segment(insufficient, s.barInsufficient)}
      {segment(unavailable, s.barMissing)}
      {segment(pending, s.barPending)}
    </span>
  );
}

// One mark per observation: solid when met, struck through when not met, a solid edge when
// the judge samples disagree, an ochre base when there is not enough evidence, hatched when
// unavailable, dashed while the answer is pending. "Not enough evidence" is a final answer, so
// it is never dashed.
export function markClass(outcome: string, active = false) {
  return outcome === "verified"
    ? s.markMet
    : outcome === "rejected"
      ? s.markFailed
      : outcome === "split"
        ? s.markSplit
        : outcome === "scored"
          ? s.markScored
          : outcome === "insufficient"
            ? s.markInsufficient
            : active
              ? s.markPending
              : s.markMissing;
}
export function OutcomeLegend({
  pending = false,
  scored = false,
  split = false,
  insufficient = false,
}: {
  pending?: boolean;
  scored?: boolean;
  split?: boolean;
  insufficient?: boolean;
}) {
  return (
    <ul className={s.legend} aria-label="Result marks">
      <li>
        <span className={`${s.mark} ${s.markMet}`} aria-hidden />
        Met
      </li>
      <li>
        <span className={`${s.mark} ${s.markFailed}`} aria-hidden />
        Not met
      </li>
      {scored && (
        <li>
          <span className={`${s.mark} ${s.markScored}`} aria-hidden />
          Scored
        </li>
      )}
      {split && (
        <li>
          <span className={`${s.mark} ${s.markSplit}`} aria-hidden />
          Split
        </li>
      )}
      {insufficient && (
        <li>
          <span className={`${s.mark} ${s.markInsufficient}`} aria-hidden />
          Not enough evidence
        </li>
      )}
      <li>
        <span className={`${s.mark} ${pending ? s.markPending : s.markMissing}`} aria-hidden />
        {pending ? "Not yet checked" : "Unavailable"}
      </li>
    </ul>
  );
}

export function Loading({ label = "Loading workspace" }: { label?: string }) {
  return (
    <div className={s.loading} role="status" data-loading="true">
      <CircleNotch size={20} className={s.spin} aria-hidden />
      {label}…
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const focus = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) {
      focus.current = document.activeElement as HTMLElement;
      dialog.showModal();
      // Start at the first visible field, so an early Enter never closes the dialog. A field in
      // a closed disclosure can't take focus. A dialog with no field starts at its close button.
      [
        ...dialog.querySelectorAll<HTMLElement>(
          "input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled)",
        ),
      ]
        .find((field) => field.checkVisibility())
        ?.focus();
    } else if (!open && dialog?.open) {
      dialog.close();
      focus.current?.focus();
    }
  }, [mounted, open]);
  // A modal inside a closed disclosure can make the page inert while remaining
  // invisible. Portals keep restored dialogs outside hidden or clipped ancestors.
  if (!mounted) return null;
  return createPortal(
    <dialog
      ref={ref}
      className={s.dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        // A styled select keeps Esc even while its list is closed, so the dialog never gets
        // its close request. Esc on a closed select closes the dialog here.
        const target = event.target as HTMLElement;
        if (event.key !== "Escape" || target.tagName !== "SELECT") return;
        let listOpen = false;
        try {
          listOpen = target.matches(":open");
        } catch {
          listOpen = false;
        }
        if (listOpen) return;
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        // Native close events are queued. A prior close must not dismiss or
        // steal focus from a dialog that has already been opened again.
        if (ref.current?.open) return;
        // A controlled close already closed the dialog and gave focus back in the effect. A late
        // second focus would undo a move that came after it, so only a native close that the
        // parent did not ask for, such as a form with method=dialog, gives focus back here.
        if (!open) return;
        onClose();
        focus.current?.focus();
      }}
    >
      <div className={s.sectionHeading}>
        <h2>{title}</h2>
        <button type="button" className={s.iconButton} onClick={onClose} aria-label="Close dialog">
          <X size={20} aria-hidden />
        </button>
      </div>
      {children}
    </dialog>,
    document.body,
  );
}
