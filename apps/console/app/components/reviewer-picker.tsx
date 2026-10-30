"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import type { ReviewerProfile } from "../../../../dist/packages/contracts/src/review.js";
import type { Page } from "../../../../dist/packages/contracts/src/catalog.js";
import { action, read, message } from "./api";
import { Dialog, Notice, Loading } from "./ui";
import s from "./workbench.module.css";

const preference = "basalt-reviewer-profile";
function rememberReviewer(profile: ReviewerProfile) {
  try {
    localStorage.setItem(preference, profile.id);
  } catch {}
}
export function ReviewerPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: ReviewerProfile | null;
  onChange: (profile: ReviewerProfile) => void;
  disabled?: boolean;
}) {
  const [page, setPage] = useState<Page<ReviewerProfile> | null>(null);
  const [query, setQuery] = useState(""),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [pageNumber, setPageNumber] = useState(1),
    [attempt, setAttempt] = useState(0);
  const choice = useRef(0);
  const creating = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(
      () =>
        void read<Page<ReviewerProfile>>(
          `/api/reviewers?q=${encodeURIComponent(query)}&page=${pageNumber}`,
          controller.signal,
        )
          .then((p) => {
            if (!controller.signal.aborted) setPage(p);
          })
          .catch((c) => {
            if (!controller.signal.aborted) setError(message(c));
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          }),
      150,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, pageNumber, attempt]);
  useEffect(() => {
    let active = true;
    const ticket = choice.current;
    if (!value) {
      let id: string | null = null;
      try {
        id = localStorage.getItem(preference);
      } catch {}
      if (id)
        void read<ReviewerProfile>(`/api/reviewers/${id}`)
          .then((p) => {
            if (active && ticket === choice.current) onChange(p);
          })
          .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, []);
  function choose(profile: ReviewerProfile) {
    choice.current++;
    rememberReviewer(profile);
    onChange(profile);
  }
  return (
    <fieldset className={s.stack} disabled={disabled || busy} aria-busy={loading}>
      {error && (
        <Notice>
          {error}
          <button
            type="button"
            className={s.secondary}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Reload profiles
          </button>
        </Notice>
      )}
      {loading && !page && (
        <p className={s.small} role="status">
          Loading reviewer profiles…
        </p>
      )}
      {(query || (page?.total ?? 0) > 5) && (
        <div className={s.field}>
          <label htmlFor="reviewer-search">Find a reviewer</label>
          <input
            id="reviewer-search"
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPageNumber(1);
            }}
          />
          {query && (
            <button
              type="button"
              className={s.textButton}
              onClick={() => {
                setQuery("");
                setPageNumber(1);
              }}
            >
              Clear search
            </button>
          )}
        </div>
      )}
      {(value || (page?.total ?? 0) > 0) && (
        <div className={s.field}>
          <label htmlFor="reviewer-profile">Reviewer</label>
          <select
            id="reviewer-profile"
            value={value?.id ?? ""}
            onChange={(e) => {
              const p = page?.items.find((p) => p.id === e.target.value);
              if (p) choose(p);
            }}
          >
            <option value="">Choose your profile</option>
            {value && !page?.items.some((p) => p.id === value.id) && (
              <option value={value.id}>{value.displayName}</option>
            )}
            {page?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName} · {p.id.slice(0, 6)}
              </option>
            ))}
          </select>
        </div>
      )}
      {page && page.pages > 1 && (
        <div className={s.row}>
          <button
            className={s.secondary}
            type="button"
            disabled={loading || page.page === 1}
            onClick={() => setPageNumber(page.page - 1)}
          >
            Previous profiles
          </button>
          <span>
            {page.page} / {page.pages}
          </span>
          <button
            className={s.secondary}
            type="button"
            disabled={loading || page.page === page.pages}
            onClick={() => setPageNumber(page.page + 1)}
          >
            More profiles
          </button>
        </div>
      )}
      {!loading && page?.total === 0 && query && (
        <p className={s.small}>
          No profiles match this search. Clear the search before you create a new profile.
        </p>
      )}
      <details open={page?.total === 0 && !query}>
        <summary>Create your reviewer profile</summary>
        <div className={s.field}>
          <label htmlFor="reviewer-name">Your name</label>
          <input
            id="reviewer-name"
            maxLength={100}
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <p className={s.small}>
          Profiles keep each person’s answers separate on this device. Profiles with the same name
          do not merge.
        </p>
        <button
          className={s.secondary}
          type="button"
          disabled={busy || !name.trim()}
          onClick={() => {
            if (creating.current) return;
            creating.current = true;
            setBusy(true);
            setError("");
            void action<ReviewerProfile>("/api/reviewers", "create_reviewer", { displayName: name })
              .then((p) => {
                choose(p);
                setName("");
                setQuery("");
                setPageNumber(1);
                setAttempt((value) => value + 1);
              })
              .catch((c) => setError(message(c)))
              .finally(() => {
                setBusy(false);
                creating.current = false;
              });
          }}
        >
          {busy ? "Creating…" : "Create profile"}
        </button>
      </details>
    </fieldset>
  );
}

/** The actor is pinned for the mounted session. Other tabs cannot reattribute it. */
export function ReviewIdentity({
  batchId,
  children,
}: {
  batchId: string;
  children: (profile: ReviewerProfile) => ReactNode;
}) {
  const [required, setRequired] = useState<ReviewerProfile | null>(null),
    [actor, setActor] = useState<ReviewerProfile | null>(null),
    [open, setOpen] = useState(false),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0),
    [futureName, setFutureName] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    void read<ReviewerProfile>(`/api/reviews/${batchId}/profile`)
      .then((p) => {
        if (!active) return;
        setRequired(p);
        try {
          if (localStorage.getItem(preference) === p.id) setActor(p);
        } catch {}
      })
      .catch((c) => {
        if (active) setError(message(c));
      });
    return () => {
      active = false;
    };
  }, [batchId, attempt]);
  if (error)
    return (
      <main>
        <Notice>
          {error}
          <button className={s.secondary} onClick={() => setAttempt((value) => value + 1)}>
            Reload reviewer profile
          </button>
        </Notice>
        <Link href="/reviews" className={s.textButton}>
          Return to optional reviews
        </Link>
      </main>
    );
  if (!required)
    return (
      <main>
        <Loading label="Loading reviewer profile" />
      </main>
    );
  if (!actor)
    return (
      <main>
        <h1>Open your review</h1>
        <section className={`${s.panel} ${s.panelBody}`}>
          <p>
            This review is assigned to <strong>{required.displayName}</strong>. Saved answers stay
            with this profile.
          </p>
          <button
            className={s.primary}
            onClick={() => {
              rememberReviewer(required);
              setActor(required);
            }}
          >
            Review as {required.displayName}
          </button>
          <Link href="/reviews" className={s.textButton}>
            Return to optional reviews
          </Link>
        </section>
      </main>
    );
  return (
    <>
      <div className={`${s.row} ${s.reviewerBar}`}>
        <span>
          Reviewing as <strong>{actor.displayName}</strong>
        </span>
        <button
          className={s.textButton}
          aria-label="Change reviewer profile"
          onClick={() => setOpen(true)}
        >
          Change
        </button>
        {futureName && (
          <span className={s.small} role="status">
            Future reviews will use {futureName}. This session remains assigned to{" "}
            {actor.displayName}.
          </span>
        )}
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title="Reviewer profile">
        <p>
          This open review stays assigned to {actor.displayName}. The profile you choose here
          applies to future reviews.
        </p>
        {open && (
          <ReviewerPicker
            value={actor}
            onChange={(p) => {
              rememberReviewer(p);
              setFutureName(p.displayName);
              setOpen(false);
            }}
          />
        )}
      </Dialog>
      {children(actor)}
    </>
  );
}
