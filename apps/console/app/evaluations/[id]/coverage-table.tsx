import type { CoverageNotesRecord } from "../../../../../dist/packages/operator/src/coverage-notes.js";
import type {
  CheckSupport,
  Coverage,
  PromptSupport,
} from "../../../../../dist/packages/eval-authoring/src/coverage-request.js";
import { ScrollRegion, Status } from "../../components/ui";
import { statementText } from "../../components/result-display";
import s from "../../components/workbench.module.css";

const coverageLabels: Record<Coverage, string> = {
  matches: "Matches",
  partial: "Partly tested",
  stricter: "Stricter",
  untested: "Not tested",
};
const promptLabels: Record<PromptSupport, string> = {
  stated: "Stated",
  implied: "Implied",
  unstated: "Not stated",
};
const supportLabels: Record<CheckSupport, string> = {
  supports: "Supports",
  orphan: "No criterion",
  unstated_in_public_contract: "Not asked in the prompt",
};

/**
 * The notes that a person should read: a criterion that the tests do not check as written, that
 * the prompt does not state or that mixes evidence classes, and a private check without plain
 * support. Each criterion and each check counts one time across the coverage models.
 */
export function coverageGapCount(records: CoverageNotesRecord[]): number {
  const criteria = new Set(
    records.flatMap((record) =>
      record.criteria
        .filter(
          (item) =>
            item.coverage !== "matches" || item.promptSupport === "unstated" || item.mixesClasses,
        )
        .map((item) => item.criterionId),
    ),
  );
  const checks = new Set(
    records.flatMap((record) =>
      record.checks.filter((item) => item.support !== "supports").map((item) => item.checkId),
    ),
  );
  return criteria.size + checks.size;
}

/** The coverage notes of each coverage model, with one table for criteria and one for checks. */
export function CoverageTable({
  id = "coverage-notes",
  records,
  criteria,
  checks,
  modelNames,
}: {
  /** The element ID. Each stage of a staged evaluation has its own table. */
  id?: string;
  records: CoverageNotesRecord[];
  /** The authored criteria, in the authored sequence. */
  criteria: Array<{ id: string; text: string }>;
  /** The private checks of the prepared tests. */
  checks: Array<{ id: string; statement: string }>;
  modelNames: Record<string, string>;
}) {
  const gaps = coverageGapCount(records);
  const criterionText = (id: string) =>
    statementText(criteria.find((item) => item.id === id)?.text ?? id);
  return (
    <details id={id} className={s.section} open={gaps > 0}>
      <summary>
        Coverage notes{" "}
        {gaps > 0 ? (
          <Status tone="warning">{gaps === 1 ? "1 note to read" : `${gaps} notes to read`}</Status>
        ) : records.every((record) => record.state === "complete") ? (
          <Status tone="good">Nothing to read</Status>
        ) : null}
      </summary>
      <p className={s.small}>
        A second model compared the prompt, the criteria and the prepared tests in both directions.
        Its notes can be wrong, and they don’t change the tests or the answers. If a note is
        correct, edit the prompt or the criteria and run the benchmark again.
      </p>
      {records.map((record) => (
        <div key={record.model.identityHash} className={s.section}>
          <p className={s.small}>
            Coverage model: {modelNames[record.model.id] ?? record.model.id}
          </p>
          {record.state === "incomplete" && (
            <p className={s.small}>
              The coverage model didn’t finish all of its notes. Reason: {record.reason}
            </p>
          )}
          {record.criteria.length > 0 && (
            <ScrollRegion className={s.tableWrap} label="Coverage of each criterion">
              <table className={s.stackTable}>
                <thead>
                  <tr>
                    <th scope="col">Criterion as written</th>
                    <th scope="col">Coverage</th>
                    <th scope="col">In prompt</th>
                    <th scope="col">Mixes evidence classes</th>
                    <th scope="col">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {record.criteria.map((item) => (
                    <tr key={item.criterionId}>
                      <th scope="row">{criterionText(item.criterionId)}</th>
                      <td data-label="Coverage">
                        <Status tone={item.coverage === "matches" ? "good" : "warning"}>
                          {coverageLabels[item.coverage]}
                        </Status>
                      </td>
                      <td data-label="In prompt">
                        <Status tone={item.promptSupport === "unstated" ? "warning" : "good"}>
                          {promptLabels[item.promptSupport]}
                        </Status>
                      </td>
                      <td data-label="Mixes evidence classes">
                        <Status tone={item.mixesClasses ? "warning" : "good"}>
                          {item.mixesClasses ? "Yes" : "No"}
                        </Status>
                      </td>
                      <td data-label="Note">{item.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          )}
          {record.checks.length > 0 && (
            <div className={s.section}>
              <div className={s.sectionHeading}>
                <h3>Private checks</h3>
              </div>
              <ScrollRegion className={s.tableWrap} label="Private checks">
                <table className={s.stackTable}>
                  <thead>
                    <tr>
                      <th scope="col">Private check</th>
                      <th scope="col">Support</th>
                      <th scope="col">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {record.checks.map((item) => (
                      <tr key={item.checkId}>
                        <th scope="row">
                          {statementText(
                            checks.find((check) => check.id === item.checkId)?.statement ??
                              item.checkId,
                          )}
                        </th>
                        <td data-label="Support">
                          <Status tone={item.support === "supports" ? "good" : "warning"}>
                            {supportLabels[item.support]}
                          </Status>
                          {item.criterionIds.length > 0 && (
                            <span className={s.tableMeta}>
                              {item.criterionIds.length === 1 ? "Criterion" : "Criteria"}:{" "}
                              {item.criterionIds.map(criterionText).join("; ")}
                            </span>
                          )}
                        </td>
                        <td data-label="Note">{item.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollRegion>
            </div>
          )}
        </div>
      ))}
    </details>
  );
}
