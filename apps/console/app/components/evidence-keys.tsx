"use client";
import { useEffect, useRef } from "react";
import {
  evidenceKeyCommand,
  type EvidenceKeyCommand,
  type EvidenceKeyTarget,
} from "../../../../dist/packages/contracts/src/evidence-keys.js";
import { Arrow } from "./ui";
import s from "./workbench.module.css";
import r from "./run-experience.module.css";

/**
 * Where a key event started. An open dialog or disclosure, a field and a region with
 * `data-own-keys` keep their keys, so the page never takes a key that they use.
 */
function keyTarget(event: KeyboardEvent): EvidenceKeyTarget {
  const node = event.target instanceof Element ? event.target : null;
  if (document.querySelector("dialog[open]") || node?.closest("details[open]")) return "overlay";
  if (
    node?.closest("input, select, textarea") ||
    (node instanceof HTMLElement && node.isContentEditable)
  )
    return "text";
  if (node?.closest("[data-own-keys]")) return "owned";
  return "page";
}

/**
 * Runs the page command of each key that no field, region or overlay keeps. `run` returns
 * true when it used the command. Only then does the key stop its default action.
 */
export function usePageKeys(active: boolean, run: (command: EvidenceKeyCommand) => boolean) {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (!active) return;
    // The window gets the key last, after the page and each region had their chance.
    const listener = (event: KeyboardEvent) => {
      const command = evidenceKeyCommand({
        key: event.key,
        shift: event.shiftKey,
        alt: event.altKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        defaultPrevented: event.defaultPrevented,
        target: keyTarget(event),
      });
      if (command && latest.current(command)) event.preventDefault();
    };
    addEventListener("keydown", listener);
    return () => removeEventListener("keydown", listener);
  }, [active]);
}

interface KeyHint {
  /** The key caps on screen. */
  keys: string[];
  /** The keys in words, for screen readers. */
  spoken: string;
  label: string;
}

const arrowKeys: Record<string, "left" | "right" | "up" | "down"> = {
  "←": "left",
  "→": "right",
  "↑": "up",
  "↓": "down",
};

/** Visible keyboard shortcuts under a navigation bar. */
export function KeyHints({ hints }: { hints: KeyHint[] }) {
  if (!hints.length) return null;
  return (
    <ul className={r.keyHints} aria-label="Keyboard shortcuts" data-key-hints>
      {hints.map((hint) => (
        <li key={hint.label}>
          <span className={r.keyCaps} aria-hidden="true">
            {hint.keys.map((key) => (
              <kbd key={key}>{key in arrowKeys ? <Arrow direction={arrowKeys[key]} /> : key}</kbd>
            ))}
          </span>
          <span className={s.visuallyHidden}>{hint.spoken}: </span>
          {hint.label}
        </li>
      ))}
    </ul>
  );
}

export const CRITERION_KEYS: KeyHint = {
  keys: ["←", "→"],
  spoken: "Left or Right arrow",
  label: "Previous or next criterion",
};
export const BUILD_KEYS: KeyHint = {
  keys: ["Shift", "←", "→"],
  spoken: "Shift with Left or Right arrow",
  label: "Previous or next build",
};
export const RESULTS_KEY: KeyHint = { keys: ["Esc"], spoken: "Escape", label: "All results" };
