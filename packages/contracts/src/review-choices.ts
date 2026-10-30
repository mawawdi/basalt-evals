/** Presentation only: persisted rubric text and categorical decisions stay unchanged.
 * Negate simple English predicates. Quantifiers and compound clauses keep an
 * explicit whole-statement negation so a UI shortcut cannot reverse their scope.
 */
export function criterionChoices(statement: string): { satisfied: string; violated: string } {
  const text = statement
    .trim()
    .replace(/^(?:[-*+] |\d+[.)] )/u, "")
    .replace(/[.!]$/u, "");
  const fallback = { satisfied: text, violated: `Not true: ${text}` };
  if (
    /[.!?]\s+\S|[;:\n]/u.test(text) ||
    /\b(?:no|none|neither|all|every|each|both|only|any|some|exactly|at least|at most|fewer|more|less|and|or|unless|if|when|while|before|after|that|which|who|whose|where|means)\b/iu.test(
      text,
    )
  )
    return fallback;
  const auxiliaries: Array<[RegExp, string]> = [
    [/^(.+?) does not (.+)$/u, "$1 does $2"],
    [/^(.+?) doesn't (.+)$/u, "$1 does $2"],
    [/^(.+?) is not (.+)$/u, "$1 is $2"],
    [/^(.+?) isn't (.+)$/u, "$1 is $2"],
    [/^(.+?) are not (.+)$/u, "$1 are $2"],
    [/^(.+?) aren't (.+)$/u, "$1 are $2"],
    [/^(.+?) is (.+)$/u, "$1 is not $2"],
    [/^(.+?) are (.+)$/u, "$1 are not $2"],
    [/^(.+?) has (.+)$/u, "$1 does not have $2"],
    [/^(.+?) can (.+)$/u, "$1 cannot $2"],
    [/^(.+?) exists$/u, "$1 does not exist"],
    [
      /^(.+?) (looks|shows|contains|responds|appears|remains|works|moves|returns)(.*)$/u,
      "$1 does not $2$3",
    ],
  ];
  for (const [pattern, replacement] of auxiliaries)
    if (pattern.test(text)) {
      let negative = text.replace(pattern, replacement);
      negative = negative.replace(
        /does not (looks|shows|contains|responds|appears|remains|works|moves|returns)\b/u,
        (_match, verb: string) => `does not ${verb.slice(0, -1)}`,
      );
      return { satisfied: text, violated: negative };
    }
  return fallback;
}
