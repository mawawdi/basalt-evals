"use client";

import { useEffect, useState } from "react";
import type { ScreenRecordingEntry } from "../../../../dist/packages/operator/src/screen-recordings.js";
import { message, read } from "./api";
import { Notice, ScrollRegion } from "./ui";
import s from "./workbench.module.css";

/**
 * Links to the screen recording of each observation, with its Studio slot. A recording is a
 * diagnostic: checks, judges, reviews and exports never read it.
 */
export function ScreenRecordings({
  operationId,
  refresh,
}: {
  operationId: string;
  /** A new value loads the list again, for example when an observation completes. */
  refresh: unknown;
}) {
  const [items, setItems] = useState<ScreenRecordingEntry[]>([]);
  const [error, setError] = useState("");
  const base = `/api/operations/${encodeURIComponent(operationId)}/screen`;
  useEffect(() => {
    const controller = new AbortController();
    void read<ScreenRecordingEntry[]>(base, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setItems(value);
        setError("");
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(message(cause));
      });
    return () => controller.abort();
  }, [base, refresh]);
  if (!items.length && !error) return null;
  return (
    <section className={s.section} aria-labelledby="screen-recordings-heading">
      <div className={s.sectionHeading}>
        <div>
          <h2 id="screen-recordings-heading">Screen recordings</h2>
          <p>
            Each recording shows the Studio windows during one observation. It helps you see what
            happened, but checks and reviews never use it.
          </p>
        </div>
      </div>
      {error && <Notice>{error}</Notice>}
      {!!items.length && (
        <ScrollRegion label="Screen recordings">
          <table className={s.stackTable}>
            <thead>
              <tr>
                <th scope="col">Observation</th>
                <th scope="col">Studio slot</th>
                <th scope="col">Recording</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.unit}>
                  <th scope="row">
                    Build {item.build} · observation {item.observation}
                    <span className={s.tableMeta}>{item.builderName}</span>
                  </th>
                  <td data-label="Studio slot">Studio slot {item.lane + 1}</td>
                  <td data-label="Recording">
                    <a
                      className={s.action}
                      href={`${base}?unit=${encodeURIComponent(item.unit)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Screen recording of build ${item.build}, observation ${item.observation}, Studio slot ${item.lane + 1}`}
                    >
                      Watch
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </section>
  );
}
