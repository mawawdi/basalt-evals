# Roadmap: acceptance and measurement

[Architecture](ARCHITECTURE.md) describes the current implementation, and
[README](../README.md) describes the use of the product. [Development](DEVELOPMENT.md)
gives the commands, [Evals](EVALS.md) gives the claim rules, and [Research](RESEARCH.md)
keeps the retained evidence. This page is the backlog of the work that remains. It does
not authorize model spending or Studio execution.

## Product acceptance

The workbench puts these tasks first: choose evaluations, select models, set a spending
limit, start one time, compare results and examine evidence. The creation of evaluations
stays a main task. Review by people is optional and has limits. One selection launches
drafts, ready evaluations and suites. This release has no accounts system, fleet or
automatic review backlog.

The implementation and synthetic regression tests are in place for the launch from mixed
sources, the shared spending limit and recovery. They are also in place for durable
edits, model comparisons, bounded blind review and the catalog of 1,000 evaluations and
15,000 outcomes. Keep these guarantees in the current test suites. Do not turn completed
work into another checklist.

Each release still needs `npm run verify`, `git diff --check`, an installed
`npm run plugin:build` and a visual inspection. The local acceptance record and the
console-check manifest keep the actual commands, counts, screenshots, implementation
identity and limits. Synthetic adapter calls are not live model or Studio calls.

The open gates for release acceptance include human interaction, assistive behavior in
Safari, how the connector renders in Studio and live execution. Synthetic checks show
only the recorded interactions and browser conditions. They do not close human gates.

## Interface correctness and usability

Keep the current visual language and the implemented boundaries of binding, authority
and recovery in [Architecture](ARCHITECTURE.md). The detailed synthetic evidence stays in
the acceptance storage that Git ignores. The acceptance work that remains must exercise
these conditions:

- the actual focus pixels;
- long immutable identities;
- keyboard pan of an image at its original size;
- spending and Markdown tables that overflow;
- narrow numeric fields;
- short desktop navigation;
- reflow at 320 CSS pixels;
- enlarged text;
- text-spacing overrides.

Scope each claim to its observed browser, viewport and modality.

Use the synthetic browser boundary to reproduce these conditions:

- observation URLs that contradict each other;
- an absent observation beside a healthy one;
- interleaved editor saves;
- denied storage together with failed server saves;
- delayed responses to load and publish;
- suite conflicts;
- lost acknowledgments.

Require these results:

- exact preservation of text and identity;
- searches bound to the query;
- bounded selected lists at 1,000 entries;
- retained evidence with the same bound during a transport failure;
- no paid dispatch from a view refresh or a recovery inspection.

Exercise prepared-only amendments and the recovery of retained source after catalog
changes. A permanently invalid authorization needs authoritative proof of the dispatch
state before anyone designs a new exit. A frontend error cannot authorize cancellation or
replay.

The scroll of the connector depends on its content, and its availability depends on its
state. Render it at the minimum dock size that it supports, with long instructions.
Include the busy, disconnected, starting and unsealed states, and keyboard and assistive
access. Parse, analyze and module tests do not show how the connector renders in Studio
or how it behaves with assistive technology. Keep this validation separate from builds
that models make and from controlled judge evidence.

## Human accessibility and first use

The project still defers the test with a genuine first-time participant. Do not use
assistant answers, synthetic fixtures or a coached retry in place of this gate.

Give the participant four outcomes to reach, with no walkthrough of the product:

- Start a model comparison.
- Explain the spending limit.
- Find evidence for a failed criterion.
- Finish a short review.

Record the assistance, confusion, mistakes, completion and active time. Fix each problem
that blocks the participant. If you must repeat first-use acceptance, use a new
participant. These labels stay separate from calibration and research data.

Automated Chromium checks exercise keyboard interactions, actual tab zoom at 200% and
400%, text-spacing overrides, reflow, dialogs and accessibility scans. Keyboard and zoom
use by people and Safari VoiceOver stay open for edits, launch, progress, interruptions,
evidence, review and completion. Check the spoken announcements of selected controls and
the live status. Check the order in which VoiceOver reads the page, errors and visible
focus. Check dialog containment and restoration, and check that nothing covers a control.
Automated checks do not show these manual results.

Inspect the widths 390, 768, 1024 and 1440px with long titles, large criteria, absent
images, connection failures and reduced motion. Essential work must stay usable with no
horizontal scroll at the page level.

## Live execution acceptance — separately authorized

The implementation does not authorize another paid run. Keep the current human-authored
Beacon and moving-platform inputs. Before execution, show the exact selected workload and
an explicit total spending limit. If comparable measured costs are not available, say so.
The liability bounds of requests are not the expected spending.

The initial live packet must show a new Beacon run, a new moving-platform run, the reuse
of a definition and a controlled model comparison. Start the runs from the new UI. Record
these items:

- the actual model calls;
- Studio attempts;
- preparation reuse;
- the allocation for each build;
- charges;
- unresolved pending charges;
- observations;
- failures;
- recovery.

Exercise a refresh and the closure of the browser. Use the supported stop, status check
and resume actions. Do not replay an uncertain request. A rejected build is an evaluation
result. Absent execution evidence does not close acceptance. Do not repeat a run only to
get a favorable outcome.

Measure the run times against these release targets. The targets are five minutes
for a new Beacon run and ten minutes for a new moving-platform run, and both include
readiness. They are targets, not established performance. Reference tests, public
development evidence, reassessment and repair each need their own explicitly selected
scope and spending limit. Historical cost summaries need actual comparable completed runs
and their sample count. They do not promise the price or the completion of the next run.

Test the current readiness check, bounded compilation and explicit cancellation separately
in live runs.

Prove two Studio lanes in the one worker account with a Studio-only replay at $0. Do it when
no Studio MCP runs in the account of the person, so that the anchor is the first StudioMCP.
Accept when:

- one replay on one lane records a footprint, and then two replays on lanes 0 and 1 overlap
  for at least half of the shorter job;
- both replays are complete and verified, with the same artifacts other than frames as their
  one-lane baselines, and with frames for each actor within 10 % of the baselines;
- the anchor keeper stops its StudioMCP within 1 minute after the last job.

`node scripts/check-studio-lanes.mjs <baseline-a> <baseline-b> <pair-a> <pair-b>` checks the
first two conditions from the stored receipts. If the proof fails, set `lanes` back to `[0]`
and keep the runs.

The practices from Harbor have these open live acceptance items. Quote each step with the
free preview, and get approval for its scope and spending limit:

1. Open one exported ATIF trajectory in the Harbor viewer. The viewer needs downloads that
   a person approves.

Prove the new connector facts with the $0 spike in
[studies/connector-spike](../studies/connector-spike/README.md). Run it only when the Mac has
free memory. The first attempt stopped after 5 minutes: Studio crashed in the `errors` step,
and a user lookup over SSH failed. Accept when each of the 4 sources has 2 complete
observations, and when these questions have answers:

- S1: the readable `performance_trace` fields, their noise floor on the idle source, and a
  clear difference for the heavy source;
- S2: the real `source.path` and `stackTrace` formats of script errors on the server and the
  client;
- S3: the pixel position of a GUI rectangle to 2 px or less, with `IgnoreGuiInset` true and
  false.

Then move each rule that the spike proves from `SPIKE_PENDING_RULES` into the capability
catalog and the preparation tool schema. This changes the preparation requests again. If S3
gives another pixel mapping, correct the one mapping function first.

Then do the live steps of the visual work. Quote each step with the free preview, and get
approval for its scope and spending limit:

1. Prepare the 3 visual evaluations that the person writes.
2. Run one launch benchmark: a new model and 2 current models, with 6 builds of each model
   for each evaluation. Make the model report and the exports.
3. Do one blind review session of 40 answers on the appearance criteria. Then run a
   `sensitivity` test on the same criteria with the blank, text-only, unrelated, shuffled
   and donor-swap controls.
4. Compare the `production` and `production-lint` harnesses in one run: 2 models, 2
   evaluations and 6 builds of each.

## Measurement and research

A run that functions is not evidence of a calibrated judge. Keep this work separate
from release work. The code for evidence classes, anchored steps, clock probes,
evidence-use controls, baselines, selective acceptance and the two-reviewer protocol
is in place. [Evals](EVALS.md) and [Architecture](ARCHITECTURE.md) describe it. Each
step below needs its own approval if it spends money, uses Studio or needs human time.

Only tests call these functions now. The steps below need them, so do not delete them:
`planDetectorCalibration`, `planHarnessComparison` and `planMatchedRepair` in
`protocols.ts`, `deployedRule` in `acceptance.ts`, `requiredFailingBuilds` and
`quadraticWeightedKappa` in `statistics.ts`, and `deriveVisualAcceptance` in `contracts`.

1. **Human authorship (no spend).** People do these tasks. A model must not do them.
   - Set the evidence class of the criteria with the status
     `draft_requires_human_review` (see `studies/product-acceptance/README.md`) and of
     impact-vfx `intent-coherence`.
   - Split criteria that mix appearance and timing, for example the impact-vfx text
     "Immediately clear, well-grounded, well-timed".
   - Write `requirement.withinMs` with a rubric quote where a criterion states a time
     bound.
   - Build the impact corpus again as base designs with six siblings each. Each
     sibling changes one parameter: reference, nuisance twin, visibility boundary,
     visibility fail, grounding boundary and grounding fail. Use one layout for all
     designs, split by base design, and approve the rubric.
   - Write the effect regions, the excluded regions and the anchor builds for the
     baselines, the region controls and the comparison stream.
   - Make the red-team twin builds: a note to the judge, a false success banner, a
     staged end state, effects on a broken mechanic, occlusion at the decisive moment,
     and empty and banner-only builds.
   - Write `rubric.md` and `criteria-map.json` for each pilot task in `tasks/pilot`, and
     approve them. The parity study refuses the drafts until then.
   - Review the API notes pack `roblox-api-basics` and the questions in
     `studies/failure-questions.md`. Then change their draft status.
2. **Studio calibration (Studio only, no model calls).**
   - Run `sequence timing` on the first new recordings to measure request widths,
     gaps and clock residuals. This sets the baseline for later capture changes.
   - Test anchored steps with two builds whose effect comes 0.4 s and 1.5 s after the
     input. Basalt must observe both, with a latency of at most the delay plus one poll
     interval. With `withinMs` 1000, the first build passes and the second fails.
     Measure replication lag, probe round trip, drift over 20–30 s and the clock
     difference between clients.
   - On a neutral place with frame counters, measure `screen_capture` delay, hitches
     and absent interface at 1, 2, 4 and 8 clients. Make sure that Studio renders
     normally in the isolated login.
   - Replace the simulated frame budgets of the pilot views (5, 5 and 17) with values
     from one recorded acquisition.
   - Measure the noise floor of the pixel measures across repeated observations.
   - Make sure that no judged frame shows identity text, and measure the impact mask
     regions again.
3. **Expert ceiling (human time).** Run the blind two-reviewer protocol on 6–8
   development builds before the full labels. The gate is build acceptance agreement
   of at least 0.80, and at most 0.10 below reviewer–reviewer agreement. Always report
   the exact lower bound. Do not run an alternative-annotator test with two reviewers.
4. **Paid judge pilots (development split only).**
   - Send fixed recordings to the judge 3–5 times. Report the flip rate of identical
     requests apart from the disagreement across observations. A quality difference
     below the flip rate stays unresolved.
   - Compare billed prompt tokens for identical images across endpoints. Receipts
     record `imageInputs` for this check.
   - Make sure that the router keeps the order of labelled images before the text.
     Its documents advise text first.
   - Measure the effect of reasoning effort, of one criterion against all criteria in
     one request, and of image resolution.
   - Run the evidence-use controls with repeats on several builds. Measure position
     flips and distractor effects in the comparison stream.
5. **First controlled study.** Use 30 authored builds that function (5 base designs
   with 6 siblings). Split them by base design: 1 for development, 1 for calibration and
   3 for the holdout. Use 3 observations for each build, two blind reviewers, and two
   judges from different families. The estimate is about 670 judge calls, or $15–60 at
   observed prices. This is not a preview. Preregister the hypotheses and pin the
   analysis code before the holdout opens. The strongest claim is a "preregistered
   case study at the level of criteria". "Reliable on these items" needs 18 of 18. A
   miss rate of at most 10% needs 29 builds that fail, with no miss.
6. **Capture streams (Studio, after measurement).** Replace polled `screen_capture`
   with ScreenCaptureKit window streams with frame display times only if all these
   are true:
   - capture runs in the isolated account with no clicks;
   - hidden Studio windows continue to render;
   - the clock alignment is better than the request widths from step 2;
   - the stream shows what players saw;
   - the stream fits the storage and load limits.

   Then add 6–10 Hz bursts around events. A burst shows whether an effect was visible.
   It never shows how fast it was.

7. **Builder comparisons.** Compare builders under identical tasks, environments,
   tools, limits and planned coverage, with a judge from another family. Measure
   whether public development feedback changes useful behavior. Do not show private
   criteria or expert answers to builders.
8. **Demonstration.** Make a short demonstration with evidence that a reader can
   examine, and say clearly what did not work. Add mechanics only when a measured
   limitation makes it necessary.

Broad judge tournaments and automatic promotion to "calibrated" remain research
work. Use adaptive sampling only with recorded inclusion probabilities that have a
lower limit. Do not use prediction-powered correction until you measure judge–human
agreement on about 100 labels. Protocols that exist now keep their original authority. A
change to execution limits needs a new, separately approved protocol.

## Proposed workbench additions

Each item extends current contracts. No item permits spending. Accept an item when
synthetic coverage in the current suites exercises every constraint that it states.
The measurement rules above still apply to its claims.

1. **Evidence-use report across runs.** One sensitivity test can already pool several
   builds of one evaluation. For each criterion, observation and control, it shows
   whether the answer held, changed or abstained. Add these results up for each
   evaluation, criterion and judge across tests, with sample counts. Then a criterion
   whose visual answers never change is visible without a look at each test.
2. **Console follow-ups.** The console does not show these data yet:
   - the miss rate, the false-acceptance share, the removal and escalation shares,
     the reliability figures with intervals, and the harness blocks;
   - the holdout look count, the withheld captures of saved examples, and the scene
     text with its owner;
   - the baselines in the analysis view;
   - a region editor, a reviewer picker and a twin picker for the region, swap and
     note controls. Say "does not apply" for controls on criteria that use no images;
   - a page where a person chooses anchor builds for the comparison stream.

   Also add browser checks for the round 2 and training review pages. Make sure that the
   launch text agrees with the selection that the run sends.

## Open transport and preparation gaps

The live preparation of 3 October 2026 found this gap. No item permits spending.

1. **Live proof of the stream stop.** No live run stopped a runaway stream yet. Basalt
   also does not examine reasoning text for long runs of whitespace. Accept when an
   authorized live run records a stopped stream with its charge.

## Completion rule

Report these items separately: implementation, synthetic verification, manual
accessibility and usability, live execution and judge calibration. An open human or live
gate stays open, even if every automated test passes. Keep acceptance artifacts in the
current local evidence storage. Update these guides in place. Do not add result diaries
or duplicate completion checklists.
