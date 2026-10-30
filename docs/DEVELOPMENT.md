# Development and operation

Other documents are the authority for these topics:

- [README](../README.md): the product journey.
- [Architecture](ARCHITECTURE.md): the service boundaries.
- [Evaluation policy](EVALS.md): the rules for evidence and review.

## Local setup

You need these items:

- Node.js 22.13 or newer, npm and the Rokit tools in [rokit.toml](../rokit.toml).
- On the controller: `luau-lsp` and `rojo` at the versions that `rokit.toml` pins. The
  source analysis runs them from the repository root, because Rokit reads the pins there.
- For live execution: Roblox Studio with its MCP server enabled, a separate macOS GUI
  login, localhost SSH without a password and a pinned signing key for the worker.
- Provider credentials, but only for paid model work that you explicitly authorized.

```sh
npm install
npm run verify
npm run plugin:build
npm run console
```

The console listens on loopback at <http://127.0.0.1:43127/>. `npm run console` serves the
production build. If there is no build, or if the build is stale, the command builds it
one time. Later starts use that build again. If an owned execution is active, an automatic
rebuild cannot replace its code. If the port is in use, the command gives a short
explanation and does not stop the server that is already active.

The console and the CLI entry point load the `.env` file of the repository automatically.
Git ignores this file. The working directory of the shell has no effect on this. Execution
workers inherit this server environment.

Set `OPENROUTER_API_KEY` in this file, or export it before startup. Exported values have
priority. If you change credentials, restart the console. Inspection works without a
credential. Settings shows whether the credential is present, but it never shows its
value.

Use `npm run console:dev` only for UI development. This command compiles the TypeScript
services again and then starts the Next development mode. In this mode, Next compiles each
page on demand at the first visit, so first visits are slower. For an explicit production
build, use `npm run console:build`.

Never put secrets in authored inputs, browser execution requests, fixtures or Git.

## Runtime bounds and reference tests

A normal authorization first checks Studio. Then preparation sends a public proposal, and for
each stage a private plan and private criteria. Each one gets a maximum of three corrections.
A part that Basalt keeps from an earlier version sends no request. If the criteria do not
compile on a kept plan, the stage prepares a new plan and new criteria. Preparation does not
generate reference builds. Saved definitions that are ready skip preparation.

Preparation, builds and checks have no elapsed-time cutoff, no SDK request timer and no
HTTP response timeout. Spending limits, turn limits, output size and an explicit Stop
still control admission. If the transport ignores the abort, Stop still keeps the pending
charges of uncertain requests. The safeguards for Studio startup and acquisition stay
separate, in `packages/contracts/src/execution-limits.ts` and in the native worker.

When Basalt stops Studio, it waits for the signed terminal receipt of Studio. It uses a
new recovery signal for this wait. It does not use the cancelled execution signal again to
transfer the receipt. If the recovery of the receipt fails, the native lane stays owned
until a read-only reconciliation proves termination. Never delete its ownership marker to
start a new run.

If preparation fails after its corrections, that attempt stays stopped, and Basalt keeps
its charges. Resume and an increase of the spending limit cannot correct it. Do these
steps:

1. Read the explanation of the run and its **Technical details**.
2. If the explanation names a gate, change that gate to an event after an action.
3. Set up a new run from the saved evaluation. Each run prepares the checks again.
4. Authorize the new run.
5. If the new run fails in the same way, edit the criterion that the details name.

Do not change the criteria that people wrote only to clear a system error.

To test a definition explicitly with reference builds, use one of these two paths:

- The action on the detail page of the evaluation.
- The canonical launch preview with `kind: "reference"`. Its selection contains
  `revisionId` and `gradingModelId`.

Authorize that preview with a separate spending limit. Ordinary results and reference
tests use the same configuration to calculate scores. Research registration still needs a
checked reference record.

### Tool sets and API notes

A tool set is a harness file. To add a tool set, do these steps:

1. Write `studies/harnesses/<id>.json`. The file name is the harness ID.
2. Give each setting of `HarnessDefinition` (`docs/ARCHITECTURE.md`, "Builder harnesses").
   Set `notesPack` to a pack ID or to null. Add `verifyLint` only for lint feedback.
3. Commit the file. A live run needs committed execution source.
4. Open the run setup. The tool set shows under More options.

To change the tool set of new runs and repairs, set `defaultHarnessId` in
`studies/operator-config.json`.

To give a tool set an API notes pack, do these steps:

1. Read each file of `studies/notes/<id>/` and correct the facts.
2. Set `review` to `person_reviewed` in its `pack.json`.
3. Set `notesPack` of the tool set to the pack ID.
4. Add `notes.list` and `notes.read` to its tools, and `{{notes}}` to its template.
5. Commit the changes.

If the preview refuses a pack because it repeats private text of an evaluation, edit the
pack. Do not edit the criteria to clear the refusal. If a freeze reports that a pack
changed after the preview, make the preview again.

## Native execution setup

Studio runs outside containers, in the GUI session of an isolated account. One isolated
account is a Studio worker. To set up the account of a worker, do these steps:

1. Provision Studio.
2. Enable the MCP server of Studio.
3. Set `Studio.PluginsDir` to the absolute path of `~/.local/share/basalt-evals/plugins`.
   Keep no other Studio plugin in the account. A plugin dialog can cover the Edit window in
   a recording.
4. Install the same connector bytes in the plugin directory that `Studio.PluginsDir`
   actually sets for that account.
5. After each new build of the connector, verify the installed bytes.
6. Turn off window restoration for Studio in the account of the worker:

   ```sh
   defaults write com.Roblox.RobloxStudio ApplePersistenceIgnoreState -bool YES
   ```

Do not skip step 6. After a Studio crash, macOS otherwise shows a modal alert at each new
start of Studio. No person answers it in the worker session, so each later Studio start
stops at the readiness limit.

The primary build command always writes
`$HOME/Documents/Roblox/Plugins/BasaltEvalStudioPlugin.rbxmx`. This command alone does not
update the configured plugin directory of another account. Keep the plugin directory of
each worker outside disposable trial storage. When you clear `~/BasaltTrials`, never remove
the connector, the golden template or the signing key.

### Studio workers file

Git ignores the host file `.basalt-evals/native-worker/workers.json`. This file names the
Studio workers. Create it with this exact shape:

```json
{
  "schema": "basalt-evals/studio-workers",
  "workers": [
    {
      "id": "evals",
      "user": "evals",
      "sshKeyFile": "/absolute/path/to/localhost-ssh-key",
      "nodeExecutable": "/absolute/path/to/node",
      "lanes": [0],
      "maxClients": 2,
      "screenRecording": false
    }
  ]
}
```

Each field of a worker has one meaning:

- `id`: the name of the worker in commands. It has 1 to 32 lowercase letters, digits and
  hyphens.
- `user`: the macOS account of the worker. It cannot be the controller account. Two
  workers cannot use the same account.
- `sshKeyFile`: the absolute path of the localhost SSH key without a password.
- `nodeExecutable`: the absolute path of Node in the account of the worker.
- `lanes`: the global lane numbers of the worker, from 0 to 3. Two workers cannot use the
  same lane. Lane n uses the connector port 43123 + n. The console shows lane n as Studio
  slot n + 1.
- `maxClients`: the largest number of Studio clients in one job, from 1 to 8. A job can
  take any slot, so the launch preview refuses a plan with more clients than the smallest
  `maxClients` of the workers.
- `screenRecording`: true records the Studio windows of each job of the worker. The
  recording is a diagnostic. Refer to [Screen recording](#screen-recording).

Before you give the workers two or more lanes in total, do a control trial on this Mac.
Two Studio jobs share the CPU and the memory, and timed scenarios can give different
results. Each lane claim is in `.basalt-evals/native-worker/lanes/<n>`.

The number of lanes is a setting that only a person changes. Use one lane, `[0]`, unless a
control trial shows that two lanes keep the evidence complete. A second lane does not start
at all times. Basalt starts a job beside a running job only if this Mac has enough free
memory and spare CPU for one more job, from the measured footprint of the last 10 jobs.
It also needs no Studio MCP in your own account: close the Studio MCP server of your own
agent sessions before a run with two lanes. Before the first measured job, only one lane runs. A job that waits for headroom starts as
soon as no other job holds a lane. A change of `lanes` changes the Studio environment identity, so
it needs a new preview and a new readiness check.

### Golden preferences template

After you set up Studio in the account of a worker, capture its golden preferences
template:

```sh
node bin/basalt-evals.js studio template capture <worker-id>
```

The worker reads `~/Library/Roblox/GlobalSettings_13.xml` and the defaults domain
`com.Roblox.RobloxStudio` of its own account. The capture refuses these preferences:

- A key that looks like a credential: it contains cookie, token, auth, session, login or
  password.
- A `Studio.PluginsDir` other than `~/.local/share/basalt-evals/plugins`.
- An `ApplePersistenceIgnoreState` other than YES.

The worker keeps the template in `~/.local/share/basalt-evals/golden/`. Basalt records its
hash in `.basalt-evals/native-worker/templates/<worker-id>.json`. The environment identity
of Studio binds this hash. Thus a new capture needs a new preview.

Before a job starts Studio, the worker resets the Studio preferences of its account to the
template. The reset occurs only when no other slot of the worker has a claim and no Studio
process of the account runs. Otherwise the job keeps the current preferences, and its
signed manifest records `skipped_busy`. The reset uses `defaults import` and an atomic
replacement of the settings file. It never changes logs, plugins, cookies or the Keychain.
After an intentional change of the Studio settings of a worker, capture the template again.

### Screen recording

A worker with `screenRecording: true` records the windows of its own Studio processes at 2
frames each second. A recording stops at 30 minutes or 256 MiB. A recording failure never
fails the job, and the signed manifest records it. To allow the recording, do these steps:

1. Log in to the account of the worker.
2. Open System Settings, then Privacy & Security, then Screen & System Audio Recording.
3. Grant the permission. The jobs start over SSH, so macOS can ask for the permission of the
   SSH service (`/usr/libexec/sshd-keygen-wrapper`) and not of the recorder.
4. Run one job. If its recording failed, read `diagnostics/recorder.log` in the job folder
   below `~/BasaltTrials` of the worker.

Basalt imports each recording to `diagnostics/screen.mp4` beside the session of the
observation, outside the signed tree. The import checks the size and the hash that the
signed manifest records. Only `GET /api/operations/:id/screen?unit=<observation>` serves a
recording. Reviews, judges and exports never read it.

### Signing key and checks

To set up the signing key of the workers, do these steps:

1. Provision the key pair of the workers independently.
2. Pin the public key at `.basalt-evals/native-worker/isolated-public-key.pem`.
3. Keep the private key in each worker account.

The native adapter puts the trial inputs below `~/BasaltTrials` of the worker. It verifies
the configured connector and imports signed results that are bound to hashes. Basalt never
starts Studio in the GUI account of the operator as a fallback.

The worker runs from a compiled bundle at `/Users/Shared/basalt-evals-worker-<inputs>`.
Basalt builds this bundle one time for each change to `packages`. After verification,
Basalt uses the bundle again. While no Studio job runs, you can remove superseded bundles.

Settings shows the provider configuration, Studio, the connector, the setup of the
isolated accounts and the signing key for evidence. Settings and Recheck setup also run the
read-only preflight of each worker over SSH. The preflight makes no model call and does not
start Studio. It checks these items, and it gives one sentence for each failed check:

- The SSH connection and the account name.
- Node in the account of the worker.
- The Studio version on this Mac.
- The plugin folder of Studio and the bytes of its connector.
- `ApplePersistenceIgnoreState`.
- The golden template and its recorded hash.
- The GUI login session of the account.
- The lane folders.

Each run also runs the preflight before its readiness check takes a slot. After an update of
Studio or a change to the connector, do these steps:

1. Check the readiness again.
2. Create new work from a new preview.

Do not rewrite failed receipts. Do not bypass a frozen implementation identity. You can
examine saved evidence without the prerequisites for live execution.

## Verification

```sh
git diff --check
npm run verify
npm run plugin:build
```

Run these commands in sequence, because the builds share `dist`.

`npm test` is the only test gate. It takes approximately one and a half minutes. It runs
these checks:

- The format check and lint.
- The documentation links and diagrams.
- TypeScript.
- Task validation.
- The Node unit tests and component tests.
- The end-to-end tests in `test/e2e`. They drive the offline HTTP API and an owned child driver
  through preparation, build, capture, checks and review.
- Journal crash recovery.
- The script tests of artifact health, project discovery and the console launcher.
- The parse, analyze and module tests of the connector.
- Study fixture checks.
- Temporary Rojo builds.

The format check and lint keep content caches in `node_modules/.cache`. A cache entry is
valid only for the same file content, tool version and configuration. If you think that a
cache result is wrong, delete `node_modules/.cache` and run the gate again.

`npm run test:node` runs only the Node tests. Keep the gate at approximately two minutes
or less. If a scenario is slow, delete it or make it smaller. Do not move it to a separate
tier.

If a test starts the offline API environment, put it in `test/e2e`. Put no other test
there. `verify` runs `npm test`, the production build of the console and the browser
integration test.

The browser test uses the real HTTP boundary, the owned child driver, the SQLite journal
and signed synthetic adapters. Its screenshots and result manifest are in
`.basalt-evals/console-check`. The test uses states with data, empty states, interrupted
states and partial states, with keyboard interactions. It captures each state at 1440 and
390px, checks reflow at 768 and 1024px, and scans each state for accessibility.

Approximately twenty representative states also use the dark scheme, real Chromium tab
zoom at 200% and 400%, and text-spacing overrides. These results are not real Studio
captures, independent human labels or a full manual accessibility audit.

Each entry in the evaluation library keeps a stable identity across edits. Working copies
use compare-and-swap revisions and the expected earlier authored snapshot in the journal.
The revision checks of the server reject stale writes. Concurrent editors and suite
dialogs keep a recovery record for each session.

Before you explicitly load or apply text again, compare the saved text. Basalt keeps the
previous conflict text separately. If the save to the server and the save to the device
both fail, the UI shows that the text is unsaved. It keeps the text in the memory of the
tab, and it lets you copy the text or try again. Keep the tab open until one durable save
is successful.

Each launch identity has a separate recovery of run setup. When you type a spending limit,
the value replaces the transient history. Basalt keeps a maximum of 40 disposable
selection snapshots. Basalt never prunes an unresolved launch authorization with those
snapshots.

Review recovery has a separate scope for each reviewer, review, question and tab session.
Immutable inputs and execution ledgers are independent of these recovery records.

A conflict keeps the answer and any concern that something could reveal the source. If a
conflict occurs, do these steps:

1. Load the saved answer again.
2. Choose explicitly whether to restore the local draft.

Basalt does not overwrite the answer automatically.

If you clear the journal, Basalt creates a new workspace identity. At its next load, the
console clears the earlier recovery records of the editor, run setup and reviews. It keeps
the explicit run preferences. Browser writes carry `X-Basalt-Workspace`. A tab from a
cleared workspace must load again before it can change current data.

Before an authorized reset, do these steps:

1. Make sure that no owned work is active.
2. Take an external verified snapshot.
3. Make sure that the snapshot keeps the unresolved costs and ownership records.

A blank dashboard does not cancel unresolved costs or ownership records.

After you send a launch request, the form keeps its exact inputs and spending limit. If
the connection is interrupted, the form offers the recovery of that authorization. The
settings stay fixed until the outcome of the authorization is known. If you open the form
again, it cannot create a second execution.

Tests must not make real model calls or start Studio. Record the actual results of the
commands. Do not keep test counts in this guide, because they change. `plugin:build`
writes the installed connector. A temporary Rojo build does not replace it.

## CLI and HTTP entry points

For the exact arguments, run `node bin/basalt-evals.js --help`.

If stderr is a terminal, some commands write one more line on stderr after their JSON
result. The line gives the URL where you can open the result:

- `launch authorize` and `operation command` give the run page, `/runs/<id>`.
- `comparison create` gives `/comparisons/<id>`.
- `review create` gives `/reviews/<id>`.
- `export run` and `export comparison` give the `file://` URL of `index.html` in the new
  folder.

The console URLs use port 43127, which is the default port of `npm run console`. A failed
command writes no line. If stderr goes to a pipe or a file, the command writes no line, so
a script gets only the JSON on stdout.

- Working copies: `GET /api/working-copies/:id`, and `POST` with
  `X-Basalt-Action: save_working_copy`. The body is
  `{revision,evaluationId,baseDraftId,title,prompt,criteria}`. A new evaluation uses null
  identity bindings. A `revision` of zero creates a working copy. To publish, use
  `POST /api/working-copies/:id/publish` with the action `save_evaluation` and
  `{revision}`. A conflict returns 409, and the local text stays. To archive or restore,
  use `POST /api/evaluations/:id/archive` with the action `archive_evaluation` and
  `{archived}`.
- Evaluations and launch: `eval save`, `launch preview <intent.json>` and
  `launch authorize <authorization.json>`. The authorization contains `previewId`,
  `ceilingUsd` and `idempotencyKey`. An ordinary preview uses `kind: "evaluation"`
  and the selection `{sources:[{kind:"draft",id}],objective:"evaluate",builderModelIds,
harnessIds,repetitions,capturePasses,gradingModelId,judgeSettings,preparationModelId,
coverageModelId,capacity}`. The judge settings are `{samples,grouping}`, with 1 to 5
  samples and the grouping `shared` or `per_criterion`. To set them on the command line, add
  `--judge-samples <1-5>` or `--per-criterion` after the intent file of `launch preview`.
  The flags apply to an `evaluation` or a `regression` intent. The sources can mix drafts
  and ready evaluations. To retry one submission, use the same key again. Use a new key only
  when you intentionally start another run.
- Explain failures: use `launch preview` with `kind: "explain_failures"` and the selection
  `{revisionId,modelId}`. Then use `launch authorize` with an explicit spending limit. The
  preview fails when the evaluation has no plan warning. A person edits the questions in
  `studies/failure-questions.md`. After a review, change its status line to
  `Status: reviewed`. A change to the questions needs a new preview.
- Progress and recovery: `operation status`, `operation outcomes` and
  `operation command <id> <command.json>`. A command has a `kind` of `stop`, `resume`,
  `reconcile`, `budget` or `amend`. It also has the necessary reason, spending limit or
  preview.
- Archive and delete: `operation archive <id> <true|false>`, `operation delete <id>`,
  `operation deleted` and `eval delete <id>`. In HTTP, use
  `POST /api/operations/:id/archive` with the action `archive_run` and `{archived}`,
  `POST /api/operations/:id/delete` with `delete_run` and `{}`, and
  `POST /api/evaluations/:id/delete` with `delete_evaluation` and `{}`. A refusal returns
  409 and names its cause. `GET /api/deleted-runs` lists the spending records of deleted
  runs. If a delete stops after its journal step, run `operation delete <id>` again. This
  command removes the files that wait for removal.
- Reusable workloads: `suite create`, `suite save`, `suite list`, `suite read`,
  `suite baseline`; `comparison preview`, `comparison create`, `comparison report`;
  `regression save`, `regression list`, `regression read`, `regression holdout`. The JSON of
  `comparison preview` is `{populations:[{operationId,treatmentId}]}` with two to six runs in
  the order of the columns. `treatmentId` is null when a run has one judge. A launch
  intent identifies exact evaluation sources or a saved example. A suite expands to its
  saved evaluations. A reassessment identifies the saved run, build, model and evidence
  form. It does not need a Studio installation.
- Rechecks and known builds: `recheck preview <selection.json>` classifies saved builds
  with another revision and runs the code checks at no cost. The selection holds
  `operationId`, `subjectIds`, `revisionId` and `judge` (`{modelId, presentation}` or null).
  Each paid part is a launch with the intent `recheck` and the `part` `judge` or
  `observation`. For known builds, use `known-build mark`, `known-build retire`,
  `known-build list <library-evaluation-id>` and `known-build gate <evaluation-id>`.
- Preparation parity study: `parity curate <task-directory> <source-id>...`,
  `parity prepare <study-id> <preparation-model-id>...`,
  `parity run <study-id> <evaluation-id>...` and
  `parity report <study-id> <curated-operation-id> <model-id>=<operation-id>...`. The
  `prepare` and `run` commands give launch previews. A run starts only after you authorize
  its preview with a spending limit.
- Drafts and clarifications: `eval save`, `eval read`, `eval list`,
  `eval clarifications` and `eval clarify`.
- Research analysis: `experiment report`, `experiment discovery`,
  `experiment repair-population` and `operation public-feedback`.
- Models: `models list`, `models search <words>`, `models add <id>`, `models remove <id>`,
  `models defaults <defaults.json>` and `models concurrency <id> <1-16>`. The search reads
  the public OpenRouter catalog and sends no model request. The defaults JSON holds
  `builderModelIds`, `gradingModelId`, `preparationModelId` and `coverageModelId`. The
  concurrency is the most requests that one run sends to the model at the same time. In HTTP,
  use `GET /api/models`, `GET /api/models/search?q=`, and `POST /api/models/add`, `/remove`,
  `/defaults` or `/concurrency` with the actions `add_model`, `remove_model`,
  `save_model_defaults` and `save_model_concurrency`. The body of `/concurrency` is
  `{ "id": "<id>", "maxConcurrentRequests": <1-16> }`.
- Local checks: `task validate`, `task show` and `doctor`.
- Studio setup: `studio template capture <worker-id>`. Refer to
  [Golden preferences template](#golden-preferences-template).
- Optional review: `review preview`, `review create`, `review second`,
  `review round-two`, `review list`, `review progress`, `review session`,
  `review question`, `review draft`, `review answer`, `review activity`,
  `review end`, `review report`. A draft JSON or an answer JSON holds `reason`:
  `{ "code": ..., "sentence": ... }`.

The JSON for `suite create` and `suite save` needs `actionId`, `title`, `description`,
`members` and `expectedSnapshotId`. For each deliberate free save, use a new UUID. Keep
the exact request and identity until its result is known. A retry of that request returns
the original suite. Basalt rejects changed inputs under that identity.

In the browser, you can create and edit suites, and Basalt keeps their historical
snapshots. The browser deliberately has no archive or restore for suites. `suite baseline`
assigns a finished run of the exact snapshot. The browser shows that assignment, but it
does not create it.

To create a local reviewer, use `reviewer create`. To select a reviewer, use
`reviewer list`. `review select` saves run selection snapshots, and `review selection`
shows them. `review treatments` lists the frozen grading streams. Blind actions need the
reviewer ID of the review. A research registration must name that same authority. The
HTTP lists of reviews can filter `purpose` and `state` independently.

- Trusted research setup: `source register`, then `experiment register`, then the
  `research` launch intent. Protocols are data on the server. They are not execution
  programs from the browser.
- Anchor builds: `exemplar choose <exemplar-choice.json>` saves the anchor builds of one
  criterion. The JSON holds `evaluationId`, `criterionId`, `reviewerId`, `reason` and
  `exemplars`. Each item of `exemplars` is `{savedExampleId,captureId}` or
  `{operationId,subjectId,captureId}`. `exemplar read` and `exemplar list` are also
  available.
- Anchor build pairs: use `launch preview` with the `exemplar_comparison` intent. The
  selection holds `operationId`, `subjectId`, `modelId`, `criterionIds` and
  `analysisPlanId`. Then use `launch authorize` with an explicit spending limit.
  `exemplar report <operation-id>` reads the verified report.
- Export: `export run|comparison <id> <new-directory> [--private]` writes `index.html`,
  `report.json`, `manifest.json` and, for a run, one ATIF trajectory of each build. The
  folder must not exist. Basalt refuses a run that can still start work. Without
  `--private`, the export numbers the criteria and has no criterion text, reasons or images.
- Dataset: `export dataset <run-id> <new-directory> [--private]` writes `builds.jsonl` with
  one line for each build, `dataset.json`, the ATIF trajectories and `manifest.json`. It has
  the same folder, run and scope rules as `export run`.
- Sequence timing: `sequence timing <sequence-directory>` reads the `index.json` of a
  stored acquisition. It reports screenshot widths, gaps and clock residuals.
- Historical inspection: `archive seal <operation-id>`, `archive list`, `archive read`. `archive seal` indexes saved historical bytes. It does
  not import their schemas or labels into current reports.

| API family                                                                                 | Responsibility                                                       |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `/api/launch-previews`, `/api/operations`                                                  | Canonical intent preview and run authorization                       |
| `/api/launch-authorizations/:identity`                                                     | Read the original authorization after refresh or a lost response     |
| `/api/run-inbox`, `/api/evaluations`, `/api/runs`, `/api/results`                          | Active work, interruption counts, search, and pagination             |
| `/api/evaluations/current`, `/api/evaluations/:id/archive`, `delete`                       | Current evaluation summaries, archive, restore and delete            |
| `/api/working-copies/:id`, `/api/working-copies/:id/publish`                               | Save a working copy and publish it as an evaluation                  |
| `/api/benchmarks`, `/api/notifications`                                                    | Benchmark reports and console notices                                |
| `/api/launch-options`, `/api/readiness`                                                    | Registry choices and local prerequisites                             |
| `/api/eval-authoring`                                                                      | Free drafts and preparation diagnostics                              |
| `/api/eval-authoring/:id/clarification`, `/api/operations/:id/clarifications`, `authoring` | Clarification answers and the result of a preparation                |
| `/api/operations/:id/progress`, `/api/operations/:id/commands`                             | Shared lifecycle, costs and supported recovery commands              |
| `/api/operations/:id/archive`, `/api/operations/:id/delete`                                | Archive, restore and delete of a settled run                         |
| `/api/deleted-runs`                                                                        | Permanent spending records of deleted runs                           |
| `/api/operations/:id/results`, `evidence`, `asset`, `activity`, `assessment`               | Indexed results/activity and focused verified inspection             |
| `/api/operations/:id/screen`                                                               | Screen recordings of observations, a diagnostic outside evidence     |
| `/api/operations/:id/side-by-side?left=&right=&criterion=&pass=`                           | Released evidence of two builds of one evaluation, side by side      |
| `/api/operations/:id/outcomes`, `subjects`, `spending`                                     | Verified outcomes, the builds of a run and its spending records      |
| `/api/operations/:id/causes`                                                               | The units that did not finish, by recorded cause                     |
| `/api/operations/:id/analysis`, `repair-discovery`, `repair-population`, `public-feedback` | Research analysis, repair discovery and saved public feedback        |
| `/api/operations/:id/comparison`                                                           | Verified report of anchor build pairs                                |
| `/api/operations/:id/model-report`                                                         | Tests of model pairs and tool-set pairs, and failure patterns        |
| `/api/runs/:id/units/:stage-:unit/log`                                                     | The plain-text log of one build or judgment                          |
| `/api/operations/:id/build?candidate=&page=`                                               | How one build was built, in pages of 10 turns                        |
| `/api/operations/:id/export?scope=`, `/api/comparisons/:id/export?scope=`                  | A `.tar` export in the `public` (default) or `private` scope         |
| `/api/operations/:id/dataset?scope=`                                                       | A `.tar` dataset of the builds of a run, in the same scopes          |
| `/api/exemplars`, `/api/exemplars/:evaluationId`                                           | Save a choice of anchor builds and list the current choices          |
| `/api/suites`, `/api/comparisons`, `/api/regressions`                                      | Frozen workloads, explicit baselines, comparisons and saved examples |
| `/api/evaluations/:id/recheck`, `known-build-gate`                                         | Recheck saved builds and read the known build gate of a revision     |
| `/api/known-builds`, `/api/known-build-retirements`                                        | Mark, list and retire known builds                                   |
| `/api/experiments`                                                                         | Registered protocol inspection                                       |
| `/api/reviewers`                                                                           | Local profile list/create/read; names never merge identities         |
| `/api/review-batches/selections`                                                           | Immutable snapshots of run selections, with identifiers only         |
| `/api/review-batches/treatments`                                                           | Catalog of the frozen grading streams of each run                    |
| `/api/review-batches`                                                                      | Preview, create, second reviewer, round 2, progress, report          |
| `/api/reviews`                                                                             | Blind sessions, assignments, drafts, answers, and verified assets    |
| `/api/archives`                                                                            | Verified historical file inspection                                  |

A browser request needs a loopback Host, the same Origin for mutations, named action
headers, bounded payloads and server validation. Filesystem paths, worker programs and
provider access stay on the server. The evidence and assets of a run need a `candidate`
identity. An optional selection of criteria narrows the judgment projection. Results and
activity use pages of 20 rows, with a maximum of 50. The browser recovery of drafts and
launches uses the same launch contract as the API and the CLI.

`catalog rebuild` restores the disposable indexes and the progress record of each run from
the saved journal, which is the authority. Before you change persisted contracts, do these steps:

1. Stop the owned work.
2. Take an external snapshot.

Unsupported historical shapes stay as archive material. There are no compatibility readers
or migrations. Never drop pending charges or ownership evidence.

## Recovery and contribution

Before you resume a run, examine its status, receipts, source lineage and original
evidence. If saved evidence is damaged, Stop is still available. Stop keeps the open
requests and the pending charges. Resume still needs verified evidence.

Resume checks the ownership, the execution identity, the open actions and the cumulative
ledger. If a saved response exists, use it. Do not send the request again. If a terminal
request has no price, Basalt keeps its full pending charge. Open or unbound calls stay
incomplete. Routine recovery does not need a provider Activity lookup.

If a provider failure pauses a build or a judgment, the run page names the cause in one
sentence. A higher spending limit does not continue the paused work. Do these steps:

1. Read the cause. An account pause comes from the API key, the credits or another refusal
   of the account. A model pause comes from a model that OpenRouter cannot serve. A
   persistent pause comes from repeated rate limits or server failures.
2. Correct the cause in OpenRouter, or wait until the provider is available again.
3. Select Resume. Basalt sends a new request for the paused step as the next request
   ordinal. The rejected request keeps its known charge.

Each build and judgment keeps an append-only log at
`.basalt-evals/eval-operations/<run>/units/<stage>-<unit>.log`. The log records the start,
the request ordinals, the tool names, the pauses and the failures, to a maximum of 8 MiB.
Details links each log, and `GET /api/runs/<run>/units/<stage>-<unit>/log` returns it. An
unknown or recovery failure also keeps a redacted stack file in
`.basalt-evals/eval-operations/<run>/failures/stacks/`. Its failure record names the file
hash in `evidenceRefs`. The stack file keeps no provider key and no authorization header.

After each build, Basalt analyzes the sealed source with the pinned `luau-lsp`. If a tool
is absent or has another version, the build continues and its unit log records
`source_analysis_failed`. A code check that reads the analysis then stops with the cause.
Do these steps:

1. Run `rokit install` in the repository root.
2. Make sure that `luau-lsp --version` and `rojo --version` show the pins of `rokit.toml`.
3. Select Resume. The code check makes the analysis again.

A tool set with lint feedback also runs these tools for each `workspace.verify`. If a tool
is absent, the builder gets one line that says that lint is unavailable, and the build
continues without the treatment. Install the tools before a run of such a tool set.

Basalt stores each analysis at `.basalt-evals/source-analysis/<key>.json`. The key is the
hash of the build and the toolchain. Do not edit or delete a stored analysis while a saved
run uses it, because Basalt reads it again to verify the code checks of that run.

If preparation fails at the output limit, Basalt keeps the response and the charges. It
also does not make a new plan automatically. Examine the saved response before a new
launch. Do not increase request limits or change models inside the original authorization.

A native cancellation acts only on the process tree that the trial owns. An SSH disconnect
does not prove that Studio stopped. If the Studio updater exits, this is an infrastructure
interruption, not an outcome of the build. In that case, do these steps:

1. Finish the official update in the isolated login.
2. Keep the failed attempt.

If the process of a run stops during a dispatched Studio job, the slot stays claimed. A later
job takes the slot back only under the conditions in
[Architecture](ARCHITECTURE.md#fixed-studio-execution-and-evidence). Then Resume records the
observation as incomplete with the cause `studio_job_lost`. Basalt never stops a process for this.
Never delete a lane claim by hand while its job can run.

After a test passes or fails, and its owned workers stop, the test deletes its synthetic
workspace. Browser screenshots and the latest result manifest stay in
`.basalt-evals/console-check`. Test logs go with the acceptance evidence. A complete
native transfer verifies the imported session and then removes its staged copies. If an
import is interrupted, Basalt keeps the staged copies until the reconciliation finishes.

Keep historical artifacts for one of these named purposes: reusable authored inputs,
current acceptance evidence, selected results, or unresolved costs and ownership. An
explicitly authorized retirement can remove obsolete raw evidence and its archive entries
together. Before you remove evidence, check if a saved evaluation, replay or review uses
it. For unresolved calls, keep the exact requests, receipts, authorizations and full
pending charges. An empty current journal does not settle historical pending charges. If
you retire raw evidence, update Research, so that pinned readouts do not suggest that
deleted captures are still available.

Follow [AGENTS.md](../AGENTS.md). Replace active shapes completely. Keep unrelated work,
immutable evidence, pending charges and ownership records. Remove redundant build copies
and completed scratch work. After an explicit cleanup, do not keep rollback copies. Never
clear all of the temporary directory of the operating system.

Keep this guide about operation. Architecture goes in its own document. Claim semantics go
in Evaluation policy. Historical observations go in Research. Unfinished work goes in
Roadmap. Do not add another status diary or a duplicate operation manual.

## Acceptance handoff

Keep acceptance manifests, screenshots, observed usability results and live request
ledgers in `.basalt-evals/acceptance`, which Git ignores. For live work, use the unchanged
authored inputs in `studies/product-acceptance`. After you build Basalt, run
`node scripts/acceptance-workspace.mjs` to make a new offline workspace for a participant.
This script writes a template for tasks and results in the local acceptance storage. It
keeps the evidence at shutdown. Synthetic labels stay isolated from live runs and research
runs.

Use the first-use tasks and the live acceptance scope in [Roadmap](ROADMAP.md). Live
acceptance needs a separate, explicit authorization for the total. Launch the runs one after
the other through the UI. Give each run its spending limit from the total that remains after
all charges and pending charges. Report these items:

- The identities of the implementation and of the connector.
- The model requests.
- The native attempts.
- The charges.
- The pending charges that Basalt keeps.
- The source lineage.
