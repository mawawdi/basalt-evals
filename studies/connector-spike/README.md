# Connector spike: performance trace, script errors and GUI layout

This spike tests two new fact kinds of the connector, `performance_trace` and `gui_layout`.
It also records the real formats of script errors. It runs fixed, hand-written control
sources under one fixed Studio plan. It makes no model calls and it has a spending limit of
$0. No deterministic rule uses the new facts yet. Rules come after the spike proves the facts.

## Questions

S1. Performance (`performance_trace`, server context)

1. Are `instanceCount` and `memoryMb` readable? If Studio refuses the first read of a value,
   every sample leaves it out. Thus an absent field means "not readable". A later refusal
   stops the trace, and the observation is incomplete.
2. What are the units? `elapsedMs`, `meanFrameMs` and `maxFrameMs` are milliseconds,
   `instanceCount` is a count and `memoryMb` is megabytes. Confirm that the values agree
   with these units.
3. What is the noise floor? Compare the two observations of the `idle` source.
4. Does the trace tell the `heavy` source apart from the `idle` source?

S2. Script errors (`diagnostics`, server and client)

1. What are the real formats of `source.path` and `stackTrace` on the server and on the
   client? Each deliberate error has a unique tag, for example `SPIKE-S-REMOTE`. The tags
   are in the comments of the `errors` source.
2. Which errors have `source.kind` `unavailable`, and which errors come only in `messages`?

S3. GUI layout (`gui_layout`, client) and the phase capture

1. Does `pixel = (AbsolutePosition + GuiInset) × captureWidth / ViewportSize.X` agree with
   the captured frame to 2 px or less, for IgnoreGuiInset true and for IgnoreGuiInset false?
2. What is the effect of the Retina scale? Compare `capture.width` with `viewport.w`.
3. What is the effect of the capture format? Read `capture.mediaType` and look at the edges
   of the solid markers.

## Contents

| Path                  | Content                                                         |
| --------------------- | --------------------------------------------------------------- |
| `task/`               | The curated task: the plan, the public files, the rubric, a map |
| `task/evaluator.json` | The fixed Studio plan of the spike                              |
| `sources/idle/`       | A source with no work                                           |
| `sources/heavy/`      | 2000 parts each second in ServerStorage and a 20 ms Heartbeat   |
| `sources/errors/`     | Deliberate errors in each script place of S2                    |
| `sources/gui/`        | Two ScreenGuis with solid markers at known offsets              |
| `register/`           | The input of `source register` for each source                  |

The plan has three parts. Each observation runs all of them, in three separate Plays:

- The scenario `performance` traces the server for 30 s: 120 samples, one each 250 ms.
- The scenario `errors` records `diagnostics` on the server and on the client after 10 s.
  It also records `gui_layout` of `SpikeHudFull` in the client context.
- The phase `hud` waits for `SpikeHudFull`, records `gui_layout` of both ScreenGuis and
  `diagnostics`, and captures one still frame.

The rubric has one static code check (`src/server/Spike.server.luau` exists). The compiler
needs one mapped criterion, and each source passes it.

## Path

The spike uses the preparation parity study. `parity run` quotes a code-only run with no
builder model and no judge model (`quoteParityRun` in
[parity-study.ts](../../packages/operator/src/parity-study.ts)). Each source gets two
observations, so each question has one repeat. A `research` experiment needs judge
batches, and the control-source path needs a preparation model, so they cost money.

## Steps

Do these steps in the main checkout, after the branch of this spike is merged. Do the
steps in this sequence.

1. Make sure that the checkout is clean and committed. The guard counts `studies/` as
   execution source, and it also counts untracked files.
2. Tell the other sessions. Then build:

   ```sh
   npm run build
   ```

3. Install the new connector. Then compare its hash with the copy of the isolated account,
   and replace that copy atomically if the hashes differ:

   ```sh
   npm run plugin:build
   shasum -a 256 "$HOME/Documents/Roblox/Plugins/BasaltEvalStudioPlugin.rbxmx" \
     /Users/evals/.local/share/basalt-evals/plugins/BasaltEvalStudioPlugin.rbxmx
   ```

4. Register the four sources. Keep the `id` of each result:

   ```sh
   node bin/basalt-evals.js source register studies/connector-spike/register/idle.json
   node bin/basalt-evals.js source register studies/connector-spike/register/heavy.json
   node bin/basalt-evals.js source register studies/connector-spike/register/errors.json
   node bin/basalt-evals.js source register studies/connector-spike/register/gui.json
   ```

5. Curate the study with the four source IDs. Keep `id` (the study ID) and
   `curatedRevisionId` of the result:

   ```sh
   node bin/basalt-evals.js parity curate studies/connector-spike/task \
     <idle-id> <heavy-id> <errors-id> <gui-id>
   ```

6. Make the launch preview. Keep the `id` of the preview. Make sure that its quote is $0:

   ```sh
   node bin/basalt-evals.js parity run <study-id> <curated-revision-id>
   ```

7. Write the authorization outside the checkout, for example in `$TMPDIR`. The
   `idempotencyKey` has 16 to 100 characters from `A-Z`, `a-z`, `0-9`, `_` and `-`:

   ```json
   { "previewId": "<preview-id>", "ceilingUsd": 0, "idempotencyKey": "connector-spike-0001" }
   ```

8. Before you start the run, tell the person its time and its cost. The cost is $0. The
   run starts 24 Plays: 4 sources, 2 observations each, and 3 Plays each observation. The
   scenario budgets are 55 s for each observation. Calculate the time from a measured pace
   of Play starts on this Mac.
9. Start the run, and keep its `operationId`:

   ```sh
   node bin/basalt-evals.js launch authorize "$TMPDIR/connector-spike-authorization.json"
   ```

10. Monitor the run until it ends:

    ```sh
    node bin/basalt-evals.js operation status <operation-id>
    ```

## Read the results

All paths are below `.basalt-evals/eval-operations/<operation-id>/`.

1. Read `manifest.json`. Each entry of `captureCells` has `id`, `treatmentId` and `pass`
   (1 or 2). The `subjects` entry with `id` equal to `treatmentId` has the `sourceId` from
   step 4.
2. Read `capture/<cell-id>/studio/evidence.json` for each capture cell. If a cell has no
   evidence, read its failure in `operation status` and in `driver.log`.

For S1, read `scenarios[]` with `scenarioId` `performance`. In `reports[]` with `context`
`server`, step `trace`, the observation `server-performance` has `samples`. For each
source and each pass, find:

- the samples that have no `instanceCount` or no `memoryMb`
- the median and the spread of `meanFrameMs`, `maxFrameMs` and `frames`
- the first and the last `instanceCount` and `memoryMb`

Compare the two passes of `idle` to get the noise floor. Then compare `heavy` with `idle`.
The heavy server has about 20 ms more frame time and up to 40000 more parts.

For S2, read `scenarios[]` with `scenarioId` `errors`, step `settle`. The observation
`server-errors` is in the report of `server`. The observation `client-errors` is in the
report of `primary`. For each tag, record `source.kind`, `source.path`,
`source.className`, `source.inDataModel` and the first lines of `stackTrace`. Also record
the tags that are only in `messages`. The phase `hud` has the same client errors of the
presentation Play in `presentation-errors`.

For S3, read `phases[]` with `phaseId` `hud` for the `gui` source:

1. Read `layout-full` and `layout-inset`: `screen`, `guiInset`, `viewport`,
   `ignoreGuiInset` and the `rect` of each marker. The marker colours are in the comments
   of `sources/gui/src/client/Spike.client.luau`.
2. Open the captured image at `capture/<cell-id>/studio/<file>`, with `file`, `mediaType`,
   `width` and `height` from `captures[]` of the phase.
3. Find the edges of each solid marker in the image. Compare them with
   `(rect.x + guiInset.left) × width / viewport.w` and
   `(rect.y + guiInset.top) × width / viewport.w`. Do the check for the markers of
   `SpikeHudFull` and of `SpikeHudInset`.
4. Check `ClipChild`: its `clippedRect` must be the bottom-right quarter of `ClipFrame`.
   Check `FixedLabel`: its `textFits` must be false.
5. Compare `client-layout` of the scenario `errors` with `layout-full` of the phase.

The other sources show `exists` false for both layouts. That is the expected fallback.
