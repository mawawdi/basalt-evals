# Research and retained evidence

[Architecture](ARCHITECTURE.md) describes the current implementation.
[Evaluation policy](EVALS.md) defines the current claims. Each result below applies only
to its recorded implementation and population. A successful example does not show
general reliability or judge calibration.

## September 30 live acceptance

The local file `.basalt-evals/acceptance/live-two-builds.json` records two new
human-authored evaluations. The operator started them from the production console under
an approved total of $10 for all attempts. Both selected GPT-6 Luna with the production
tools, one independent build and three final observations. MiMo checked the supported
qualitative criteria. The original prompts and rubrics did not change. The record keeps
the interrupted attempts and their spending, and later repairs do not replace their
outcomes.

- Beacon `flow-e532b14a39895dec7b3f63ef87540e56` completed all three native final
  observations, and all three judge checks accepted its one authored criterion. Its 15
  model requests cost $0.01893978, with no pending charge. One readiness job, three
  public development jobs and three final acquisition jobs completed. When the run tab
  closed and opened again, Basalt did not duplicate the work. The time from the start to
  the results was 9m46s, with an early interruption by the implementation admission.
  This time did not meet the release target of five minutes.
- Moving platform `flow-7c52cca7ca2681669465b8ce416bda43` made 12 model requests and
  completed two public development jobs, but no final observations or judge checks.
  Edits to the documentation during the run activated the implementation guard before
  the next request. The builder sealed this local interruption incorrectly as a provider
  failure and counted a tenth builder call that did not occur. Its nine actual builder
  requests and three preparation requests cost $0.02424681, with no pending charge. This
  acceptance result stays incomplete.
- The retry `flow-8cd3dcb31895c20d6b0666bd5a4d0f09` used the saved definition. It
  skipped preparation and finished a source build in six model requests ($0.00648459).
  Duplicate cleanliness checks still blocked public development and final collection
  before dispatch. Those entry points now share one admission guard.
- The replay `run-39d589edee278a14508808b2de23b7eb` of the retained source collected all
  three final observations with no model calls. The assessment
  `run-edd51effd11b056d6ceaa20fbd637736` made three MiMo requests ($0.0493398584). Each
  observation failed travel, reported no mechanic errors and left smoothness incomplete.
  The builder guessed the endpoint names, because the runtime omitted the public seed
  scene. In a separate problem, the first image acquisition overlapped the rider
  placement, so no frame was provably before the action. These failures of functional
  input and capture do not show reliability under the repaired runtime.

Beacon used implementation `75efc10d6e103c58f8e8218236838c3f3505b4ea`. The replay used
implementation `13408eee9cf95804f4e69beb14ce6edc7d4bc27c`. Both used Studio
`0.741.19.7411056` and the connector artifact
`9450179051e2dbc141ee8a7a57a540d6cc53afb3cdd7a6a3b306bdb20101dc0b`.
An earlier readiness attempt with no cost kept two failures: a removed plugin directory
and a required Studio update. The operator restored the connector outside the disposable
trial directory. The official Studio update completed before the paid runs started.

Offline regression tests cover resumable admission before dispatch and inspection of the
immutable public scene. They also cover recorder readiness before scenario actions and
inspection of retained evidence with no request for judge checks. The three original
capture intervals overlap, and Basalt still assesses them as insufficient.

The attempt `flow-31b82d0133ad0708127cac38eac65c13` used the saved definition,
implementation `44174255ab1de4f68a4827a67036037b380e2ff5` and connector
`4451540157fbfaea5b6fcb0be20b86fb6c18652c15b39d3aafb9667ae417d1cb`.
It completed one new source build and three sufficient final recordings, each with 305
sequence frames. When the whole controlled browser closed and opened again, Basalt did
not duplicate the execution. Its eight builder requests and three judge requests cost
$0.09806351.

All three judge responses reached their output limit of 8,192 tokens, and all nine
checks stayed incomplete. The first response used 8,190 tokens for reasoning. Complete
recordings did not give complete evaluation results.

This attempt also showed a defect in the public development feedback. A summary of 9,065
bytes grew to 12,992 bytes when Basalt added frame references, which was more than the
tool limit of 12,000 bytes. Thus Basalt did not show the completed recording of 365
frames to the builder. Commit `373c2da1` added a limit to the complete summary that the
builder receives. It also permitted read-only inspection of the original signed recording
with no change to that recording. The retained builder did not receive this repaired
feedback.

Commit `5f79dcc8` bound one judge configuration for output and reasoning through the
preview, the execution and the treatment identity. Reasoning models received up to 32,768
total output tokens. Basalt sent a separate reasoning limit only when the provider
metadata supported it. This was an output allowance, not a guarantee of a complete
answer.

The reassessment `run-4a390501a6ee7f38d34c3d26ced1ab55` used this configuration with the
same MiMo model and three retained sequences. It made no new builds and did no Studio
work. Two requests returned all six answers with 11,353 and 22,077 output tokens, and
they cost $0.06580854. The third request returned HTTP 429 without a price. Three answers
stayed unavailable, and $0.05744396 stayed as a pending charge. Basalt did not send that
request again.

For both completed observations, the judge accepted route travel and the absence of
errors. But the judge checks of motion quality did not agree, although each check noted
that the rider detached near an endpoint. This does not show that the judge is
calibrated.

The next new run `flow-ed35a987b155d47cb4512d18e43b7b6d` tested the combined fixes
through the normal launch path. It had a spending limit of $1 inside the same approved
total of $10. It used the original prepared definition again, evaluated GPT-6 Luna one
time and completed the three requested observations. The builder received and inspected
its public development recording successfully.

The three automated checks of the first final observation accepted travel, usable motion
and the absence of errors. Its recorded displacement between the rider and the platform
stayed below 0.46 studs over the long motion window. The other two judge requests
returned HTTP 429 without a price. Six of nine answers stayed unavailable, and
$0.11483668 stayed as pending charges. The eleven requests cost $0.04349652. Basalt did
not send a failed request again, and this evaluation result is still incomplete.

The time from the start to the retained results was 17m29s. The project defers latency
work.

The follow-up assessment `run-5f34d8f1674fa1af70d9082d0873c0e5` kept the same
MiMo/DeepInfra configuration and all three recordings. All three requests returned HTTP
429 without a price. They gave no answers, and another $0.17227882 stayed as pending
charges. Basalt did not write the pending requests or the original results again.

The assessment `run-7bce39769cf9bb3bd1d0c89f0c6d4564` explicitly selected the
`novita/fp8` endpoint for the same MiMo revision. It froze this endpoint as a separate
treatment. The source, rubric, evidence, sequence presentation, seed and output allowance
did not change. Its three requests returned all nine answers. For each of the three
observations, the judge accepted travel and return, usable motion and the absence of
recorded mechanic errors. The charges were $0.08713390 in total, with no pending charge
in this assessment.

This assessment made no new builds or Studio attempts. The production console showed
nine available answers and zero incomplete answers. This run completed the automated
assessment of the retained platform build. It does not change the unavailable answers of
the original run, and it does not show judge calibration. This follow-up used
implementation `b2512cb6fe744a7fa736e7fcabf3b574c411462d`.

In all of these attempts and repairs, 67 model requests cost $0.3935135084. Six terminal
requests without a price held $0.34455946 as pending charges. The combined liability was
$0.7380729684, inside the approved total of $10. Five independent build attempts produced
four completed source builds.

Twenty-six native jobs completed: five readiness checks, nine public development
recordings and twelve final observations. Two earlier readiness jobs failed. The local
acceptance artifact contains the exact identities of the requests, processes, evidence
and implementations. These functional repairs do not show general reliability, human
usability or judge calibration.

The attempts with rate limits showed a loss of diagnostic data. The transport errors
discarded the typed provider causes and the retry-delay headers. The repaired transport
keeps only known cause codes and a bounded, normalized delay, and no raw provider content.
If a criterion result is not available, Basalt now shows its own recorded check failure.
Offline regression tests make sure that unpaid pending charges stay and that no automatic
replay occurs. They cannot recover the details that Basalt already discarded from these
three live errors.

## Evaluation architecture rationale

The external file `acceptance/showcase-live.json` is evidence about the retired approval
chain. It records ten paid requests, no evaluated builds or final captures, and
$0.022804785 in charges with no pending charge. Beacon
`flow-9ea3dbcae2b4782d660a53de43aab853` stopped for a Studio update. Moving platform
`flow-85d831c30fed082ee0d17f33723e501b` reached the limit of its audit output. Four
preparation audits took 41 minutes 46 seconds. The file does not validate the replacement
architecture.

The replacement keeps executable compilation separate from optional reference tests and
human calibration. It uses code for measurable facts and a frozen model judge for
qualitative evidence. See [Anthropic's evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
[AI SDK execution settings](https://ai-sdk.dev/docs/ai-sdk-core/settings) and
[OpenRouter provider selection](https://openrouter.ai/docs/guides/routing/provider-selection).
These sources give reasons for design choices. Only retained Basalt execution can show
the latency of Basalt, its Studio acceptance or the validity of its scores.

The moving-platform run `flow-8fa206b38bbd9e92bba40cb8f9b6ecf5` failed preparation after
four charged requests ($0.02259323), before any evaluated build. The private correction
added the required presentation phase, and then a later validator read the labels of
capture anchors incorrectly as references to scenario steps. The file
`test/fixtures/preparation/moving-platform.json` keeps the exact authored input and the
four structured responses as an offline regression test. It tests compilation and
reference validation, not live execution or the quality of judge checks. The original
receipts and spending stay immutable.

Later, the run `flow-20d1aa67cc5f15633857b094bc84ba82` completed preparation and its
first evaluated build. Its frozen scenario requested 590 seconds of Play for each
observation. The first recorder returned 299 frames, and then a Studio MCP request timed
out. Play continued until its scheduled end, although the sequence acquisition was
incomplete. Then the result check received a terminal HTTP 429 without a price, and
Basalt showed it incorrectly as absent criteria. The operator stopped the next capture.

The retained charges were $0.02372291, with $0.029858171 as pending charges. The run gave
no valid result for a model comparison. Offline regression tests cover the propagation
of acquisition failures, retained frames, the report of provider errors and the progress
timing of each evaluation. They do not show that the live Studio capture connection is
reliable.

A later offline inspection reproduced these additional boundary failures:

- image buffers for a whole recording and a limit of 512 frames;
- a recorder for four clients against plans for eight clients;
- the transfer overhead for each file;
- smaller read limits of the judge for images and receipts;
- the recovery of cancelled receipts;
- stale ownership of a native lane after the publication of a receipt.

Regression fixtures cover long frame series, large original images, cancellation and
terminal capture failures. They do not call models or Studio.
[Architecture](ARCHITECTURE.md) specifies the current behavior. These checks do not close
live acceptance.

The external folder `acceptance/release-packet` contains the later previews with no cost
and the exact byte inventory of the compiler requests. It also contains the provider
metadata of that time, the comparison of the installed connector and the archive
verification. This inspection showed a bug in native identity: a tree reader that
accepted only Luau files rejected the compiled runner artifacts. The release fix bound
the compiled files and native helpers with a separate bounded inventory.

A later change replaced the policy of that fix for model time limits. Now the elapsed
time informs operators and does not stop preparation, builds or judge checks. The
verification manifest of the packet records the exact release and test results. These
checks do not show native startup or the live latency targets.

## October 2 research review: judges and capture

Two research reviews examined how Basalt judges rendered evidence and how Studio
captures it. Research agents checked 446 citations again: 391 supported the claim, the
reviews removed the 10 that contradicted it, and no citation was an invention. Many
sources are 2026 preprints. No source measures judges on rendered Roblox evidence, so
each transfer to Basalt is a hypothesis that Basalt must test. [Roadmap](ROADMAP.md)
lists the tests.

- **Timing goes to code.** Executable checks reached about 93% balanced accuracy
  against about 78% for a video judge on game assertions
  ([SWE-Game](https://arxiv.org/abs/2609.33678)). Models scored 49–54% on timing
  glitches at 1 fps, 5 fps or native video
  ([TempGlitch](https://arxiv.org/html/2605.21443)). The best model scored 37.9%
  against 95.2% for people on order questions
  ([TOMATO](https://arxiv.org/html/2410.23266)). This is the reason for evidence
  classes and the request with no images.
- **Steps wait for facts.** Async waits caused about 45% of flaky tests in open source
  ([Luo et al.](https://mir.cs.illinois.edu/lamyaa/publications/fse14.pdf)) and 78% of
  fixed flaky tests at Microsoft, where longer delays had no effect
  ([Lam et al.](https://mir.cs.illinois.edu/winglam/publications/2020/LamETAL20FaTB.pdf)).
  This is the reason for anchored scenario steps.
- **Controls must show content use.** Judge accuracy depends on the image for under
  3–5% of items on standard benchmarks ([ACL 2026](https://arxiv.org/html/2604.17768)).
  The presence of an image moves labels more than its content
  ([MIST](https://arxiv.org/html/2609.37863)). This is the reason for the sham region,
  the pixel fill, the donor swap and the order controls.
- **Selective acceptance needs exact bounds.** Agreement-based escalation with a
  statistical guarantee ([Trust or Escalate](https://arxiv.org/abs/2407.18370))
  replaces stated confidence. No miss among 29 builds that fail bounds the miss rate at
  10%, and 59 bound it at 5%. A study of 12–24 builds cannot certify a low rate.
- **People label first.** Wrong AI verdicts cut expert accuracy from about 80% to
  20–46% ([Dratsch et al.](https://doi.org/10.1148/radiol.222176)), and expert
  agreement on 3D quality was only about κ 0.53
  ([GPTEval3D](https://arxiv.org/html/2401.04092)). This is the reason for blind
  reviewers and a gate relative to their agreement.
- **Comparison has a cost.** Pairwise judges were more accurate than scores
  ([MLLM-as-a-Judge](https://arxiv.org/html/2402.04788v3)), but distractors changed
  35% of pairwise verdicts against 9% of absolute verdicts
  ([COLM 2025](https://arxiv.org/html/2504.14716v1)). The comparison stream stays a
  separate stream until a pilot measures this.
- **Related judges and builders.** Related models prefer each other's output
  ([preference leakage](https://arxiv.org/abs/2502.01534)), and a null model won 86.5%
  on one automatic benchmark ([2410.07137](https://arxiv.org/abs/2410.07137)). This is
  the reason for the holdout record and the scene-text route. On 2026-10-03 a person
  allowed a judge from the family of a builder, so a claim about that pair carries this risk.

## October 4 live check: client start and viewport

A Studio-only replay of one saved arena build compared two ways to start the clients of a
scenario step. Each replay had one observation and no model calls.

- **The clients start one after another.** A parallel start saved 7–9 s for each step
  that worked. In 1 of 3 steps, the second client did not join within 60 s, and the
  recording showed one player only. A retry costs about 77 s, so the parallel start was
  reverted.
- **Each Play client now sets the declared viewport.** The connector set the Device
  Simulator only in Edit. Each Play client is a separate Studio session, so it kept
  "Current device" and reported a 1081×642 game view, and every sequence was
  insufficient. Now each client sets the view before it reports ready. In a second replay
  both clients traced 1280×720 in every scenario, the sequence was sufficient, and the
  step times did not change.
- **A third-party plugin covered the Edit window.** The first recording showed a dialog
  of a third-party plugin in the Edit window. A person removed the plugin from the account
  of the worker, and the next recording showed no dialog.

## October 4 live check: test reuse and recheck

A fresh arena benchmark used the current arena version: 2 models, 2 builds each and 3 judge
samples. It cost $0.224. One build failed with a tool-use failure. The other 3 builds gave
126 answers, and no answer lacked evidence. The Orb-visibility criterion got 6 met and 3
not met samples, after "not enough evidence" for every sample before the viewport fix.

A person changed the wording of one criterion. The preparation kept the public part, the
Studio plan and 13 criteria of the earlier version, and prepared 1 criterion with 2
requests for $0.071. The full preparation of the same evaluation cost $0.246. A recheck of
the 3 builds needed no build and no observation. It judged the edited criterion and the
12 criteria of its shared request again, and reused the separate Orb answers, for $0.014.
Of the 36 answers judged again, 31 matched the majority of the earlier samples. The 5
others were criteria whose earlier samples did not agree.

## October 4 live check: two Studio lanes

A Studio-only proof tested two lanes in the one worker account. Each run replayed one saved
arena build one time, with no model calls and a spending limit of $0.

- **One lane gave the baseline.** Two replays ran one after the other on lane 0. Both were
  complete and verified, in 331 s and 353 s. Each job used at most 5.1 GiB of resident
  memory and a mean of 2.06 cores in one step.
- **The CPU rule of the admission was wrong.** It compared the load average of one minute
  with the CPU count. macOS reported a load average of 36 on 8 cores while 63 % of the CPU
  was idle, so the second lane could never start. The rule now samples the idle CPU.
- **Two lanes failed.** Lanes 0 and 1 started 2 s apart. Both jobs failed about 10 s into
  the first scenario. One Studio MCP client closed, and the other timed out after 15 s.
- **The cause is the shared Studio MCP.** StudioMCP is a relay on a local port that all
  accounts share. Each lane saw the Studios of the other lane and of the person. Each
  lane probed the Play clients of the other lane. A probe that got no answer closed the
  whole client. Each capture also starts and stops its own StudioMCP, so the end of one
  capture can break a relay of the other lane. No call reached a Studio of the person.

The search for the Play clients now survives a slow probe, and each worker account holds
one Studio MCP anchor. A second lane also needs no Studio MCP in the account of the person.
The live proof of these changes is open in [Roadmap](ROADMAP.md).

## October 5 demo baseline

Three new evaluations ran with three builders: timed shutter, XP progress and impact effect.
Each builder made 2 builds of each evaluation, and Studio observed each build one time. Claude
wrote the builder prompts and the rubrics on the behalf of the person. No human expert wrote or
reviewed them, so these results make no expert claim.

- **The first run found a contract defect.** With Gemini 3.8 Flash as the judge, 57 of 126
  answers had not enough evidence. A public role had an id and a separate tag, and most
  builders tagged their objects with the id. A role now has one name. The judge also wrote 3
  answers as text, and one request timed out after about 210 s for all three samples. The
  run cost $2.44, and a person stopped it.
- **The rerun gave usable results.** With MiMo-V2.6-Flash as the judge, 105 of 126 answers
  were met, 2 were not met, 16 had not enough evidence and 3 were not available. It cost
  $0.53, and it took about 80 minutes on one lane, with one resume.
- **The models differ.** DeepSeek V4.1 Flash met all 42 of its answers. GLM 5.3 Flash met 32,
  and its two shutter builds never opened the shutter. GPT-6 Luna met 31: one shutter build
  did not tag the lever, and one impact effect was not visible.

## Spending and interaction redesign

Basalt withdrew the context-maximum recommendation from launch. A bounded liability for
each request protects the authorization. A cost forecast that multiplies the maximum
turns is not empirical. The replacement uses admission for each request, protected funds
for checks and independent allowances for builds. Measurements of comparable runs need
actual completed observations, and they report their sample count.

The current design and architecture guides specify the visual system and the current
mechanics. This redesign does not imply live execution or genuine human acceptance.

## Rationale

The local folder `.basalt-evals/acceptance` keeps the current synthetic acceptance
artifacts for the architecture. The local folder `.basalt-evals/console-check` keeps the
screenshots of responsive interaction and their manifest. Fixtures for mixed draft and
ready execution, admission by allocation, reassessment, comparison, saved examples and
label reuse test the application behavior. Their generated adapter responses and
scripted labels are not evidence from live Studio or from human research.

- [Finite-population confidence bounds](https://arxiv.org/abs/2405.06722):
  sample without replacement from a frozen population. Keep unresolved sampled labels in
  conservative bounds. A question allowance is not a promise of accuracy.
- [EvalGen](https://arxiv.org/abs/2404.12272): keep human-authored criteria and
  evaluator validation separate from automated judge checks.
- [EvalPlus](https://arxiv.org/abs/2305.01210): targeted negatives and valid
  alternatives probe weaknesses that thin tests miss.
- [SCAM](https://arxiv.org/html/2504.04893v7),
  [MMStar](https://arxiv.org/html/2403.20330v2) and
  [TVBench](https://daniel-cores.github.io/tvbench/): investigate image dependence,
  text shortcuts and temporal limitations. These papers do not measure Basalt.
- [WCAG 2.2](https://www.w3.org/WAI/WCAG22/quickref/) and the
  [dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/):
  give information for accessibility checks. Automated tests do not show full
  conformance.

Frozen study inputs stay under [studies](../studies). These are research data, not
additional manuals for the product.

The project defers the
[detector-calibration population](../studies/detector-calibration/population.md). Keep
its original resource policy without change. If the bounds change, they need a
separately approved protocol, and they cannot show acceptance of the original treatment.
Its large workload is outside the initial native pilot with two mechanics.

## Historical result index

This index keeps the summaries of earlier results. The detailed records are not in this
repository. Each summary gives the run IDs, the charges and the limits of its result. The
commands of those earlier versions are retired. Use [Development](DEVELOPMENT.md) for the
supported commands.

The approved reset on September 30 removed all user evaluations, runs, reviews,
captures, diagnostics and archive entries from the live workspace. An external recovery
snapshot with verified hashes keeps their exact files, spending liabilities and ownership
records. The new live workspace kept only the execution setup. The app does not import or
show that snapshot. This index keeps historical readouts and identities, but not each raw
image or receipt, and it cannot give new verification. Basalt binds no
historical label to current evidence.

### Visual judgment

| Record                                      | Retained result and limit                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Impact study                                | `judge-85dd28a0b3dd32b4c63a` showed evidence-sufficiency and contradictory-decision failures. `judge-53774f73d69a87003fd7` kept an invalid/output-limit response. Later repeats showed unstable answers on clean images. The study did not show a calibrated judge or a general overlay effect.                 |
| Breadth evidence and frozen protocol        | XP UI and checkpoint feedback, human-authored rubrics, signed captures and expert interpretation. Ordered still images could not show activation timing.                                                                                                                                                        |
| Eight-case development result               | 32 DeepSeek calls with charges of $0.0072631104. 6 accepts and 2 rejects agreed with one expert, and 16/16 blanks abstained. The judge over-scored XP c02. Pass/fail agreement did not show ordinal accuracy or production risk.                                                                                |
| Three-grader comparison                     | `experiment-46d4981f0870492bc0cf`: DeepSeek, Gemini and Qwen on the same eight builds. Gemini scored one blank, and all three over-scored XP c02. The reused baseline and serial execution do not show a randomized rank order of speed.                                                                        |
| Reserved-layout protocol and holdout result | Eight new layouts of familiar mechanics, 32 calls and charges of $0.0072271472. 7/8 decisions routed automatically, with pass/fail agreement from one expert. One disagreement between repeats escalated, and 16/16 blanks abstained. Ordinal scores that were too high and unsupported timing language stayed. |

The development result has one judge identity for each case. In the order XP c01–c04
and then checkpoint c01–c04, they are `judge-e5a3e2f35a7243fc29e2`,
`judge-3aa8ba7c8b54eaef9f74`, `judge-c80a077a5cdb43e0e1e7`,
`judge-8c01a7345a48b3f0fc90`, `judge-d2947329d524de2f9192`,
`judge-b80780e9a28e95e5a094`, `judge-ae22c925a4370c3523fb`
and `judge-bc958e7307d73624fd87`. Repeated calls are not independent builds.

### Builders and native evidence

| Record                          | Retained result and limit                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bomb-passing builders           | Study `9cbe140`: one Luna build verified 16/16 required criteria. Other attempts kept interruptions from an absent submission or from a Play client that opened as Edit. Earlier studies kept actual failures of authority, forgery, damage and cleanup. An invented avatar icon stayed a failure in the judge reason. |
| Initial builder breadth         | Study `938b057`: eight solo builds reached verified Studio outcomes. Gate attempts stopped on builder or tool failures or on native startup of the Play roles. The study did not rank the models by quality on the gate.                                                                                               |
| Builder transfer                | Study `c488189`: Studio verified 10/12 treatments. The other gate attempts kept invalid-tool or local-parse failures. These earlier checks did not prove physical passage yet.                                                                                                                                         |
| Gate physics follow-up          | Saved `tr-58dedde14707bf66b369` and `tr-033f4b51fa1c24688243` each passed 23/23 with new signed physical probes. Controls that work and negative controls discriminated passage. There were no builder or judge calls, and Basalt did not write the original trials again.                                             |
| Shutter evaluator transfer      | This work corrected a readiness requirement for an exact status string that no person authored. Controls that work passed 18/18. State-only and passable-closed controls failed the intended physical checks. A trajectory gap stayed incomplete and was not a rejection of the build.                                 |
| Shutter builders and replay     | Study `0a50cc3`: DeepSeek ended on an invalid tool call, and the original presentation of Luna was incomplete. A replay of the retained Luna source with the corrected evaluator rejected physical passage while open. There is no claim about visual quality.                                                         |
| Reliability protocol and result | Study `1604233df03296b395160dd040a2026bbe2b1990`, report `report-6704b81c6286815f718c`: Studio verified 10/12 builds. One HTTP 429 and one invalid tool call never reached Studio. The known builder charges were $0.0702957416. The liability without a price stayed separate.                                        |
| Native worker diagnostics       | Exact startup attempts, process ownership, receipts and records of isolation. At `af967bf0f82bf294b3df565186812b56992d9af6`, three isolated jobs completed, and a monitor on the operator side saw zero Studio activations. This was not a general estimate of startup reliability.                                    |
| Worker control validation       | Study `88130db27465406588447d30acbdafa8743ff1a4`: four new controls with 48 signed artifacts each and the expected outcomes 18/18, 17/18, 16/18 and 18/18. Focus theft in the shared login stayed despite restoration. The evidence from the isolated login is separate.                                               |
| Public development capture      | `studio-4cfe480244c9e4682746`, `development-3f9132614040e7ca7368`: 46 signed artifacts, 21 original frames, zero model calls and $0. An authored integration control, not a measured builder improvement.                                                                                                              |
| Feedback protocol               | Keeps the original separation between physical success and visible player feedback, the experimental partitions and the research gates. Basalt retired its old executors and manual cell commands.                                                                                                                     |

### Preparation, recovery, and consolidation

Pipeline diagnostics recorded charged preparation attempts, compiler or
acquisition failures, native attempts and references to recovery evidence. Examples:

- The batch of five inputs at `44ce3025538d612f440d192ca7fe3b6ac6f3d5ab` prepared one
  checkpoint and left four diagnostic drafts. It ran no controls and no Studio.
  “Prepared” did not mean that controls checked the input.
- The operations `prepare-0b7f13f1-6df1-4860-8d7e-33298d46f26a` and
  `prepare-276f122d-050b-4f9b-ba46-fb65c8bcd4c3` keep the moving-platform and XP
  preparation failures separate from build behavior.
- Later Beacon and checkpoint diagnostics kept failures of schema, causal evidence,
  criterion selection, trace provenance, charges and controls. The full chronological
  record stays as it was. Basalt does not interpret it again as current release
  acceptance.

The predecessor notes kept the earlier consolidation history and unique evidence. This
evidence included `run-beacon-categorical-production`,
`run-a2a143ed4b764d529694b4086b885c02`, checkpoint preparation attempts, the liability of
terminal 429 responses without a price and historical engineering measurements. The
second run stopped after seven builder calls with unknown charges and no Studio or visual
judge checks. It showed that Basalt kept the launch and the failure, but it did not show
completion.

The project removed the separate result, protocol and manual files, so that the guidance
does not conflict. [Roadmap](ROADMAP.md) is the only current backlog.
