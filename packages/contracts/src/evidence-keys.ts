/**
 * The keyboard commands of the evidence view and of the build history. The console finds
 * where the key event started, and this function decides the command. A key that a field, a
 * region with its own keys or an open overlay receives never becomes a page command.
 */

/**
 * Where a key event started:
 * - `text`: an input, a select, a text area or editable text
 * - `owned`: a region with `data-own-keys`, for example the player or a scroll region
 * - `overlay`: an open dialog or an open disclosure
 * - `page`: all other places on the page
 */
export type EvidenceKeyTarget = "text" | "owned" | "overlay" | "page";

export interface EvidenceKeyInput {
  key: string;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  /** An earlier listener used the key. */
  defaultPrevented: boolean;
  target: EvidenceKeyTarget;
}

export type EvidenceKeyCommand =
  /** The previous or the next criterion of the build. The observation stays. */
  | { kind: "criterion"; step: -1 | 1 }
  /** The previous or the next build. The criterion and the observation stay. */
  | { kind: "build"; step: -1 | 1 }
  /** All results of the run. */
  | { kind: "results" };

export function evidenceKeyCommand(input: EvidenceKeyInput): EvidenceKeyCommand | null {
  if (input.defaultPrevented || input.target !== "page") return null;
  // The browser and the system use Alt, Control and Command with these keys, for example
  // for Back. The page never takes those combinations.
  if (input.alt || input.ctrl || input.meta) return null;
  if (input.key === "Escape") return input.shift ? null : { kind: "results" };
  const step = input.key === "ArrowLeft" ? -1 : input.key === "ArrowRight" ? 1 : null;
  if (step === null) return null;
  return { kind: input.shift ? "build" : "criterion", step };
}
