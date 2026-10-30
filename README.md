# Basalt Evals

Basalt is a local workbench for the evaluation of agents that write Roblox code. A person
supplies a prompt for the builder and a private rubric. The person approves one spending
limit. Then the person gets automatic results with evidence that they can examine.
Ordinary runs do not need a person to grade the results. Reviews by a person are optional
and limited.

**Choose evaluations → select models → set a spending limit → start → compare results → inspect evidence → export**

## Use the workbench

1. Open **Models**. Search the OpenRouter catalog, and add each model that you want to
   test or use as the judge. Basalt adds only models that accept tool calls. OpenRouter
   picks the endpoint of each request. Select the default builders, the default judge, the
   preparation model and the coverage model. Then select **Save defaults**.
2. Open **Benchmarks**. Then select **Run a benchmark**. Choose one or more saved
   evaluations or drafts, and then choose the models to test. On the same setup page, a
   suite selects its saved evaluations.
3. Enter your **spending limit**. The preview is free, and it does not start models or
   Studio. It does not suggest an expected cost that Basalt did not measure. If comparable
   completed runs exist, the preview shows their measured costs and the sample count.
4. Start the run one time. Basalt checks Studio and prepares each definition that it does
   not have yet. Then it makes a build with each selected model, collects the evidence and
   checks the results. Basalt uses prepared definitions again. The run needs no automatic
   reference builds and no grades from a person. If you close the page, the run does not
   stop, and **Benchmarks** shows it under **Running now**.
5. Examine **Results**, **Models**, **Progress** or **Details**. Each build is independent,
   and its observations are repeated measurements. **Models** compares each criterion between
   the models of the run: **Meets more often**, **Meets less often** or **Not enough builds
   to tell**. Basalt keeps behavior, quality, unavailable answers, cost and time separate. To
   examine the evidence of a success criterion, open that criterion. To see how a build was
   built, select **How it was built** on its row or in its evidence. Each turn shows the tool
   calls, the Luau errors and each change of the code.
6. To share a finished run, open **Run actions** and select **Export**. A comparison has the
   same **Export** action. The export is a `.tar` file with a report that opens in a
   browser, the results as JSON, an ATIF trajectory of each build and a manifest with the
   SHA-256 of each file. By default the export calls the criteria "Criterion 1",
   "Criterion 2" and so on. Select **Include private criteria and judge reasons** only for
   people who may read them. For post-training work, the CLI command `export dataset` writes
   one JSONL line for each build of a run, with its code and its answers.
7. If you want a review, choose **Review a sample**. The default size is 40 questions. A
   review session ends after 20 active minutes or 40 answers. Then you continue in a new
   review session. You need a reviewer profile only for a review.

   Each answer needs a reason. This includes the answer “Cannot tell”. If you stop,
   Basalt never creates replacement assignments. A second reviewer and round 2 measure
   the agreement of two experts.

Create evaluations in the **Evaluations** library or directly from run setup. The editor
has a title, a prompt and private success criteria. Basalt saves working copies to the
server automatically, with revision checks and local recovery. **Save evaluation** and
**Save changes** are free. An edit changes the same library entry. **Duplicate** makes an
intentional copy.

An evaluation can have up to six stages. Select **Add stage** to give the model a new prompt
that continues its own build. Each stage has its own private success criteria, and you can
move or remove a stage. A **gate** on a stage is optional. Check the required criteria that
the build must pass before the next stage starts. Each gate criterion needs a code check,
and preparation stops if a criterion needs a judge. Use a change or an action result for a
gate, for example "the score increases by 1 when a player touches an orb". A starting value,
for example "the score starts at 0", has no valid code check, and preparation stops.

In a run, the model builds stage 1. Then it continues from its own sealed build with the
prompt of stage 2 in a new conversation, and so on. Basalt prepares, observes and checks
each stage separately, and the preview quotes every stage within one spending limit. The
results show each stage as its own evaluation, for example "Shop · Stage 2 of 3". If a build
fails, or a gate is not met, the later stages of that build show **Not reached**. Not
reached is not a failure, and it counts separately.

Runs and suites keep the exact authored inputs that they selected. **Archive evaluation**
removes an entry from ordinary selection. You can undo this through the Archived filter.
**Delete evaluation** removes an entry from the library if no run, suite, saved example or
anchor build choice uses it. Preparation never changes the authored meaning. The tested
model gets the prompt but cannot see the private criteria.

On a finished, stopped or interrupted run, **Run actions** has **Archive run** and
**Delete run**. Archive removes the run from Benchmarks, Records, notifications and
comparison choices. The run keeps its results, evidence and charges. In **Records**, the
**Archived** filter has **Restore**.

**Delete run** permanently removes the records and the files of the run. Basalt does not
delete a run with a request that has no confirmed charge, or a run that other saved work
uses. The error names that work. Basalt keeps the title and the charges of each deleted
run, so that spending totals stay correct.

The primary navigation is **Benchmarks, Evaluations, Models**.
**Optional reviews, Records, Research, Archives, Settings** are secondary. Without the
live prerequisites, saved results and reviews are still available. Registered research
keeps its own explicit human workload and its own release gates.

The run continues after you close the browser. Each paid request reserves only its own
maximum cost from the limit that remains. Thus, no run has to fund its theoretical worst
case. The builds, observations and checks of a run can run at the same time. Studio does
one observation or one public test at a time. Basalt starts the checks of an observation
when Studio saves it. If the next request of a work item does not fit, that work item
pauses at its checkpoint. If you increase the limit, the work item resumes, and Basalt
keeps the charges and pending charges.

**More actions** on a build can collect evidence again (**Check the same build again**),
record development evidence (**Record extra observation**) or try a repair. It can also
start a reassessment of the saved evidence or a sensitivity test, or save an example for
future checks. A sensitivity test finds whether the answers depend on the evidence. Each
paid action uses an explicit spending limit and names its source run. A comparison of
two to six runs identifies the actual differences in the test conditions of each pair of
runs and shows their answers in one grid. Basalt does not infer an overall score, a winner
badge or a calibration claim.

A new run starts with the defaults of the Models page, the default tool set, one build for
each model and three observations. A tool set is a saved file in `studies/harnesses/`: the
prompt, the tools, the Studio development runs and the limits of a build. The run setup
shows the settings of each tool set, and you cannot change them there. The preparation model
prepares new inputs in separate requests: one public part, then a plan and criteria for each
stage. Then Basalt plays the empty build, the seed with no
changes, with the private checks. A required code check that passes there is a plan warning.
The coverage model writes coverage notes about each criterion and each private check. The
evaluation page shows the plan warnings and the notes. After benchmarks, a check that every
build fails or every build meets is a plan warning too. **Explain failures** asks a model four
authored questions about each flagged criterion, and the evaluation page shows its
hypotheses. They never change an answer.

After an edit, **Check saved builds again** on the evaluation page shows which saved answers
stay and which need a code check, a judge check, a new observation or a new build. Only the
judge checks and the new observations cost money. You can mark a saved build as a known good
build or a known bad build for named criteria. If a later version answers against it, that
version cannot start a new benchmark until a person fixes the version or retires the mark.
If you change only the success criteria, the new preparation keeps the tests of the earlier
version where they still fit. A recheck then checks the changed criteria again. It also judges
again the other criteria that shared a judge request with a changed criterion. The judge
answers as many times as it did in the run.

Code checks evaluate the assertions that they explicitly
support. Judge checks interpret the authored criteria with their selected evidence. The
details show the exact identities of the parts that support each result.

On the Models page, **Requests at once** sets the most requests that one run sends to each
model at the same time. New builds start in turn across the models, so one model does not
take all the build slots. A run keeps the values that it started with.

Basalt remembers preferences and explicit spending limits. Run setup identifies the
remembered defaults and has **Reset setup**. These defaults stay after workspace changes,
and earlier runs stay in **Records**. Each editor session has its own draft recovery. If
durable storage fails, Basalt identifies the unsaved text.

Run setup keeps the selected evaluations visible, and you can edit or remove them
directly. If you clear the filters, the selected work stays. A planned build is not a
completed build. The results show source creation, evidence collection and available
answers separately.

Suites contain prepared evaluations. You can create and edit suites, and Basalt keeps
their historical snapshots. The operator command assigns baselines. A saved example is a
reference for future checks, and it holds the planned observations of the build. It is
free to save an example. A future check needs a separate approval.

## Run locally

To install and start Basalt, follow the [development guide](docs/DEVELOPMENT.md#local-setup).
It also gives the procedures for local configuration and recovery. A live run needs Roblox
Studio, an isolated macOS login, a signing identity, provider credentials and an installed
connector that matches the built connector. Without these items, you can still examine saved
evidence. The CLI uses the same services: `node bin/basalt-evals.js --help`.

## Status and documentation

Synthetic integration tests cover the journey with one start, the limited review, the
protocol gates and the browser interactions. These tests do not prove live acceptance in
Studio, the calibration of the judge or usability without help. The
[roadmap](docs/ROADMAP.md) records the known gaps in the implementation and the acceptance
work that remains.

| Read                                 | Purpose                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| [Development](docs/DEVELOPMENT.md)   | Setup, commands, verification, and operational recovery   |
| [Architecture](docs/ARCHITECTURE.md) | Service boundaries, contracts, persistence, and execution |
| [Evaluation policy](docs/EVALS.md)   | Human authority, evidence, review, and claim semantics    |
| [Research](docs/RESEARCH.md)         | Rationale and a summary of historical results             |
| [Roadmap](docs/ROADMAP.md)           | Unfinished work and acceptance criteria                   |

The [design system](design-system/basalt/MASTER.md) is the visual specification. Research
keeps the summaries of historical results. Their commands are retired, and they are not
current interfaces.

The **Benchmarks** page compares frozen generation matrices in each harness. It shows the
original criterion answers and the answer coverage of the full plan. It also shows the
charges of the builder and the judge, and the median time of the build stage. The page
shows the native token counters and their coverage too.

If no aggregation rule was saved, Basalt does not infer a success rate for each case. A
counter that is absent stays unknown. Basalt does not add the reasoning and cache counters
to the input and output counters. The page counts shared preparation one time. Finished or
insufficient results need no routine review by a person.

Notifications at the top right count active interruptions and unresolved request payments.
Each notification opens its original run or its exact request. When you read the
notifications, Basalt never sends the work again.
