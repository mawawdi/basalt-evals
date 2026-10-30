import Link from "next/link";
import type { FailureExplanationRecord } from "../../../../../dist/packages/operator/src/failure-explanation.js";
import { Status } from "../../components/ui";
import { statementText } from "../../components/result-display";
import s from "../../components/workbench.module.css";

/** The short name of each authored question. The full question is in its row. */
const questionNames: Record<string, string> = {
  prompt_gap: "Missing from the prompt",
  observation_gap: "Not observed by the plan",
  gaming: "Passes without the behavior",
  infrastructure: "Caused by Studio",
};
const values: Record<string, { label: string; tone: "warning" | "good" | "neutral" }> = {
  yes: { label: "Yes", tone: "warning" },
  no: { label: "No", tone: "good" },
  unclear: { label: "Unclear", tone: "neutral" },
};

/**
 * The hypotheses of each explanation, newest run last. A hypothesis is a model's guess about a
 * plan warning. It never changes an answer, a review or a total.
 */
export function FailureHypotheses({
  records,
  modelNames,
}: {
  records: FailureExplanationRecord[];
  modelNames: Record<string, string>;
}) {
  if (!records.length) return null;
  return (
    <section className={s.section} id="failure-hypotheses" aria-label="Hypotheses">
      <h3>Hypotheses</h3>
      <p className={s.small}>
        These are a model’s guesses about why a check may not tell builds apart. Read the evidence
        before you edit the prompt or the criteria. They don’t change any answer.
      </p>
      {records.map((record) => (
        <div className={s.smallStack} key={record.operationId}>
          <p className={s.small}>
            {modelNames[record.model.id] ?? record.model.id} ·{" "}
            <Link className={s.action} href={`/runs/${record.operationId}`}>
              Open run
            </Link>{" "}
            {record.state === "incomplete" && <Status>Incomplete</Status>}
          </p>
          {record.questions.status === "draft" && (
            <p className={s.small}>
              The questions are still a draft that a person hasn’t approved. A person can approve
              them in <code>studies/failure-questions.md</code>.
            </p>
          )}
          {record.criteria.map((criterion) => (
            <div key={criterion.criterionId}>
              <h4 className={s.hypothesisCriterion}>{statementText(criterion.statement)}</h4>
              <ul
                className={s.hypotheses}
                aria-label={`Hypotheses for ${statementText(criterion.statement)}`}
              >
                {record.hypotheses
                  .filter((item) => item.criterionId === criterion.criterionId)
                  .map((item) => (
                    <li key={item.questionId}>
                      <div className={s.hypothesisHead}>
                        <strong>{questionNames[item.questionId] ?? item.questionId}</strong>
                        {item.state === "complete" && item.value ? (
                          <Status tone={values[item.value]!.tone}>
                            {values[item.value]!.label}
                          </Status>
                        ) : (
                          <Status>Incomplete</Status>
                        )}
                      </div>
                      {item.state !== "complete" && item.reason && (
                        <p className={s.small}>{item.reason}</p>
                      )}
                      <dl className={s.hypothesisFacts}>
                        <div>
                          <dt>Evidence for</dt>
                          <dd>{item.evidenceFor || "None given"}</dd>
                        </div>
                        <div>
                          <dt>Evidence against</dt>
                          <dd>{item.evidenceAgainst || "None given"}</dd>
                        </div>
                        <div>
                          <dt>Observations</dt>
                          <dd>
                            {item.observationIds.length
                              ? item.observationIds.map((id, index) => {
                                  const source = record.sources.find(
                                    (row) =>
                                      row.criterionId === criterion.criterionId &&
                                      row.observationId === id,
                                  );
                                  return (
                                    <span key={id}>
                                      {index > 0 && ", "}
                                      {source?.operationId ? (
                                        <Link
                                          className={s.action}
                                          href={`/runs/${source.operationId}?tab=evidence&candidate=${source.subjectId}&criterion=${encodeURIComponent(source.evidenceCellId ?? "")}&pass=${source.pass}`}
                                        >
                                          Build {source.buildNumber}, observation {source.pass}
                                        </Link>
                                      ) : source ? (
                                        "Empty build"
                                      ) : (
                                        id
                                      )}
                                    </span>
                                  );
                                })
                              : "None"}
                          </dd>
                        </div>
                      </dl>
                      <details>
                        <summary>Full question</summary>
                        <p className={s.questionText}>
                          {record.questions.items.find(
                            (question) => question.id === item.questionId,
                          )?.text ?? ""}
                        </p>
                      </details>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
