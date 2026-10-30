import Link from "next/link";
import type { Page, RunSummary } from "../../../../dist/packages/contracts/src/catalog.js";
import { Status } from "./ui";
import { formatMoney } from "./api";
import { modelList, phaseLabel, problemSummary } from "./result-display";
import s from "./workbench.module.css";

// Work that is still running belongs at the top of the desk: it is where you return.
export function ActiveRuns({
  runs,
  modelNames,
}: {
  runs: Page<RunSummary>;
  modelNames: Record<string, string>;
}) {
  if (!runs.items.length) return null;
  return (
    <section className={s.liveRuns} aria-labelledby="running-now">
      <div className={s.sectionHeading}>
        <h2 id="running-now">Running now</h2>
        {runs.total > runs.items.length && (
          <Link className={s.action} href="/?view=activity&status=active">
            See all {runs.total} active runs
          </Link>
        )}
      </div>
      <ul>
        {runs.items.map((run) => (
          <li key={run.id}>
            <Link href={`/runs/${run.id}?tab=progress`} className={s.liveRun}>
              <span className={s.liveTitle}>{run.title}</span>
              <span className={s.livePhase}>
                {run.blocker ? problemSummary(run.blocker) : phaseLabel(run.phase)}
              </span>
              <span className={s.liveMeta}>
                {modelList(run.models, modelNames)}
                <span className={s.numeric}>
                  {formatMoney(run.billedUsd ?? 0)} charged
                  {run.reservedUsd ? `, ${formatMoney(run.reservedUsd)} pending` : ""}
                </span>
              </span>
            </Link>
            <Status tone={run.state === "attention" ? "warning" : "active"}>{run.state}</Status>
          </li>
        ))}
      </ul>
    </section>
  );
}
