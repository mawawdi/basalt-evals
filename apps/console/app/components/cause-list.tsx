import { useId } from "react";
import Link from "next/link";
import {
  OUTCOME_CAUSE_ORDER,
  type CauseUnits,
} from "../../../../dist/packages/contracts/src/failure.js";
import { causeLabel, causeUnitsText } from "./result-display";
import s from "./workbench.module.css";

/**
 * Why work did not finish, by recorded cause. Causes outside the build come first, in the fixed
 * order. Each cause links to the builds that it stopped. A unit without a recorded cause shows
 * "No recorded cause": Basalt never guesses one.
 */
export function CauseList({
  causes,
  operationId,
  buildTitle,
}: {
  causes: CauseUnits[];
  /** The run of the builds. Each build links to its evidence in this run. */
  operationId: string;
  /** The title of a build, or null when the page has none. */
  buildTitle: (subjectId: string) => string | null;
}) {
  const heading = useId();
  if (!causes.length) return null;
  return (
    <section className={s.causes} aria-labelledby={heading}>
      <h3 id={heading}>Why work didn’t finish</h3>
      <ul className={s.causeList}>
        {causes.map(({ cause, units }) => {
          const builds = [
            ...new Set(units.flatMap((unit) => (unit.subjectId ? [unit.subjectId] : []))),
          ].flatMap((subjectId) => {
            const title = buildTitle(subjectId);
            return title
              ? [
                  {
                    subjectId,
                    title,
                    href: `/runs/${operationId}?tab=evidence&candidate=${encodeURIComponent(subjectId)}`,
                  },
                ]
              : [];
          });
          return (
            <li key={cause}>
              <span>
                <strong>{causeLabel(cause)}</strong> · {causeUnitsText(units)}
              </span>
              {builds.length > 0 && (
                <span>
                  {builds.map((item, index) => (
                    <span key={item.subjectId}>
                      {index > 0 && " · "}
                      <Link className={s.action} href={item.href}>
                        {item.title}
                      </Link>
                    </span>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className={s.small}>
        Causes outside the build, such as the model provider or Studio, come first. Work without a
        recorded cause says so.
      </p>
    </section>
  );
}

/** The causes of several benchmark rows as one list, in the fixed order. */
export function mergeCauses(rows: ReadonlyArray<{ causes: CauseUnits[] }>): CauseUnits[] {
  return OUTCOME_CAUSE_ORDER.flatMap((cause) => {
    const units = rows.flatMap((row) =>
      row.causes.filter((item) => item.cause === cause).flatMap((item) => item.units),
    );
    return units.length ? [{ cause, units }] : [];
  });
}
