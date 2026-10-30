"use client";
import { useId, useState } from "react";
import type { LaunchSelection } from "../../../../dist/packages/contracts/src/execution.js";

import type { LaunchCatalog } from "../../../../dist/packages/contracts/src/console.js";
import {
  MAX_JUDGE_SAMPLES,
  judgeSettings,
} from "../../../../dist/packages/contracts/src/judge-settings.js";
import {
  harnessSettingRows,
  harnessSummary,
} from "../../../../dist/packages/contracts/src/harness.js";
import { formatMoney } from "./api";
import s from "./workbench.module.css";
import r from "./run-experience.module.css";
export type Options = Omit<LaunchSelection, "sources">;
type Catalog = LaunchCatalog;
const preferencesKey = "basalt-run-preferences";
export function validLaunchOptions(
  value: unknown,
  models: Catalog["models"],
  harnesses: Catalog["harnesses"],
): value is Options {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  const ids = new Set<string>(models.map((model) => model.id));
  const harnessIds = new Set<string>(harnesses.map((harness) => harness.id));
  return (
    Object.keys(selection).sort().join() ===
      [
        "objective",
        "builderModelIds",
        "gradingModelId",
        "judgeSettings",
        "preparationModelId",
        "coverageModelId",
        "capacity",
        "harnessIds",
        "repetitions",
        "capturePasses",
      ]
        .sort()
        .join() &&
    selection.objective === "evaluate" &&
    Array.isArray(selection.builderModelIds) &&
    selection.builderModelIds.every((id) => typeof id === "string" && ids.has(id)) &&
    new Set(selection.builderModelIds).size === selection.builderModelIds.length &&
    typeof selection.gradingModelId === "string" &&
    ids.has(selection.gradingModelId) &&
    validJudgeSettings(selection.judgeSettings) &&
    (selection.preparationModelId === null ||
      (typeof selection.preparationModelId === "string" &&
        ids.has(selection.preparationModelId))) &&
    (selection.coverageModelId === null ||
      (typeof selection.coverageModelId === "string" && ids.has(selection.coverageModelId))) &&
    typeof selection.capacity === "string" &&
    ["interactive", "flex"].includes(selection.capacity) &&
    Array.isArray(selection.harnessIds) &&
    selection.harnessIds.every((id) => harnessIds.has(id)) &&
    new Set(selection.harnessIds).size === selection.harnessIds.length &&
    [1, 2, 3].includes(selection.repetitions as number) &&
    [1, 2, 3].includes(selection.capturePasses as number)
  );
}
/** Judge samples from 1 to 5, in shared requests or with one criterion per request. */
export function validJudgeSettings(value: unknown): boolean {
  try {
    judgeSettings(value);
    return true;
  } catch {
    return false;
  }
}
export function launchPreferences(
  defaults: Options,
  models: Catalog["models"],
  harnesses: Catalog["harnesses"],
) {
  try {
    const saved = JSON.parse(localStorage.getItem(preferencesKey) ?? "null");
    const selection = saved?.selection;
    if (validLaunchOptions(selection, models, harnesses)) {
      return {
        selection: { ...selection, objective: "evaluate" } as Options,
        ceiling: typeof saved.ceiling === "string" ? saved.ceiling : "",
        remembered: true,
      };
    }
  } catch {
    /* Preferences are optional. */
  }
  return { selection: defaults, ceiling: "", remembered: false };
}
export function rememberLaunch(selection: Options, ceiling: string) {
  try {
    localStorage.setItem(preferencesKey, JSON.stringify({ selection, ceiling }));
  } catch {
    /* Explicit launch stays available. */
  }
}
export function LaunchBudget({
  id = "launch-budget",
  value,
  onChange,
  disabled = false,
  scope = "run",
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** A recheck explains its own work above the field, so its help names only the limit. */
  scope?: "run" | "assessment" | "recheck";
}) {
  return (
    <div className={s.field}>
      <label htmlFor={id}>Spending limit (USD)</label>
      <input
        id={id}
        disabled={disabled}
        type="number"
        min="0"
        step="any"
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Enter a limit"
        aria-describedby={id + "-help"}
      />
      <small id={id + "-help"}>
        {scope === "assessment"
          ? "This is the most this run can cost. It checks the saved evidence again and makes no new builds or Studio observations."
          : scope === "recheck"
            ? "This is the most this run can cost. Work pauses before it would go over the limit."
            : "This is the most this run can cost, including preparation, builds and checks. Work pauses before it would go over the limit, and the limit never rises on its own."}
      </small>
    </div>
  );
}
export function LaunchSummary({
  description,
  budget,
  timeLimits,
}: {
  description: string;
  budget: import("../../../../dist/packages/contracts/src/execution.js").BudgetSummary;
  timeLimits?: import("../../../../dist/packages/contracts/src/launch.js").OperationLaunchPreview["timeLimits"];
}) {
  return (
    <div className={s.smallStack}>
      {description && <p>{description}</p>}
      <p className={s.small}>
        {budget.history
          ? `Similar past runs cost ${formatMoney(budget.history.minimumUsd)}–${formatMoney(budget.history.maximumUsd)} (${budget.history.count} runs).`
          : budget.note}
      </p>
      {budget.history && (
        <p className={s.small}>
          {budget.note} Past costs are a guide, not a price for your next run.
        </p>
      )}
      {timeLimits && (timeLimits.readinessMs > 0 || timeLimits.longestStudioTrialMs !== null) && (
        <details>
          <summary>Studio time limits</summary>
          {timeLimits.readinessMs > 0 && (
            <p className={s.small}>
              Basalt waits up to {Math.ceil(timeLimits.readinessMs / 60000)} minutes for Studio to
              open.
            </p>
          )}
          {timeLimits.longestStudioTrialMs !== null && (
            <p className={s.small}>
              If a Studio session runs longer than{" "}
              {Math.ceil(timeLimits.longestStudioTrialMs / 60000)} minutes, Basalt treats it as
              stuck. This limit covers starting Studio and recording. It isn’t an estimate of how
              long a session takes.
            </p>
          )}
        </details>
      )}
    </div>
  );
}
/** How many times the judge answers each check, and how many criteria share a request. */
function JudgeSettingsFields({
  value,
  update,
}: {
  value: Options;
  update: (next: Partial<Options>) => void;
}) {
  const settings = value.judgeSettings;
  return (
    <>
      <div className={s.field}>
        <label htmlFor="judge-samples">Judge samples</label>
        <select
          id="judge-samples"
          value={settings.samples}
          aria-describedby="judge-samples-help"
          onChange={(event) =>
            update({ judgeSettings: { ...settings, samples: Number(event.target.value) } })
          }
        >
          {Array.from({ length: MAX_JUDGE_SAMPLES }, (_, index) => index + 1).map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <small id="judge-samples-help">
          The judge answers each check this many times, and each answer costs the same. If the
          answers disagree, the check shows as Split and a person decides it.
        </small>
      </div>
      <label className={s.choice}>
        <input
          type="checkbox"
          checked={settings.grouping === "per_criterion"}
          onChange={(event) =>
            update({
              judgeSettings: {
                ...settings,
                grouping: event.target.checked ? "per_criterion" : "shared",
              },
            })
          }
        />
        <span>
          One criterion per request
          <small>The judge sees one criterion at a time. This sends more requests.</small>
        </span>
      </label>
    </>
  );
}
export function RunOptions({
  value,
  onChange,
  models,
  harnesses = [],
  disabled,
  mode = "launch",
}: {
  value: Options;
  onChange: (next: Options) => void;
  models: Catalog["models"];
  /** The registered tool sets. Only a launch shows them. */
  harnesses?: Catalog["harnesses"];
  disabled: boolean;
  mode?: "launch" | "repair" | "replay" | "public-development";
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const selectedModels = models.filter((model) => value.builderModelIds.includes(model.id));
  const visibleModels = models.filter((model) =>
    model.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const hiddenSelections = selectedModels.filter((model) => !visibleModels.includes(model));
  const update = (next: Partial<Options>) => onChange({ ...value, ...next });
  const modelSelect = (id: string, label: string, key: "gradingModelId") => (
    <div className={s.field}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value[key] ?? ""}
        onChange={(event) => update({ [key]: event.target.value })}
      >
        {!value[key] && (
          <option value="" disabled>
            Select a judge
          </option>
        )}
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <fieldset disabled={disabled} className={s.form}>
      {(mode === "repair" || (mode === "launch" && value.objective === "evaluate")) && (
        <>
          <fieldset id="run-models">
            <legend>{mode === "repair" ? "Model to repair the build" : "Models to test"}</legend>
            <p className={s.small}>
              {mode === "repair"
                ? "Choose one model to make the repair. The original build remains available."
                : "Each model gets the same prompts. Choose one model, or several to compare them."}
            </p>
            <div className={r.selectionHeading}>
              <p className={s.small} aria-live="polite">
                {selectedModels.length} {selectedModels.length === 1 ? "model" : "models"} selected
              </p>
              {selectedModels.length > 0 && mode !== "repair" && (
                <button
                  type="button"
                  className={s.textButton}
                  onClick={() => update({ builderModelIds: [] })}
                >
                  Clear models
                </button>
              )}
            </div>
            {hiddenSelections.length > 0 && (
              <div className={r.chips} aria-label="Selected models">
                {hiddenSelections.map((model) => (
                  <button
                    type="button"
                    className={r.chip}
                    key={model.id}
                    aria-label={`Remove ${model.name}`}
                    onClick={() =>
                      update({
                        builderModelIds: value.builderModelIds.filter((id) => id !== model.id),
                      })
                    }
                  >
                    {model.name} <span aria-hidden="true">×</span>
                  </button>
                ))}
              </div>
            )}
            <div className={s.field}>
              <label htmlFor={searchId}>Search models</label>
              <input
                id={searchId}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Model name"
              />
            </div>
            <div className={s.selectionGrid}>
              {visibleModels.map((model) => (
                <label className={s.choice} key={model.id}>
                  <input
                    type={mode === "repair" ? "radio" : "checkbox"}
                    name="builder-model"
                    checked={value.builderModelIds.includes(model.id)}
                    onChange={(event) =>
                      update({
                        builderModelIds:
                          mode === "repair"
                            ? [model.id]
                            : event.target.checked
                              ? [...value.builderModelIds, model.id]
                              : value.builderModelIds.filter((id) => id !== model.id),
                      })
                    }
                  />
                  <span>{model.name}</span>
                </label>
              ))}
            </div>
            {visibleModels.length === 0 && (
              <p className={s.small}>
                No models match “{query}”.{" "}
                <button type="button" className={s.textButton} onClick={() => setQuery("")}>
                  Clear search
                </button>
              </p>
            )}
          </fieldset>
          <details>
            <summary>How Basalt checks builds</summary>
            <p className={s.small}>
              Code checks test the facts Basalt can measure. The judge checks the rest against your
              success criteria, the same way for every model. Check costs show separately from build
              costs.
            </p>
            {modelSelect("grading-model", "Judge model", "gradingModelId")}
            {mode === "launch" && <JudgeSettingsFields value={value} update={update} />}
          </details>
        </>
      )}
      <details className={s.advanced}>
        <summary>More options</summary>
        <div className={s.form}>
          {(mode === "repair" || (mode === "launch" && value.objective === "evaluate")) && (
            <>
              {mode === "launch" && (
                <fieldset id="run-tool-sets">
                  <legend>Tools</legend>
                  <div className={s.selectionGrid}>
                    {harnesses.map((harness) => (
                      <label className={s.choice} key={harness.id}>
                        <input
                          type="checkbox"
                          checked={value.harnessIds.includes(harness.id)}
                          onChange={(event) =>
                            update({
                              harnessIds: event.target.checked
                                ? [...value.harnessIds, harness.id]
                                : value.harnessIds.filter((item) => item !== harness.id),
                            })
                          }
                        />
                        <span>
                          {harness.title}
                          <small>{harnessSummary(harness)}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                  <p className={`${s.small} ${s.toolSetNote}`}>
                    Each tool set is a saved file in the project, so you can’t change its settings
                    here.
                  </p>
                  {harnesses.map((harness) => (
                    <details key={harness.id}>
                      <summary>{harness.title} settings</summary>
                      <dl className={s.definitionList}>
                        {harnessSettingRows(harness).map((row) => (
                          <div key={row.label}>
                            <dt>{row.label}</dt>
                            <dd>
                              {row.label === "Tools" ? (
                                <span className={s.codeList}>
                                  {harness.tools.map((tool) => (
                                    <code key={tool}>{tool}</code>
                                  ))}
                                </span>
                              ) : (
                                row.value
                              )}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  ))}
                </fieldset>
              )}
              <div className={s.columns}>
                <div className={s.field}>
                  <label htmlFor="run-generations">
                    {mode === "repair" ? "Repair attempts" : "Builds per model"}
                  </label>
                  <select
                    id="run-generations"
                    value={value.repetitions}
                    onChange={(event) => update({ repetitions: Number(event.target.value) })}
                  >
                    {[1, 2, 3].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </div>
                <div className={s.field}>
                  <label htmlFor="run-captures">Observations per build</label>
                  <select
                    id="run-captures"
                    value={value.capturePasses}
                    onChange={(event) => update({ capturePasses: Number(event.target.value) })}
                  >
                    {[1, 2, 3].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </div>
              </div>
            </>
          )}
          {(mode === "replay" || mode === "public-development") && (
            <div>
              {" "}
              <div className={s.field}>
                <label htmlFor="run-captures">Observations per build</label>
                <select
                  id="run-captures"
                  value={value.capturePasses}
                  onChange={(event) => update({ capturePasses: Number(event.target.value) })}
                >
                  {[1, 2, 3].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
          {mode === "launch" && (
            <div className={s.field}>
              <label htmlFor="execution-capacity">Request priority</label>
              <select
                id="execution-capacity"
                value={value.capacity}
                onChange={(event) =>
                  update({ capacity: event.target.value as Options["capacity"] })
                }
              >
                <option value="interactive">Interactive · faster responses</option>
                <option value="flex">Flex · may wait longer</option>
              </select>
              <small>
                Interactive asks the provider for quick responses. Flex may wait when the provider
                is busy. Neither guarantees how long a run takes.
              </small>
            </div>
          )}
        </div>
      </details>
    </fieldset>
  );
}
