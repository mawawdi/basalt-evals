"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import type {
  ModelRegistry,
  RegisteredModel,
} from "../../../../dist/packages/operator/src/model-registry.js";
import type { CatalogModel } from "../../../../dist/packages/model-client/src/catalog.js";
import { MODEL_CONCURRENCY } from "../../../../dist/packages/contracts/src/execution-limits.js";
import { action, message, read } from "../components/api";
import s from "../components/workbench.module.css";

type SearchResult = CatalogModel & { added: boolean };

const concurrencyChoices = Array.from(
  { length: MODEL_CONCURRENCY.maximum - MODEL_CONCURRENCY.minimum + 1 },
  (_, index) => MODEL_CONCURRENCY.minimum + index,
);

const price = (value: number | null) =>
  value === null ? "unknown" : `$${value.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;

export function ModelManager({ initial }: { initial: ModelRegistry }) {
  const [registry, setRegistry] = useState(initial);
  const [defaults, setDefaults] = useState(initial.defaults);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run<T>(name: string, task: () => Promise<T>) {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      return await task();
    } catch (failure) {
      setError(message(failure));
      return null;
    } finally {
      setBusy(null);
    }
  }
  function accept(next: ModelRegistry, text: string) {
    setRegistry(next);
    setDefaults(next.defaults);
    setResults(
      (current) =>
        current?.map((item) => ({
          ...item,
          added: next.models.some((model) => model.id === item.id),
        })) ?? null,
    );
    setNotice(text);
  }
  const search = () =>
    run("search", async () => {
      const found = await read<SearchResult[]>(`/api/models/search?q=${encodeURIComponent(query)}`);
      setResults(found);
    });
  const add = (model: SearchResult) =>
    run(model.id, async () => {
      const next = await action<ModelRegistry>("/api/models/add", "add_model", { id: model.id });
      accept(next, `Added ${model.name}.`);
    });
  const remove = (model: RegisteredModel) =>
    run(model.id, async () => {
      const next = await action<ModelRegistry>("/api/models/remove", "remove_model", {
        id: model.id,
      });
      accept(next, `Removed ${model.name}. Runs that used it keep their saved model.`);
    });
  const save = () =>
    run("defaults", async () => {
      const next = await action<ModelRegistry>(
        "/api/models/defaults",
        "save_model_defaults",
        defaults,
      );
      accept(next, "Defaults saved. New runs start with these models.");
    });
  // Basalt saves a change immediately, and the unsaved defaults stay. Only the newest save of a
  // model changes the page.
  const concurrencySaves = useRef(new Map<string, number>());
  const showConcurrency = (id: string, maxConcurrentRequests: number) =>
    setRegistry((current) => ({
      ...current,
      models: current.models.map((item) =>
        item.id === id ? { ...item, maxConcurrentRequests } : item,
      ),
    }));
  const saveConcurrency = async (model: RegisteredModel, maxConcurrentRequests: number) => {
    const save = (concurrencySaves.current.get(model.id) ?? 0) + 1;
    concurrencySaves.current.set(model.id, save);
    showConcurrency(model.id, maxConcurrentRequests);
    const next = await run(`concurrency:${model.id}`, () =>
      action<ModelRegistry>("/api/models/concurrency", "save_model_concurrency", {
        id: model.id,
        maxConcurrentRequests,
      }),
    );
    if (concurrencySaves.current.get(model.id) !== save) return;
    const saved = next?.models.find((item) => item.id === model.id);
    // A refused change shows the value that Basalt kept.
    showConcurrency(model.id, saved?.maxConcurrentRequests ?? model.maxConcurrentRequests);
    if (saved)
      setNotice(
        `Saved. New runs send ${model.name} up to ${saved.maxConcurrentRequests} ${
          saved.maxConcurrentRequests === 1 ? "request" : "requests"
        } at once.`,
      );
  };
  const toggleBuilder = (id: string) =>
    setDefaults((current) => ({
      ...current,
      builderModelIds: current.builderModelIds.includes(id)
        ? current.builderModelIds.filter((item) => item !== id)
        : [...current.builderModelIds, id],
    }));
  const choice = (
    key: "gradingModelId" | "preparationModelId" | "coverageModelId",
    label: string,
  ) => (
    <label className={s.field}>
      {label}
      <select
        value={defaults[key] ?? ""}
        disabled={!!busy}
        onChange={(event) => setDefaults({ ...defaults, [key]: event.target.value || null })}
      >
        <option value="">None</option>
        {registry.models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <>
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={s.small} role="status">
          {notice}
        </p>
      )}
      <section className={s.section} aria-labelledby="your-models">
        <h2 id="your-models">Your models</h2>
        {registry.models.length === 0 ? (
          <p className={s.small}>
            You have no models yet. Search the OpenRouter catalog below and add the ones you want to
            test.
          </p>
        ) : (
          <>
            <p className={s.small} id="requests-at-once-help">
              Requests at once limits how many requests one run sends to a model at the same time.
              Lower it if the provider rate-limits your requests. Runs that already started keep
              their values.
            </p>
            <ul className={s.modelList} aria-label="Your models">
              {registry.models.map((model) => (
                <li key={model.id}>
                  <div>
                    <h3>{model.name}</h3>
                    <code>{model.id}</code>
                  </div>
                  <div className={s.modelActions}>
                    <label>
                      <input
                        type="checkbox"
                        checked={defaults.builderModelIds.includes(model.id)}
                        disabled={!!busy}
                        onChange={() => toggleBuilder(model.id)}
                      />{" "}
                      Default builder
                    </label>
                    <label className={s.modelConcurrency}>
                      Requests at once
                      <select
                        value={model.maxConcurrentRequests}
                        disabled={!!busy && busy !== `concurrency:${model.id}`}
                        aria-label={`Requests at once for ${model.name}`}
                        aria-describedby="requests-at-once-help"
                        onChange={(event) =>
                          void saveConcurrency(model, Number(event.target.value))
                        }
                      >
                        {concurrencyChoices.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Link
                      className={s.action}
                      href={`/?view=results&q=${encodeURIComponent(model.name)}`}
                      aria-label={`See results for ${model.name}`}
                    >
                      See results
                    </Link>
                    <Link
                      className={s.secondary}
                      href={`/runs/new?model=${encodeURIComponent(model.id)}`}
                      aria-label={`Run a benchmark with ${model.name}`}
                    >
                      Run with this model
                    </Link>
                    <button
                      type="button"
                      className={s.secondary}
                      disabled={!!busy}
                      onClick={() => void remove(model)}
                      aria-label={`Remove ${model.name}`}
                    >
                      {busy === model.id ? "Removing…" : "Remove"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section className={s.section} aria-labelledby="defaults">
        <h2 id="defaults">Defaults</h2>
        <p className={s.small}>
          New runs start with these models. You can change them for any run before it starts.
        </p>
        <div className={s.defaultsForm}>
          {choice("gradingModelId", "Default judge")}
          {choice("preparationModelId", "Preparation model")}
          {choice("coverageModelId", "Coverage model")}
          <p className={s.small}>
            After preparation, the coverage model compares the prepared tests with each criterion.
            Its notes show on the evaluation page and don’t change the tests. Pick a model from a
            different family than the preparation model.
          </p>
        </div>
        <button type="button" className={s.primary} disabled={!!busy} onClick={() => void save()}>
          {busy === "defaults" ? "Saving…" : "Save defaults"}
        </button>
      </section>
      <section className={s.section} aria-labelledby="add-model">
        <h2 id="add-model">Add a model</h2>
        <form
          className={`${s.modelActions} ${s.searchRow}`}
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <label className={`${s.field} ${s.modelSearch}`}>
            Search OpenRouter
            <input
              type="search"
              value={query}
              placeholder="Name or ID, for example qwen vl"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button type="submit" className={s.primary} disabled={!!busy}>
            {busy === "search" ? "Searching…" : "Search"}
          </button>
        </form>
        {results && results.length === 0 && (
          <p className={s.small}>No OpenRouter models match this search.</p>
        )}
        {results && results.length > 0 && (
          <ul className={s.modelList} aria-label="Search results">
            {results.map((model) => (
              <li key={model.id}>
                <div>
                  <h3>{model.name}</h3>
                  <code>{model.id}</code>
                  <p className={s.small}>
                    {model.inputModalities.includes("image") ? "Reads images" : "Text only"} ·{" "}
                    {model.contextLength
                      ? `${model.contextLength.toLocaleString("en-US")} tokens of context`
                      : "Context unknown"}{" "}
                    · {price(model.promptPerMillionUsd)} input and{" "}
                    {price(model.completionPerMillionUsd)} output per million tokens
                  </p>
                </div>
                <div className={s.modelActions}>
                  {model.added ? (
                    <span className={s.small}>Added</span>
                  ) : !model.tools ? (
                    <span className={s.small}>No tool calls</span>
                  ) : (
                    <button
                      type="button"
                      className={s.secondary}
                      disabled={!!busy}
                      onClick={() => void add(model)}
                      aria-label={`Add ${model.name}`}
                    >
                      {busy === model.id ? "Adding…" : "Add model"}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
