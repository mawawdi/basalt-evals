import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { hashJson, sequenceViewReferenceErrors } from "../../contracts/src/index.js";
import type { ANCHOR_FACT_SEMANTICS } from "../../contracts/src/capabilities.js";

// An anchor fact name looks like an observation kind, but it is valid only in at.after.fact.
// The correction must name the observation that records the same state.
const OBSERVATION_FOR_ANCHOR_FACT: Record<keyof typeof ANCHOR_FACT_SEMANTICS, string> = {
  gui_visible: "gui_text or gui_geometry, which record visible",
  instance_present: "instance, which records exists",
  part_can_collide: "part_physics or part_physics_trace, which record canCollide",
  part_anchored: "part_physics or part_physics_trace, which record anchored",
  character_on_part: "actor_part_support, which records the downward ray target",
  character_near_part: "part_position or actor_part_motion",
  humanoid_state: "no observation; use it only as an anchor",
};

function valueAt(value: unknown, pointer: string): unknown {
  let current = value;
  for (const part of pointer.split("/").slice(1)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[
      part.replaceAll("~1", "/").replaceAll("~0", "~")
    ];
  }
  return current;
}

// Validate the exact schema supplied to the model, without coercion or defaults.
// Cross-field semantics and authority are still enforced by the compiler.
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>();

export function assertSubmissionShape(
  value: unknown,
  schema: object,
  label: string,
  referenceErrors: string[] = [],
): void {
  const key = hashJson(schema);
  let validate = validators.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    if (validators.size >= 64) validators.delete(validators.keys().next().value!);
    validators.set(key, validate);
  }
  if (validate(value) && !referenceErrors.length) return;
  const errors = validate.errors ?? [];
  // A wrong discriminant identifies an inapplicable union member. Its missing
  // fields are noise; report the selected kind's errors in the same correction.
  const excluded = errors
    .filter(
      (error) => error.keyword === "enum" && error.schemaPath.endsWith("/properties/kind/enum"),
    )
    .map((error) => ({
      schema: error.schemaPath.slice(0, -"/properties/kind/enum".length) + "/",
      instance: error.instancePath.slice(0, -"/kind".length),
    }));
  const isExcluded = (error: ErrorObject) =>
    excluded.some(
      ({ schema, instance }) =>
        error.schemaPath.startsWith(schema) &&
        (error.instancePath === instance || error.instancePath.startsWith(instance + "/")),
    );
  // A union without a kind discriminant reports only its closest form: the form whose errors
  // reach deepest into the value, then the form with the fewest errors.
  const dropped = new Set<ErrorObject>();
  const within = (child: ErrorObject, union: ErrorObject) =>
    child !== union &&
    child.schemaPath.startsWith(union.schemaPath + "/") &&
    (child.instancePath === union.instancePath ||
      child.instancePath.startsWith(union.instancePath + "/"));
  const depth = (error: ErrorObject) =>
    error.instancePath.split("/").length +
    (error.keyword === "required" || error.keyword === "additionalProperties" ? 1 : 0);
  for (const union of errors
    .filter((entry) => ["oneOf", "anyOf"].includes(entry.keyword))
    .sort((left, right) => left.schemaPath.length - right.schemaPath.length)) {
    if (dropped.has(union) || isExcluded(union)) continue;
    const forms = new Map<string, ErrorObject[]>();
    for (const child of errors) {
      if (dropped.has(child) || isExcluded(child) || !within(child, union)) continue;
      const form = child.schemaPath.slice(union.schemaPath.length + 1).split("/")[0]!;
      forms.set(form, [...(forms.get(form) ?? []), child]);
    }
    if (forms.size < 2) continue;
    const ranked = [...forms.values()].sort(
      (left, right) =>
        Math.max(...right.map(depth)) - Math.max(...left.map(depth)) || left.length - right.length,
    );
    for (const form of ranked.slice(1)) for (const child of form) dropped.add(child);
  }
  const relevant = errors.filter(
    (error) =>
      !["oneOf", "anyOf"].includes(error.keyword) && !isExcluded(error) && !dropped.has(error),
  );
  // If no branch accepts a kind, none of its enum errors survive the branch
  // filter. Keep the deepest unmatched union so unrelated errors cannot hide it.
  for (const error of errors
    .filter(
      (entry) =>
        ["oneOf", "anyOf"].includes(entry.keyword) && !isExcluded(entry) && !dropped.has(entry),
    )
    .sort((left, right) => right.schemaPath.length - left.schemaPath.length)) {
    if (
      !relevant.some(
        (child) =>
          child.schemaPath.startsWith(error.schemaPath + "/") &&
          (child.instancePath === error.instancePath ||
            child.instancePath.startsWith(error.instancePath + "/")),
      )
    )
      relevant.push(error);
  }
  const describe = (error: ErrorObject) => {
    if (["oneOf", "anyOf"].includes(error.keyword)) {
      const kinds = [
        ...new Set(
          errors
            .filter(
              (child) =>
                child.keyword === "enum" &&
                child.instancePath === error.instancePath + "/kind" &&
                child.schemaPath.startsWith(error.schemaPath + "/"),
            )
            .flatMap((child) => child.params.allowedValues as string[]),
        ),
      ];
      const used = valueAt(value, error.instancePath + "/kind");
      if (
        kinds.length &&
        typeof used === "string" &&
        Object.hasOwn(OBSERVATION_FOR_ANCHOR_FACT, used)
      )
        return `${error.instancePath}/kind: ${used} is an anchor fact. Use it only in at.after.fact. To observe this state, use ${OBSERVATION_FOR_ANCHOR_FACT[used as keyof typeof OBSERVATION_FOR_ANCHOR_FACT]}. Expected one of: ${kinds.join(", ")}`;
      if (kinds.length)
        return `${error.instancePath}/kind: unsupported kind; expected one of: ${kinds.join(", ")}`;
    }
    const suffix =
      error.keyword === "required"
        ? "/" + String(error.params.missingProperty)
        : error.keyword === "additionalProperties"
          ? "/" + String(error.params.additionalProperty)
          : "";
    return `${error.instancePath || ""}${suffix || (error.instancePath ? "" : "/")}: ${error.message}`;
  };
  const messages = [
    ...new Set([...(relevant.length ? relevant : errors).map(describe), ...referenceErrors]),
  ];
  throw new Error(
    `${label} shape errors:\n${messages.slice(0, 32).join("\n")}${messages.length > 32 ? "\nAdditional shape errors omitted." : ""}`,
  );
}

/** A correction sees shape and independently checkable references in one diagnostic set. */
export function assertPreparationShape(value: unknown, schema: object, label: string): void {
  const record = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item);
  const errors: string[] = [];
  if (record(value)) {
    const development = value.publicDevelopment;
    if (record(development) && Array.isArray(development.views))
      for (const [index, view] of development.views.entries())
        errors.push(
          ...sequenceViewReferenceErrors(
            view,
            development.plan,
            `/publicDevelopment/views/${index}`,
          ),
        );
    // A private plan submission holds its sequence view next to its Studio plan.
    if (Object.hasOwn(value, "studio") && Object.hasOwn(value, "sequence"))
      errors.push(...sequenceViewReferenceErrors(value.sequence, value.studio, "/sequence"));
  }
  assertSubmissionShape(value, schema, label, errors);
}
