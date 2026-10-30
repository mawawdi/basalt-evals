import assert from "node:assert/strict";
import test from "node:test";
import {
  authoredNumericScale,
  authoredScoreAnchors,
} from "../packages/eval-authoring/src/rubric-grading.js";
import { authoredCriteria, createEvalDraft } from "../packages/eval-authoring/src/index.js";

test("headings and scale tables remain governing authority without becoming scored requirements", () => {
  const rubric =
    "# Required: all following criteria; visibility carries 80%\n- Beacon is blue.\n\n| Score | Meaning |\n| --- | --- |\n| 0 | Absent |\n| 1 | Visible |";
  const draft = createEvalDraft({
    schema: "basalt-evals/eval-authoring-input",
    stages: [{ prompt: "Build a beacon", rubric: rubric }],
  });
  const passages = draft.stages[0]!.criteria;
  assert.equal(passages.length, 1);
  const context = passages[0]!.contextNodeIds
    .map((id) => draft.stages[0]!.document.find((node) => node.id === id)!.text)
    .join("\n");
  assert.match(context, /80%/u);
  assert.match(context, /\| 1 \| Visible \|/u);
  for (const passage of passages)
    assert.equal(rubric.slice(passage.start, passage.end), passage.text);
});

test("explicit optional heading scopes its children without weakening unrelated mentions", () => {
  const draft = createEvalDraft({
    schema: "basalt-evals/eval-authoring-input",
    stages: [
      {
        prompt: "Build the display",
        rubric:
          "# Optional presentation\n- Add a glow.\n# Required behavior\n- A button labelled Optional is visible.",
      },
    ],
  });
  assert.equal(draft.stages[0]!.criteria[0]?.required, false);
  assert.equal(draft.stages[0]!.criteria[1]?.required, true);
  assert.ok(draft.stages[0]!.criteria[0]?.contextNodeIds.length);
  for (const node of draft.stages[0]!.document)
    assert.equal(draft.stages[0]!.rubric.slice(node.start, node.end), node.text);
});

test("Markdown hierarchy preserves nested lists, multiline paragraphs, Unicode spans and clauses", () => {
  const rubric =
    "# Required\r\n\r\n- Display 🟦 clearly:\r\n  - It remains visible and readable unless hidden by the player.\r\n  - Optional: animate it.\r\n\r\nThe label spans\r\ntwo lines.";
  const draft = createEvalDraft({
    schema: "basalt-evals/eval-authoring-input",
    stages: [{ prompt: "Build the display", rubric: rubric }],
  });
  assert.equal(draft.stages[0]!.criteria.length, 4);
  assert.deepEqual(
    draft.stages[0]!.criteria.map((item) => item.required),
    [true, true, false, true],
  );
  assert.ok(draft.stages[0]!.criteria[1]!.clauses.length >= 3);
  assert.match(draft.stages[0]!.criteria[3]!.text, /spans\r\ntwo/u);
  for (const criterion of draft.stages[0]!.criteria) {
    assert.equal(rubric.slice(criterion.start, criterion.end), criterion.text);
    for (const clause of criterion.clauses)
      assert.equal(rubric.slice(clause.start, clause.end), clause.text);
  }
});

test("criterion tables retain requirements while weight metadata does not invent a scoring scale", () => {
  const draft = createEvalDraft({
    schema: "basalt-evals/eval-authoring-input",
    stages: [
      {
        prompt: "Build the display",
        rubric:
          "Weight: 80%\n\n| Requirement | Importance |\n| --- | --- |\n| It is blue. | Required |\n| It is visible. | Required |",
      },
    ],
  });
  assert.equal(draft.stages[0]!.criteria.length, 2);
  assert.ok(
    draft.stages[0]!.criteria.every((criterion) =>
      criterion.contextNodeIds.some(
        (id) => draft.stages[0]!.document.find((node) => node.id === id)!.text === "Weight: 80%",
      ),
    ),
  );
});

test("two inputs preserve human rubric wording and source spans", () => {
  const input = {
    schema: "basalt-evals/eval-authoring-input" as const,
    stages: [
      {
        prompt: "Build a cooperative gate\nGive both players feedback.",
        rubric:
          "- Gate opens only for two players.\n- Both players can see the gate.\n\nTiming must feel fair.",
      },
    ],
  };
  const draft = createEvalDraft(input);
  assert.equal(draft.stages[0]!.criteria.length, 3);
  for (const criterion of draft.stages[0]!.criteria)
    assert.equal(input.stages[0]!.rubric.slice(criterion.start, criterion.end), criterion.text);
  assert.deepEqual(createEvalDraft(input), draft);
  assert.deepEqual(authoredCriteria(input.stages[0]!.rubric), draft.stages[0]!.criteria);
});

test("authoring rejects unknown metadata fields instead of quietly accepting a recipe", () => {
  assert.throws(
    () =>
      createEvalDraft({
        schema: "basalt-evals/eval-authoring-input",
        stages: [{ prompt: "Build a gate.", rubric: "It opens for two players." }],
        statePath: "game.ReplicatedStorage.EvalState",
      }),
    /accepts only stages and an optional title/,
  );
});

test("emphasized optional children keep their own requiredness and exact passages", () => {
  const rubric =
    "- Build a visible display.\n  - **Optional:** add a glow.\n  - Required: show a label.";
  const criteria = authoredCriteria(rubric);
  assert.deepEqual(
    criteria.map((item) => item.required),
    [true, false, true],
  );
  for (const criterion of criteria)
    assert.equal(rubric.slice(criterion.start, criterion.end), criterion.text);
});

test("scoring lists preserve complete anchor labels and weights stay separate from numerical scales", () => {
  const rubric =
    "# Visibility\nScoring weight: 80%\n\n- The display is legible.\n  - 0: Absent. No readable display.\n  - 1: Readable; player can identify it.\n";
  const draft = createEvalDraft({
    schema: "basalt-evals/eval-authoring-input",
    stages: [{ prompt: "Build a display", rubric: rubric }],
  });
  assert.equal(draft.stages[0]!.criteria.length, 1);
  const governing = draft.stages[0]!.criteria[0]!.contextNodeIds.map(
    (id) => draft.stages[0]!.document.find((node) => node.id === id)!.text,
  ).join("\n");
  assert.deepEqual(authoredScoreAnchors(governing), [
    { score: 0, label: "Absent. No readable display." },
    { score: 1, label: "Readable; player can identify it." },
  ]);
  assert.equal(authoredNumericScale("Scoring weight: 80%"), false);
  assert.equal(authoredNumericScale("Weight: 2 points"), false);
  assert.deepEqual(
    authoredScoreAnchors(
      "| ID | Requirement |\n| --- | --- |\n| 0 | Must be blue |\n| 1 | Must be visible |",
    ),
    [],
  );
  assert.equal(authoredNumericScale("Scale: 0 to 10"), true);
  assert.deepEqual(
    authoredScoreAnchors("Score 0: Absent. Score 1: Visible. Minimum passing score 1."),
    [
      { score: 0, label: "Absent" },
      { score: 1, label: "Visible" },
    ],
  );
});

test("explicit table requiredness overrides scope while unclear importance remains an unresolved passage", () => {
  const rubric =
    "# Optional extras\n| Requirement | Required |\n| --- | --- |\n| It remains visible. | Yes |\n| Add a glow. | No |\n| Add a border. | Sometimes |";
  const draft = createEvalDraft({
    schema: "basalt-evals/eval-authoring-input",
    stages: [{ prompt: "Build a display", rubric: rubric }],
  });
  assert.deepEqual(
    draft.stages[0]!.criteria.map((item) => item.required),
    [true, false, false],
  );
  assert.ok(
    draft.stages[0]!.document.some(
      (node) => node.role === "unresolved" && node.text === "Sometimes",
    ),
  );
  for (const node of draft.stages[0]!.document)
    assert.equal(rubric.slice(node.start, node.end), node.text);
});

test("requirement tables do not make another row's threshold governing authority", () => {
  const draft = createEvalDraft({
    schema: "basalt-evals/eval-authoring-input",
    stages: [
      {
        prompt: "Build two signals",
        rubric:
          "| Requirement | Required |\n| --- | --- |\n| First signal uses minimum passing score 1. | Yes |\n| Second signal uses minimum passing score 2. | Yes |",
      },
    ],
  });
  const second = draft.stages[0]!.criteria[1]!;
  const context = second.contextNodeIds
    .map((id) => draft.stages[0]!.document.find((node) => node.id === id)!.text)
    .join("\n");
  assert.doesNotMatch(context, /minimum passing score 1/u);
  assert.match(context, /Requirement \| Required/u);
});

test("evidence class and sufficiency lines are grading metadata, never requirement text", () => {
  const draft = (rubric: string) =>
    createEvalDraft({
      schema: "basalt-evals/eval-authoring-input",
      stages: [{ prompt: "Build a door", rubric: rubric }],
    });
  const nested = draft(
    "- The door visibly opens after the press.\n  - Evidence class: appearance\n  - Insufficient evidence when the door is occluded.\n- The door opens within one second.\n  - **Evidence class:** timing",
  );
  assert.deepEqual(
    nested.stages[0]!.criteria.map((criterion) => [criterion.text, criterion.evidenceClass]),
    [
      ["- The door visibly opens after the press.", "appearance"],
      ["- The door opens within one second.", "timing"],
    ],
  );
  const context = nested.stages[0]!.criteria[0]!.contextNodeIds.map((id) =>
    nested.stages[0]!.document.find((node) => node.id === id)!,
  ).map((node) => [node.role, node.text]);
  assert.deepEqual(context, [
    ["grading_metadata", "- Evidence class: appearance"],
    ["grading_metadata", "- Insufficient evidence when the door is occluded."],
  ]);
  // A standalone sufficiency condition is metadata. It is not a criterion.
  const sufficiency = draft(
    "The door opens.\n\nInsufficient evidence when the rider is occluded.\n\nInsufficient evidence: the camera misses the door.",
  );
  assert.deepEqual(
    sufficiency.stages[0]!.criteria.map((criterion) => criterion.text),
    ["The door opens."],
  );
  // A class in a section applies to every requirement below it.
  const section = draft("## Motion\n\nEvidence class: motion\n\n- The door swings.\n- It returns.");
  assert.deepEqual(
    section.stages[0]!.criteria.map((criterion) => criterion.evidenceClass),
    ["motion", "motion"],
  );
  assert.equal(draft("- The door opens.").stages[0]!.criteria[0]!.evidenceClass, null);
  // Metadata inside requirement text is ambiguous authority, so it cannot become a criterion.
  const inline = draft("- The door opens. Evidence class: motion\n- The door is red.");
  assert.deepEqual(
    inline.stages[0]!.criteria.map((criterion) => criterion.text),
    ["- The door is red."],
  );
  assert.equal(
    inline.stages[0]!.document.find((node) => node.text.includes("motion"))!.role,
    "unresolved",
  );
  assert.throws(
    () => draft("- The door opens.\n  - Evidence class: speed"),
    /Use one of these evidence classes: appearance, timing, motion, causality/,
  );
  assert.throws(
    () => draft("Evidence class: motion\n\n- The door opens.\n  - Evidence class: appearance"),
    /more than one evidence class/,
  );
});

test("A Polarity: absence line is grading metadata, never requirement text.", () => {
  const draft = (rubric: string) =>
    createEvalDraft({
      schema: "basalt-evals/eval-authoring-input",
      stages: [{ prompt: "Build a door", rubric: rubric }],
    });
  const nested = draft(
    "- The door flickers.\n  - Evidence class: appearance\n  - Polarity: absence\n- The door opens.\n  - **Polarity:** presence",
  );
  assert.deepEqual(
    nested.stages[0]!.criteria.map((criterion) => [
      criterion.text,
      criterion.evidenceClass,
      criterion.polarity,
    ]),
    [
      ["- The door flickers.", "appearance", "absence"],
      ["- The door opens.", null, "presence"],
    ],
  );
  assert.deepEqual(
    nested.stages[0]!.document.filter((node) => /polarity/iu.test(node.text)).map(
      (node) => node.role,
    ),
    ["grading_metadata", "grading_metadata"],
  );
  // A criterion without a polarity line has presence. A section line applies to each child.
  assert.equal(draft("- The door opens.").stages[0]!.criteria[0]!.polarity, "presence");
  const section = draft("## Errors\n\nPolarity: absence\n\n- The door shakes.\n- It squeaks.");
  assert.deepEqual(
    section.stages[0]!.criteria.map((criterion) => criterion.polarity),
    ["absence", "absence"],
  );
  // A polarity inside requirement text is ambiguous authority, so it cannot become a criterion.
  const inline = draft("- The door shakes. Polarity: absence\n- The door is red.");
  assert.deepEqual(
    inline.stages[0]!.criteria.map((criterion) => criterion.text),
    ["- The door is red."],
  );
  assert.throws(
    () => draft("- The door opens.\n  - Polarity: never"),
    /Use one of these polarities: presence, absence/,
  );
  assert.throws(
    () => draft("Polarity: absence\n\n- The door opens.\n  - Polarity: presence"),
    /more than one polarity/,
  );
});
