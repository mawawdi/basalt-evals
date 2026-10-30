import Link from "next/link";
import type { AssessmentReport } from "../../../../../dist/packages/contracts/src/assessments.js";
import type {
  BuildMcNemar,
  BuildSignTest,
  ControlResult,
  CriterionEvidenceUse,
  PairStatus,
  Rate,
} from "../../../../../dist/packages/experiments/src/evidence-use.js";
import { ScrollRegion, Status } from "../../components/ui";
import {
  controlLevelNames,
  decisionAnswer,
  evidenceConditionNames,
  statementText,
} from "../../components/result-display";
import s from "../../components/workbench.module.css";

type Unit = AssessmentReport["results"][number];
const statusNames: Record<PairStatus, string> = {
  held: "Same answer",
  changed: "Changed",
  abstained: "Not enough evidence",
  unavailable: "Cannot compare",
};
const STATUSES = Object.keys(statusNames) as PairStatus[];
const conditionName = (condition: string) => evidenceConditionNames[condition] ?? condition;
const decisionIn = (unit: Unit | undefined, criterionId: string) =>
  unit?.result?.decisions.find((item) => item.criterionId === criterionId);
const share = (rate: Rate) => `${rate.numerator} of ${rate.denominator}`;
const p = (value: number | null) =>
  value === null ? "—" : value < 0.001 ? "<0.001" : value.toFixed(3);

/** One build cannot show an effect, so a test names its build count. */
function signText(test: BuildSignTest | null, positive: string) {
  if (!test) return "No builds to compare";
  return `${test.positives} of ${test.builds} ${test.builds === 1 ? "build" : "builds"} ${positive} · p ${p(test.greaterP)}, Holm ${p(test.holmP)}`;
}
function mcnemarText(test: BuildMcNemar | null) {
  if (!test) return "No Met or Not met pairs";
  return `${test.firstOnly} ${test.firstOnly === 1 ? "build" : "builds"} toward Not met, ${test.secondOnly} toward Met · mid-p ${p(test.midP)}, Holm ${p(test.holmP)}`;
}

function ControlRows({ use, noise }: { use: CriterionEvidenceUse; noise: boolean }) {
  const floor = use.noiseFloor.status === "measured" ? use.noiseFloor : null;
  return (
    <>
      {floor && (
        <tr>
          <th scope="row">As recorded, checked again</th>
          <td>Noise floor</td>
          {STATUSES.map((status) => (
            <td key={status}>{floor[status]}</td>
          ))}
          <td>{share(floor.movedRate)}</td>
          <td>—</td>
        </tr>
      )}
      {use.controls.map((control: ControlResult) => (
        <tr key={control.condition}>
          <th scope="row">
            {conditionName(control.condition)}
            {control.status === "not_available" && (
              <span className={s.tableMeta}>
                Not available.{" "}
                {control.reasons.join(" ") || "No observation has answers to compare."}
              </span>
            )}
          </th>
          <td>{controlLevelNames[control.level] ?? control.level}</td>
          {STATUSES.map((status) => (
            <td key={status}>{control[status]}</td>
          ))}
          <td>{share(control.movedRate)}</td>
          <td>
            {noise
              ? signText(control.againstNoise, "above the noise floor")
              : "Noise floor not measured"}
            <span className={s.tableMeta}>{mcnemarText(control.mcnemar)}</span>
          </td>
        </tr>
      ))}
    </>
  );
}

function Findings({ use }: { use: CriterionEvidenceUse }) {
  const lines: string[] = [];
  const { localization, direction, text } = use;
  if (localization)
    lines.push(
      localization.status === "measured"
        ? `With the region removed, ${share(localization.decisiveMoved)} answers changed. With the sham region removed, ${share(localization.shamMoved)} changed. ${localization.effect === null ? "The difference can’t be calculated." : `The difference is ${Math.round(localization.effect * 100)} points.`} ${mcnemarText(localization.mcnemar)}.` +
            (localization.blackMinusFill === null
              ? ""
              : ` With the region in black, the change rate was ${Math.round(localization.blackMinusFill * 100)} points higher than with the region removed.`)
        : `Region controls are not available. ${localization.reasons.join(" ")}`,
    );
  if (direction)
    lines.push(
      direction.status === "measured"
        ? `With swapped images, the answer followed the images in ${share(direction.followRate)} checks. It kept the reviewer's answer for the original build in ${direction.kept} checks. ${signText(direction.signTest, "followed the images more often")}.`
        : `Swapped images are not available. ${direction.reasons.join(" ")}`,
    );
  if (text)
    lines.push(
      text.status === "measured"
        ? `With the note to the judge, ${share(text.towardRate)} answers moved toward the answer the note asks for, and ${text.away} moved away. ${signText(text.signTest, "moved toward the note")}.`
        : `The note control is not available. ${text.reasons.join(" ")}`,
    );
  return lines.length ? (
    <ul className={s.small}>
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  ) : null;
}

/**
 * A sensitivity test shows each criterion's answer on the recorded evidence beside its answer
 * under every control. It never totals into accuracy: the only question is whether answers moved.
 */
export function SensitivityResults({
  report,
  evidenceHref,
}: {
  report: AssessmentReport;
  evidenceHref: (subjectId: string, criterionId: string, pass: number) => string;
}) {
  const use = report.evidenceUse;
  const controls = report.selection.conditions.filter((condition) => condition !== "original");
  const repeats = report.selection.sensitivity?.originalRepeats ?? 1;
  const columns = [
    ...Array.from({ length: repeats }, (_, index) => ({
      condition: "original",
      repeat: index + 1,
    })),
    ...controls.map((condition) => ({ condition, repeat: 1 })),
  ];
  // One row is one observation of one build, in the sequence of the selected builds.
  const observations = report.builds.flatMap((build) =>
    [
      ...new Set(
        report.results.filter((unit) => unit.subjectId === build.id).map((unit) => unit.pass),
      ),
    ]
      .sort((a, b) => a - b)
      .map((pass) => ({ build, pass })),
  );
  const pooled = report.builds.length > 1;
  const unitFor = (
    subjectId: string,
    pass: number,
    condition: string,
    repeat: number,
    criterionId: string,
  ) =>
    report.results.find(
      (unit) =>
        unit.subjectId === subjectId &&
        unit.pass === pass &&
        unit.condition === condition &&
        unit.repeat === repeat &&
        unit.criterionIds.includes(criterionId),
    );
  const cellStatus = (criterionId: string, captureId: string, condition: string, repeat: number) =>
    use?.cells.find(
      (cell) =>
        cell.criterionId === criterionId &&
        cell.observation === captureId &&
        cell.condition === condition &&
        cell.repeat === repeat,
    )?.status;
  const total = (condition: string, status: PairStatus) =>
    use?.cells.filter((cell) => cell.condition === condition && cell.status === status).length ?? 0;
  const noise = use?.noiseFloor === "measured";
  return (
    <div className={s.sensitivity}>
      <p className={s.sensitivityNote}>
        Each control changes one part of the evidence the judge reads: the images, the recorded
        behavior and code, one region, the image source or the frame order. If an answer stays the
        same under a control, it didn’t depend on that part. A changed answer shows dependence, not
        correct use. This test doesn’t measure accuracy, and its answers can’t be used in reviews or
        comparisons.
      </p>
      <p className={s.small}>
        {noise
          ? `The judge checked the recorded evidence ${repeats} times. The noise floor is how often its answer changed with no change to the evidence.`
          : "The noise floor wasn’t measured because the judge checked the recorded evidence only once."}{" "}
        {use?.builds === 1
          ? "All observations come from one build, so the exact tests count one build and cannot show an effect."
          : `The exact tests count ${use?.builds ?? 0} builds.`}{" "}
        {report.selection.sensitivity &&
          (report.selection.sensitivity.labelRule === "labels_keep_slots"
            ? "Under order and swap controls, image labels stayed in their slots."
            : "Under order and swap controls, image labels moved with the images.")}{" "}
        {report.selection.sensitivity?.holdoutLook
          ? "The test includes withheld observations, and Basalt recorded this as one look at them."
          : "The test uses only development observations."}
      </p>
      <ScrollRegion className={s.tableWrap} label="Answers under each control">
        <table className={s.conditionTable}>
          <thead>
            <tr>
              <th scope="col">Control</th>
              {STATUSES.map((status) => (
                <th scope="col" key={status}>
                  {statusNames[status]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {controls.map((condition) => (
              <tr key={condition}>
                <th scope="row">{conditionName(condition)}</th>
                {STATUSES.map((status) => (
                  <td key={status}>{total(condition, status)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      {report.criteria.map((criterion) => {
        const rows = observations.filter(({ build, pass }) =>
          unitFor(build.id, pass, "original", 1, criterion.id),
        );
        if (!rows.length) return null;
        const statement = statementText(criterion.statement);
        const criterionUse = use?.criteria.find((item) => item.criterionId === criterion.id);
        return (
          <section key={criterion.id} aria-label={statement}>
            <h3>{statement}</h3>
            {criterionUse && (
              <>
                <ScrollRegion className={s.tableWrap} label={`Answer changes for ${statement}`}>
                  <table className={s.conditionTable}>
                    <thead>
                      <tr>
                        <th scope="col">Control</th>
                        <th scope="col">Question</th>
                        {STATUSES.map((status) => (
                          <th scope="col" key={status}>
                            {statusNames[status]}
                          </th>
                        ))}
                        <th scope="col">Any change</th>
                        <th scope="col">Exact tests</th>
                      </tr>
                    </thead>
                    <tbody>
                      <ControlRows use={criterionUse} noise={noise} />
                    </tbody>
                  </table>
                </ScrollRegion>
                <Findings use={criterionUse} />
              </>
            )}
            <ScrollRegion className={s.tableWrap} label={`Answers for ${statement}`}>
              <table className={s.conditionTable}>
                <thead>
                  <tr>
                    <th scope="col">Observation</th>
                    {columns.map(({ condition, repeat }) => (
                      <th scope="col" key={`${condition}:${repeat}`}>
                        {conditionName(condition)}
                        {repeat > 1 && `, check ${repeat}`}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ build, pass }) => (
                    <tr key={`${build.id}:${pass}`}>
                      <th scope="row">
                        {pooled ? `${build.title}, observation ${pass}` : `Observation ${pass}`}
                        <Link
                          className={s.action}
                          href={evidenceHref(build.id, criterion.id, pass)}
                          aria-label={`Recorded evidence for ${build.title}, observation ${pass}: ${statement}`}
                        >
                          Evidence
                        </Link>
                      </th>
                      {columns.map(({ condition, repeat }) => {
                        const unit = unitFor(build.id, pass, condition, repeat, criterion.id),
                          decision = decisionIn(unit, criterion.id),
                          answer = decisionAnswer(decision, Boolean(unit?.result || unit?.error)),
                          status =
                            condition === "original" && repeat === 1
                              ? null
                              : cellStatus(criterion.id, unit?.captureId ?? "", condition, repeat);
                        return (
                          <td key={`${condition}:${repeat}`}>
                            {unit ? (
                              <Status tone={answer.tone}>{answer.text}</Status>
                            ) : (
                              <span className={s.tableMeta}>Not available</span>
                            )}
                            {status && <span className={s.tableMeta}>{statusNames[status]}</span>}
                            {decision?.rationale && (
                              <details>
                                <summary>Why</summary>
                                <p>{decision.rationale}</p>
                              </details>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </section>
        );
      })}
      <p className={s.small}>{report.limitation}</p>
    </div>
  );
}
