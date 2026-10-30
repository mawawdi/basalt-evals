"use client";
import Link from "next/link";
import { PageHeading } from "./components/ui";
import s from "./components/workbench.module.css";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main>
      <PageHeading
        title="Basalt could not load this view"
        description="No data was lost. Your evaluations, runs and results are still saved on this Mac. Try again, or find the run in Records."
      />
      <div className={s.row}>
        <button className={s.primary} onClick={reset}>
          Try again
        </button>
        <Link className={s.secondary} href="/?view=activity">
          Open Records
        </Link>
      </div>
    </main>
  );
}
