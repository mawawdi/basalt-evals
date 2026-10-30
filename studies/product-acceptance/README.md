# Product acceptance inputs

These are authoring text, not executable evaluator definitions. Submit them through
the two-input creation page or `eval save`. Saving is free. An authorized fresh
launch checks isolated Studio readiness before compilation, then prepares the
public setup and private evaluation in separate calls. Ordinary launches do not
generate controls; reference testing is an explicit, separately quoted action.
An unchanged saved definition skips compilation on subsequent runs.

`beacon.json` preserves the exact prompt and rubric of the existing static Beacon
acceptance. `moving-platform.json` preserves the original moving-platform prompt,
three acceptance points and 18-stud requirement. Neither input supplies a scoring
scale or pass threshold. Do not invent one during preparation.

The text was recovered from the immutable authored-input artifacts
`1bdf19f53fe1a0af55ce7f58127448815e37d7271286b8cf878dda40ee44f417` and
`b96c38557e616dd3dfb21df7d31c67dff990492b137fa016f9c834ac3c6b52b8` respectively.
Only original text and title are reused. Historical evaluator schemas, validation
receipts and execution results do not make the newly compiled inputs runnable.

The rubrics add an `Evidence class:` line only where the human text makes the class
obvious. The Beacon criterion is `appearance`. The 18-stud travel criterion is
`motion` in both moving-platform inputs. No other criterion has a class yet: the
smooth-motion, rider-carriage, motion-readability and runtime-error criteria have the
status `draft_requires_human_review`. A person must set their class. A model cannot
judge rendered frames for a criterion without a class, and a model must not choose
the class.

`moving-platform-carriage.json` is a separately authored follow-up input. It retains
the builder request and separates rider carriage from visible motion readability.
Its content hash identifies a new draft; it never relabels earlier criteria or
judgments. It is not compiled, reference tested, or Studio validated by saving.
The capture plan must establish boarding and the full trip before a carriage
judgment can be supported. No numeric readability scale or timing threshold is
introduced.
