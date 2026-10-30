export const metadata = { title: "Review report · Basalt" };
import Link from "next/link";
import { reviewAuditReport } from "../../../lib/server";
import { reviewerProfile } from "../../../lib/server";
import { repositoryRoot } from "../../../lib/data";
import { ScrollRegion, PageHeading, Notice, Status } from "../../components/ui";
import { ExpertActions } from "./expert-actions";
import type {
  AuditShare,
  ExpertAnswerView,
  RaterAgreement,
  ReviewVerdict,
} from "../../../../../dist/packages/contracts/src/review.js";
import { reasonLabels } from "../../components/review-reasons";
import s from "../../components/workbench.module.css";
import r from "../../components/review-experience.module.css";
import { checkerLabel, statementText } from "../../components/result-display";
export const dynamic = "force-dynamic";
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const shareText = (value: AuditShare | null) =>
  !value
    ? "Not calculated"
    : value.denominator
      ? `${value.numerator} / ${value.denominator}`
      : "No answers yet";
const rangeText = (value: AuditShare | null) =>
  value?.interval
    ? `${percent(value.interval.lower)}–${percent(value.interval.upper)}`
    : "Not calculated";
const answerView = (answer: ExpertAnswerView | null) =>
  !answer?.decision
    ? "No answer"
    : `${
        answer.decision.kind === "abstain"
          ? "Cannot tell"
          : answer.decision.kind === "score"
            ? `Score ${answer.decision.value}`
            : answer.decision.value === "satisfied"
              ? "Met"
              : "Not met"
      }${answer.reason ? ` — ${reasonLabels[answer.reason.code]}: ${answer.reason.sentence}` : ""}${
        answer.flagged ? " (flagged)" : ""
      }`;
const judgeView = (verdict: ReviewVerdict | null, score: number | null) =>
  verdict === "satisfied"
    ? "Met"
    : verdict === "violated"
      ? "Not met"
      : verdict === "insufficient"
        ? "Not enough evidence"
        : verdict === "scored"
          ? `Score ${score}`
          : "No answer";
const pairLabel: Record<RaterAgreement["pair"], string> = {
  judge_first: "Judge and first reviewer",
  judge_second: "Judge and second reviewer",
  first_second: "First and second reviewer",
};
const statusLabel = {
  awaiting_round_two: "Round 2 not started",
  round_two_open: "Round 2 open",
  resolved: "Agreed in round 2",
  contested: "Contested",
} as const;
const gateLabel = {
  met: "Met",
  not_met: "Not met",
  unresolved: "Unclear",
  needs_second_reviewer: "Needs a second reviewer",
  not_applicable: "Not applicable",
} as const;
const exclusionLabel = {
  missing_outcome: "No definite answer",
  unavailable_evidence: "Evidence not available",
  withheld: "Withheld evidence",
  diagnostic_control: "Answer under a control",
  training: "Used in a training review",
  labelling: "Used in a review that counts",
} as const;
export default async function AuditReportPage({ params }: { params: Promise<{ id: string }> }) {
  const report = await reviewAuditReport(repositoryRoot(), (await params).id),
    progress = report.progress;
  const reviewer = await reviewerProfile(repositoryRoot(), progress.reviewer);
  const experts = report.experts;
  const [firstReviewer, secondReviewer] = experts
    ? await Promise.all([
        reviewerProfile(repositoryRoot(), experts.first.reviewer),
        reviewerProfile(repositoryRoot(), experts.second.reviewer),
      ])
    : [null, null];
  const counted = report.purpose !== "training" && progress.expert?.round !== 2;
  const scoreScales = report.reliability.filter((group) => group.kind !== "categorical");
  return (
    <main>
      <PageHeading
        title={
          report.purpose === "training"
            ? "Training review report"
            : progress.expert?.round === 2
              ? "Round 2 report"
              : report.purpose === "audit"
                ? "Random review report"
                : report.purpose === "diagnostic"
                  ? "Targeted review results"
                  : "Research review report"
        }
        description={
          report.purpose === "training"
            ? "A training review uses separate questions. Its answers do not count in any agreement."
            : report.purpose === "audit"
              ? "How often did reviewers agree with the automatic results in this sample? Unanswered and flagged questions stay uncertain."
              : "What did reviewers find in these selected questions? These findings describe this sample."
        }
        action={
          progress.state === "active" && (
            <Link prefetch={false} className={s.primary} href={`/reviews/${report.batchId}`}>
              Continue review
            </Link>
          )
        }
      />
      <div className={r.summary}>
        <Status>{progress.state === "completed" ? "Completed" : "Ready to continue"}</Status>
        <p>
          Reviewer: <strong>{reviewer.displayName}</strong>. Answers are saved under this reviewer.
        </p>
        <p>
          {progress.remaining} assigned{" "}
          {progress.remaining === 1 ? "question remains" : "questions remain"}.
        </p>
      </div>
      {report.purpose === "audit" && counted && (
        <section className={s.auditAnswer} aria-labelledby="audit-answer">
          <h2 id="audit-answer">Agreement with automatic results</h2>
          <p className={s.auditFigure}>
            {report.acceptance.agreement.denominator
              ? `${report.acceptance.agreement.numerator} of ${report.acceptance.agreement.denominator}`
              : "Not calculated yet"}
          </p>
          <p>
            {report.acceptance.agreement.denominator
              ? "answers agree with the automatic result"
              : "No answers to compare yet"}
            {report.acceptance.agreement.interval &&
              `; likely range ${percent(report.acceptance.agreement.interval.lower)}–${percent(report.acceptance.agreement.interval.upper)}`}
            .
            {report.acceptance.agreement.unresolved > 0 &&
              ` ${report.acceptance.agreement.unresolved} unclear ${report.acceptance.agreement.unresolved === 1 ? "answer widens" : "answers widen"} the range and ${report.acceptance.agreement.unresolved === 1 ? "doesn’t" : "don’t"} count as agreement.`}
          </p>
        </section>
      )}
      <dl className={s.stats}>
        <div className={s.stat}>
          <dt>Saved answers</dt>
          <dd>
            {progress.assigned ? `${progress.answered} / ${progress.assigned}` : "No assignments"}
          </dd>
        </div>
        <div className={s.stat}>
          <dt>Cannot tell</dt>
          <dd>{progress.abstained}</dd>
        </div>
        <div className={s.stat}>
          <dt>Answers reused</dt>
          <dd>{progress.reused}</dd>
        </div>
        <div className={s.stat}>
          <dt>Repeats</dt>
          <dd>{progress.repeats}</dd>
        </div>
        <div className={s.stat}>
          <dt>Sessions</dt>
          <dd>{progress.session?.number ?? 0}</dd>
        </div>
        <div className={`${s.stat} ${s.statTime}`}>
          <dt>Active review time</dt>
          <dd>{(progress.activeMs / 60000).toFixed(1)} min</dd>
        </div>
      </dl>
      <p className={s.small}>
        Saved answers include Cannot tell, repeats and answers reused from this reviewer, so not
        every saved answer is a new, definite answer. Only the first answer to each question counts
        toward agreement.
      </p>
      <Notice kind="info">
        {report.purpose === "audit" && counted
          ? "These numbers describe only the answers in this sample, and unclear answers show up as uncertainty in the range. They don’t predict future runs, and they don’t measure the reliability of a game mechanic or the calibration of the judge."
          : report.purpose === "diagnostic" && counted
            ? "These findings describe only the selected questions. They do not measure the overall accuracy or calibration of the judge."
            : report.claim}
      </Notice>
      {report.gate.state !== "not_applicable" && (
        <section className={s.section} aria-labelledby="acceptance-gate">
          <h2 id="acceptance-gate">Acceptance gate: {gateLabel[report.gate.state]}</h2>
          <p>
            The gate uses build acceptance agreement: whether the judge and a reviewer both accept
            or both reject the same build. The judge needs at least {percent(report.gate.minimum)}{" "}
            agreement with each reviewer, and that agreement can be at most{" "}
            {Math.round(report.gate.maximumShortfall * 100)} percentage points below the agreement
            between the two reviewers. The gate compares the observed figures, so always quote the
            exact lower bound with them.
          </p>
          <ScrollRegion className={s.tableWrap} label="Acceptance gate figures">
            <table className={`${s.resultTable} ${s.stackTable}`}>
              <thead>
                <tr>
                  <th scope="col">Pair</th>
                  <th scope="col">Agreed / compared</th>
                  <th scope="col">Unclear</th>
                  <th scope="col">Exact lower bound</th>
                  <th scope="col">Likely range (95%)</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Judge and first reviewer", report.gate.judgeFirst],
                    ["Judge and second reviewer", report.gate.judgeSecond],
                    ["First and second reviewer", report.gate.experts],
                  ] as const
                ).map(([label, value]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    <td data-label="Agreed / compared">{shareText(value)}</td>
                    <td data-label="Unclear">{value?.unresolved ?? "Not calculated"}</td>
                    <td data-label="Exact lower bound">
                      {value?.interval ? percent(value.interval.lower) : "Not calculated"}
                    </td>
                    <td data-label="Likely range">{rangeText(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
          <p className={`${s.small} ${s.tableNote}`}>
            {report.gate.shortfall === null
              ? "The gate needs two reviewers and a clear result for each compared build."
              : report.gate.shortfall > 0
                ? `The judge is ${(report.gate.shortfall * 100).toFixed(1)} percentage points below the two reviewers.`
                : "The judge is not below the two reviewers."}{" "}
            If one side of a pair has no clear result for a build, the build stays unclear. The
            range covers all possible results for unclear builds.
          </p>
        </section>
      )}
      {report.repeats.pairs.length > 0 && (
        <section className={s.section} aria-labelledby="repeat-agreement">
          <h2 id="repeat-agreement">Repeats</h2>
          <p>
            Some questions came back later in the same review. The reviewer gave the same answer to{" "}
            {shareText(report.repeats.agreement)} repeats. Unclear repeats:{" "}
            {report.repeats.agreement.unresolved}. Likely range:{" "}
            {rangeText(report.repeats.agreement)}.
          </p>
          <p className={s.small}>
            This is the reviewer’s agreement with themselves, and it never counts toward judge
            agreement.
          </p>
        </section>
      )}
      {experts && (
        <section className={s.section} aria-labelledby="expert-agreement">
          <h2 id="expert-agreement">Two reviewers</h2>
          <p>
            {firstReviewer!.displayName} and {secondReviewer!.displayName} answered the same{" "}
            {experts.items} questions without seeing each other’s answers. {experts.unanswered}{" "}
            questions don’t have answers from both reviewers yet.
          </p>
          <ScrollRegion className={s.tableWrap} label="Agreement on the same questions">
            <table className={`${s.resultTable} ${s.stackTable}`}>
              <thead>
                <tr>
                  <th scope="col">Pair</th>
                  <th scope="col">Criterion agreement</th>
                  <th scope="col">Likely range (95%)</th>
                  <th scope="col">Alpha</th>
                  <th scope="col">Build agreement</th>
                </tr>
              </thead>
              <tbody>
                {experts.agreements.map((item) => (
                  <tr key={item.pair}>
                    <th scope="row">{pairLabel[item.pair]}</th>
                    <td data-label="Criterion agreement">
                      {item.acceptance.denominator
                        ? `${item.acceptance.numerator} / ${item.acceptance.denominator}`
                        : "No answers yet"}
                      {item.acceptance.unresolved > 0 && ` · ${item.acceptance.unresolved} unclear`}
                    </td>
                    <td data-label="Likely range">
                      {item.acceptance.interval
                        ? `${percent(item.acceptance.interval.lower)}–${percent(item.acceptance.interval.upper)}`
                        : "Not calculated"}
                    </td>
                    <td data-label="Alpha">
                      {item.acceptanceAlpha === null
                        ? "Not calculated"
                        : item.acceptanceAlpha.toFixed(2)}
                    </td>
                    <td data-label="Build agreement">
                      {shareText(item.candidateAcceptance)} · lower bound{" "}
                      {item.candidateAcceptance.interval
                        ? percent(item.candidateAcceptance.interval.lower)
                        : "not calculated"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
          <h3>Judge agreement where the reviewers agreed or disagreed</h3>
          <ScrollRegion className={s.tableWrap} label="Judge agreement by reviewer agreement">
            <table className={`${s.resultTable} ${s.stackTable}`}>
              <thead>
                <tr>
                  <th scope="col">Reviewers in round 1</th>
                  <th scope="col">Questions</th>
                  <th scope="col">Judge and first reviewer</th>
                  <th scope="col">Judge and second reviewer</th>
                </tr>
              </thead>
              <tbody>
                {experts.strata.map((item) => (
                  <tr key={item.stratum}>
                    <th scope="row">{item.stratum === "agreed" ? "Agreed" : "Disagreed"}</th>
                    <td data-label="Questions">{item.units}</td>
                    <td data-label="Judge and first reviewer">
                      {shareText(item.judgeFirst)} · {rangeText(item.judgeFirst)}
                    </td>
                    <td data-label="Judge and second reviewer">
                      {shareText(item.judgeSecond)} · {rangeText(item.judgeSecond)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
          <p className={s.small}>{experts.claim}</p>
          <h3>Disagreements</h3>
          {!experts.disagreements.length && (
            <p className={s.small}>The two reviewers gave the same answer to each question.</p>
          )}
          <ul className={s.stack}>
            {experts.disagreements.map((item) => (
              <li key={item.unitId}>
                <p>
                  <strong>{statementText(item.statement)}</strong> · Observation {item.pass} ·{" "}
                  {statusLabel[item.status]}
                </p>
                <p className={s.small}>
                  {firstReviewer!.displayName}: {answerView(item.first)}
                </p>
                <p className={s.small}>
                  {secondReviewer!.displayName}: {answerView(item.second)}
                </p>
                {item.firstRoundTwo && (
                  <p className={s.small}>
                    Round 2, {firstReviewer!.displayName}: {answerView(item.firstRoundTwo)}
                  </p>
                )}
                {item.secondRoundTwo && (
                  <p className={s.small}>
                    Round 2, {secondReviewer!.displayName}: {answerView(item.secondRoundTwo)}
                  </p>
                )}
                <p className={s.small}>
                  Judge: {judgeView(item.automatic.verdict, item.automatic.score)} ·{" "}
                  <Link
                    className={s.action}
                    href={`/runs/${item.operationId}?tab=evidence&candidate=${item.candidateId}&criterion=${item.criterionId}&pass=${item.pass}`}
                  >
                    Open the evidence
                  </Link>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ExpertActions
        batchId={report.batchId}
        reviewer={reviewer}
        canAddSecond={progress.expert?.role === "first" && progress.expert.round === 1 && !experts}
        canStartRoundTwo={
          !!experts &&
          !experts.roundTwo &&
          experts.disagreements.length > 0 &&
          experts.first.answered === experts.first.assigned &&
          experts.second.answered === experts.second.assigned
        }
      />
      {counted && (
        <section className={s.section}>
          <h2>What was sampled</h2>
          <p>
            Basalt could sample {report.eligible} of the {report.plannedOutcomes} automatic results
            planned for the chosen judges. These runs planned {report.sourcePlannedOutcomes} results
            across all judges. Unavailable results still count in the totals. The sample leaves out
            answers under a control, training questions and judges you didn’t choose.
          </p>
          <p className={s.small}>
            {
              {
                uniform_without_replacement: "Basalt picked the questions at random.",
                targeted: "Basalt picked the questions from failed or unclear results.",
                registered_protocol: "The study plan picked the questions.",
                training: "Basalt picked training questions at random.",
              }[report.sampling]
            }{" "}
            {progress.assigned} questions; {progress.remaining} still unanswered. A session ends
            after {Math.round(progress.sessionLimits.activeMs / 60000)} active minutes or{" "}
            {progress.sessionLimits.questions} answers. These limits control the amount of work, not
            the accuracy.
          </p>
        </section>
      )}
      {counted && (
        <section className={s.section}>
          <h2>Judges</h2>
          {report.treatments.map((t) => (
            <article
              className={`${s.panel} ${s.panelBody}`}
              key={`${t.operationId}:${t.treatment?.id ?? "deterministic"}`}
            >
              <h3>{t.treatment ? checkerLabel(t.treatment) : "Code checks"}</h3>
              <p>
                {t.eligible} available for the sample · {t.plannedOutcomes} planned · {t.excluded}{" "}
                left out · {t.reused} answers reused
              </p>
              <p className={s.small}>
                {t.acceptance.agreement.denominator
                  ? `Agreed on ${t.acceptance.agreement.numerator} of ${t.acceptance.agreement.denominator} answered questions; `
                  : "No answered questions yet; "}
                {t.acceptance.agreement.unresolved} unclear.
                {t.acceptance.agreement.interval &&
                  ` Likely range: ${percent(t.acceptance.agreement.interval.lower)}–${percent(t.acceptance.agreement.interval.upper)}.`}
              </p>
              <Link className={s.action} href={`/runs/${t.operationId}?tab=results`}>
                Open the run
              </Link>
            </article>
          ))}
        </section>
      )}
      {counted && (
        <section className={s.section}>
          <h2>How often reviewers agreed</h2>
          <ScrollRegion className={s.tableWrap} label="Agreement figures">
            <table className={`${s.resultTable} ${s.stackTable}`}>
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  <th scope="col">Agreed / answered</th>
                  <th scope="col">Sampled / total</th>
                  <th scope="col">Unclear</th>
                  <th scope="col">Likely range (95%)</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Agreement", report.acceptance.agreement],
                    ["Wrongly passed", report.acceptance.falseAcceptanceShare],
                    ["Wrongly failed", report.acceptance.falseRejectionShare],
                  ] as const
                ).map(([label, value]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    <td data-label="Agreed / answered">
                      {value.denominator
                        ? `${value.numerator} / ${value.denominator}`
                        : "No answers yet"}
                    </td>
                    <td data-label="Sampled / total">
                      {value.population
                        ? `${value.selected} / ${value.population}`
                        : "Nothing to sample"}
                    </td>
                    <td data-label="Unclear">{value.unresolved}</td>
                    <td data-label="Likely range">
                      {value.interval
                        ? `${percent(value.interval.lower)}–${percent(value.interval.upper)}`
                        : "Not calculated"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
          <p className={`${s.small} ${s.tableNote}`}>
            Cannot tell, flagged and unanswered questions count as unclear. The likely range covers
            all possible answers to these questions. Extra observations of the same build do not
            count as extra builds.
          </p>
        </section>
      )}
      {counted && scoreScales.length > 0 && (
        <section className={s.section}>
          <h2>Scores by criterion</h2>
          {scoreScales.map((group) => {
            const scores = (kind: "human" | "automatic", flagged: boolean) =>
              report.ratings
                .filter(
                  (rating) =>
                    rating.scale === group.scale &&
                    rating.rater.kind === kind &&
                    rating.flagged === flagged &&
                    rating.score !== null,
                )
                .map((rating) => rating.score)
                .join(", ");
            return (
              <div className={s.panelBody} key={group.scale}>
                <h3>{statementText(group.statement)}</h3>
                <p>Reviewer scores: {scores("human", false) || "None available"}</p>
                <p>
                  Flagged scores: {scores("human", true) || "None"}. {group.flagged} flagged ·{" "}
                  {group.unanswered} unanswered · {group.abstained} cannot tell.
                </p>
                <p>Automatic scores: {scores("automatic", false) || "None available"}</p>
                <details>
                  <summary>Scale and pass mark as written</summary>
                  <pre className={s.code}>{JSON.stringify(JSON.parse(group.scale), null, 2)}</pre>
                </details>
              </div>
            );
          })}
        </section>
      )}
      <details className={s.section}>
        <summary>What was left out</summary>
        <p className={s.small}>
          Sample ID: <code>{report.populationId}</code>
        </p>
        <ul>
          {report.exclusions.map((item, index) => (
            <li key={`${item.operationId}:${item.unitId}:${index}`}>
              <Link className={s.action} href={`/runs/${item.operationId}?tab=results`}>
                {exclusionLabel[item.reason]}
              </Link>
            </li>
          ))}
        </ul>
        {!report.exclusions.length && <p className={s.small}>Nothing was left out.</p>}
      </details>
      <details className={s.section}>
        <summary>Questions and evidence</summary>
        <ul>
          {report.evidence.map((item, index) => (
            <li key={index}>
              <Link
                className={s.action}
                href={`/runs/${item.operationId}?tab=evidence&candidate=${item.candidateId}&criterion=${item.criterionId}&pass=${item.pass}`}
              >
                Question {index + 1} · {item.answered ? "Answer recorded" : "Unanswered"} ·
                Observation {item.pass}
                {item.repeat ? " · Repeat" : ""}
              </Link>
            </li>
          ))}
        </ul>
      </details>
    </main>
  );
}
