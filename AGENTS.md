# Basalt Evals: rules for agents

Basalt Evals is a local workbench. It compares AI agents that build Roblox mechanics.
It freezes the test conditions and runs the builds under one spending limit. It
collects signed evidence from Roblox Studio and checks the evidence against authored
criteria.

These rules apply to all agents and all sessions in this repository.

## Language standard: ASD-STE100

Write all English text in ASD-STE100 Simplified Technical English. This includes
documentation, code comments, commit messages and reports to the user. Text that a person
reads in the console has an exception below.

- Use one word for one meaning. Use the same term for the same thing everywhere.
- Use the technical names of this project, for example "build", "capture" and
  "criterion".
- Write an instruction in the imperative. Put one instruction in one sentence.
- Use 20 words or fewer in an instruction. Use 25 words or fewer in a description.
- Write one topic in a paragraph. Use six sentences or fewer in a paragraph.
- Use the active voice. Use the simple present, simple past or simple future tense.
- Put a condition before its instruction: "If the run stops, read its failure".
- Do not use words that end in "-ing", except in technical names.
- Keep the words "the" and "a". Do not remove words only to make a sentence shorter.
- Do not use a noun cluster of more than three words. Write it again with a
  preposition.
- Use a vertical list for steps. Write the steps in the sequence that the reader does
  them.
- Do not use contractions, idioms or slang.
- Start a warning with a clear instruction. Then give the reason.

### Exception for console text

Console text that a person reads uses natural, plain English. ASD-STE100 is only a guide
for it. The user asked for this, because strict ASD-STE100 sounds forced in an interface.

- Write console sentences in short, plain English. Sentences include errors, notices,
  help text, empty states, confirmations and accessible descriptions.
- If an ASD-STE100 rule makes a console sentence sound forced, write the natural sentence.
- Write labels with the usual interface conventions. Labels include buttons, links,
  tabs, column heads, field names, menu items and status words.
- Use only the approved console words in `design-system/basalt/MASTER.md`. Use one
  approved word for one concept in all console text.
- `design-system/basalt/MASTER.md` gives the full rules for console text.

## Documents

One document is the authority for each topic. Change that document. Do not add a new
guide, a result diary or a completed checklist.

| Topic                                   | Authority                        |
| --------------------------------------- | -------------------------------- |
| Product and the main user journey       | `README.md`                      |
| Setup, commands, tests and recovery     | `docs/DEVELOPMENT.md`            |
| Implemented architecture                | `docs/ARCHITECTURE.md`           |
| Evaluation policy and claims            | `docs/EVALS.md`                  |
| Future work and its acceptance criteria | `docs/ROADMAP.md`                |
| Rationale and historical evidence       | `docs/RESEARCH.md`               |
| Visual design and console text          | `design-system/basalt/MASTER.md` |

- Keep `.agents/` and `.claude/` local. Git ignores them. Do not commit them.
- This repository is public. Do not put private details about people or other companies
  in it.
- If the code and `docs/ARCHITECTURE.md` do not agree, examine the code and the
  tests. Then correct the side that is wrong.

## Repository

- `apps/console`: the Next.js console.
- `packages/operator`: operations, the driver, quotes and reports.
- `packages/agent-runtime`: the model turns of builders and graders.
- `packages/model-client`: the provider transport and the spending ledger.
- `packages/studio-runner`: the native control of Roblox Studio.
- `packages/contracts`: the shared data shapes and their validators.
- `plugin/`: the Luau Studio connector.
- `tasks/` and `studies/`: task definitions and frozen study inputs.
- `test/`: the Node tests. `test/e2e` holds only tests that start the offline API.
- `.basalt-evals/`: the local workspace with runs, evidence and the journal. Git
  ignores it.

## Commands

```sh
npm install
npm test
npm run verify
npm run plugin:build
npm run console
```

- `npm test` is the only test gate. It takes approximately 1.5 minutes.
- `npm run verify` adds the console build and the browser check. Use it before a
  release.
- `npm run plugin:build` installs the connector at
  `$HOME/Documents/Roblox/Plugins/BasaltEvalStudioPlugin.rbxmx`.
- Use `node bin/basalt-evals.js` for the CLI. It loads the `.env` file.
- `npm run build` deletes `dist` and builds it again. Do not start it while another
  session has a live run or a test that reads `dist`.

## Data shapes and stored runs

- Make clean breaks. Delete superseded schemas, commands, packages and storage paths.
- Do not add compatibility readers, migrations, deprecated aliases or fallbacks for
  old shapes. Old stored data can become unreadable.
- Do not add version numbers to Basalt names, for example `@2`, `v2` or ordinal labels.
  Content hashes can identify immutable inputs and evidence.
- Record the versions of Roblox Studio and of provider models when they affect
  execution or evidence.
- Tell the user before you change grader text, tool schemas or the transport
  configuration. Basalt verifies a stored paid run when it reads it. It builds each
  request again and compares the hash, so these changes make all stored paid runs
  unverifiable.

## Evaluation integrity

- Keep these authorities separate: creator requests, observations, platform policies,
  agent hypotheses, evaluator criteria and benchmark oracles.
- Do not show hidden evaluator material to the builder.
- People write rubrics and expert criteria. Do not let a model write or change them
  inside an evaluated treatment.
- Keep generic harness packages independent of examples, evaluator fixtures, mechanic
  adapters, repair solutions and Studio registries.
- Keep Studio plans as canonical JSON data that fixed runner source interprets. Do not
  add code, expressions, callbacks, generic property access or mechanic harnesses.
- Use `eligible`, `rejected` and `incomplete` for the local gate. Use
  `locally_eligible` only for a candidate outcome.
- Do not call a candidate "Studio-verified" without an authoritative Studio
  evaluation.
- Do not say that one grader treatment is better without a controlled comparison.

## Models and spending

- Keep model orchestration in `packages/agent-runtime`. Keep each provider transport
  to one turn and easy to replace.
- Do not let provider SDK types into the runtime or the contracts.
- Use the smallest output limit of the frozen endpoint set for each model request. Do not
  add a Basalt output limit or a reasoning token limit.
- If the input bound of a builder request leaves less context, use the remaining context
  as its output allowance.
- All stages of a run share one spending limit. Each request reserves its full cost
  before it starts.
- Do not send an uncertain paid request again. Keep a call without a known result
  incomplete.
- Record a provider rejection as a known zero charge. A rejection is a 4xx result without a
  generation ID and without a cost. OpenRouter creates no generation for it.
- Let the bounded client retry a rate limit at most 3 times, after waits of 20 s, 60 s and
  120 s. Each try is a new request with its own receipt.
- Do not ask the user to examine provider activity or to supply generation IDs.

## Builder workspace access

- Limit builder access to declared roots and regular Luau source files.
- Use hash-guarded replacement and explicit creation of absent files.
- Stop on an unsafe path or a symbolic link.

## Live runs

- Get approval from the user for the scope of live runs. A budget that the user gives
  for a session covers all runs inside that scope. Ask again only when the scope changes
  or the budget is used.
- Do the scope that the user asked for. If you think that a larger scope is better,
  ask first.
- Before a run of more than 15 minutes, tell the user its time and cost. Calculate the
  time from a measured pace.
- A live run needs a clean, committed execution source. An uncommitted change to
  execution source stops the run.
- These paths are not execution source:
  - Markdown files at the root, in `docs/` and in `design-system/`
  - `apps/console/`, `test/` and `.github/`
  - `scripts/check-*` and `scripts/test-*`
  - the ignore files, `.prettierrc.json` and `eslint.config.mjs`
- Do not change execution source during a live run. Keep temporary files outside the
  checkout.
- Routine Studio trials use the native macOS worker on an isolated account. They do
  not need human clicks. Keep Studio outside containers.
- Stop only the process that the trial owns. Keep frozen inputs and failed attempts by
  default. Only a person deletes a run.
- The isolated account loads its own copy of the connector from
  `/Users/evals/.local/share/basalt-evals/plugins/`. After `npm run plugin:build`,
  compare the two hashes. If they differ, replace the copy atomically.
- Use concurrency and parallelism when they make a run faster. Queue only the steps that
  share one resource, for example the Studio session of the worker.

## Tests

- Run `git diff --check` and `npm test` before you complete a task.
- Keep `npm test` at approximately two minutes or less. A test that takes more than a
  few seconds must have a clear reason.
- Delete a slow test suite or make it smaller. Do not move it to a separate tier.
- Do not make model calls or Studio runs in tests.
- Put a test in `test/e2e` only when it starts the offline API environment.

## Other sessions

- Other agent sessions can work in this checkout at the same time.
- Keep changes that are not yours. Stage only the files that you changed.
- Tell the other sessions before you start `npm run build` or a live run.
- Get approval from the user before you remove data that you cannot make again.

## Reports

Tell the user these items:

1. What changed.
2. The commands that you ran and their exact results.
3. The model calls and Studio runs that you made, and their cost.
4. The problems that are still open.
5. The next smallest step.
