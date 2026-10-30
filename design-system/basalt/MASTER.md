# Basalt workbench

The main work in Basalt is to test models and to compare them. The journey has these
steps:

1. Choose evaluations.
2. Select models.
3. Set a spending limit.
4. Start.
5. Compare the results.
6. Examine the evidence.

Two other types of work are also first-class: the creation of reusable evaluations and
optional human review.

## Visual language

The console looks like a quiet research instrument. It has a light cream page inside a
column with hairline frames, and spruce is the one solid mark. Names use a serif type over
a sans interface. Mono capitals set each label that classifies an item. Labels that a
person reads as text do not use mono capitals. All other color shows only the state of a
result.

- The tokens are in `apps/console/app/globals.css`. They set these values:
  - cream `#FAF7F0` for the ground
  - white paper for panels, tables and fields
  - sage tint `#F2F4EF` for table heads and quiet panels
  - spruce `#20352C` for section bars, primary actions, the selected segment and met marks
  - ink `#191C1A`
  - slate `#5A605C` for support text
  - rules `#DCDDD5`/`#BEC5BC`
  - control border `#8A958F`
  - green `#2F6A4F` for links, action labels, the current state and focus
  - brick `#B0433A`, which means not met or error
  - ochre `#8A6514`, which means unavailable or pending charges
  - one tint for each kind of measure in figure tiles: sage for results and counts, rose
    for charges and warm grey for time
  - a neutral `#4F4F4F` stage for rendered evidence, so that the stage does not tint the
    colors that a person examines.
- Components use only semantic tokens. The frame and solid basalt are separate tokens. The
  frame is the spruce section bars and the setup summary bar. Solid basalt is for primary
  actions, selected segments, met marks and finished steps.
- Light is the default. The console never reads the color preference of the system. The
  header switch (Dark mode, a pressed toggle) selects dark. This device remembers the
  choice, and the console applies it before paint.
- Dark is a separate scheme, not an inversion of light. It is warm graphite, the night
  side of the cream page. Dark has no green-tinted grounds, and the evidence stage does
  not change. Dark uses these values:
  - neutral grounds `#141312` and panels `#1C1B19`
  - neutral bars `#2D2A26`
  - warm cream type `#ECE7DE`
  - cream as the solid mark, for primary actions, selected segments and met marks
  - sage `#A3CBB3`, only for links and focus.
- The words obey the rules in Console text below. Keep technical IDs and raw records
  inside disclosures. Lists, notifications and live runs show a recorded run problem as
  one plain sentence. The run page adds a Full error disclosure with the exact text. If
  rows repeat the same work, the console shows them as one row with a count.
- The console has three type voices:
  - Geist (self-hosted, OFL) is the interface: 16px body, 15px tables, 14.5px controls and
    support text, and weights 400 and 500 for words.
  - The system serif (Iowan Old Style, New York) names things: 40px page titles (32px on
    phones), 23px section headings, 18px card and step titles and an 18px lede. It always
    uses weight 400.
  - Geist Mono sets column heads, status tags, segmented views, fact labels, section bars,
    action links, step numbers and figures in leaderboard cells. It uses capitals at
    11–12.5px with `letter-spacing: 0.04em`.
- Names of runs, models and evaluations stay in sentence case. Prose, form labels and
  recovery messages also stay in sentence case. Counts use tabular numerals, and large
  figures use the light weight (300). Words that replace an absent figure
  ("Not timed yet", or "Not recorded" after the work finished) use Geist, not Mono.
- The frame has a 56px cream header over a hairline and a 1320px column with hairline
  sides. Each page heading has a rule across the full column. The frame uses 4/8px space
  steps, 44px controls, 2px control corners and square sheets. Only overlays have shadows.
  Before you add another box, use space, rules and type.
- The square is the motif. Each status starts with a 7px square in its tone. The current
  navigation item, log results, notification dots and answer marks are squares. Progress
  steps and setup steps are sequences, so they use numbered squares.
- Dropdowns use the field frame, with a thin chevron at the far edge of the control. If
  the browser allows it, the open list is a paper sheet with a hairline frame. The sheet
  has tinted hover rows, mono group labels and a small square beside the chosen option. A
  count or a limit that describes a control is a hint under the control, not beside it. A
  person types amounts, limits and scores into plain fields without spin arrows.
- Views are segmented controls. Their cells have hairlines and share borders, and the
  selected cell is solid spruce. If a table or a fact list stands alone on the desk, it
  hangs from a spruce bar with its name. Otherwise, it starts with a sage header strip in
  mono type.
- Actions have three weights:
  - the primary spruce button, one in each context
  - the bordered secondary button, for row actions and parallel actions
  - the action link, for standalone navigation. It uses green mono capitals with an arrow,
    shows a wash on hover and aligns to the text edge.
- Only links inside sentences have underlines. Names of runs, builds and evaluations show
  as links with ink titles.
- Unfinished work shows as whole-row links. Each link names the kind of work, what the
  work is about and what makes it different. The first three links show, and the other
  links fold under a count. If the server confirms a start, the start leaves the list for
  its run. An unconfirmed start is first in the list and says that it is unconfirmed. A
  person cannot discard it.
- The console shows criterion statements without their authored list marker. The stored
  text and each answer keep the exact authored span.
- All disclosures use the same chevron, which rotates. Phosphor icons go with visible
  labels. Short color transitions obey the reduced motion preference. The only ambient
  motion is the pulse on an active status. Do not show slogans, invented progress
  percentages or unsupported times.

## Console text

Console text is natural, plain English. ASD-STE100 is a guide for it, not a rule set: keep
its short sentences, active voice and one word for one concept. If an ASD-STE100 rule makes a
sentence sound stiff, write the sentence that a good product writer would write. The
documents, code comments and commit messages still follow ASD-STE100 (`AGENTS.md`).

- Write short, direct sentences in the active voice. Join two short steps with "and" or a
  comma instead of a chain of "Then …" sentences.
- Do not start every sentence with "Basalt". Use it when the reader must know that Basalt
  acted, for example "Basalt kept the original evidence."
- Words that end in "-ing" and contractions are fine when they read naturally.
- Say what the person sees and does. Do not say how Basalt stores it, for example
  "retained", "frozen", "provenance", "grading stream" or "reservation".
- An error message says what happened and what to do next.
- Labels use the usual interface conventions. A label can omit "the" and "a". A status word
  can end in "-ing", for example "Loading…" or "Running".

Use only these words for these concepts. Use the code name only inside a Full error
disclosure or a raw record.

| Console word           | Meaning                                                                        | Do not use                       |
| ---------------------- | ------------------------------------------------------------------------------ | -------------------------------- |
| evaluation             | A prompt for the builder model and its private success criteria                | eval, task                       |
| criterion              | One success criterion of an evaluation (plural: criteria)                      | requirement, rule                |
| run                    | One start with one spending limit                                              | operation, job                   |
| benchmark              | A run that builds the same evaluations with one or more models                 | experiment                       |
| build                  | The code that one model makes for one evaluation                               | candidate, solution, subject     |
| observation            | One recorded play of a build in Studio                                         | capture, pass, trial             |
| evidence               | The images, recorded behavior and code of an observation                       | artifacts, material              |
| check                  | One answer for one criterion and one observation                               | outcome, judgment, result check  |
| code check             | A check that fixed Basalt code makes from recorded facts                       | deterministic check              |
| judge check            | A check that the judge makes from the evidence                                 | qualitative check, visual check  |
| evidence class         | What a judge criterion needs to see: appearance, timing, motion or causality   | capability, slice, category      |
| answer                 | Met, Not met, Not enough evidence or a score                                   | verdict, decision                |
| judge                  | The model that makes judge checks, with the evidence form that it reads        | checker, grader, judging setup   |
| spending limit         | The maximum cost of a run                                                      | budget, cap, ceiling             |
| charge                 | A cost that the provider confirmed                                             | spend, bill                      |
| pending charge         | An amount that a request holds until the provider confirms the cost            | reservation                      |
| preview                | The free check of a selection before a run starts                              | quote, estimate                  |
| reassessment           | A run that checks saved evidence again with a judge                            | regrade                          |
| sensitivity test       | A run that checks saved evidence again with parts of it replaced or removed    | control run                      |
| control                | One change to the evidence that the judge reads, for example blank images      | substitution                     |
| noise floor            | How often the judge changes its answer when it checks the same evidence again  | repeat variance, jitter          |
| judge sample           | One of the identical requests that the judge answers for the same check        | retry, replicate                 |
| split                  | The answer of a check whose judge samples disagree; neither met nor not met    | mixed, inconclusive, flaky       |
| addressed to the judge | Text in a build’s output that speaks to the judge; a person checks it          | prompt injection, jailbreak      |
| region                 | A rectangle of an image that a person marks for one criterion                  | area of interest, heatmap        |
| comparison             | A report on two or more runs and the differences in their test conditions      | diff                             |
| review                 | A sample of questions that a person answers without the judge's answers        | audit                            |
| reviewer               | The person who answers a review                                                | auditor, labeler                 |
| random review          | A review of questions that Basalt picks at random                              | audit, random sample             |
| targeted review        | A review of questions that a person picks for one reason                       | diagnostic, targeted check       |
| review session         | One sitting in which a reviewer answers questions                              | batch                            |
| training review        | A short review of separate questions whose answers never count                 | practice, calibration            |
| reason                 | The fixed reason code and the one sentence of each saved answer                | rationale, note                  |
| second reviewer        | A second person who answers the same questions in a separate review            | adjudicator                      |
| round 2                | The step where each reviewer sees only the other reviewer’s answer and reason  | consensus, adjudication          |
| contested              | A question where the two reviewers still disagree after round 2                | unresolved                       |
| repeat                 | A question that comes back later in the same review, for reviewer agreement    | duplicate                        |
| acceptance gate        | The rule for build acceptance agreement between the judge and two reviewers    | threshold, bar                   |
| sequence notes         | Notes that a model writes from a recorded sequence before the judge reads them | sequence observations            |
| reference build        | A build that a person supplied to test an evaluation                           | control                          |
| saved build            | A build from an earlier run that Studio plays again; no model makes it         | retained, saved source           |
| source run             | The run that made the saved builds or the evidence that another run uses       | earlier attempt, parent, origin  |
| anchor build           | A build that a person chose to show the lowest level that meets one criterion  | exemplar, bar build              |
| suite                  | A saved set of evaluations                                                     | collection                       |
| saved example          | A saved build and its evidence, kept for future checks                         | regression                       |
| reference test         | A test of an evaluation against reference builds that people supplied          | control validation               |
| Studio                 | Roblox Studio                                                                  | the engine                       |
| Studio slot            | One Studio that the Studio computer can run at a time for Basalt               | lane                             |
| waiting for Studio     | The time that a job waits for a free Studio slot                               | queue time, time in queue        |
| Studio time            | The time that Studio runs a development run or an observation of a build       | session time                     |
| turn                   | One request of the builder model, with the tool calls that answer it           | step, iteration, trace           |
| build time             | The time that the model works on one build. Paused time does not count         | duration, wall time              |
| total time             | On Progress: from the start of a run, with its Studio check, to its results    | wall time, elapsed               |
| first build to results | On Benchmarks: from the first build of a run to its results summary            | total time, campaign time        |
| Show                   | The choice of the measure in the results of each evaluation                    | display, metric                  |
| model                  | An OpenRouter model that a person added on the Models page                     | pool model, approved model       |
| preparation model      | The model that prepares a draft and writes the builds of a reference test      | planner, compiler model          |
| coverage notes         | Notes of a second model about how the prepared tests cover each criterion      | audit, plan review               |
| coverage model         | The model that writes coverage notes after preparation                         | auditor, audit model             |
| defaults               | The models that a new run starts with, saved on the Models page                | presets, launch defaults         |
| screen recording       | The video of the Studio windows of one observation, a diagnostic only          | diagnostic capture, video        |
| private check          | One test of the prepared plan that the builder never sees                      | hidden test, executable check    |
| empty build            | The files of an evaluation before any change, played with the private checks   | blank build, seed run            |
| plan warning           | A sign that a private check may not tell builds apart                          | red flag, lint                   |
| provider pause         | Work that waits for Resume after OpenRouter refused or kept failing requests   | outage, provider hold            |
| log                    | The saved record of the steps of one build or judge check, for diagnosis       | trace, transcript                |
| requests at once       | The most requests that one run sends to one model at the same time             | concurrency, parallel requests   |
| tool call              | One action that the builder model asks a tool to do in a turn                  | function call, action            |
| change                 | What one tool call did to one source file of a build, line by line             | diff, patch                      |
| export                 | A file with the results of a run or a comparison that a person can share       | bundle, snapshot, archive        |
| tool set               | The saved prompt, tools and limits that a model builds with                    | harness, profile                 |
| API notes              | Public Roblox and Luau reference files that a tool set can give the model      | reference pack, docs, notes pack |
| context summary        | A summary that replaces a long build conversation, when the tool set allows it | compaction                       |
| reasoning effort       | How much a model reasons before it answers, as a tool set asks for it          | thinking budget                  |
| keyboard shortcut      | A key that does an action of the page, for example → for the next criterion    | hotkey, key binding              |
| hypothesis             | A model's guess about why a check has a plan warning; it changes no answer     | diagnosis, finding, root cause   |
| recheck                | A check of saved builds with another version of their evaluation               | regrade, rerun                   |
| known good build       | A saved build that a person marked as meeting named criteria                   | golden build, oracle             |
| known bad build        | A saved build that a person marked as not meeting named criteria               | negative oracle, bad example     |
| contradicted           | A known build whose answer in a new version differs from its mark              | broken, regressed                |
| retire                 | Stop a known build from checking new versions, and keep its mark               | delete, archive                  |
| stage                  | One ordered part of an evaluation: a prompt and criteria that continue a build | milestone, step, phase, level    |
| gate                   | The required criteria of a stage that a build must pass before the next stage  | checkpoint, barrier, threshold   |
| not reached            | A build of a later stage that never started, because an earlier stage stopped  | skipped, failed, blocked         |
| end run                | Close a run that has no active work; its charges and records stay              | cancel, abort, dismiss           |
| model answer           | Meets more often, Meets less often or Not enough builds to tell                | better, worse, wins, tie         |
| pattern answer         | Happens more often, Happens less often or Not enough builds to tell            | better, worse, regression, fixed |
| unclear build          | A build without a clear outcome for a criterion, also after an outside stop    | unresolved, undecided            |
| failure pattern        | The builds of one model that show one kind of failure, with their share        | failure mode, error profile      |
| code analysis          | The luau-lsp findings in the sealed code of a build, by lint code              | lint, static analysis            |

## Journey

The workbench is one loop: Benchmarks → Run a benchmark → watch Progress → read Results →
check evidence → optionally review. Each step has a link forward to the next step and a
link back to its origin. One thing keeps one name everywhere, for example
"Run a benchmark", "Records", "Optional reviews", "Met" and "Not met". A page title is the
same as the navigation item that opens it.

- Benchmarks is the desk. Active runs show first, under Running now, and each one opens
  its Progress. Runs name their models with the registry names, also before the run freezes
  its models. Unfinished work shows the unfinished setups and evaluation drafts that
  Basalt recovered on this device. The latest saved comparison comes next.
- Each row in Evaluations has Run. Run opens the setup with that evaluation selected.
  Models links to step two of the setup. If a person opened Settings from a setup,
  Settings returns to that setup and keeps its choices.
- The Progress view of a finished run has View results. Benchmarks links each model to its
  build results. Its Open this run link opens the run.

## Navigation, setup and editor

A 56px cream header holds the serif brand beside its three basalt columns. Then it holds
the primary items Benchmarks (home), Evaluations and Models. Then it holds Records and a
More menu with Optional reviews, Research, Archives and Settings. More shows the name of
its active destination. More closes on Escape, on a click outside it and on navigation.
Below 1024px, the header keeps the brand, the notifications and a labeled Menu dialog.

Each detail page starts with a back link to its section, then the current page. Section
pages have no breadcrumb. Use one current route for each surface. Do not keep retired
route aliases. An absent execution setup never blocks saved evidence or review.

Records puts active work and results first. A compact Needs attention link counts the runs
that are interrupted now, and it opens the filtered run list. Old errors never make a
stack of banners above the results. Keep the diagnostics and pending charges of a stopped
run beside the run. Show them in All runs and in the workspace of the run. If a person
hides the global banners, the failures stay unresolved and the pending charges stay.

Run a benchmark has three numbered steps on one page: Evaluations, Models to test and
Confirm & start. The third step hangs from a spruce bar. It holds the spending limit, the
evaluations × models = builds equation and the start action. On desktop, it stays beside
the first two steps. On narrow screens, it comes after them.

Create evaluation returns to the selection, which stays as it was. Selected model names
stay visible during a search, also when the filter hides them. More options has tools,
repetitions, observations and provider capacity. How Basalt checks builds identifies the
code checks and the judge. It does not make the support models another setup step for the
person.

The evaluation editor has a title, Prompt and Success criteria. Explain one time that the
criteria stay private. Add stage adds a stage below the last one. With one stage, the
editor shows no stage heading, no stage actions and no gate, so it looks the same as
before. With two or more stages, each stage has the heading “Stage 2 of 3”, Move up, Move
down and Remove stage. After a move, focus follows the moved stage. Remove stage shows
“Stage N removed.” with Undo until the next change, and focus goes to Undo. Each stage
except the last has the optional Gate before stage N, with a checkbox for each required
criterion of that stage. Wherever authored criteria show, the criteria pane looks sealed: a
deeper ground, a basalt rule and a Private tag. Keep the original words and the number of
criteria. Show the parsed criteria beside their text. Put each clarification at its
passage.

Evaluation drafts save to the server. Each draft has local recovery, and the editor shows
conflicts. Save evaluation and Save changes are free. Edits keep one library entry, and
Duplicate deliberately creates another entry. Archive, restore and delete are explicit
actions under More actions, beside the evaluation. Saved runs keep their exact original
inputs.

A settled run has Run actions beside its recovery actions: Archive run or Restore run, and
Delete run. Each action opens a dialog that states its effect. The delete dialog tells the
person that they cannot undo the action. Rows in All runs have Archive or Restore, and the
Status filter has Archived. Spending of deleted runs is a closed disclosure under the archived
runs.

The summary of the selected evaluation has Edit and Remove, and these actions keep the run
setup. Always use Suites for saved groups. Show the authored criteria one time. Put the
prepared check mappings and the reference test in disclosures. Models show in a compact
list.

A staged evaluation page shows each stage under its own “Stage N of M” heading, with its
prompt, its sealed criteria, its checks and its coverage notes. A gate shows as an info
notice under its stage. It lists its criteria and names the stages that show as not reached
if the build fails the gate. Known builds, rechecks and reference tests check one build
alone, so a staged evaluation shows none of them. In the results, each stage is its own
evaluation with the title “Title · Stage N of M”, in stage order. A build of a later stage
links to the build that it continues. A stage that the run did not reach shows a neutral
“Not reached”, never a failure mark, and its builds count separately.

A build that the run did not reach says why, in its result row and on its evidence page:
“Model · Build 2 didn’t pass the stage 1 gate, so this build never started.” A link, “See
the gate check”, opens the gate check that failed. If no gate check failed, the text says
that the earlier build didn’t finish its stage. The evidence page of the build has the
heading “This build never started”, with no answer, build history or actions. Activity
shows its event as “Building not reached”.

A build that failed or did not finish says why it stopped, on Progress and in Activity. The
sentence comes from the saved run of the build: its stop reason, the count of refused tool
calls and the last refusal, or the output limit. Examples: “The model sent 3 tool calls that
Basalt refused, so the build stopped. Last refusal: …” and “The model used its full output
limit and called no tool, so the build stopped.” A quoted reason has at most 200
characters. The text never shows a request, model text or tool arguments. The recorded
category stays in Full error.

When work stopped, Progress and each benchmark table show “Why work didn’t finish”. Each row
names one recorded cause in a few words, such as “Tool calls refused” or “Model provider
error”, counts its units (“1 build · 2 observations”) and links each build that it stopped.
Causes outside the build, such as the provider or Studio, come first. Work without a
recorded cause shows “No recorded cause”. Basalt never guesses a cause.

The evidence of a code check shows the values that Studio recorded beside its answer, for
example “Recorded: 0 before and 3 after, a change of 3.” Why this result explains the
answer in plain words, such as “The measured change was outside the expected range.” The
stored result keeps the text of the code check, because Basalt checks it against its hash.

If preparation started from an earlier version of the evaluation, the evaluation page says in
one sentence what Basalt kept, for example “Basalt kept the tests of the earlier version and
prepared 2 new or changed criteria.” If Basalt kept the tests of only some stages, the
sentence gives the count of stages. If it kept none, the sentence says that Basalt prepared
new tests. Without an earlier version, the page has no such sentence.

The evaluation page puts Plan warnings beside Coverage notes. A required code check that
passes on the empty build is the row “Passes on the empty build”. After benchmarks, a check
gets the row “Every build fails with the same value”. A check that every build fails or meets
gets the neutral row “Every build fails” or “Every build meets it”, because an easy or a hard
check also gives it. Neutral rows come after the warnings. The summary counts them apart, as
“same in every build”. Each row has a short sentence under What Basalt saw. The section also
says when the empty build check is incomplete or has not run. The section opens by itself only
for a warning or an incomplete empty build check. Coverage notes have one table for the
criteria, with In prompt and Mixes evidence classes, and one table for the private checks.

Explain failures sits under the plan warnings. Its button opens a free preview, and a second
button starts the one request with a spending limit. Hypotheses show one table for each
flagged criterion, with Question, Hypothesis (Yes, No or Unclear), Evidence for, Evidence
against and Observations. Each cited observation links to its evidence. An answer that names
an unknown observation shows Incomplete with its reason. While the questions are a draft, the
section says so. The benchmark page shows a short note with the count of plan warnings and a
link to the evaluation. If all its rows are neutral, the note gives the count of checks that
gave every build the same answer.

## Cost and progress

Show the explicit spending limit, the charges and the pending charges separately. Do not
recommend a maximum-context forecast as the expected cost. For work without a measured
cost, the console says “Basalt has no measured cost for this setup.” Comparable history
includes the sample count and the scope.

All work shares one spending limit. If the next request of a work item does not fit, that
work pauses until a person raises the limit. Details lists the charged and pending amounts
for each work item.

The run header shows the title, the state, a ledger of charges and the tested models. The
ledger shows charged / limit with a meter. A hatched segment of the meter shows the
pending charges, only when they exist. The views are Results, Models, Progress and Details.
At first, active work opens Progress, and finished work opens Results. Keep a view that a
person selected explicitly.

The steps are Checking Studio → Preparing tests → Building with selected models →
Collecting evidence → Checking results. A reference test has the step Testing reference
builds after Preparing tests. The timeline is the only place that tells what
occurs now. The reached step expands in place and shows its action, elapsed times and
explanation. Between two units of work, the latest step with completed work stays reached,
and the steps before it stay finished. Show the actual elapsed time and the completed counts. Mark reuse explicitly.
If no tested model started, state this explicitly. A run that only prepares checks ends with
the step Ready to run, which says what it does: "Saves the checks, so the evaluation can run
in a benchmark." A finished preparation says "Checks prepared", not "Results available".
A run that a person stopped says "Run stopped", and its chip says Stopped, also when a
failure came first. "Run paused" is only for a run that can continue without a stop.

A provider pause has one notice. It starts with "Paused:", names the cause in plain words
and says what to fix, for example "Paused: OpenRouter rejected the API key. Fix the key,
then resume." The notice holds the only Resume action of the page. It never offers a higher
spending limit, because a higher limit does not continue a provider pause.

A run without model builds and without judge checks, for example a Studio replay of a saved
build, says "No model requests" in place of its charges and spending limit, and it offers no
higher spending limit. Its spending section names its source runs and says that each run
keeps its own charges. The last event of a run says in plain words what no person confirmed
yet, for example that no reference test tried the checks. A run without answers mentions no
review.

An interruption has one explanation, its effect, its charges so far and the supported
recovery actions. A Studio stack trace or any text with source locations goes under Full
error, below one plain sentence. For an unknown paid request, offer Check payment status. Never offer an
unsafe retry. At an interruption, stop the elapsed clock. Model work has no countdown and
no time allowance, and stopped work must not look active or overdue.

Show the elapsed time of the current step separately from the elapsed time of the run.
During Collecting evidence, name the tested model and show the declared Play observation
window. Explicitly exclude the overhead of startup and acquisition from that window.

Details keeps the execution activity as a dense log. Each transition has one line with its
time and a result square. Under the transition, the line names what its unit covers, in the
words of the results table, for example "OpenAI: GPT-6 Luna · Build 2 · observation 1 ·
criteria 1–13 · judge sample 2". A criterion has the number that the evidence view shows. The
judge sample shows only when a check has more than one. The line adds the recorded reason
only when one exists. The start
of a build or a judge check links its log with View log. The date
repeats only when it changes. On phones, figure tables stack and keep the row name above
the labeled values.

Details lists the screen recording of each observation before the activity log, only when
a recording exists. Each row names the build and the observation, shows its Studio slot
and has one "Watch" link, and its accessible name names the build, the observation and the
slot. The recording answers byte ranges, so a person can seek in it. A screen recording is a diagnostic. Never show it beside answers, in evidence, in a
review or in an export.

Keep the Studio recovery safeguard in a disclosure. It is not a completion estimate, and it
is not a model timeout. Show the check failures that are not resolved, also while other
authorized work continues. Preparation failures show their saved diagnostics inline, under
Technical details. If neither Resume nor a spending limit increase can resolve the problem,
hide both actions. A failed preparation says that each run prepares the checks again, and
that a person edits the named criterion only if it fails the same way again. It offers Set
up a new run, and Edit evaluation for a library evaluation. If preparation finds unclear
criteria, the notice lists each one in the person's own words, with the reason, in place of
Technical details. Its first action is Edit evaluation, which opens the editor with the same
reasons beside the criteria. After any stopped preparation, nothing runs, so Stop becomes
End run, and its confirmation says that the charges and records stay. The page of a draft
evaluation lists its related runs. If the newest one needs attention, a notice gives the
reason and links to it.

## Results and evidence

Answers show as marks, not as words in pills, with one numbered mark for each observation.
A mark is solid basalt when met, and brick with a line through it when not met. The line
stops short of the observation number, so the number stays readable. A split
mark has a solid basalt edge on a paper face. "Not enough evidence" is a final answer, not
an absent result: its mark has a solid ochre base on an ochre wash, and it is never dashed.
A mark has an ochre hatch when unavailable, and it is dashed while the check is not
complete. A legend goes with the marks. A check with judge samples states the combined
answer, for example "Met 3 of 3", "Split: 2 of 3 met" or "Not enough evidence: 1 of 3 met".
A check whose build output speaks to the judge has the warning status "Text addressed to
the judge". The accessible name of each mark states the criterion, the observation and the
answer. Aggregates use the same colors and patterns, as a proportional bar beside written
counts. They count "Not enough evidence" apart from unavailable answers.

Group independent builds by evaluation. Show behavior, quality, unavailable answers, build
cost and time separately. A count of answers counts each check one time, with the combined
answer of its judge samples. Not enough evidence has its own count, for example "2 not
enough evidence". It is an answer. It is never unavailable, and it never causes "Some
results missing". Repeated observations expand inside their build. Keep optional
tool-call columns out of the default table. A single build opens its criteria directly,
with one statement for each criterion and a button for each observation. Optional review
and refresh are in Result actions.

A comparison has two to six runs. A person chooses them with checkboxes, and the order of
the choice is the order of the columns. The banner states Same test conditions, Conditions
differ or Cannot compare for the worst pair of runs. Differences between runs is a
disclosure that names the two runs of each difference and the unknown dimensions. One grid
has a row for each criterion in authored order and a column for each run. Each cell has an
outcome bar, written counts and numbered marks that open the evidence. Every column has the
same neutral style, so no column looks better. Answers that changed on the same saved
evidence stay in a neutral disclosure. Without an authored acceptance threshold, numerical
scores stay scores. Distributions keep the context of the criterion and the scale. Never
invent an overall quality score, a winner, a threshold or a calibration badge.

Models compares the models of one run, one criterion at a time. A person picks a model in
Model, and the URL keeps the choice. Each criterion row gives the met builds of that model,
for example "4 of 5 met · 1 unclear". For each other model of the same tool set, the row
gives one model answer: "Meets more often", "Meets less often" or "Not enough builds to
tell", with the met builds of the other model. A model answer is not the judge answer "Not
enough evidence". One sentence explains "Not enough builds to tell": the difference in these
builds could still be chance. If no criterion can reach an answer with the build counts of
the run, a sentence above the tables says so. By evidence class gives the same answers for
each group of criteria. Failure patterns count the builds of the selected model by how they
ended, by the local checks and tool calls that failed, by refused tool calls and by the
causes of unfinished work. Code analysis counts the builds with a finding of each lint code,
shown as code, and Script errors counts the builds with an error from their own scripts or
from an unknown script. A sentence names how many builds have a code analysis. A build
without one never counts as a clean build. For each other model, a failure pattern row gives
one pattern answer: "Happens more often", "Happens less often" or "Not enough builds to
tell", with the builds of the other model, for example "0 of 6 builds · 2 without a code
analysis". A pattern that only the other model shows gets a row with 0 builds.

When a run builds one model with two or more tool sets, Compare with offers Other models and
Other tool sets, and the URL keeps the choice. Other tool sets compares the tool set of the
selected model with each other tool set of the same model. Each column names the tool set,
for example "Compared with Studio tools + code analysis", and gives the same model answers
and pattern answers. If a tool set shows the model its code analysis, a sentence says that
fewer findings are expected and that the criteria show how often the builds meet each
criterion. Every column has the same neutral style. No color, order or word marks a better
model or tool set. How Basalt decides explains the outcome of a build and the tests.

How it was built shows the turns of one build in order. Each turn row has its tool calls,
its Luau errors, its tokens, its charge, its time and a link to its request when the
spending records agree. A change shows its lines with + and − glyphs on neutral grounds, not
in the colors of results. A change that Basalt can't check against its records says "Basalt
can't verify this change" and shows no text. A build row and the evidence of a build open
this view.

The request page reads only saved records. It shows the confirmed charge, the pending charge,
the model that answered and how the response ended. An answer that the output limit cut says
whether the model started its answer. The page also shows the tokens, the sampling values
that the request sent and the size of each image in request order. A build request sends no
sampling values, so the page says "None sent: provider defaults".

Export is in Run actions and on a comparison. The export is a .tar file. By default it
calls each criterion "Criterion 1", "Criterion 2" and so on, and it has no criterion text,
judge reasons, scales or images. The checkbox "Include private criteria and judge reasons"
adds them.

Inside the console, a criterion reads as its authored statement, for example in the “Order
changes by criterion” table of a benchmark analysis. A criterion without a statement reads
as “Criterion n”, with n from the authored order that the server gives. If Basalt cannot
read the revision of a criterion, it has no authored number, so it reads as “Unnamed
criterion”. The console never invents a number. A criterion identity never shows.

Planned, in progress, produced and recorded are distinct states. If there are no criteria,
show that there are no criteria. Never show a green 0/0 completion. A saved build does not
count as a new build. Where a model name goes, a build without a model reads as Saved build or
Reference build, never as its stored kind.

Evidence starts with All results, Previous criterion and Next criterion, above the visible
Build and Success criterion pickers. Then come the mark and the statement of the selected
criterion, a full-width viewer, and the result explanation and relevant limitations in
disclosures. The default view is Images, Recorded behavior or Code, as the criterion
requires. A judge check of timing, motion or causality reads no images, so it opens on
Recorded behavior. Keep the dimensions, frame navigation, recorded intervals and phase context
in Recording details. State that sampled playback is not real-time video.

Under the statement, a line names the kind of check and the evidence class, for example
"Judge check · Timing. The judge reads recorded behavior, not images." Each criterion of
Results has the same line without the second sentence. Recording details also give the clock
alignment of the events and the images, with its uncertainty, and the frame budget: the most
images of the recording that one judge check gets.

A recorded sequence plays like a video, from one spruce bar fixed under the stage. The bar
has play, pause and replay, frame steps, elapsed and total time in mono, a square-thumb
scrubber and a speed choice. Frames advance at their recorded times, never under 0.1
seconds each. The player waits for the next frame and does not skip it. An unavailable
answer states the reason under its heading. Equal frame indexes never establish alignment.

Each test player records its own view, so playback follows one player at a time and never
alternates between two views. With more than one player, a “Test player” choice above the
viewer lists the actor names of the plan, and another player's view opens at the same moment
of play. All players share one clock. In Choose image, each player has its own “Gameplay
recording · p1” group. Recording details name the plan label of the scenario or phase, never
its id, and the player: “Gameplay recording · Full round · p1’s view.” They give local times
to the millisecond, such as “It was taken on Oct 4, 2026, between 9:25:08.514 AM and
9:25:09.413 AM.”, never raw timestamps.

Compare with build, beside the Build and Success criterion pickers, lists the other builds
of the same evaluation. It opens the selected criterion and observation of two builds side
by side. Each side has its own build choice, First build or Second build, its mark and
answer, and the reason for absent evidence. Swap sides exchanges the two builds. Back to
evidence returns to the criterion. On a phone the sides stack, with the first build on top.
Each comparison choice has its own label: Compare with build chooses a build, and
Observation to compare, under Compare another observation, chooses an observation.

The view shows every recorded frame, not only the frames that the judge saw, and says so above
the rows. A frame that the judge saw stays with the event that the judge saw it with. Its
caption says why the judge saw it, for example “The judge saw this frame: last frame before the
round-start event.” Any other frame goes with the nearest event and has no such line.

Rows pair images by test player, phase and time from the anchor of the phase, never by frame
number. A caption gives that time, for example “0.500 s before the round-start event”. The
event keeps its plan id, as in Jump to an event, because a transition has no plan label. A
moment with an image of only one build shows “No image at this moment” on the other side. A
side that a review holds back shows its reason and requests no image. A code check compares
the recorded values of the two builds, not images.

Previous and Next move through the criteria. Details keeps the provenance and the raw
observations. Between them, the pager shows the authored number of the criterion, for example
"Criterion 5 of 7", where 7 counts every criterion of the evaluation. Previous and Next step
only through the criteria of the run, so in a run that plans fewer criteria, the numbers can
skip.

The evidence view has keyboard shortcuts:

- ← and → go to the previous or the next criterion. The observation stays.
- Shift+← and Shift+→ go to the previous or the next build on the current results page. The
  criterion, the observation and the evidence view stay.
- Esc goes back to All results.

How it was built has the same Shift keys and Esc. It has no criteria, so ← and → do
nothing there. A row of `<kbd>` hints under the navigation bar shows only the keys that
work now. A device with touch as its main input does not show the hints.

These rules apply to each keyboard shortcut of a page:

- Do not take a key from a field, a select, an open dialog or an open disclosure.
- Do not take a key from a region with `data-own-keys`. The player, the zoom, the code, the
  measurement tables, the notifications and each scroll region or tab strip that overflows
  use their own keys.
- Do not take a key that an earlier handler used (`preventDefault`). An open menu that
  closes on Escape uses that Escape.
- Do not take a key with Alt, Control or Command. The browser and the system use them.
- Name the key in `aria-keyshortcuts` on the control that the key repeats.

Recorded behavior lists the errors for each channel: Errors in Output and
Script errors. It never adds the two channels together. Identical errors from one source
count as one row ("100×"), with the script path and its stack trace in a disclosure. If
the source is unknown, the row says so. If a channel is full, it says that Basalt did not
record later errors. A count describes the output of the build and never assigns fault.

Recorded behavior also lists each scenario step, also a step that recorded no fact. Times
are seconds after the scenario started, on the Studio clock. Each step shows one of three
outcomes, and none of them has the red mark of a failed check:

- Observed: the times when the step started to look, saw its start, acted and captured.
- Not seen in time: Studio did not see the start of the step inside its time window. This
  is not a failure. Only a time bound in the rubric makes it one, and a code check gives
  that answer.
- Couldn’t read: the step is incomplete.

If the rubric sets a time bound for a step, the step quotes it. The facts of a step and the
recorded facts under the steps show each label above its value, in a grid.

More actions has these items:

- Check the same build again
- Record extra observation
- Try a repair
- Assess saved evidence again
- Run a sensitivity test
- Save an example for future checks

Each item explains its new work. Each item asks for an explicit spending limit and names
its source run. In a sensitivity test, a person chooses the controls with
checkboxes. All checkboxes are on by default.

A reassessment page uses the same summary strip as the run page. The strip shows the
status, the charges against the limit with the total of the original run below, and the
answers decided. The page lists each criterion with one row for each observation. Each row
shows the observation, its status tag, the reason of the judge and an Evidence link. If an
observation has no answers, the page explains this one time above the list.

A sensitivity test uses the same strip, but it counts the answers recorded, not the
answers decided. The strip is under its run title, which ends with "· sensitivity test". A
sensitivity test never offers a review. Results start with what the controls change. Then
a table counts, for each control, the answers that stayed the same, changed, could not
decide or cannot be compared.

Then each criterion has a table, with one row for each observation and its Evidence link.
The table has one column for each condition, with As recorded first. Each control cell
holds the status tag of the answer, how it moved from the recorded answer and the reason
in a disclosure. Under a control, "Not enough evidence" is an answer. It is not an absent
result.

## Optional review

A review from Review a sample has 40 questions by default. A review session ends after 20 active minutes
or 40 answers. The next Start session button continues with the same questions. Ask for a remembered
profile only when a person reviews. Freeze the attribution of a review session. If a
person opens the work of another reviewer, require an explicit switch. When a person
examines a review, Basalt does not assign questions.

A neutral review page has these items:

- one assigned question
- the evidence
- answer buttons with complete statements, or authored numerical scales
- Cannot tell
- a Reason select with one sentence
- Save & next, Previous and End session.

A save acknowledges the evidence on the screen. Cannot tell records an abstention and also
needs a reason. Round 2 shows only the answer and the reason of the other reviewer. The
blind review page never identifies repeats. A reviewer applies a saved answer to other
observations only by an explicit action, and only to assigned questions with acknowledged
evidence.

Recover drafts. Show edits that conflict. Finish the session neutrally, without an
extension. Identity, the answers of the judge, treatments and operator navigation stay out
of blind payloads and the blind UI.

## Accessibility and verification

Use semantic forms and tables, associated labels and errors, visible focus, live statuses
and unobscured controls. Use native dialogs with containment and focus restoration. A
dialog gives focus back to its trigger one time for each close, so a later focus move stays.
During a disconnection, keep the last valid view. Reject stale responses. URLs keep the filters,
selected views, builds, criteria, observations and review questions.

Examine the console at 390/768/1024/1440px, with long content, with absent images and with
reduced motion. The browser test also examines actual 200% Chromium tab zoom, separately
from viewport emulation. Safari VoiceOver and human interaction still need manual
verification. A first-time participant must start a benchmark, explain the spending
limit, find evidence and finish a short review without help.

The contrast ratios are:

- Base: ink/cream 16.06:1, slate/cream 6.02:1, slate/white 6.44:1, slate/sage tint 5.81:1,
  slate on the lowest-contrast tile 5.50:1, white/spruce 13.07:1, bar label/spruce
  12.06:1, muted bar text/spruce 7.04:1, green/cream 5.96:1, green/wash 5.42:1,
  brick/cream 5.29:1, ochre/cream 4.97:1.
- Dark: ink/ground 15.07:1, slate/panel 6.95:1, slate on the lowest-contrast tile 6.24:1,
  sage/panel 9.63:1, brick/panel 7.23:1, ochre/panel 9.10:1, solid mark text 14.91:1, bar
  label/bar 12.02:1, control border/panel 3.76:1.

For each state in the browser test, the test first confirms that a dark host preference
does not change the page. Then it audits the state and makes a screenshot in the chosen
dark scheme. Human usability and live Studio acceptance need separate evidence.

## Benchmark home and notifications

Start with the saved benchmark and the Model comparison view for each tool set. Show the
actual tool set compactly. Offer a filter only when there are several tool sets. Use
readable 15px row content, mono figures and column heads, and 14px support text. The scope
shows as a strip of figure tiles beside the benchmark picker. Narrow screens use labeled
model cards with two columns. Checked counts every answer, also "Not enough evidence", and
names the "Not enough evidence" and unavailable answers below. A model with more than three
providers shows their count, with the names in a disclosure.

By evaluation has one table for each evaluation, under its public title. The table has one
column for each model and tool set, in the order of the run. The evaluation row shows the
result bar of each model. It opens to one row for each criterion, in authored order. A
criterion row has one numbered mark for each observation. A hairline and the build number
separate the marks of each build, and each mark links to its evidence.

By evidence class has one table for each evidence class of the judge criteria: Appearance,
Timing, Motion and Causality, in this order. "No evidence class" follows them, for judge
criteria whose author set no class. "Code checks" comes last, because a code check has no
evidence class, and no answer counts in two groups. A row shows the result bar and counts of
a model, the coverage, such as "12 of 18 answers", and the coverage of each evaluation. More
than three evaluations fold into a disclosure. A line under each table names how many
evaluations the group covers. The groups never add up to an overall score.

Cost and coverage has three aligned strips for each model and tool set: Criteria met,
Confirmed charge and Build time. Each strip has one axis for every model. One dot is one
build, and a quiet band shows the range of the builds of the model. A dashed ochre line from a
dot shows how far missing and split answers, or pending charges, can move that build. A build
without a figure has no dot, and the strip counts it. A note under each strip says what it
leaves out. Under Confirmed charge, the note says that shared preparation and charges that
match no build are only in the run total. Nothing joins the strips, sorts the models, marks a
best model or draws a frontier. "Figures for each build" lists each build with "4 of 6 met",
its charge and its time. On a phone each model is a card, and each strip and each note names
its strip.

Show selects Answers, Charge or Build time. Charge and Build time show a split bar for each
build. The known parts are in proportion. A part without a record is a fixed ochre hatch with
"Not recorded", and pending charges use the hatch of the ledger. The bar never shows a total,
because the parts can overlap. Build time prints only the measured build time. Its key has one
line for each part: Build, Observations and Judge.

The URL keeps the view, the Show choice and the open evaluations. On phones, the views wrap,
so every view and the selected view stay in sight. Each row is a card, and each cell keeps
its model name. The table does not sort by a mean, rank the
models or add their figures together. Original evidence, scale identities, role counters
and operational provenance belong in the drilldown. Absent case rules, absent telemetry and
incomplete answers stay explicit. They do not become zero measurements or review
assignments.

Keep the primary comparison space free of alert banners. A notification button at the top
right shows a count and opens a compact list of active issues. Each issue shows the time
of the last change of its run, so two runs of one evaluation are different. The list has
exact run and request destinations, keyboard focus on its heading, focus restoration on
Escape or close, and dismissal on an outside click. When a person opens the list, the
unresolved issues stay. The list shows explicit text when it is empty, when it loads and
when a refresh fails. Consent and immediate validation stay beside the action that
authorizes the cost.
