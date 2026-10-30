import type {
  KnownBuild,
  KnownBuildGate,
  KnownBuildRetirement,
  KnownBuildStatus,
} from "../../../../../dist/packages/contracts/src/known-builds.js";
import { ScrollRegion, Status } from "../../components/ui";
import { statementText } from "../../components/result-display";
import s from "../../components/workbench.module.css";
import { KnownBuildRetire } from "./known-build-actions";
import { RecheckLaunch } from "./recheck-launch";

const statusNames: Record<KnownBuildStatus, string> = {
  holds: "Holds",
  broken: "Contradicted",
  incomplete: "Incomplete",
  needs_person: "Needs a person",
  needs_judge: "Needs a judge check",
};
const statusTones: Record<KnownBuildStatus, "good" | "bad" | "warning" | "neutral"> = {
  holds: "good",
  broken: "bad",
  incomplete: "neutral",
  needs_person: "warning",
  needs_judge: "warning",
};
const answerNames: Record<string, string> = {
  met: "Met",
  not_met: "Not met",
  split: "Split",
  scored: "Scored",
  insufficient: "Not enough evidence",
};

/**
 * The known build gate of one evaluation version. A person marks saved builds as known good or
 * known bad builds. Basalt checks them with each new version, and a version that contradicts
 * them can't start a new benchmark. The gate never changes an answer.
 */
/** "Known good build · Build 1 · GPT-6 Luna": the mark and the saved build that it names. */
export function knownBuildName(known: KnownBuild, buildTitles: Record<string, string>) {
  const title = buildTitles[`${known.build.operationId}:${known.build.subjectId}`];
  return `${known.expectation === "met" ? "Known good build" : "Known bad build"} · ${title ?? "a saved build"}`;
}

export function KnownBuildGatePanel({
  gate,
  knownBuilds,
  criteria,
  knownStages,
  buildTitles,
  models,
}: {
  gate: KnownBuildGate;
  /** The known builds of the library evaluation, or null when the version is not in the library. */
  knownBuilds: Array<KnownBuild & { retirement: KnownBuildRetirement | null }> | null;
  /** The authored criteria of each stage of this version. An ID is unique only in its stage. */
  criteria: Array<{ stage: number; id: string; text: string }>;
  /** The stage of each known build. */
  knownStages: Record<string, number>;
  /** The title of each saved build, by `<run>:<build>`. */
  buildTitles: Record<string, string>;
  models: Array<{ id: string; name: string }>;
}) {
  const active = (knownBuilds ?? []).filter((known) => !known.retirement);
  const kind = (expectation: "met" | "not_met") =>
    expectation === "met" ? "Known good build" : "Known bad build";
  const buildName = (id: string) => {
    const known = knownBuilds?.find((item) => item.id === id);
    return known ? knownBuildName(known, buildTitles) : "Known build";
  };
  const criterionText = (id: string | null, knownBuildId: string) =>
    statementText(
      criteria.find(
        (criterion) => criterion.id === id && criterion.stage === knownStages[knownBuildId],
      )?.text ?? "",
    ) || "A criterion that this version no longer has";
  const blocked = gate.state === "blocked";
  return (
    <details id="known-builds" className={s.section} open={blocked}>
      <summary>
        Known builds{" "}
        {!gate.checked ? (
          active.length ? (
            <Status>Not checked</Status>
          ) : null
        ) : blocked ? (
          <Status tone="warning">Blocks new benchmarks</Status>
        ) : gate.results.length ? (
          <Status tone="good">All hold</Status>
        ) : (
          <Status tone="good">Nothing blocks</Status>
        )}
      </summary>
      <p className={s.small}>
        A known good or known bad build is a saved build that a person marked for named criteria.
        Basalt checks each one with every new version of this evaluation. If a version gives a
        different answer, or a check can’t decide, new benchmarks wait until a person fixes the
        version or retires the build. Known builds never change an answer.
      </p>
      {gate.checked && !gate.results.length ? (
        <p className={s.small}>Every known build that checked this version is retired.</p>
      ) : !gate.checked ? (
        <p className={s.small}>
          {active.length
            ? "Basalt prepared this version before these known builds existed, so they don’t block it. They check the next version that Basalt prepares."
            : "No known builds yet. Mark a saved build under Check saved builds again."}
        </p>
      ) : (
        <ScrollRegion className={s.tableWrap} label="Known build checks">
          <table className={s.conditionTable}>
            <thead>
              <tr>
                <th scope="col">Known build</th>
                <th scope="col">Criterion</th>
                <th scope="col">Answers now</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {gate.results.map((result) => {
                const known = knownBuilds?.find((item) => item.id === result.knownBuildId);
                return (
                  <tr key={`${result.knownBuildId}:${result.authoredCriterionId}`}>
                    <th scope="row">{buildName(result.knownBuildId)}</th>
                    <td>{criterionText(result.targetCriterionId, result.knownBuildId)}</td>
                    <td>
                      {result.checks.length
                        ? result.checks
                            .map((check) =>
                              check.answer === null
                                ? "Waiting for the judge"
                                : answerNames[check.answer],
                            )
                            .join(" · ")
                        : "—"}
                    </td>
                    <td>
                      <Status tone={statusTones[result.status]}>
                        {statusNames[result.status]}
                      </Status>
                      {result.reason && <p className={s.small}>{result.reason}</p>}
                      {result.status === "needs_judge" && known && result.judgePart && (
                        <RecheckLaunch
                          label="Check with the judge"
                          part={result.judgePart}
                          chooseJudge
                          models={models}
                          selection={{
                            operationId: known.build.operationId,
                            subjectIds: [known.build.subjectId],
                            revisionId: gate.revisionId,
                            judge: null,
                          }}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      {active.length > 0 && (
        <>
          <h3 className={s.markedHeading}>Marked builds</h3>
          <ul className={s.markedBuilds}>
            {active.map((known) => (
              <li key={known.id}>
                <span>
                  <strong>{buildName(known.id)}</strong>
                  <span className={s.small}>“{known.reason}”</span>
                </span>
                <KnownBuildRetire knownBuildId={known.id} title={kind(known.expectation)} />
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
