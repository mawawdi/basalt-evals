"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { RegressionReference } from "../../../../dist/packages/contracts/src/comparisons.js";
import type { LaunchIntent } from "../../../../dist/packages/contracts/src/launch.js";
import type { EvidenceCondition } from "../../../../dist/packages/contracts/src/assessments.js";
import type { LabelRule } from "../../../../dist/packages/contracts/src/execution.js";
import { read, message, formatMoney } from "./api";
import { Dialog, Notice, ProblemText } from "./ui";
import { useLaunchPreview } from "./launch-preview";
import { isLaunchAttempt, startLaunchAttempt, type LaunchAttempt } from "./launch-attempt";
import {
  RunOptions,
  LaunchBudget,
  LaunchSummary,
  launchPreferences,
  rememberLaunch,
  validJudgeSettings,
  type Options,
} from "./run-configuration";
import { evidenceConditionNames, judgingSetup } from "./result-display";
import s from "./workbench.module.css";
type Configuration = import("../../../../dist/packages/contracts/src/console.js").LaunchOptions;
type Workload =
  | { kind: "research"; experimentId: string }
  /** The judge part of a recheck of one build against the evaluation of its run. */
  | { kind: "recheck"; operationId: string; subjectId: string; revisionId: string }
  | {
      kind: "sensitivity";
      operationId: string;
      subjectId: string;
      /** Other saved builds of the same evaluation in this run. */
      peers: Array<{ id: string; title: string }>;
    }
  | { kind: "regression"; reference: RegressionReference };
/**
 * Controls that need no authored data. Region, swap and note controls need authored regions,
 * expert answers or a twin build in the plan, so this form does not offer them.
 */
const CONTROLS: EvidenceCondition[] = [
  "blank",
  "facts_and_source",
  "text_only",
  "reversed",
  "shuffled",
  "phase_shuffled",
  "repeated_frame",
];
const DEFAULT_CONTROLS: EvidenceCondition[] = [
  "blank",
  "facts_and_source",
  "text_only",
  "shuffled",
];
const ORDER_CONTROLS: EvidenceCondition[] = [
  "reversed",
  "shuffled",
  "phase_shuffled",
  "repeated_frame",
];
const controlDetails: Partial<Record<EvidenceCondition, string>> = {
  blank: "Every image replaced by a blank one",
  facts_and_source: "Images left out; recorded behavior and code stay",
  text_only: "Only the evaluation prompt and the criteria",
  reversed: "The recorded frames in reverse order",
  shuffled: "The recorded frames in a random order",
  phase_shuffled: "Frames mixed only between the same two actions",
  repeated_frame: "The last frame of each view in every slot",
};
const labelRuleNames: Record<LabelRule, string> = {
  labels_keep_slots: "Stay in place",
  labels_follow_images: "Move with the images",
};
export function WorkloadLaunch(props: Workload) {
  const key =
    props.kind === "regression"
      ? `basalt-saved-example-launch:${props.reference.id}`
      : props.kind === "research"
        ? `basalt-study-launch:${props.experimentId}`
        : props.kind === "sensitivity"
          ? `basalt-sensitivity-launch:${props.operationId}:${props.subjectId}`
          : `basalt-evidence-launch:${props.operationId}:${props.subjectId}`;
  return <WorkloadForm key={key} workload={props} storageKey={key} />;
}
function WorkloadForm({ workload: props, storageKey }: { workload: Workload; storageKey: string }) {
  const router = useRouter();
  const fieldId = useId();
  const mounted = useRef(true);
  const visible = useRef(false);
  const starting = useRef(false);
  const presentationChosen = useRef(false);
  const generation = props.kind === "regression" && props.reference.purpose === "generation";
  const [open, setOpen] = useState(false),
    [configuration, setConfiguration] = useState<Configuration | null>(null),
    [options, setOptions] = useState<Options | null>(null),
    [budget, setBudget] = useState(""),
    [intent, setIntent] = useState(""),
    [presentation, setPresentation] = useState<"still" | "sequence" | "grounded-sequence">("still"),
    [controls, setControls] = useState<EvidenceCondition[]>(DEFAULT_CONTROLS),
    [repeats, setRepeats] = useState(2),
    [labelRule, setLabelRule] = useState<LabelRule>("labels_keep_slots"),
    [builds, setBuilds] = useState<string[]>(
      props.kind === "sensitivity" ? props.peers.map((peer) => peer.id) : [],
    ),
    [holdoutLook, setHoldoutLook] = useState(false),
    [startedId, setStartedId] = useState<string | null>(null),
    [attempt, setAttempt] = useState<LaunchAttempt | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [configurationError, setConfigurationError] = useState(""),
    [configurationAttempt, setConfigurationAttempt] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open || configuration) return;
    let active = true;
    const controller = new AbortController();
    setConfigurationError("");
    void read<Configuration>("/api/launch-options", controller.signal)
      .then((value) => {
        if (!active) return;
        setConfiguration(value);
        const prefs = launchPreferences(value.defaults, value.models, value.harnesses);
        setOptions(prefs.selection);
        setBudget(prefs.ceiling);
        setIntent(crypto.randomUUID());
        try {
          const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
          if (
            typeof saved?.intent === "string" &&
            /^[a-f0-9-]{36}$/u.test(saved.intent) &&
            isLaunchAttempt(saved.attempt)
          ) {
            setAttempt(saved.attempt);
            setIntent(saved.intent);
            setBudget(String(saved.attempt.ceilingUsd));
          }
          if (
            Array.isArray(saved?.controls) &&
            saved.controls.length &&
            saved.controls.every((item: string) => (CONTROLS as string[]).includes(item))
          )
            setControls(saved.controls);
          if ([1, 2, 3].includes(saved?.repeats)) setRepeats(saved.repeats);
          if (
            props.kind === "sensitivity" &&
            Array.isArray(saved?.builds) &&
            saved.builds.every((id: string) => props.peers.some((peer) => peer.id === id))
          )
            setBuilds(saved.builds);
          if (typeof saved?.holdoutLook === "boolean") setHoldoutLook(saved.holdoutLook);
          if (Object.keys(labelRuleNames).includes(saved?.labelRule)) setLabelRule(saved.labelRule);
          const selection = saved?.options;
          const modelIds = new Set(value.models.map((model) => model.id));
          const harnessIds = new Set(value.harnesses.map((harness) => harness.id));
          if (
            selection?.objective === "evaluate" &&
            Array.isArray(selection.builderModelIds) &&
            selection.builderModelIds.every((id: string) => modelIds.has(id)) &&
            modelIds.has(selection.gradingModelId) &&
            validJudgeSettings(selection.judgeSettings) &&
            (selection.preparationModelId === null || modelIds.has(selection.preparationModelId)) &&
            (selection.coverageModelId === null || modelIds.has(selection.coverageModelId)) &&
            Array.isArray(selection.harnessIds) &&
            selection.harnessIds.every((id: string) => harnessIds.has(id)) &&
            [1, 2, 3].includes(selection.repetitions) &&
            [1, 2, 3].includes(selection.capturePasses) &&
            ["interactive", "flex"].includes(selection.capacity) &&
            typeof saved.budget === "string" &&
            typeof saved.intent === "string" &&
            /^[a-f0-9-]{36}$/u.test(saved.intent) &&
            ["still", "sequence", "grounded-sequence"].includes(saved.presentation) &&
            (saved.attempt === null || isLaunchAttempt(saved.attempt))
          ) {
            setOptions(selection);
            setBudget(saved.attempt ? String(saved.attempt.ceilingUsd) : saved.budget);
            setIntent(saved.intent);
            presentationChosen.current = true;
            setPresentation(saved.presentation);
            setAttempt(saved.attempt);
          }
        } catch {
          /* Optional local recovery. */
        }
      })
      .catch((cause) => {
        if (active) setConfigurationError(message(cause));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [open, configuration, configurationAttempt, storageKey]);
  useEffect(() => {
    if (!options || !intent) return;
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          options,
          budget,
          intent,
          presentation,
          controls,
          repeats,
          labelRule,
          builds,
          holdoutLook,
          attempt,
        }),
      );
    } catch {
      /* Optional recovery. */
    }
  }, [
    storageKey,
    options,
    budget,
    intent,
    presentation,
    controls,
    repeats,
    labelRule,
    builds,
    holdoutLook,
    attempt,
  ]);
  const selection: LaunchIntent | null =
    !open ||
    !!attempt ||
    !options ||
    !options.gradingModelId ||
    (generation && (!options.builderModelIds.length || !options.harnessIds.length)) ||
    (props.kind === "sensitivity" && !controls.length)
      ? null
      : props.kind === "regression"
        ? {
            kind: props.kind,
            selection: { referenceId: props.reference.id, configuration: options, presentation },
          }
        : props.kind === "research"
          ? {
              kind: props.kind,
              selection: {
                experimentId: props.experimentId,
                gradingModelId: options.gradingModelId,
              },
            }
          : props.kind === "sensitivity"
            ? {
                kind: props.kind,
                selection: {
                  operationId: props.operationId,
                  subjectIds: [
                    props.subjectId,
                    ...props.peers.map((peer) => peer.id).filter((id) => builds.includes(id)),
                  ],
                  modelId: options.gradingModelId,
                  presentation,
                  conditions: [
                    "original",
                    ...CONTROLS.filter((condition) => controls.includes(condition)),
                  ],
                  sensitivity: {
                    originalRepeats: repeats,
                    labelRule,
                    regions: [],
                    expertReviewer: null,
                    canary: null,
                    holdoutLook,
                  },
                },
              }
            : {
                kind: props.kind,
                selection: {
                  operationId: props.operationId,
                  subjectIds: [props.subjectId],
                  revisionId: props.revisionId,
                  judge: { modelId: options.gradingModelId, presentation },
                  part: "judge",
                },
              };
  const { preview, loading, error: previewError, retry } = useLaunchPreview(selection);
  useEffect(() => {
    if (
      (props.kind !== "recheck" && props.kind !== "sensitivity") ||
      presentationChosen.current ||
      attempt ||
      !preview?.assessment
    )
      return;
    const originals = [
      ...new Set(preview.assessment.sourceJudgingSetups.map((setup) => setup.presentation)),
    ];
    presentationChosen.current = true;
    if (
      originals.length === 1 &&
      ["still", "sequence", "grounded-sequence"].includes(originals[0]!)
    )
      setPresentation(originals[0] as typeof presentation);
  }, [props.kind, preview, attempt]);
  const label =
    props.kind === "regression"
      ? "Check saved example"
      : props.kind === "research"
        ? "Preview study run"
        : props.kind === "sensitivity"
          ? "Run a sensitivity test"
          : "Assess saved evidence again";
  async function start() {
    if (
      (!preview && !attempt) ||
      !options ||
      !intent ||
      starting.current ||
      !budget.trim() ||
      !Number.isFinite(Number(budget)) ||
      Number(budget) < 0
    )
      return;
    starting.current = true;
    const request = attempt ?? { previewId: preview!.id, ceilingUsd: Number(budget) };
    setAttempt(request);
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ options, budget, intent, presentation, controls, attempt: request }),
      );
    } catch {
      /* Optional recovery. */
    }
    setBusy(true);
    setError("");
    try {
      rememberLaunch(options, budget);
      const result = await startLaunchAttempt(intent, request);
      if (result.kind === "rejected") {
        if (mounted.current) {
          setAttempt(null);
          setIntent(crypto.randomUUID());
          setError(result.error);
        }
        return;
      }
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* Browser recovery is optional. */
      }
      if (!mounted.current) return;
      setStartedId(result.operationId);
      if (visible.current) router.push(`/runs/${result.operationId}`);
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      starting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <button
        className={s.secondary}
        disabled={busy}
        onClick={() => {
          if (startedId) {
            router.push(`/runs/${startedId}`);
            return;
          }
          visible.current = true;
          setOpen(true);
        }}
      >
        {busy ? "Starting run…" : startedId ? "Open started run" : label}
      </button>
      {!open && error && <Notice>{error}</Notice>}
      <Dialog
        open={open}
        onClose={() => {
          visible.current = false;
          setOpen(false);
        }}
        title={label}
      >
        {configurationError && (
          <Notice>
            {configurationError}{" "}
            <button
              className={s.secondary}
              type="button"
              onClick={() => setConfigurationAttempt((value) => value + 1)}
            >
              Load options again
            </button>
          </Notice>
        )}
        {(error || previewError) && (
          <Notice>
            {error || <ProblemText text={previewError} />}
            {previewError && (
              <button className={s.secondary} onClick={retry}>
                Check again
              </button>
            )}
          </Notice>
        )}
        <form
          className={s.form}
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <p>
            {generation
              ? "This run makes new builds from the original evaluation and collects new Studio evidence for them. The builder does not see the private findings."
              : props.kind === "research"
                ? "Run the planned study under its fixed test conditions. Its human review happens separately from the automatic checks."
                : props.kind === "sensitivity"
                  ? "Check the same evidence as recorded and under each control you choose. If an answer stays the same under a control, it didn’t depend on what that control changed. This test doesn’t measure accuracy, and its answers can’t be used in reviews or comparisons."
                  : "Check the same evidence with a different judge. Answers from the same judge stay as they are, and this run makes no new builds or Studio observations."}
          </p>
          <p className={s.small}>
            The preview is free. Once you start, only this new work can add cost, up to the limit
            you enter.
          </p>
          {attempt && (
            <p className={s.small}>
              A launch request with a {formatMoney(attempt.ceilingUsd)} limit was already sent. Its
              settings stay locked until you recover it.
            </p>
          )}
          {!configuration && !configurationError && <p role="status">Loading run options…</p>}
          {!attempt &&
            options &&
            configuration &&
            (generation ? (
              <RunOptions
                value={options}
                models={configuration.models}
                harnesses={configuration.harnesses}
                onChange={setOptions}
                disabled={busy || !!attempt}
              />
            ) : (
              <>
                <div className={s.field}>
                  <label htmlFor={fieldId + "-model"}>Judge model</label>
                  <select
                    id={fieldId + "-model"}
                    disabled={busy || !!attempt}
                    value={options.gradingModelId ?? ""}
                    onChange={(e) => setOptions({ ...options, gradingModelId: e.target.value })}
                  >
                    {!options.gradingModelId && (
                      <option value="" disabled>
                        Select a judge
                      </option>
                    )}
                    {configuration.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </div>
                {props.kind !== "research" && (
                  <div className={s.field}>
                    <label htmlFor={fieldId + "-presentation"}>Evidence presentation</label>
                    <select
                      id={fieldId + "-presentation"}
                      disabled={busy || !!attempt}
                      value={presentation}
                      onChange={(e) => {
                        presentationChosen.current = true;
                        setPresentation(e.target.value as typeof presentation);
                      }}
                    >
                      <option value="still">Still images</option>
                      <option value="sequence">Recorded sequence</option>
                      <option value="grounded-sequence">Notes from recorded sequence</option>
                    </select>
                  </div>
                )}
                {props.kind === "sensitivity" && (
                  <fieldset>
                    <legend>Builds</legend>
                    <div className={s.selectionGrid}>
                      <label className={s.choice}>
                        <input type="checkbox" checked disabled />
                        <span>
                          This build
                          <small>Always included</small>
                        </span>
                      </label>
                      {props.peers.map((peer) => (
                        <label className={s.choice} key={peer.id}>
                          <input
                            type="checkbox"
                            disabled={busy || !!attempt}
                            checked={builds.includes(peer.id)}
                            onChange={(event) =>
                              setBuilds(
                                event.target.checked
                                  ? [...builds, peer.id]
                                  : builds.filter((id) => id !== peer.id),
                              )
                            }
                          />
                          <span>{peer.title}</span>
                        </label>
                      ))}
                    </div>
                    <p className={s.small}>
                      The exact tests count builds, so one build cannot show an effect. Each build
                      adds to the cost.
                    </p>
                    <label className={s.choice}>
                      <input
                        type="checkbox"
                        disabled={busy || !!attempt}
                        checked={holdoutLook}
                        onChange={(event) => setHoldoutLook(event.target.checked)}
                      />
                      <span>
                        Include withheld observations
                        <small>Basalt records this as one look at the withheld observations.</small>
                      </span>
                    </label>
                  </fieldset>
                )}
                {props.kind === "sensitivity" && (
                  <fieldset>
                    <legend>Controls</legend>
                    <div className={s.selectionGrid}>
                      {CONTROLS.map((condition) => (
                        <label className={s.choice} key={condition}>
                          <input
                            type="checkbox"
                            disabled={busy || !!attempt}
                            checked={controls.includes(condition)}
                            onChange={(event) =>
                              setControls(
                                event.target.checked
                                  ? [...controls, condition]
                                  : controls.filter((item) => item !== condition),
                              )
                            }
                          />
                          <span>
                            {evidenceConditionNames[condition]}
                            <small>{controlDetails[condition]}</small>
                          </span>
                        </label>
                      ))}
                    </div>
                    <p className={s.small}>
                      Each control checks every observation once more, so each one adds to the cost.
                      This form doesn’t offer the region, swapped-image and note controls, because
                      they need marked regions, reviewer answers or a build with a note to the
                      judge.
                    </p>
                    <div className={s.field}>
                      <label htmlFor={fieldId + "-repeats"}>Checks of recorded evidence</label>
                      <select
                        id={fieldId + "-repeats"}
                        disabled={busy || !!attempt}
                        value={repeats}
                        onChange={(event) => setRepeats(Number(event.target.value))}
                      >
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                        <option value={3}>3</option>
                      </select>
                      <small>
                        Two or more checks measure the noise floor: how often the judge changes its
                        answer when the evidence stays the same.
                      </small>
                    </div>
                    {controls.some((condition) => ORDER_CONTROLS.includes(condition)) && (
                      <div className={s.field}>
                        <label htmlFor={fieldId + "-labels"}>
                          Frame labels under order controls
                        </label>
                        <select
                          id={fieldId + "-labels"}
                          disabled={busy || !!attempt}
                          value={labelRule}
                          onChange={(event) => setLabelRule(event.target.value as LabelRule)}
                        >
                          {(Object.keys(labelRuleNames) as LabelRule[]).map((rule) => (
                            <option key={rule} value={rule}>
                              {labelRuleNames[rule]}
                            </option>
                          ))}
                        </select>
                        <small>
                          Choose before the test starts. If the labels stay in place, they disagree
                          with the images. If they move, only the order of the images changes.
                        </small>
                      </div>
                    )}
                  </fieldset>
                )}
              </>
            ))}
          <LaunchBudget
            id={fieldId + "-budget"}
            scope={!generation && props.kind !== "research" ? "assessment" : "run"}
            value={attempt ? String(attempt.ceilingUsd) : budget}
            onChange={setBudget}
            disabled={busy || !!attempt || !configuration}
          />
          {preview && (
            <LaunchSummary
              description={
                !preview.quote
                  ? "The preview describes the work that this spending limit covers."
                  : preview.quote.workload.independentBuilderTrials
                    ? `${preview.quote.workload.independentBuilderTrials} new ${preview.quote.workload.independentBuilderTrials === 1 ? "build" : "builds"} · ${preview.quote.workload.criterionOutcomes} checks`
                    : `No new builds · ${preview.quote.workload.criterionOutcomes} answers to check`
              }
              budget={preview.budget}
              timeLimits={preview.timeLimits}
            />
          )}
          {preview?.assessment &&
            (() => {
              const name = (id: string) =>
                configuration?.models.find((model) => model.id === id)?.name ?? id;
              const before = preview.assessment.sourceJudgingSetups.map((setup) =>
                judgingSetup(name(setup.modelId), setup.presentation),
              );
              const after = judgingSetup(
                name(preview.assessment.selection.modelId),
                preview.assessment.selection.presentation,
              );
              return (
                <p className={s.small}>
                  {before.length
                    ? `The original checks used ${before.join("; ")}. `
                    : "Basalt did not record the original judge. "}
                  {props.kind === "sensitivity"
                    ? `This test uses ${after} for the recorded evidence and every control.`
                    : `This run uses ${after}. Only the judge changes; the builds and observations stay the same.`}
                </p>
              );
            })()}
          {preview?.assessment && (
            <p className={s.small} style={{ overflowWrap: "anywhere" }}>
              Prices in this preview are for:{" "}
              {preview.quote?.models
                .map(
                  (model) =>
                    `${model.name} via ${model.endpoints.map((endpoint) => `${endpoint.provider} (${endpoint.quantization})`).join(", ")}`,
                )
                .join("; ") ?? "Unavailable"}
              . If you start from this preview, each request uses the fastest of these providers.
            </p>
          )}
          {preview?.assessment && (
            <details>
              <summary>Experimental evidence bundle: coverage and token limits</summary>
              <p className={s.small}>
                The run still sends the original selection. No test shows that this experimental
                bundle helps the judge or costs less. Basalt keeps all of the recorded evidence.
              </p>
              {preview.assessment.evidencePackets.map((packet) => (
                <section key={packet.captureId}>
                  <p>
                    {packet.dispatchedImages} images sent · {packet.proposedImages ?? "Unknown"} in
                    the experimental bundle.
                  </p>
                  <p>
                    {packet.manifest?.status ?? packet.error ?? "No experimental bundle needed"}
                  </p>
                  <pre className={s.code}>{JSON.stringify(packet.manifest, null, 2)}</pre>
                </section>
              ))}
              <p className={s.small}>
                The token limits below include text, images and output for each provider. They are
                the most it could cost, not a prediction. Unknown usage stays unknown.
              </p>
              <pre className={s.code}>
                {JSON.stringify(preview.assessment.proposedPacketWork, null, 2)}
              </pre>
            </details>
          )}
          {preview && preview.humanQuestions > 0 && (
            <p role="status">
              This study needs {preview.humanQuestions} human review questions. Optional sample
              reviews don’t count toward them.
            </p>
          )}
          <button
            className={s.primary}
            disabled={
              busy ||
              (!preview && !attempt) ||
              !budget.trim() ||
              !Number.isFinite(Number(budget)) ||
              Number(budget) < 0
            }
            type="submit"
          >
            {busy
              ? "Starting…"
              : attempt
                ? "Recover launch request"
                : `${props.kind === "sensitivity" ? "Start sensitivity test" : !generation && props.kind !== "research" ? "Start reassessment" : "Start run"} · limit ${budget.trim() && Number.isFinite(Number(budget)) ? formatMoney(Number(budget)) : "—"}`}
          </button>
          {loading && <p role="status">Checking selection…</p>}
          {!attempt && props.kind === "sensitivity" && !controls.length && (
            <p role="status">Choose at least one control to continue.</p>
          )}
          {!attempt &&
            generation &&
            options &&
            (!options.builderModelIds.length || !options.harnessIds.length) && (
              <p role="status">Choose at least one model and one tool setup to continue.</p>
            )}
          {busy && (
            <p role="status">
              Closing the dialog won’t stop this launch request. Once the run starts, you’ll find it
              in Runs.
            </p>
          )}
        </form>
      </Dialog>
    </>
  );
}
