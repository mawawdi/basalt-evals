# Fresh detector-calibration population

The author authorized retiring the dependency on previous studies on 2026-09-25.
Experiment A will therefore use six newly generated sources, rather than claim to
reuse the missing historical candidates. Historical results cannot establish the
performance of this new population.

Freeze the compiled cooperative-gate and timed-shutter definitions, their checked
controls, and this population recipe before the first population-generation call.
Use the ordinary shared operation service, fresh endpoint snapshots and recommended
ceilings. Generate the following four blocks sequentially in the listed order:

| Block            | Task             | Builder                        | Independent trials |
| ---------------- | ---------------- | ------------------------------ | ------------------ |
| Gate Luna        | Cooperative gate | `openai/gpt-6-luna`            | 2                  |
| Shutter DeepSeek | Timed shutter    | `deepseek/deepseek-v4.1-flash` | 2                  |
| Gate DeepSeek    | Cooperative gate | `deepseek/deepseek-v4.1-flash` | 1                  |
| Shutter Luna     | Timed shutter    | `openai/gpt-6-luna`            | 1                  |

All six use the production harness: 32 turns, 8,192 output tokens per turn and at
most three public development runs, with no builder wall-clock cutoff. The frozen
operation manifests record actual seeds and any endpoint that does not support
them. Each ordinary generation operation includes one independent final capture
and its configured grading. These six preliminary captures and judgments are
population-construction work, quoted and reported separately from A. They do not
replace any of A's three fresh passes or select which candidates enter A.

Retain every planned trial and its outcome. Register every available sealed source
by saved operation/subject identity, preserving the builder receipt and source
hash. Do not replace a failed trial or choose candidates based on their quality.
If a trial produces no usable source, retain the planned denominator and report
the affected calibration workload as incomplete. Changing this rule requires a
new preregistration before further generation.

Within each task, order generated candidates by the block order above, then the
manifest's repetition and subject identity. This is also the development-only
parent-search order for matched repair. The population has three generated sources
per task and three sources per builder across both tasks; it is not a model-ranking
experiment.

Add one working and two targeted negative controls per task, retaining their
predeclared contrasts. A then preserves its planned 12 sources, four views, three
fresh passes, 144 capture cells, 504 judgment batches, 672 grader calls and 48
three-pass expert items. Seal source hashes and all views before calibration calls.
Development labels select the presentation before withheld work. No historical
tag-attachment fixture is needed for fresh builders using current public roles.

The expert remains the human author. Automated judgments and scripted test labels
cannot substitute for the required blind labels.
