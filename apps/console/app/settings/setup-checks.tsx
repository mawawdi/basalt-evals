"use client";

import { useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import type { LocalReadinessCheck } from "../../../../dist/packages/contracts/src/console.js";
import { read, message } from "../components/api";
import { Notice, Status } from "../components/ui";
import s from "../components/workbench.module.css";

// Commands, setting names and paths show as code, so a person can copy them exactly.
const codeToken =
  /(npm run [\w:-]+|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|(?<![\w.])\.env\b|(?:~|\b[\w.-]+)?\/[^\s]*[^\s.,])/u;
function HelpText({ text }: { text: string }) {
  return text
    .split(codeToken)
    .map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part));
}

export default function SetupChecks({ initial }: { initial: LocalReadinessCheck[] }) {
  const [checks, setChecks] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState(false);
  const missing = checks.filter((check) => !check.ready).length;
  // What still needs setup leads; ready items follow in their usual order.
  const ordered = [
    ...checks.filter((check) => !check.ready),
    ...checks.filter((check) => check.ready),
  ];
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setChecks(await read<LocalReadinessCheck[]>("/api/readiness"));
      setChecked(true);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={s.stack}>
      <div className={s.sectionHeading}>
        <div>
          <h2>What runs need</h2>
          <p className={s.small} role="status">
            {checked ? "Rechecked. " : ""}
            {missing
              ? `${missing} of ${checks.length} ${missing === 1 ? "needs" : "need"} setup.`
              : "Everything is ready."}
          </p>
        </div>
        <button className={s.secondary} disabled={busy} onClick={refresh}>
          <ArrowClockwise size={18} aria-hidden />
          {busy ? "Checking…" : "Recheck setup"}
        </button>
      </div>
      {error && <Notice>{error} The list below shows the last available checks.</Notice>}
      <section className={s.panel} aria-label="What runs need" aria-busy={busy}>
        {ordered.map((check) => (
          <div className={s.attention} key={check.name}>
            <div>
              <h3>{check.name}</h3>
              <p className={s.setupHelp}>
                <HelpText text={check.help} />
              </p>
            </div>
            <Status tone={check.ready ? "good" : "warning"}>
              {check.ready ? "Ready" : "Needs setup"}
            </Status>
          </div>
        ))}
      </section>
      <p className={s.small}>
        These checks are free and do not launch Studio. Each run checks Studio before any paid work
        starts. Saved results and reviews stay available while setup is incomplete.
      </p>
    </div>
  );
}
