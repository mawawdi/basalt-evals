import type { ExperimentAnalysisView } from "../../../../dist/packages/contracts/src/experiment-report.js";
import { formatMoney } from "./api";
import { stageLabel, statementText } from "./result-display";
import { ProblemText, ScrollRegion, Status } from "./ui";
import s from "./workbench.module.css";
export type Analysis = ExperimentAnalysisView;
const PRESENTATION_LABELS = {
  still: "Still images",
  sequence: "Recorded sequence",
  "grounded-sequence": "Sequence notes",
} as const;
const ANCHOR_BUILD_PAIRS = "Anchor build pairs";
export function AnalysisView({ value }: { value: Analysis }) {
  const data = value.analysis;
  const anchors = "exemplarComparison" in data ? data.exemplarComparison : null;
  const plannedWork =
    data.units.builder.intended + data.units.capture.intended + data.units.judgment.intended;
  const stages = { builder: "Builds", capture: "Studio observations", judgment: "Judge checks" };
  const stageName = (stage: string | null) => (stage ? stageLabel(stage) : "Run");
  const percentage = (value: number) => `${(value * 100).toFixed(1)}%`;
  // A criterion reads as its authored statement, or as "Criterion n" in the authored order.
  const criterionName = (evalId: string, criterionId: string) => {
    const criterion = value.criteria.find(
      (item) => item.evalId === evalId && item.criterionId === criterionId,
    );
    if (!criterion) return "Unnamed criterion";
    return statementText(criterion.statement) || `Criterion ${criterion.number}`;
  };
  return (
    <div className={`${s.stack} ${s.section}`}>
      <div className={s.row}>
        <Status tone={!plannedWork ? "neutral" : value.executionComplete ? "good" : "warning"}>
          {!plannedWork
            ? "No automated work planned"
            : value.executionComplete
              ? "Planned work complete"
              : "Planned work incomplete"}
        </Status>
        <Status
          tone={
            !data.units.capture.intended ? "neutral" : value.evidenceComplete ? "good" : "warning"
          }
        >
          {!data.units.capture.intended
            ? "No Studio observations planned"
            : value.evidenceComplete
              ? "Studio observations complete"
              : "Studio observations incomplete"}
        </Status>
        <Status
          tone={
            !data.units.review.intendedPasses
              ? "neutral"
              : data.claimStatus === "reviewed"
                ? "good"
                : "warning"
          }
        >
          {!data.units.review.intendedPasses
            ? "No human review planned"
            : data.claimStatus === "reviewed"
              ? "Research claims reviewed"
              : "Research claims incomplete"}
        </Status>
      </div>
      <p className={s.small}>
        Complete means the planned work was recorded. It doesn’t mean that every build passed or
        that the study proves a general claim.
      </p>
      <dl className={s.stats}>
        <div className={`${s.stat} ${s.statCost}`}>
          <dt>Confirmed charges</dt>
          <dd>{formatMoney(value.spending.billedUsd)}</dd>
        </div>
        <div className={`${s.stat} ${s.statCost}`}>
          <dt>Pending charges</dt>
          <dd>{formatMoney(value.spending.retainedLiabilityUsd)}</dd>
        </div>
        <div className={s.stat}>
          <dt>Observations reviewed</dt>
          <dd>
            {data.units.review.intendedPasses
              ? `${data.units.review.reviewedPasses} of ${data.units.review.intendedPasses}`
              : "None planned"}
          </dd>
        </div>
        <div className={`${s.stat} ${s.statTime}`}>
          <dt>Active review time</dt>
          <dd>{(value.activeReviewMs / 60000).toFixed(1)} min</dd>
        </div>
      </dl>
      {value.spending.unresolvedActions > 0 && (
        <p className={s.small}>
          {value.spending.unresolvedActions} paid{" "}
          {value.spending.unresolvedActions === 1 ? "action has" : "actions have"} unconfirmed
          costs, so the confirmed total isn’t final.
        </p>
      )}
      {!value.spending.recordedActions && (
        <p className={s.small}>This report has no record of paid actions.</p>
      )}
      <ScrollRegion className={s.tableWrap} label="Run workload">
        <table>
          <thead>
            <tr>
              <th scope="col">Work</th>
              <th scope="col">Planned</th>
              <th scope="col">Completed</th>
              <th scope="col">Failed or incomplete</th>
              <th scope="col">Not started</th>
            </tr>
          </thead>
          <tbody>
            {(["builder", "capture", "judgment"] as const).map((stage) => (
              <tr key={stage}>
                <th scope="row">{stages[stage]}</th>
                <td>{data.units[stage].intended || "None planned"}</td>
                <td>{data.units[stage].intended ? data.units[stage].completed : "—"}</td>
                <td>{data.units[stage].intended ? data.units[stage].failed : "—"}</td>
                <td>{data.units[stage].intended ? data.units[stage].unattempted : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      {"treatments" in data && data.treatments && (
        <section className={s.smallStack}>
          <h3>Agreement with human review</h3>
          <p className={s.small}>
            Each row counts builds, not observations. A build gets an automatic result only when
            every planned observation agrees. A person reviews all other builds.
          </p>
          <ScrollRegion className={s.tableWrap} label="Agreement by evidence presentation">
            <table>
              <thead>
                <tr>
                  <th scope="col">Evidence presentation</th>
                  <th scope="col">Test set</th>
                  <th scope="col">Judged</th>
                  <th scope="col">Failures accepted</th>
                  <th scope="col">Sent to review</th>
                  <th scope="col">Miss rate bound</th>
                </tr>
              </thead>
              <tbody>
                {data.treatments.map((treatment) => (
                  <tr key={`${treatment.presentation}:${treatment.partition}`}>
                    <th scope="row">{PRESENTATION_LABELS[treatment.presentation]}</th>
                    <td>{treatment.partition === "development" ? "Development" : "Withheld"}</td>
                    <td>
                      {treatment.completed} of {treatment.intended}
                    </td>
                    <td>
                      {treatment.missRate.denominator
                        ? `${treatment.missRate.numerator} of ${treatment.missRate.denominator}`
                        : "No failing builds yet"}
                    </td>
                    <td>
                      {treatment.escalationShare.numerator} of{" "}
                      {treatment.escalationShare.denominator}
                    </td>
                    <td>{percentage(treatment.missRateBound.upperBound)}</td>
                  </tr>
                ))}
                {anchors?.partitions.map((row) => (
                  <tr key={`anchor-builds:${row.partition}`}>
                    <th scope="row">{ANCHOR_BUILD_PAIRS}</th>
                    <td>{row.partition === "development" ? "Development" : "Withheld"}</td>
                    <td>
                      {row.answeredCalls} of {row.intendedCalls}
                    </td>
                    <td>
                      {row.missRate.denominator
                        ? `${row.missRate.numerator} of ${row.missRate.denominator}`
                        : "No failing builds yet"}
                    </td>
                    <td>
                      {row.escalationShare.numerator} of {row.escalationShare.denominator}
                    </td>
                    <td>{percentage(row.missRateBound.upperBound)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
          <p className={s.small}>
            The miss rate is the share of failing builds that were accepted automatically. The bound
            is an exact one-sided 95% bound, and an unclear answer counts as a miss.
          </p>
          {anchors && (
            <p className={s.small}>
              Rows for anchor build pairs count only the criteria with anchor builds. Their Judged
              column counts answers, one for each order of each anchor build.
            </p>
          )}
        </section>
      )}
      {anchors && (
        <section className={s.smallStack}>
          <h3>Automatic decisions within the miss rate limit</h3>
          <p className={s.small}>
            Each row uses the criteria with anchor builds and the withheld builds. A judge decides
            builds automatically only if its miss rate is at most {percentage(anchors.maxMissRate)}{" "}
            at 95% confidence. Otherwise, a person reviews each build.
          </p>
          <ScrollRegion
            className={s.tableWrap}
            label="Automatic decisions within the miss rate limit"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Evidence presentation</th>
                  <th scope="col">Decided automatically</th>
                  <th scope="col">Within limit</th>
                </tr>
              </thead>
              <tbody>
                {anchors.boundedAutoDecision.map((row) => (
                  <tr key={row.stream}>
                    <th scope="row">
                      {row.stream === "exemplar_comparison"
                        ? ANCHOR_BUILD_PAIRS
                        : PRESENTATION_LABELS[row.stream]}
                    </th>
                    <td>
                      {row.autoDecided.numerator} of {row.autoDecided.denominator}
                    </td>
                    <td>{row.certification.certifiedRuleId === null ? "No" : "Yes"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
          <details>
            <summary>Order changes by criterion</summary>
            <p className={s.small}>
              An order change is when the judge prefers a different build after the two builds swap
              places. These pairs go to a person.
            </p>
            <ScrollRegion className={s.tableWrap} label="Order changes by criterion">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Criterion</th>
                    <th scope="col">Test set</th>
                    <th scope="col">Order changes</th>
                    <th scope="col">Not enough evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {anchors.partitions.flatMap((row) =>
                    row.positionFlips.map((item) => (
                      <tr key={`${row.partition}:${item.taskId}:${item.criterionId}`}>
                        <th scope="row">{criterionName(item.taskId, item.criterionId)}</th>
                        <td>{row.partition === "development" ? "Development" : "Withheld"}</td>
                        <td>
                          {item.flips.numerator} of {item.flips.denominator}
                        </td>
                        <td>{item.insufficientPairs}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </ScrollRegion>
          </details>
        </section>
      )}
      {"comparison" in data && data.comparison && (
        <section className={s.smallStack}>
          <h3>Builder comparison by evaluation and model</h3>
          <p>
            {data.comparison.signTest.treatmentBetter} of {data.comparison.blocks.length} evaluation
            and model blocks favor Studio tools. {data.comparison.signTest.baselineBetter} favor
            Local tools, {data.comparison.signTest.ties} are equal and{" "}
            {data.comparison.signTest.unresolved} are unresolved.
          </p>
          <p className={s.small}>
            Studio tools minus Local tools:{" "}
            {data.comparison.meanDifference.observed === null
              ? "no complete difference is available"
              : `${(data.comparison.meanDifference.observed * 100).toFixed(1)} percentage points`}
            . With unresolved builds included, the mean difference is between{" "}
            {(data.comparison.meanDifference.lower * 100).toFixed(1)} and{" "}
            {(data.comparison.meanDifference.upper * 100).toFixed(1)} percentage points.
          </p>
          <p className={s.small}>
            Exact one-sided sign test for Studio tools: p ={" "}
            {data.comparison.signTest.treatmentBetterP.toFixed(3)}. Unresolved blocks count against
            Studio tools. The same repetition number does not make two builds a pair.
          </p>
        </section>
      )}
      {data.blindingIssues.length > 0 && (
        <p className={s.small}>
          {data.blindingIssues.length}{" "}
          {data.blindingIssues.length === 1 ? "review has" : "reviews have"} a recorded blinding
          issue and can’t establish acceptance.
        </p>
      )}
      <details>
        <summary>Time for each step</summary>
        {!value.times.length ? (
          <p className={s.small}>No step times were recorded.</p>
        ) : (
          <ScrollRegion className={s.tableWrap} label="Step times">
            <table>
              <thead>
                <tr>
                  <th scope="col">Step</th>
                  <th scope="col">Elapsed</th>
                </tr>
              </thead>
              <tbody>
                {value.times.map((time, i) => (
                  <tr key={i}>
                    <th scope="row">{stageName(time.stage)}</th>
                    <td>
                      {time.elapsedMs === null
                        ? "No end time recorded"
                        : `${(time.elapsedMs / 1000).toFixed(1)} s`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </details>
      {value.failures.length > 0 && (
        <details>
          <summary>Recorded interruptions ({value.failures.length})</summary>
          <ul>
            {value.failures.map((failure) => (
              <li key={failure.receipt}>
                <strong>{stageName(failure.stage)}:</strong>{" "}
                {failure.reason ? (
                  <ProblemText text={failure.reason} />
                ) : (
                  "There is no recorded explanation."
                )}
              </li>
            ))}
          </ul>
          <p className={s.small}>
            These are past events. For the current recovery actions, open the Progress view of the
            run.
          </p>
        </details>
      )}
      <details>
        <summary>Analysis details, uncertainty, and source identities</summary>
        <pre className={s.code}>{JSON.stringify(data, null, 2)}</pre>
        <p className={s.small}>Analysis identity: {value.id}</p>
      </details>
    </div>
  );
}
