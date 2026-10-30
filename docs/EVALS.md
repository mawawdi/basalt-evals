# Evaluation policy

People write the builder prompt and the private rubric. The compiler can bind supported
measurements to those exact passages. It cannot invent meanings, weights, score anchors,
thresholds or acceptance requirements. Creator requests, observations, platform policies,
agent hypotheses, evaluator criteria and benchmark oracles stay separate authorities.

## Units and outcomes

An independent build is the unit for builder comparisons. Captures, frames, repeated
judgments and expert labels do not create more builds. Report functional outcomes,
qualitative scores, cost, tool calls and time separately. Never invent a composite quality
score.

Keep these items separate: the completion of execution, the completeness of evidence,
automated outcomes, human assessment and grader calibration. The local gate uses
`eligible`, `rejected` and `incomplete`. A candidate outcome can be `locally_eligible`.
Only an authoritative Studio evaluation supports engine verification. Absent evidence and
absent judgments stay in the full planned denominator. This is also true after the driver
finishes.

A run in the `code` grading mode makes no judge checks. Its judge criteria stay unmeasured,
so its measurement is not complete. A code check records the Studio values that it read.
An observed value is a measurement, not a verdict.

A refusal is an incomplete outcome, not a verdict. If the model or a content policy refuses
a build, the build ends `incomplete` with the stop reason `refusal` and the classification
`model_refusal`. It is not a rejected build. If the judge refuses a judgment, the judgment
records `incomplete` with the reason `judge_refusal`. Its criteria stay incomplete in the
planned denominator. A provider pause is not an outcome: the unit waits for Resume. After 8
provider pauses, the unit ends `incomplete`.

A categorical criterion uses satisfied, violated or insufficient evidence. A numeric
criterion uses the anchors or the bounded range of the human author. A valid score without
an authored passing threshold is **Scored**. It is not an inferred pass or fail, and it is
not an abstention. Basalt does not pool scores from incompatible authored scales.

A run can send one to five identical judge samples of each judge request. The samples of a
criterion combine into one answer. Every sample met gives met, and every sample not met
gives not met. An insufficient sample gives insufficient. Samples that disagree give
**Split**, which is neither met nor failed, so a person decides it. A scored criterion is met
only when every score is at or above the authored passing threshold. A sample without an
answer leaves the check without an answer.

Insufficient evidence is an answer of the judge. It is not an absent result, so it never
counts as unavailable and it never makes the results of a run incomplete. Only a check
without an answer, for example after a failed request, is unavailable. Each count of answers
uses the combined answer, so one sample group counts one time and not one time for each
sample. The counts keep met, not met, split, scored, insufficient and unavailable apart.

A suite baseline is an explicit reference to a finished run of an exact membership
snapshot. Incomplete outcomes stay incomplete. A comparison describes frozen populations.
It identifies changed conditions of grading or acquisition. Generation numbers that match
never make independent builds a paired experiment.

A reassessment checks saved evidence again with a judge, and it creates zero new builds or
captures. The original decisions stay available with the new assessment. A reassessment of
one build with the revision of its source run can compare graders. The reuse of a human
label needs the same expert and unchanged evidence, source, rubric and criterion. Reports
still bind each automatic treatment exactly.

A recheck checks the saved builds of a run with a later revision of the same evaluation. It
compares content hashes for each build and each authored criterion. An answer stays when
the criterion, the Studio plan, the judge and the shared request of the judge stay the
same. The old and the new answers pair by authored criterion, first by the hash of its text.
A recheck cannot compare graders, because the criteria can differ.

A changed code check runs again on the saved facts at no cost. A changed judge criterion
needs a paid judge check. That check uses the judge samples and the grouping of the run, so
its samples combine with the same rules as the saved answer. A changed Studio plan needs a
new observation of the saved build. If the prompt or the seed changed, the cell needs a new
build, and the recheck gives no answer.

A known good build and a known bad build are saved builds that a person marked for named
authored criteria, with a reason. Basalt checks each active mark with each revision that it
prepares after the mark. If a revision answers against a known build, Basalt refuses a new
benchmark of that revision. A check that is incomplete, a judge check that did not run, and
changed criterion text also block. An incomplete check blocks, but it is not a failure.
Changed criterion text needs a person, because the mark binds the text that the person
read. The gate gates plan revisions only. It never scores a build, and it never changes an
answer, a criterion or a plan. A known build keeps the authored authority and the
provenance that it already has. It is not an independently validated oracle.

A regression reference is a saved example. A pinned failure helps to reproduce a problem.
A grader regression check does not imply future calibration or transfer to other
mechanics. A grader regression uses only development evidence, because a grader that you
tune on withheld evidence removes the holdout.

Basalt records each look at withheld material for its evaluation: a generation reference
that binds withheld captures, and each authorized reassessment of withheld captures. The
first code check of a recheck or of a known build on a withheld capture also records a look.
Reports state that count. Keep at least two withheld variants of each authored family in
one split. Then a report can give a fix for the class (k of n), not only for one instance.

Report the marginal spending of execution separately from the known spending of the parent
history. Keep the outstanding reservations and the unknown costs of external sources in
the report.

Resource limits are part of the treatment. An ordinary model request has no limit on
elapsed time. The limits on turns, output and spending still apply. Infrastructure
watchdogs detect a Studio acquisition that does not respond. They do not change an
infrastructure failure into a verdict on the build.

The harness is part of the treatment: the prompt template, the tool subset, the
development runs, the turn limit, the reasoning, the API notes pack, the context summaries
and the lint feedback. A changed setting gives another treatment. Do not pool builds of two harnesses
as one treatment.

An API notes pack is builder material, not evaluator material. A person writes and reviews
it. It holds only general public facts about Roblox and Luau. It must not hold criteria,
plans, controls or solutions. The freeze refuses a pack that repeats 12 words of the
private text of the evaluation. A result with a notes pack measures the builder with that
pack, not the builder alone.

Lint feedback is builder material, not evaluator material. The harness file declares a fixed
public list of lint codes. The list is the same for each evaluation, and it never comes from
the private criteria. The builder sees only the luau-lsp findings of its own source. If a
criterion uses `source_lint_absent` with one of the codes, the builder gets a direct signal
for that criterion. A result with lint feedback measures the builder with that feedback.

A frozen research protocol keeps its exact resource policy. A change to it needs a
separate authorization. Do not amend it silently. A research review allowance from a
separate agreement does not change the defaults of the optional audit in the product.

A harness comparison puts the builds into blocks by task × model. Inside a block, the
builds of each arm are independent, and a repetition number never pairs them. An exact
sign test counts the blocks. A block whose direction depends on an unresolved build counts
against the direction under test.

### Lint feedback comparison

To measure lint feedback, select the tool sets `production` and `production-lint` in one
run, with the same models, evaluations and repetitions. The two tool sets differ only in the
lint feedback, so the comparison inside the run is controlled. The model report gives one
tool-set pair for each model with the two tool sets. The dataset export gives the counts of
each build.

A tool-set pair is a controlled comparison inside one run, for one model. It compares the
builds of the model with one tool set and with the other tool set. It uses the same outcome
rule, the same exact tests and the same corrections as a pair of models. It answers two
questions for each model:

1. Does the second tool set change the met rate of each criterion? The criterion tests give
   "Meets more often", "Meets less often" or "Not enough builds to tell".
2. Does the second tool set change the share of builds with each failure pattern? Examples
   are the builds with at least one `DeprecatedApi` finding and the builds with an error from
   their own scripts. The pattern tests give "Happens more often", "Happens less often" or
   "Not enough builds to tell".

A pattern test counts only the builds that can show the pattern. A build without a complete
analysis is not a build without findings, so the test leaves it out and shows its count. The
Holm adjustment covers all criteria of the pair, and a separate Holm adjustment covers all
patterns of the pair.

The same analyzer makes the lint feedback and measures the rate of lint findings. Thus a
lower rate of a declared code with `production-lint` is expected. A lower rate alone is not
proof that the code got better. A builder can remove a finding without a better mechanic,
for example with a local declaration of an unknown global. A `--!nolint` comment hides no
finding from either. The criterion met rates carry the claim that the builds meet more
criteria.

A tool-set pair cannot show these items:

- An effect for all models. Each pair describes one model. Report the answer of each model
  apart, and do not add the answers of the models.
- An effect on other codes, other evaluations or other runs.
- That one tool set is better. The report gives no score, no rank and no winner.

Before a claim, read the lint lines in the log of each build of `production-lint`. A build
whose lint lines say that lint is unavailable did not get the treatment. Report these builds
apart.

### Model comparisons inside one run

The model report compares the rows of one run, one criterion at a time. A row is one model
with one tool set. A model pair has two models of the same tool set. A tool-set pair has two
tool sets of the same model, as in the [lint feedback comparison](#lint-feedback-comparison).
The rows of one run build the same evaluations with the same plan, judge and limits. Thus a
comparison inside the run is controlled. The report makes no claim across runs. A claim
across runs needs a comparison of runs, and it stays descriptive when the conditions differ.

Each build gets one outcome for each criterion: met, not met or unresolved. The
[Architecture](ARCHITECTURE.md#model-report) gives the rule. In this report, a refusal, an
invalid tool call, a rejection by the local gate and a turn, context or output limit are not
met, because the model did not deliver the build. The local gate still records a refusal as
incomplete. A provider error, the spending limit, a stop, an environment failure, unfinished
work and a stage that the run did not reach leave the outcome unresolved.

For a criterion and a pair of models, the report gives one of these answers:

- Meets more often
- Meets less often
- Not enough builds to tell

"Not enough builds to tell" does not mean that the models are equal. It means that the
builds do not show a difference after the correction for many tests.

Fisher's exact test compares the two models for each criterion. An unresolved build counts
against the direction under test, so an answer holds for every outcome that the unresolved
builds can have. The Holm adjustment covers all criteria of the pair at a family-wise error
rate of 0.05. Three builds of each model give a smallest p of 0.1, so no criterion can get an
answer. Four builds give 0.029, five give 0.0079 and six give 0.0022, and the Holm adjustment
multiplies the smallest p by the count of criteria. Each test states its smallest possible p,
so a reader sees when no answer was possible.

The pooled test of each evidence class gives each build the share of the criteria of the
class that it meets, so each build stays one unit. A permutation test compares the shares
inside each evaluation. It is exact up to 100,000 relabellings and uses seeded random
relabellings above that. The Holm adjustment covers the classes of the pair. A bootstrap
interval shows only when each model has more than 40 builds.

The builds of a later stage passed the earlier stages. In the report, a build that the run did
not reach is unresolved. Thus an answer for a later stage holds for every outcome of such
builds, and it describes the planned builds of the stage.

The judge can prefer builds of its own model family, so the report marks a builder of the
family of a judge. The failure patterns of a model count builds with an exact Clopper–Pearson
interval. Lint codes and script errors count only the builds with a stored, complete source
analysis. A build without an analysis is not a build without findings, so the report counts
it apart. A script error of unknown origin stays apart from an error of a build script.

For each pair of either family, a two-sided Fisher exact test compares the share of builds
with each failure pattern. A pattern answer is "Happens more often", "Happens less often" or
"Not enough builds to tell". The Holm adjustment covers all patterns of the pair. A pattern
describes how builds fail. A pattern answer alone does not show that a model or a tool set
meets more criteria.

The report never ranks models, adds criteria together, sorts models by a mean or names a
winner. Do not say that a model is better from this report. An answer is about one criterion
in one run.

### Staged evaluations

An evaluation has 1 to 6 ordered stages. A person writes the prompt and the private criteria
of each stage. An evaluation with one stage is the same as an evaluation without stages.

Each stage is its own evaluation in the results. Its builds, observations, answers and
denominators stay apart from the other stages. Basalt never adds the stages into one score,
and it never ranks models across stages.

The build of a later stage continues the sealed build of the stage before it. That parent
build has the same model, tool set and repetition, in the same run. The later build starts
a new conversation. The builder sees the prompt of its stage and the prompts of the earlier
stages. It never sees the criteria of a stage.

A gate is optional. The author can name required criteria of a stage as the gate of the next
stage. Each gate criterion needs a required code check, so a judge never decides a gate. The
compiler refuses a gate criterion without a required code check. The last stage has no gate.

A gate criterion about a value that the build creates at a fixed time has no valid code
check. An example is "the score starts at 0". The compiler refuses a fixed sample of that
value, because a slower valid build can create it later. A draft cannot carry a time bound,
so preparation stops. Use a change or an action result for a gate, for example "the score
increases by 1 when a player touches an orb". If preparation stops for this reason, the
console names the stage and the gate criterion and tells the author what to change.

The run did not reach a later stage in these conditions:

- The parent build failed or is incomplete.
- The run did not reach the stage of the parent build.
- A gate check did not pass on an observation of the parent build. A failed or incomplete
  observation or grading of a gate check also stops the later stage.

Basalt records a build that the run did not reach as `not_dispatched` with the reason
`stage_not_reached`. It makes no model request and no observation for that build.

A build that the run did not reach is not a failure, and it is not incomplete. It counts
apart in `notReached`. Its planned answers are outside the measurement of its stage. The
success bounds of a stage use only the builds that reached it. A stage without a reached
build has no bounds. The measurement of a run can be complete when some builds are not
reached.

The builds that reach a later stage are a selection. They passed the earlier stages, so the
population of a later stage can differ between models. Report the reach of each stage with
its outcomes. A comparison of a later stage between models is descriptive, not controlled.

### Measures

Each measure has one meaning. The data shape of each reported measure contains its
numerator and its denominator.

| Measure                | Numerator                                            | Denominator                   | Note                                                               |
| ---------------------- | ---------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `missRate`             | Units that the expert rejects and the stream accepts | Units that the expert rejects | Prevalence does not change it. Certify it with authored negatives. |
| `falseAcceptanceShare` | Automatic accepts that the expert rejects            | Automatic accepts             | It needs a representative random sample.                           |
| `falseRejectionRate`   | Units that the expert accepts and the stream rejects | Units that the expert accepts | Prevalence does not change it.                                     |
| `falseRejectionShare`  | Automatic rejects that the expert accepts            | Automatic rejects             | It needs a representative random sample.                           |
| `removalShare`         | Units with an automatic accept or reject             | Planned units                 | These units leave human review.                                    |
| `escalationShare`      | Units that a person must decide                      | Planned units                 |                                                                    |

An unresolved label stays in an unresolved count. Basalt never drops it. A share has no
point estimate while a label is unresolved, and its interval takes both completions.

Report two sources of automatic disagreement separately. The identical-request flip rate
counts changes between the judge samples of one identical request, so it measures judge
variance only. The cross-capture disagreement rate counts changes between captures of one
build and view. It uses only captures whose samples agree. With one sample for each
capture, it also contains judge variance. The analysis reads the sample number of each
judgment unit, so a plan with two or more samples measures the flip rate. The registered
plans have one sample of each request, so their flip rate has a zero denominator.

If an exact interval exists, use it. A protocol cell uses a two-sided Clopper–Pearson
interval over independent builds, so a cell where all builds agree keeps a nonzero width.
If n is 40 or less and an exact bound exists, do not use PPI++ or a bootstrap interval. Do
not report a binned calibration error.

### Selective acceptance

Selective acceptance gives each unit exactly one outcome: `auto_accept`, `auto_reject` or
`escalate`. These conditions always escalate a unit:

- an insufficient or truncated answer
- an integrity issue, for example text in the build output that speaks to the judge
- a failed evidence-use gate for the criterion (an input flag)
- a criterion where the experts disagree
- a disagreement across identical-request repeats, across captures, or with a judge from
  another model family
- fewer samples than the rule requires

The judge samples of one request are the identical-request repeats of a unit. A unit gets
`auto_accept` only when every sample says satisfied at or above the authored threshold. It
gets `auto_reject` only when every sample says violated. Samples that disagree escalate
the unit with `repeat_disagreement`. A build gets
`auto_accept` only when all its criteria do. One certified rejection rejects the build.

The rules come from a preregistered list in order, from the most conservative rule. The
calibration split chooses a prefix of the list. The holdout split tests that prefix in a
fixed sequence with an exact binomial certificate over independent builds that fail. The
test stops at the first rule that does not certify. The last certified rule applies. A
stream without a certified rule escalates all units.

An accepted build with an unresolved label counts as a miss. Zero misses among 29
independent builds that fail certify a miss rate at or below 10% at one-sided 95%. The
same certificate needs 59 builds for 5% and 14 builds for 20%.

The random audit is a monitor. One audited false acceptance sends that stream back to
escalate-all. The stated confidence of a judge never gates, ranks or filters a unit. Data
can keep it for display only, with the label "uncalibrated".

### Baselines

A judge has value only where it is correct more often than a simple rule on the same
units. Vision-language metrics are often not better than a simple baseline on graded sets,
and evaluators miss many targeted quality drops. Thus each judge calibration plan
preregisters a baseline ladder before any work starts. The ladder has these rungs:

- `always_pass` and `always_fail`. They need no measurement.
- Pixel rules. One rule applies one pixel measure and one direction to one required
  criterion.
- Authored pixel rules. These rules use the threshold that the human-authored criterion
  states.
- Judge controls on the same units: text only, and facts plus source. Other parts of the
  plan make their judgments.
- A second judge from another model family. This is a plan configuration.

Pixel measures are deterministic numbers from recorded frames. Basalt calculates them
offline, with no model call. Luma is the Rec. 709 weighted sum of the 8-bit code values.
Relative luminance is the same sum of linear sRGB values.

| Measure              | Definition                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `weber_contrast`     | (effect − surround) / surround, in relative luminance, after the action. The largest absolute value.          |
| `changed_pixels`     | The most measured pixels in one frame after the action whose luma differs from the pre-action frame.          |
| `screen_coverage`    | `changed_pixels` divided by all pixels of the frame.                                                          |
| `onset_ms`           | The recorded time of the first frame after the action with the authored minimum of changed pixels.            |
| `peak_ms`            | The recorded time of the frame after the action with the most changed pixels. The earlier frame wins a tie.   |
| `reference_distance` | The mean absolute luma difference of cell grids, divided by 255, between a build and a human-chosen exemplar. |

Each frame gets its phase and its recorded time from the action through the `timing` entry
of its task view. The plan has one entry for each view of a task with a pixel rule:

- Phase stills. A replication probe in the same phase records the time of each capture
  from the action, in milliseconds.
- A sequence. The plan names one required transition and one actor. The anchor is the
  measured transition time: `actedAt` of the signed step report for an action, or the
  observed state change. The probe clock alignment converts frame intervals to the Studio
  clock. The recorded time of a frame is the acquisition start from the anchor. It is 0
  for an effect frame that starts before the anchor. The frames are those of the fixed
  selection rule:
  - the last frame before the anchor
  - the frames that can overlap the effect window
  - the first frame after an observed state change
  - the first frame after the hold

The judge gets no frames from a sequence without a clock alignment or with an insufficient
assessment. Thus the measurement record of such a sequence has an issue and no values. A
record with an issue gives no decision.

The pre-action frame is the last frame before the action. A pixel changes when its luma
differs by the authored change threshold or more. The effect region comes from authored
data: the criterion region, or the view region when the criterion has none. The surround
is the band of the authored margin around that region. If no authored region exists, the
measures use the whole frame and the record says so. No measure reads an authored excluded
rectangle, for example a band of harness controls.

The reference distance aligns each frame with the exemplar frame of the same phase that
has the nearest recorded time inside a tolerance. It never aligns frames by index. Do not
include the measured capture in its own exemplar set. A different valid design can have a
large distance, so the distance is a baseline number, not a verdict.

A pixel measure is a number, never a verdict. It can gate only through a threshold that
the human-authored criterion states. The plan keeps that threshold in `authoredThreshold`,
with the exact criterion passage. Registration refuses a passage that is not in the frozen
rubric text that governs the criterion. No model and no calibration result writes that
field.

The threshold of an ordinary pixel rule comes from the development partition only. It is
the measured value that gives the most correct build decisions. If two values tie, the
stricter value wins.

Each comparison uses the withheld partition and the units of the judge: one build and one
criterion. The captures of a build combine into one build decision first, so each pair is
one independent build. One violated capture rejects the build, and an unknown value leaves
the decision unknown. An escalation is not a correct decision. For each criterion, an
exact McNemar test counts the discordant builds. Holm adjusts the p values across the
criteria of one baseline.

An unknown cell counts against the judge: an unknown judge cell is wrong, and an unknown
baseline cell is correct. The report says that the judge adds information only when both
of these conditions are true:

- The judge is correct on more discordant builds.
- The adjusted p value is 0.05 or less.

A criterion has at most twelve pairs, so the test has low power. If a pixel rule solves a
one-parameter variant family, show the value of the judge on other items.

When the operator seals an experiment report, it measures the retained frames of each
completed capture again. A capture without a completed receipt has no record and stays in
the `missing` count.

### Exemplar comparison stream

Vision-language judges agree with people more often in pairwise comparisons than in
absolute scores. But a distractor changes a pairwise verdict more often, and the answer
depends more on the order when the two builds are close. Comparative judgement is an
established method to set grade boundaries. The absolute judge of Basalt most often gives
too high a result to a borderline build. A comparison with a fixed bar at the lowest level
that meets a criterion targets this failure. Thus Basalt has a separate grading treatment:
the exemplar comparison stream.

A person chooses the exemplars. These rules apply:

- For one criterion, a person chooses one or two exemplar builds. Each exemplar shows the
  lowest level that meets the criterion. The choice records the reviewer profile of the
  person and one sentence of reason. No model chooses or changes an exemplar.
- An exemplar is a saved example or a build of a run. Only one development capture of the
  build enters a comparison. Basalt refuses a withheld capture and a saved example with
  withheld captures.
- An exemplar is never a planned build of the study. Basalt never compares a build with
  itself.

Only an appearance criterion with rendered frames and an acceptance meaning can use the
stream. A scored criterion needs an authored passing score. For each other criterion, the
stream is not applicable. Such a criterion gets no unit and no model call.

For each capture and each exemplar, one request shows the images of both builds. Code
pairs the images by player, recorded phase and time from the anchor, within the
`maximumGapMs` of the view. A frame index never pairs two images. Each build uses at most
32 images, which is half of the request. The image labels name the builds only as Build A
and Build B. The request never says which build is the exemplar.

The judge answers in both orders. A consistent win over each exemplar satisfies the
criterion. A consistent loss to each exemplar violates it. A flip, an insufficient answer
or a build between two exemplars is insufficient, so the unit escalates. Two exemplars
need four calls for each capture of a criterion.

The preview freezes the evidence of both builds. It quotes the exact requests before
Basalt spends money, with the image limits of each endpoint in the set. The run starts only with an
explicit spending limit. Each request reserves its full cost before it starts. Basalt
never sends an uncertain request again. If the evidence of a build cannot support the
criterion, the unit is insufficient and makes no call.

The stream never judges a withheld capture before the analysis plan pins it. A judge
calibration plan pins the exemplar choice of each criterion and the largest miss rate. A
preview that includes a withheld capture needs the registered plan of its run. A run that
judges withheld captures records one look at the holdout. Only one run can answer a
capture, criterion and exemplar for one analysis plan. The sealed report of the plan reads
the verified answers of these runs.

The stream stays separate from the absolute judge. The report compares them on one metric.
The metric is the share of withheld builds that a stream decides automatically at the
preregistered largest miss rate. The selective acceptance functions choose the rule on the
development split and certify it on the withheld split. A stream without a certificate
decides no build. Each row uses the same criteria and builds.

The report also gives the position-flip rate of each criterion. This rate uses the pairs
with a build preference in both orders. It is the share of these pairs that prefers a
different build in each order.

The stream has no image controls of its own, and no paid comparison has run. A paid pilot
must measure the position-flip rate of each criterion, the distractor sensitivity and the
agreement with experts on borderline builds. Distractor sensitivity is the share of
verdicts that change when an unrelated or a changed exemplar replaces the chosen one.
Until a pilot measures these values, do not say that the stream is better than the
absolute judge.

## Preparation and controls

Basalt keeps the original authored text, the Markdown structure, the inherited context and
the source spans, and it does not change them. A clarification that changes the meaning
goes back to the author. An amended input is a new immutable attempt. The previous
attempts and the spending stay.

The status Ready to run means that the authored definition compiled into supported
executable instructions. It does not mean reference-tested, calibrated or Studio-verified.
Optional `working`, targeted `negative` and `alternative` references test acquisition and
discrimination with the selected scoring configuration. Their generated expected outcomes
are hypotheses, not independent ground truth. Research keeps explicit gates for validation
and human review.

A staged evaluation has one public preparation that sees the prompts of all stages, so the
shared scene supports every stage. The private plan, the private criteria and the coverage
notes are prepared for each stage. Each stage keeps its own hashes and coverage.

Coverage notes come from a second model after the preparation. They are agent hypotheses
about the fit of the plan to the authored criteria, in two directions. For each criterion,
they say if the plan tests it as written, if the prompt states it and if it mixes evidence
classes. For each private check, they say if it supports a criterion, supports none or
tests a thing that the prompt does not ask for. The model gives its evidence before
each value, and it does not rate the quality of the prompt or the criteria.

A person reads the notes and decides to edit the prompt or the criteria or not. Notes never
change a plan, a criterion, an answer or a launch. Select a coverage model from a different
family than the preparation model, because a model can miss its own errors. A note of
`matches` is not a reference test.

Preparation also observes the empty build: the seed with no changes, with the private
Studio plan and the code checks. Only stage 1 of a staged evaluation starts from the seed.
A later stage starts from the build of the stage before it, so its record says that the
empty build does not apply. A required code check that passes on the empty build
cannot tell a build from no build. A pass on the empty build is a plan warning for a
person, not a verdict. It never changes an answer, the plan or the registration. An
incomplete empty build check gives no warning, and the evaluation stays ready.

The benchmarks of an evaluation version give more plan warnings. They read only generated
builds, and they need at least two builds:

- Every build fails a check, and each failure read the same observed value.
- Every build fails a check.
- Every build meets a check.

The known build gate of the version gives one more plan warning: a known build gets a
definite answer that differs from its mark.

An insufficient, missing, split or scored answer gives none of these warnings, because it
is not a known pass or failure. A warning is a sign for a person that a check may not tell
builds apart. It never changes an answer, a review or a total.

Explain failures asks a second model four fixed questions about each flagged criterion: a
gap in the prompt, a gap in the observation, a pass without the behavior, and a cause in
the infrastructure. A person writes the questions in `studies/failure-questions.md`. The
first draft has the status `draft` until a person reviews it, and the console says so. The
request contains only the flagged criteria, the plan, each private check and the saved
observations of up to three builds of each criterion. The answers are agent hypotheses.
Each answer gives its evidence for and against before its value, and it names the
observations that it uses. An answer that names an observation outside the request is
incomplete. A hypothesis never changes an answer, a review, a total, the plan or the
criteria.

The preparation parity study measures how often a prepared private plan answers differently
from a curated plan. A person writes the rubric of one task and the map from each rubric
criterion to a private check of the task files. Basalt compiles that curated plan. Each
preparation model then prepares the same rubric with the same curated public part, so it
writes only the private plan. The same saved builds run under each plan with code checks
only and two observations each. The report pairs the answers by authored criterion and
source hash, and it gives the disagreement count of each model. Insufficient answers and
unstable observations stay apart from the rate. A disagreement shows that two plans answer
differently. It does not show which plan is correct, and the report gives no interval,
because the cells of one build are not independent. The templates in `tasks/pilot` are
drafts for a person, and the compile refuses them until a person writes and approves them.

A sensitivity test is a diagnostic of how a judge uses the evidence. Its controls never
count as accuracy, and their answers never enter reviews or comparisons. A changed answer
shows dependence, not correct use. On judge benchmarks, the presence of an image moves
labels more than the content of that image. The test has three levels:

1. Dependence. `blank` keeps each frame slot with a blank image. `facts_and_source`
   removes the frames and keeps the runtime facts and the source. `text_only` keeps only
   the task text and the criteria.
2. Localization. `region_removed` fills the decisive region with pixels of the same view
   from a frame before the action. `region_sham` fills an equal region that does not
   overlap it. The effect is the decisive change rate minus the sham change rate.
   `region_black` fills the decisive region with black only as a check of the fill
   artifact, because black pixels are out of distribution.
3. Direction. `donor_swap` shows the frames of another build of the same evaluation and
   view whose expert answer on the criterion differs. The analysis checks if the answer
   follows the pixels.

A person authors each decisive region for one criterion and one view, in the plan of the
test. Basalt never takes a region from the citation of a judge. A criterion without an
authored region has no region controls, and the result says so.

A donor swap needs the round 1 answers of one named expert reviewer. A delayed repeat and
a round 2 answer do not count. A Cannot tell answer gives no direction, so the control is
not available for that capture. Without answers, the control is not available.

Order controls test another channel. `reversed` reverses the frames, `shuffled` moves
every frame, and `phase_shuffled` moves frames only between the same two measured anchors.
A shuffle cannot find a dependence on appearance across frames without order, for example
speed. `repeated_frame` shows the last frame of each view in every slot of that view, so
only static appearance stays.

The plan preregisters one label rule for the order controls and the donor swap. With
`labels_keep_slots`, each image label stays in its slot, so the labels and the pixels
disagree. With `labels_follow_images`, the whole label moves with its image, so the labels
still agree with the pixels. The two rules test different channels: the text of the labels
or the content of the pixels. Blank images and region controls change only pixels, so each
label stays with its slot.

The `canary` control measures text sensitivity. It judges a twin build that differs only
by an in-scene note to the judge. The plan names the answer that the note asks for. The
plan pairs each selected build with its twin build of the same evaluation. A build without
a twin has no `canary` unit, and the result says so. Basalt does not author twin builds.

The plan also sets the count of judgments of the original evidence, from one to three. Two
or more measure the noise floor: how often an answer changes when the evidence stays the
same.

One sensitivity test selects several builds of one evaluation, because one build cannot
show an effect. The test uses only the development partition. If the user authorizes a
holdout look, the test also uses withheld captures, and Basalt records one look at the
holdout.

One rubric item stays one scored criterion. Observations that support it do not create
more outcomes. A requirement that is only in the prompt stays unscored coverage.
Deterministic facts and qualitative interpretation have different methods. A guess of a
judge cannot repair absent observations, unspecified timing or an acquisition failure.

If an authored item has no supported automated check, it needs clarification before
launch. It cannot silently disappear from the results. It cannot create mandatory review
work. Public preparation excludes the private rubric. Hidden criteria, reference intent,
withheld labels and oracle transitions never reach the evaluated builders.

Preparation, optional reference generation, the build stage and the grading stage use
explicit snapshots of the model identity and bounded quotes. A snapshot freezes the set of
endpoints of one model that can do the work in one service tier. OpenRouter picks the
endpoint of each request with its default routing, and the receipt names that provider.
Thus a comparison of models includes the variation between the providers of each model. A
claim about one provider needs a set with only that provider. One launch authorizes the
cumulative spending limit. The spending limit is an authorization, not a promise of
completion. Confirmed charges and the liabilities of unresolved requests are separate
quantities. A provider rejection without a generation ID is a confirmed charge of zero. Past comparable costs give the observed sample size and scope. They are not an
expected future charge.

Every selected build stays in the results. This is also true when its next request does
not fit in the limit that remains. Basalt never automatically substitutes a model,
increases the spending limit, reduces the coverage or adds a repair attempt. A terminal
request without a price keeps its full reservation. A call without a known result and an
unbound call stay incomplete. Basalt never replays them blindly.

## Evidence

Source, runtime facts, original images, acquisition intervals and judgment provenance have
separate views. Before you use evidence, verify the signatures, the hashes, the binding to
the build, the capture identity and the release gates. The presence of an observation is
not proof that a criterion passes. Absent objects, a failed acquisition, invalid signed
provenance and omitted criterion material cannot silently become accepts.

Keep the original image dimensions and the exact recorded intervals. A frame is one part
of a capture question, not another question. Compare captures by the recorded phase and
action context. Identical frame indexes do not establish temporal alignment. Static
pictures do not prove continuous behavior, timing, input feel or physics.

A `performance_trace` comes from one Studio process on the development Mac. Studio, its
plugins and every Play context share that process. Thus its frame times, instance counts
and memory values are relative signals between builds on the same machine. They are not
device performance, and they do not give the frame rate of a player. A `gui_layout` records
geometry and text fit in GUI pixels, not appearance. Colour, transparency, images, rotation
and occlusion need rendered frames.

The human rubric author sets one evidence class for each criterion: `appearance`,
`timing`, `motion` or `causality`. Write it as an `Evidence class:` line or list item in
the scope of the criterion. A condition such as `Insufficient evidence when ...` also
stands alone. Both are grading metadata and never become requirement text. Metadata inside
a requirement passage needs clarification. The preparation model cannot set or change a
class.

The author can also set the polarity of a criterion with a `Polarity: absence` line in the
same scope. The text of an absence criterion names a thing that the build must not show,
and the criterion is met only when that thing is absent. A criterion without the line has
the polarity `presence`. The polarity is grading metadata too, and the preparation model
cannot set or change it. A score cannot measure an absent thing, so an absence criterion
with a score scale needs clarification.

The judge reports what it sees, not a double negative. For an absence criterion, it
answers `present` when the evidence shows the named thing, `absent` when the evidence shows
that the build does not show it, or `insufficient`. Present is not met and absent is met.
Insufficient stays insufficient. A presence criterion keeps `satisfied`, `violated` and
`insufficient`. The judge cannot use an answer word of the other polarity. Basalt keeps the
exact answer word with the verdict, and the judge samples combine with the same rule.

Vision-language judges are near chance on temporal judgments. Fixed checks of runtime
facts measured better than a video judge on labelled game assertions. Thus a model judges
rendered frames only for appearance and perceptibility. A timing, motion or causality
criterion needs an engine rule or signed runtime facts without frames. A rendered judgment
without a class needs clarification before launch.

Code applies the class before any model call. If the recorded evidence cannot support the
class, the outcome is insufficient and no model receives the criterion. For each actor, a
rendered transition needs these frames:

- a frame that ends before its anchor
- the frames across its authored effect window
- a frame after its declared hold

A state anchor also needs the first frame after the observed change. The unrecorded
interval between these frames cannot be more than the `maximumGapMs` of the view.

Anchors use the Studio clock and frames use the host clock. Each comparison applies an
explicit offset and uncertainty, and the signed assessment records them. The recorder sets
them from host-bracketed clock probes of the clients. If the sequence has no probe, the
sequence is insufficient.

A watched state that never changes is an effect that the recorder did not observe. Its
last frame has the role `horizon-end`. An appearance criterion tied to transitions asks
the before/after comparison directly.

The judge settings of a run set the requests of each capture. With shared requests, each
judge sample of a capture has at most two judgment requests. The criteria that select
rendered evidence share the request with images. The other criteria share a request with
no images, so they never see the images of another criterion. All timing, motion and
causality criteria are in that request, because they select no rendered evidence. With
one criterion per request, each criterion has its own request, and only a criterion that
selects rendered evidence gets images.

A reassessment and a sensitivity test always use shared requests. A sensitivity test runs
its controls only on the request with images. For each criterion of the request with no
images, the result names each control as not available.

The judge reads the signed runtime material in a compact form. The form keeps each value
and the time of each change. It omits only the inner times of a run of equal samples. The
summary of a motion trace is a calculation from the signed samples. It is not a verdict
and it uses no hidden threshold.

Scenario steps wait for observed platform facts, not for fixed offsets. If a step does not
see its anchor within its horizon, its outcome is `not_observed_within_horizon`. This
outcome is inconclusive. If the runner cannot evaluate the anchor, the outcome is
`acquisition_failed`, and the dependent criteria are incomplete. The runner does an action
one time and never tries it again. Only observations repeat.

Only a person adds a pass/fail time bound to a step. The bound must quote rubric text that
states the duration in digits and a unit. A drafted plan cannot carry a bound, and Basalt
does not learn a bound from averages. The bound starts at the recorded start of the
previous action. It ends at the first observation in the scope context. If that
observation is later than the bound by less than the poll interval, the outcome is
incomplete.

Each context records times on the replicated server clock (`workspace:GetServerTimeNow`).
The estimate of each client can differ a little from the server, so a bound that crosses
contexts also contains this difference. The timing audit shows the offset of each client.
The default treatment does not simulate network conditions.

A source lint check (`source_lint_absent`) is static. It reads the analysis of the sealed
source by the pinned luau-lsp, with Basalt's fixed Luau configuration. Basalt ignores the
Luau configuration of the build, and `--!nolint` and `--!nocheck` comments have no effect.
A finding of a named code makes the check `rejected`, and an unavailable analysis makes it
`incomplete`. A lint result is not evidence about runtime behavior. A clean result does
not prove that the code is correct or that the mechanic works.

A build error check (`build_errors_absent`) reads the script errors of its bound
diagnostics facts. Thus it claims only Studio errors in the observed session and in the
bound contexts. Fixed rules give each error one origin: a build script, a script outside the
place, or unknown. One build error makes the check `rejected`. An unknown origin, a full
channel or an absent fact makes it `incomplete`. The check does not read output messages.

The origin rules use the sealed sourcemap, the engine source path and the stack frames.
Studio copies of the scripts of StarterPlayerScripts, StarterCharacterScripts, StarterGui
and StarterPack belong to the build, but only for the actors of the evidence. A script
that the build clones to another place at runtime has an unknown origin. A script outside
the place is external, unless its name is the end of a build path. A clean result does not
prove that the build has no errors in other sessions, contexts or code paths.

A GUI layout check (`gui_layout_holds`) reads one `gui_layout` fact. It claims only geometry
and text fit as Studio reports them, in GUI pixels, at the time of that fact. It does not
claim appearance. Colour, contrast, transparency, images, rotation and occlusion need
rendered frames. `no_text_overlap` compares element rectangles, not the drawn glyphs. A text
element on an image or a frame is not an overlap.

`on_screen` uses one formula: a viewport pixel is a GUI pixel plus the GUI inset. The
connector spike compares this formula with captured frames. Until the spike confirms it, the
rule stays out of the catalog, and preparation cannot use it. A clean result covers one
viewport size and one time in the session.

Only the words of the author set a threshold. The minimum of `min_text_px` must quote the
text of its criterion, for example `at least 14 px`. If the criterion states no size, a text
size check is not valid, and the compiler asks for clarification. Basalt never adds a
default size. A `TextScaled` element makes `min_text_px` incomplete, because its `TextSize`
does not give the rendered size.

A performance check (`performance_within`) reads one server `performance_trace` fact. Its
values come from one Studio process on the development Mac. Studio also does its own work in
that process, and other programs share the Mac. Thus a value is a relative signal: compare it
only with other builds that ran under the same conditions. A verdict does not predict the
performance on a player device or on a Roblox server. `memoryMb` is the memory of the whole
Studio process, so only its growth over the trace is a signal about the build.

The pixel checks (`capture_text_contrast` and `capture_exposure`) read the luminance of the
captured frame. They do not judge appearance, style or legibility. A contrast check gives the
WCAG ratio of the two main tones in the rectangle of each text element. It is not an
accessibility certification, and it does not read the glyphs. Compression and the scale of
the capture change the pixels. The rectangle of an element uses the formula of question S3 of
the connector spike. Until the spike confirms it, the rules stay out of the catalog. An
exposure check gives one number for the whole frame, not for a region.

Only the words of the author set the maximum of a performance check and the bounds of a pixel
check, for example `at most 33 ms`, `at least 4.5:1` or `at most 5%`. Basalt never adds a
default threshold.

An inference about the failure of a build must distinguish these causes:

- a provider or tool failure
- an infrastructure failure
- an evaluator defect
- absent evidence
- observed behavior of the build

Each failure attribution names the authority that admitted it: a rule, a control or a
reviewer. A model attributor only proposes a hypothesis, and a hypothesis never comes
first. A fixed precedence puts causes outside the build before causes in the build. Group
operational issues by structured code and by the dependency that failed. When you group
them, do not clear the incomplete state of a trial that they affect.

## Optional bounded human review

Ordinary automated runs need zero manual grading judgments. A GET request for evidence
allocates no batches, assignments, labels or release receipts. Unreviewed results do not
become overdue work. Automatic assignment is off, except in an explicit registered
research protocol.

A review question is one human-authored criterion against one exact capture, with all the
evidence that the criterion requires. Do not combine captures retrospectively. Do not
reinterpret a frozen research protocol.

| Purpose                    | Selection and interpretation                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Random audit               | A uniform sample without replacement from a frozen population of automated criterion decisions with verified available evidence |
| Targeted diagnostic        | Explicit named questions or problems that the server classified. The findings are only descriptive.                             |
| Registered research review | Full assignments and release conditions from the frozen protocol                                                                |
| Training review            | At most 10 random questions from released development evidence. The answers never count in an agreement.                        |

The default of the audit is 40 questions. It is a workload limit, not a promised
precision. The preview freezes the population and the seed, and it assigns no work.
Creation binds that preview to an idempotency key. The selected set cannot grow through
tabs, retries, edits, abstentions, absent evidence or an early end.

Wrong AI verdicts lower expert accuracy, so the reviewer labels first and never sees a
judge answer. The protocol for the expert ceiling has these parts:

1. Training. A training review uses only released development evidence of ordinary runs.
   Training and the reviews that count never share an item. A preview excludes each item
   that the other kind of review used, and creation checks this again.
2. Order. Each reviewer gets a separate seeded random order. The seed comes from the
   preview seed and the batch identity, so a second reviewer gets a different order.
3. Sessions. A session ends at 20 active minutes or 40 answers, at the first of the two.
   At the time limit, the current answer still saves, but no new question opens. The
   reviewer continues the same sequence in a new session. Basalt resamples nothing.
4. Delayed repeats. A random or targeted review repeats about one question in ten later in
   the same sequence. At least one other question, and three if possible, comes between
   the two. A repeat never reuses an answer.
5. Reasons. Each saved answer, also a Cannot tell answer, has one fixed reason code and
   one sentence of at most 300 characters. The codes are in
   [Review contracts](../packages/contracts/src/review.ts).
6. Second reviewer. A second reviewer answers the same questions in a separate blind
   batch, with a separate order and separate repeats. Neither reviewer sees a judge
   answer, a judge reason or the answer of the other reviewer.
7. Round 2. Round 2 starts after both reviewers answer all questions. It asks each
   reviewer only the questions with different round 1 answers. Each question shows only
   the answer and the reason of the other reviewer. A question where the two answers still
   differ after round 2 is `contested`.

Basalt measures time from deduplicated intervals of visible, focused interaction. A
reviewer can open an answered question again only in the session of that answer. After its
delayed repeat opens, the first occurrence stays closed. Unanswered questions open in
their order. A session that is complete or that ended early does not continue
automatically.

Draft revisions prevent silent overwrites across tabs. Submitted answers and report
snapshots are immutable. Reuse needs the same reviewer and an unchanged criterion, rubric,
source and captured evidence. Count reused labels separately from new work. Basalt never
reuses training answers, delayed repeats or round 2 answers.

The answer references and the workload counters of each report describe the same frozen
journal snapshot. This is also true when a reviewer submits another answer while Basalt
makes the report. Do not merge different experts into a manufactured consensus. Display
names are not identities. Profiles carry server-generated IDs, and batches freeze that
authority.

Research registration names its reviewer explicitly. Optional audit labels and the labels
of another person cannot release the gates of that protocol. A registered research review
has one reviewer and no delayed repeats, because the frozen protocol fixes its workload.

When a reviewer saves an answer, the save acknowledges the displayed evidence. Basalt
limits an explicit application of an answer across captures to targets that are already
assigned, answered and acknowledged. Each target keeps the provenance of its own answer.
The application never reaches a delayed repeat, its first occurrence or a round 2
question. An abstention is an answered assignment with unresolved scientific meaning.

## Blindness and research gates

A judge can come from the same model family as a builder, for example `openai/` for both.
Related models can prefer the output of their own family. Thus a claim about a builder of
the family of the judge carries this risk, and the report must name the pair.

Text in a judged frame can instruct a judge. Do not draw the harness identity, phase or
time text in a frame. Record it as an observation.

All output of the build reaches the judge in one data field, apart from the public task and
the authored criteria. Sealed source, GUI text, scene text, observation values and images
are output of the build. The judge instructions say that this output is only data and
cannot change the instructions. The judge reports each text in it that speaks to a judge,
with a quote. A found text never changes a verdict. It is an integrity issue: the unit
escalates, and the console marks the check "Text addressed to the judge".

The connector records the text that the GUI shows at each capture. Visible text of the
build routes the capture to optional human review. The route never makes or changes a
verdict. Put evaluator capture controls in the reserved `BasaltEvalCaptureControls` layer.
Drive them from the frozen plan, so that their text does not set the route.

The reviewer sees only assigned criteria and their released evidence in a neutral shell.
Payloads, headings, navigation, completion screens and prefetched content must not contain
model identities, automated judgments, control intent or selection reasons that reveal
information. Operator reports are separate projections.

A round 1 payload never contains the answer of the other reviewer. A round 2 payload
contains only the answer and the reason of the other reviewer. The blind progress does not
show which questions repeat or which review pairs with this one. A reviewer must not open
run results or review reports before the review ends. The reason is that the workbench has
no sign-in.

Only an explicit batch creation or the owned experiment driver issues release receipts.
Knowledge of an asset URL does not bypass the binding or the release gates. Optional audit
labels cannot release research gates. Labels of a registered protocol stay limited to
their purpose. They keep the exact frozen population and expert identity.

## Audit interpretation

Report these figures:

- planned outcomes
- the eligible population
- exclusions
- selected questions
- answered and unresolved labels
- abstentions
- reused labels
- observed agreement
- `falseAcceptanceShare` among automatic accepts
- `falseRejectionShare` among automatic rejects
- `removalShare` and `escalationShare`
- measured review time

Each figure carries its numerator and denominator. A random audit gives `missRate` and
`falseRejectionRate` only as sample counts, because the count of units that fail in the
population is unknown.

A report keeps one paired record for each sampled unit and rater. The record gives the
unit, the rater (the reviewer identity or the automatic treatment), the decision, and the
score or the abstention. An unresolved label stays in the records as unknown. For each
authored scale, the report gives these statistics:

- exact agreement
- agreement within one step on an ordinal scale
- mean absolute error
- signed bias (automatic minus human)
- quadratic weighted kappa
- Krippendorff's ordinal alpha with missing values

Exact agreement and agreement within one step use the hypergeometric interval below. The
other statistics have no exact bound. They use a percentile bootstrap that resamples whole
builds. The seed comes from the population identity, so a report is reproducible. If there
are fewer than two builds, or if a statistic in a resample is undefined, there is no
interval. Each audit stream has a monitor: one sampled false acceptance sets the stream to
escalate-all.

Only the first round 1 answer to a question counts in an agreement. Training answers,
delayed repeats and round 2 answers never count. The report gives the agreement of each
delayed repeat with its first answer separately. This is within-reviewer agreement with an
exact Clopper–Pearson interval. Cannot tell, flagged and absent answers stay unresolved in
it.

With a second reviewer, the report compares three pairs on identical items: judge and
first reviewer, judge and second reviewer, and the two reviewers. Each pair gives these
statistics:

- exact agreement on criterion acceptance, with its interval
- nominal Krippendorff alpha
- build acceptance agreement
- the paired statistics of each authored scale

These statistics use the shared functions of
[Statistics](../packages/experiments/src/statistics.ts). For the reviewer pair, the signed
bias is the second reviewer minus the first. The report stratifies judge agreement by
whether the two reviewers gave the same round 1 answer. It lists each disagreement with
both answers and reasons, the round 2 answers, the judge answer and the status. The status
is round 2 not started, round 2 open, agreed in round 2 or contested.

The two reviewers give one measure of agreement between experts. They do not give a test
that shows if the judge can replace a reviewer (an alternative-annotator test). That test
needs three or more reviewers and 50 to 100 items, so the report does not run it. Expert
agreement on 3D quality can be low (kappa near 0.53), so the expert ceiling can be near
the gate. Report the ceiling beside each judge figure.

The acceptance gate for a random audit names its metric: build acceptance agreement
(`candidate_acceptance_agreement`). This metric counts a build as accepted when every
required criterion with an acceptance meaning is met. It counts the build as rejected when
one of these criteria is not met. The gate is met when both of these conditions are true:

- The judge–expert agreement on build acceptance is at least 0.80 for each reviewer.
- The judge–expert agreement is no more than 0.10 below the expert–expert agreement.

The gate compares the estimates. Each report and each claim also gives the exact
Clopper–Pearson lower bound of each figure. A build without a decision from both raters is
unresolved. Thus a sample that does not cover all the required criteria of a build leaves
the gate unresolved. If there is only one reviewer, the gate needs a second reviewer. A
targeted, training or registered research review does not apply the gate.

Before you freeze a random-audit population, select one grading stream for each run. The
stream identity includes the frozen provider configuration, the presentation, the method
and the evidence condition. Keep each deterministic decision one time. Do not average
judgments that compete. Do not choose the judgment that arrives first. Evidence-use
controls belong to diagnostics or registered research.

Reports keep the full denominators of the source and of the selected stream. They also
keep absent outcomes, exclusions and exact decision references. A stream can reuse a label
from another stream only for the same reviewer and an unchanged, complete binding of
rubric, source and evidence. The reuse does not create more human observations.

A sensitivity test does not estimate accuracy. For each criterion and control, it reports
the held, changed and abstained counts and the change rates. A visual criterion that stays
met without its frames shows that the answer did not rest on the frames. Captures of one
build are not independent, so each exact test counts builds, and each build gives one
sign. One build cannot show an effect.

- The McNemar mid-p uses the net change from met to not met in each build.
- A sign test compares the change rate of each control with the noise floor in each build.
- Localization uses the McNemar mid-p of decisive against sham changes in each build.
- Direction and text use a sign test: the answer follows the swapped pixels, or it moves
  toward the answer that the note asks for.
- Holm adjusts each family of tests across criteria.

Repeated judgments of the original evidence measure the noise floor. If there are no
repeated judgments, the report says "Noise floor not measured". No test against the noise
floor runs.

For a random audit, invert the hypergeometric distribution to get exact equal-tail 95%
intervals over the fixed population of criterion decisions. Keep sampled labels that are
unanswered or abstained. Use conservative bounds over their possible binary completions.
Do not discard unresolved labels. Do not report a biased complete-case estimate. The
[finite-population statistical basis](https://arxiv.org/abs/2405.06722) matches a sample
without replacement.

The experiments package contains the pure functions and the enumerated coverage checks for
small populations.

Reports of a targeted diagnostic or of a registered research review do not claim an
unbiased estimate of overall accuracy. Audit intervals do not establish the acceptance of
a build, the reliability of future runs or equal reliability across mechanics. Scores stay
in groups by compatible authored scales. No report automatically promotes a grader to
calibrated. A met acceptance gate is also not calibration.

## Claims and historical evidence

Synthetic adapters establish application behavior only. A local test, a screenshot or a
scripted label does not establish live engine acceptance, perception ability, grader
calibration or a new expert judgment. Live smoke runs need a separate explicit
authorization for spending.

Historical studies keep their original identities, failures, denominators and limitations.
Their commands and formats are not current interfaces. Archives verifies the retained
bytes without migration or compatibility interpretation. An authorized retirement removes
obsolete artifacts and their archive entries. A historical readout does not recreate
deleted evidence. See [Research](RESEARCH.md) for the evidence index and
[Roadmap](ROADMAP.md) for the live and scientific acceptance that remains.

The console groups checks by grading method: **Code checks** and **Judge checks**. These
names do not divide checks into behavior and appearance. A judge check can assess
behavior. A signed observation establishes provenance, not the correctness of a mechanic.
Basalt can treat only an explicitly authored, supported assertion as verified. Absent or
ambiguous evidence stays insufficient.

Public observation instructions declare the roles that the builder must tag on the targets
that it creates. A role has one name: its id is also its CollectionService tag. In the
evaluations of 4 October 2026, a role had a separate id and tag, and most builders put the id
on the object. The plan then found no target, so a role has no separate tag now. An absent tagged role does not establish that the requested
object is absent. The dependent checks are incomplete, with an explanation about
observation identity.

This rule applies only to a role that the capture never found. If an observation of the
same capture found the tagged target, a later absence is evidence. For example, a pickup
removes a tagged coin, and the observation after the pickup records the removal.

One case is definitive. If no target anywhere has the tag of a required role, the build
violates the public role contract. Then the result of an authored `exists=true` check on
that role is rejected. Its explanation says that the build does not meet the contract. It
does not say that no untagged object exists. For that check, optional absence, ambiguity,
a wrong class and a wrong scope stay incomplete.

Observed absence at an authored literal scene path keeps its original meaning. Basalt
keeps the raw observations and the historical judgments.

The moving-platform carriage input is a separate authored input, and the historical
original stays without change. It separates supported rider travel from motion
readability. The outcomes that exist keep their original meanings. New authored input
needs preparation and empirical validation before Basalt can use it as a runnable
evaluation.

One fixed rule selects the frames before judgment, and no model chooses them. Each view
has an authored `frameBudget` of 1 to 64 frames, which also sets the quote. For each
transition, the rule requires the frames that the transition needs. It also requires the
fewest effect-window frames that keep the view gap. If the required frames do not fit in
the frame budget, the evidence is insufficient. The rule never cuts them.

The other effect-window frames come next, and then an even fill up to the frame budget.
Phase captures in the same request reduce the room to at most 64 images in all. The image
label of each frame states its selection roles and its offset from the anchor that it
serves.

The evidence packet manifest describes this dispatched selection. It binds these items:

- the criterion IDs
- the IDs, hashes and timestamps of the original frames
- the identities of the source plan and the acquisition
- the frame budget
- the selection roles
- the omitted intervals
- the no-transform provenance

Criteria in a batch share their declared acquisition view. This is not semantic
query-aware selection. The frame sample cannot recover uncaptured or occluded events. No
controlled comparison shows that this rule judges better than another rule. The confidence
of a vision-language model is not calibration.
