"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Bell, X, CaretRight } from "@phosphor-icons/react";
import type { ConsoleNotification } from "../../../../dist/packages/contracts/src/benchmarks.js";
import { read } from "./api";
import { ReadableTime } from "./ui";
import { problemSummary } from "./result-display";
import n from "./notifications.module.css";
export function Notifications() {
  const [items, setItems] = useState<ConsoleNotification[] | null>(null),
    [error, setError] = useState(false),
    [open, setOpen] = useState(false),
    path = usePathname();
  const panel = useRef<HTMLElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const close = (restore = true) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  };
  useEffect(() => {
    let alive = true,
      inFlight = false;
    const controller = new AbortController();
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const rows = await read<ConsoleNotification[]>("/api/notifications", controller.signal);
        if (alive) {
          setItems([...new Map(rows.map((item) => [item.id, item])).values()]);
          setError(false);
        }
      } catch {
        if (alive) setError(true);
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [path]);
  useEffect(() => {
    setOpen(false);
  }, [path]);
  useEffect(() => {
    if (!open) return;
    heading.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const count = items?.length,
    label =
      items === null
        ? error
          ? "Notifications, unavailable"
          : "Notifications, loading"
        : count
          ? `Notifications, ${count} ${count === 1 ? "needs" : "need"} attention`
          : "Notifications, nothing needs attention";
  return (
    <div className={n.wrap}>
      <button
        type="button"
        ref={trigger}
        className={n.trigger}
        aria-label={label}
        aria-controls="console-notifications"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Bell size={22} aria-hidden />
        {count !== 0 && <span aria-hidden>{count ?? "…"}</span>}
      </button>
      {open && (
        <section
          ref={panel}
          id="console-notifications"
          className={n.panel}
          aria-labelledby="notifications-title"
          data-own-keys
          aria-busy={items === null && !error}
        >
          <header>
            <div>
              <h2 ref={heading} id="notifications-title" tabIndex={-1}>
                Notifications
              </h2>
              <p>
                {count === undefined
                  ? error
                    ? "Cannot refresh"
                    : "Loading…"
                  : count
                    ? `${count} ${count === 1 ? "needs" : "need"} attention`
                    : "No notifications"}
              </p>
            </div>
            <button type="button" onClick={() => close()} aria-label="Close notifications">
              <X size={20} aria-hidden />
            </button>
          </header>
          {error && (
            <p className={n.empty} role="status">
              Basalt could not refresh the notifications.{" "}
              {items
                ? "The panel shows the last list that loaded."
                : "It will try again automatically."}
            </p>
          )}
          {items === null && !error ? (
            <p className={n.empty} role="status">
              Loading notifications…
            </p>
          ) : items?.length ? (
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <Link href={item.href} onClick={() => close(false)}>
                    <span className={n.dot} aria-hidden />
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        {item.kind === "interruption" ? problemSummary(item.detail) : item.detail}
                      </small>
                      <small className={n.time}>
                        <ReadableTime value={item.at} />
                      </small>
                    </span>
                    <CaretRight size={16} aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            items && (
              <div className={n.empty}>
                <h3>Nothing needs attention</h3>
                <p>Benchmark results and records stay available.</p>
              </div>
            )
          )}
        </section>
      )}
    </div>
  );
}
