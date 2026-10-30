import type { ComparisonExportReport, ExportAnswer, RunExportReport } from "./export.js";

/** Escape text for HTML content and attribute values. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
const e = escapeHtml;

const answers: Record<ExportAnswer, string> = {
  met: "Met",
  not_met: "Not met",
  split: "Split",
  scored: "Scored",
  not_enough_evidence: "Not enough evidence",
  missing: "Unavailable",
};
/** The answer as the console writes it, with the judge samples: "Split: 2 of 3 met". */
function answerText(item: { answer: ExportAnswer; samples?: { met: number; of: number } }) {
  const samples = item.samples;
  if (!samples) return answers[item.answer];
  if (item.answer === "split") return `Split: ${samples.met} of ${samples.of} met`;
  if (item.answer === "met") return `Met ${samples.met} of ${samples.of}`;
  if (item.answer === "not_met") return `Not met ${samples.of - samples.met} of ${samples.of}`;
  if (item.answer === "not_enough_evidence")
    return `Not enough evidence: ${samples.met} of ${samples.of} met`;
  return answers[item.answer];
}
const money = (value: number | null) =>
  value === null
    ? "Not recorded"
    : `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
const duration = (value: number | null) =>
  value === null
    ? "Not recorded"
    : value < 60_000
      ? `${(value / 1000).toFixed(1)} s`
      : `${(value / 60_000).toFixed(1)} min`;

// One static style sheet: the page works from a file with no script and no network.
const style = `
:root{color-scheme:light;--ink:#191C1A;--slate:#5A605C;--rule:#DCDDD5;--paper:#fff;--cream:#FAF7F0;--spruce:#20352C;--brick:#B0433A;--ochre:#8A6514}
*{box-sizing:border-box}
body{margin:0;background:var(--cream);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:32px 16px 64px}
h1,h2,h3{font-family:"Iowan Old Style","New York",Georgia,serif;font-weight:400;line-height:1.2}
h1{font-size:34px;margin:4px 0 12px}h2{font-size:23px;margin:40px 0 12px}h3{font-size:18px;margin:24px 0 8px}
.kind,th[scope=col],dt{font:500 12px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.04em;text-transform:uppercase;color:var(--slate)}
.scope{border-left:3px solid var(--spruce);background:var(--paper);padding:12px 16px;margin:16px 0}
dl.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);margin:16px 0}
dl.facts div{background:var(--paper);padding:12px 14px}dl.facts dd{margin:4px 0 0;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto;border:1px solid var(--rule);background:var(--paper)}
table{border-collapse:collapse;width:100%;font-size:15px}
caption{text-align:left;padding:10px 14px;font-weight:500}
th,td{padding:10px 14px;border-top:1px solid var(--rule);text-align:left;vertical-align:top}
th[scope=row]{font-weight:400;min-width:12rem}
ul.marks{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.sq{display:inline-block;width:9px;height:9px;margin-right:6px;border:1.5px solid var(--slate)}
.met .sq{background:var(--spruce);border-color:var(--spruce)}
.not_met .sq{border-color:var(--brick);background:linear-gradient(45deg,transparent 42%,var(--brick) 42% 58%,transparent 58%)}
.scored .sq{border-color:var(--spruce)}
.split .sq{border-color:var(--slate);background:linear-gradient(90deg,var(--spruce) 50%,transparent 50%)}
.missing .sq{border-color:var(--ochre);border-style:dashed}
.not_enough_evidence .sq{border-color:var(--ochre);background:linear-gradient(0deg,var(--ochre) 35%,transparent 35%)}
small,.small{color:var(--slate);font-size:14px}
img{max-width:240px;height:auto;border:1px solid var(--rule);margin:4px 4px 0 0}
details{margin-top:4px}summary{cursor:pointer;color:var(--slate)}
footer{margin-top:48px;color:var(--slate);font-size:14px}
`;

function page(title: string, kind: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} · Basalt export</title>
<style>${style}</style>
</head>
<body>
<main>
<p class="kind">Basalt export · ${e(kind)}</p>
${body}
</main>
</body>
</html>
`;
}

function scopeText(scope: "public" | "private") {
  return scope === "public"
    ? "Public export. Criteria have numbers in their authored order. This page has no criterion text, judge reasons, scales or images."
    : "Private export. This page has the private criteria and the judge reasons. Share it only with people who may read them.";
}

const verdictWords = {
  meets_more_often: "Meets more often",
  meets_less_often: "Meets less often",
  not_enough_builds: "Not enough builds to tell",
} as const;
const patternVerdictWords = {
  happens_more_often: "Happens more often",
  happens_less_often: "Happens less often",
  not_enough_builds: "Not enough builds to tell",
} as const;
const familyTitles = {
  stops: "How builds ended",
  gateFailures: "Local checks that failed",
  failedToolCalls: "Tool calls that failed",
  refusedBatches: "Tool calls refused",
  causes: "Why work didn’t finish",
  lint: "Code analysis",
  scriptErrors: "Script errors",
} as const;
const outcomeText = (counts: { met: number; notMet: number; unresolved: number }) =>
  `${counts.met} of ${counts.met + counts.notMet + counts.unresolved} met${counts.unresolved ? ` · ${counts.unresolved} unclear` : ""}`;
const patternText = (counts: { builds: number; of: number; excluded: number }) =>
  `${counts.builds} of ${counts.of} builds${counts.excluded ? ` · ${counts.excluded} not measured` : ""}`;

type ExportPairs = RunExportReport["models"]["modelPairs"];

/** One table of criteria and one table of failure patterns for each pair, from the first row. */
function pairsHtml(
  pairs: ExportPairs,
  title: (pair: ExportPairs[number]) => string,
  evaluationTitle: (number: number) => string,
): string {
  // The report has each pair in both directions. The page shows each pair one time.
  const shown = pairs.filter(
    (pair, index, all) =>
      !all
        .slice(0, index)
        .some(
          (other) =>
            other.model === pair.otherModel &&
            other.toolSet === pair.otherToolSet &&
            other.otherModel === pair.model &&
            other.otherToolSet === pair.toolSet,
        ),
  );
  return shown
    .map((pair) => {
      const left = `${pair.model} · ${pair.toolSet}`,
        right = `${pair.otherModel} · ${pair.otherToolSet}`;
      const patterns = pair.patterns.length
        ? `<div class="wrap"><table>
<caption>How often each failure pattern happens in ${e(left)}, compared with ${e(right)}</caption>
<thead><tr><th scope="col">Pattern</th><th scope="col">${e(left)}</th><th scope="col">${e(right)}</th><th scope="col">Answer</th></tr></thead>
<tbody>${pair.patterns
            .map(
              (item) =>
                `<tr><th scope="row">${familyTitles[item.family]} · <code>${e(item.key)}</code></th><td>${patternText(item.model)}</td><td>${patternText(item.other)}</td><td>${patternVerdictWords[item.verdict]}</td></tr>`,
            )
            .join("")}</tbody>
</table></div>`
        : "";
      return `<h3>${e(title(pair))}</h3>
<div class="wrap"><table>
<caption>How often ${e(left)} meets each criterion, compared with ${e(right)}</caption>
<thead><tr><th scope="col">Criterion</th><th scope="col">${e(left)}</th><th scope="col">${e(right)}</th><th scope="col">Answer</th></tr></thead>
<tbody>${pair.criteria
        .map(
          (item) =>
            `<tr><th scope="row">${e(evaluationTitle(item.evaluation))} · Criterion ${item.criterion}</th><td>${outcomeText(item.model)}</td><td>${outcomeText(item.other)}</td><td>${verdictWords[item.verdict]}</td></tr>`,
        )
        .join("")}</tbody>
</table></div>${pair.decisionPossible ? "" : '<p class="small">With these build counts, no criterion can reach a decision.</p>'}
${patterns}`;
    })
    .join("\n");
}

/** The model pairs and the tool-set pairs of the run. */
function modelsHtml(report: RunExportReport): string {
  const evaluationTitle = (number: number) =>
    report.evaluations[number - 1]?.title ?? `Evaluation ${number}`;
  const models = pairsHtml(
    report.models.modelPairs,
    (pair) => `${pair.model} compared with ${pair.otherModel} · ${pair.toolSet}`,
    evaluationTitle,
  );
  const toolSets = pairsHtml(
    report.models.toolSetPairs,
    (pair) => `${pair.model}: ${pair.toolSet} compared with ${pair.otherToolSet}`,
    evaluationTitle,
  );
  const note =
    "“Not enough builds to tell” means that the difference could be chance. An unclear build counts against the answer under test. A failure pattern counts only the builds that can show it, and “not measured” counts the others.";
  return [
    models &&
      `<section>
<h2>Models</h2>
<p class="small">Each test compares two models of the same run and tool set. ${note}</p>
${models}
</section>`,
    toolSets &&
      `<section>
<h2>Tool sets</h2>
<p class="small">Each test compares two tool sets of the same model in the same run. ${note}</p>
${toolSets}
</section>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The static report of one exported run. */
export function runReportHtml(report: RunExportReport): string {
  const sections = report.evaluations
    .map((evaluation, index) => {
      const title = evaluation.title ?? `Evaluation ${index + 1}`;
      const rows = evaluation.criteria
        .map((criterion) => {
          const cells = evaluation.columns
            .map((column) => {
              const items = column.builds.flatMap((build) =>
                build.answers
                  .filter((item) => item.criterion === criterion.number)
                  .map(
                    (item) =>
                      `<li class="${item.answer}"><span class="sq" aria-hidden="true"></span>Build ${build.number}, observation ${item.observation}: ${answerText(item)}${item.score === null ? "" : ` (${item.score})`}${item.reason ? `<details><summary>Reason</summary>${e(item.reason)}</details>` : ""}${(item.frames ?? []).map((frame) => `<br><img src="${e(frame)}" alt="Build ${build.number}, observation ${item.observation}">`).join("")}</li>`,
                  ),
              );
              return `<td>${items.length ? `<ul class="marks">${items.join("")}</ul>` : '<span class="small">No answer</span>'}</td>`;
            })
            .join("");
          return `<tr><th scope="row">Criterion ${criterion.number}${criterion.statement ? `<br><small>${e(criterion.statement)}</small>` : ""}${criterion.required ? "" : " <small>Optional</small>"}</th>${cells}</tr>`;
        })
        .join("");
      const builds = evaluation.columns
        .flatMap((column) =>
          column.builds.map(
            (build) =>
              `<tr><th scope="row">${e(column.model)} · ${e(column.toolSet)} · Build ${build.number}</th><td>${money(build.charge.builderUsd)}</td><td>${money(build.charge.judgeUsd)}</td><td>${duration(build.buildMs)}</td><td>${build.notReached ? "Not reached. The run did not reach this stage, so this build never started." : build.history ? `${build.history.turns} turns · ${build.history.toolCalls} tool calls · ${build.history.changes} changes${build.history.unverifiedChanges ? ` (${build.history.unverifiedChanges} not verified)` : ""} · <a href="${e(build.history.trajectory)}">Trajectory</a>` : "Not recorded"}</td></tr>`,
          ),
        )
        .join("");
      return `<section>
<h2>${e(title)}</h2>
<div class="wrap"><table>
<caption>Answers for ${e(title)}</caption>
<thead><tr><th scope="col">Criterion</th>${evaluation.columns.map((column) => `<th scope="col">${e(column.model)}<br><small>${e(column.toolSet)}</small></th>`).join("")}</tr></thead>
<tbody>${rows}</tbody>
</table></div>
<h3>Builds</h3>
<div class="wrap"><table>
<caption>Charges, build time and how each build was built</caption>
<thead><tr><th scope="col">Build</th><th scope="col">Builder charge</th><th scope="col">Judge charge</th><th scope="col">Build time</th><th scope="col">How it was built</th></tr></thead>
<tbody>${builds}</tbody>
</table></div>
</section>`;
    })
    .join("\n");
  return page(
    report.title,
    "Run",
    `<h1>${e(report.title)}</h1>
<p class="scope">${e(scopeText(report.scope))}</p>
<dl class="facts">
<div><dt>Run</dt><dd>${e(report.runId)}</dd></div>
<div><dt>Exported</dt><dd>${e(report.exportedAt)}</dd></div>
<div><dt>Charged</dt><dd>${money(report.chargedUsd)}</dd></div>
<div><dt>Pending charges</dt><dd>${money(report.pendingUsd)}</dd></div>
</dl>
${sections}
${modelsHtml(report)}
<footer>${report.notes.map((note) => `<p>${e(note)}</p>`).join("")}<p>manifest.json lists the SHA-256 of each file.</p></footer>`,
  );
}

const verdicts = {
  direct: "Same test conditions",
  descriptive: "Conditions differ",
  incompatible: "Cannot compare",
} as const;

/** The static report of one exported comparison. */
export function comparisonReportHtml(report: ComparisonExportReport): string {
  const runs = report.runs
    .map(
      (run) =>
        `<tr><th scope="row">Run ${run.number}</th><td>${e(run.title)}<br><small>${run.kind === "assessment" ? "Reassessment" : "Run"} · ${e(run.operationId)}</small></td><td>${e(run.models)}</td><td>${e(run.judge)}</td><td>${money(run.chargedUsd)}${run.pendingUsd > 0 ? ` · ${money(run.pendingUsd)} pending` : ""}</td><td>${run.excludedAnswers}</td></tr>`,
    )
    .join("");
  const pairs = report.pairs
    .filter((pair) => pair.compatibility !== "direct")
    .map(
      (pair) =>
        `<li>Run ${pair.runs[0]} and run ${pair.runs[1]}: ${verdicts[pair.compatibility]}<ul>${pair.reasons.map((reason) => `<li>${e(reason)}</li>`).join("")}</ul></li>`,
    )
    .join("");
  const evaluations = report.evaluations
    .map((evaluation, index) => {
      const title = evaluation.title ?? `Evaluation ${index + 1}`;
      return `<section>
<h2>${e(title)}</h2>
<div class="wrap"><table>
<caption>Answers for ${e(title)}</caption>
<thead><tr><th scope="col">Criterion</th>${report.runs.map((run) => `<th scope="col">Run ${run.number}<br><small>${e(run.models)}</small></th>`).join("")}</tr></thead>
<tbody>${evaluation.criteria
        .map(
          (criterion) =>
            `<tr><th scope="row">Criterion ${criterion.number}${criterion.statement ? `<br><small>${e(criterion.statement)}</small>` : ""}</th>${criterion.runs
              .map((cell) =>
                cell.planned === 0
                  ? '<td><span class="small">Not in this run</span></td>'
                  : `<td>${cell.met} met · ${cell.rejected} not met${cell.split ? ` · ${cell.split} split` : ""}${cell.scored ? ` · ${cell.scored} scored` : ""}${cell.insufficient ? ` · ${cell.insufficient} not enough evidence` : ""}${cell.unavailable ? ` · ${cell.unavailable} unavailable` : ""}<ul class="marks">${cell.marks.map((mark) => `<li class="${mark.answer}"><span class="sq" aria-hidden="true"></span>Build ${mark.build}, observation ${mark.observation}: ${answers[mark.answer]}${mark.score === null ? "" : ` (${mark.score})`}</li>`).join("")}</ul></td>`,
              )
              .join("")}</tr>`,
        )
        .join("")}</tbody>
</table></div>
</section>`;
    })
    .join("\n");
  return page(
    report.title,
    "Comparison",
    `<h1>${e(report.title)}</h1>
<p class="scope">${e(scopeText(report.scope))}</p>
<p><strong>${verdicts[report.compatibility]}</strong></p>
${pairs ? `<h2>Differences between runs</h2><ul>${pairs}</ul>` : "<p>Basalt found no differences in the recorded test conditions.</p>"}
<h2>Runs</h2>
<div class="wrap"><table>
<caption>The runs of this comparison</caption>
<thead><tr><th scope="col">Run</th><th scope="col">Title</th><th scope="col">Models</th><th scope="col">Judge</th><th scope="col">Charged</th><th scope="col">Answers not included</th></tr></thead>
<tbody>${runs}</tbody>
</table></div>
${evaluations}
<footer>${report.notes.map((note) => `<p>${e(note)}</p>`).join("")}<p>manifest.json lists the SHA-256 of each file.</p></footer>`,
  );
}
