import { hashJson } from "../../contracts/src/index.js";
import { assertExactRecordKeys } from "../../contracts/src/validation.js";

export const MAX_CORRECTION_ENVELOPE_BYTES = 64 * 1024;

/** The fields that a correction of each proposal part can edit. */
const CORRECTION_ROOTS = {
  Public: ["publicScene", "stages"],
  PrivatePlan: ["studio", "sequence"],
  PrivateCriteria: [
    "deterministic",
    "codeQuality",
    "visual",
    "unscaled",
    "humanReview",
    "criterionMappings",
    "requiredCapabilities",
  ],
} as const;
export type CorrectionPart = keyof typeof CORRECTION_ROOTS;
const PART_NAMES: Record<CorrectionPart, string> = {
  Public: "Public",
  PrivatePlan: "Private plan",
  PrivateCriteria: "Private criteria",
};

/** Compiler-local document edits. These operations never enter a Studio plan. */
export const correctionSchema = {
  type: "object",
  properties: {
    baseHash: { type: "string" },
    edits: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add", "replace", "remove"] },
          path: { type: "string" },
          value: {},
        },
        required: ["op", "path", "value"],
        additionalProperties: false,
      },
    },
  },
  required: ["baseHash", "edits"],
  additionalProperties: false,
};

type Edit = {
  index: number;
  op: "add" | "replace" | "remove";
  path: string;
  keys: string[];
  value: unknown;
};

/** Array positions compare as numbers. "-" (append) is after every index. */
function compareKey(left: string, right: string): number {
  const position = (key: string) =>
    key === "-" ? Number.POSITIVE_INFINITY : /^(0|[1-9][0-9]*)$/u.test(key) ? Number(key) : null;
  const [a, b] = [position(left), position(right)];
  if (a !== null && b !== null) return a - b;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Every edit path addresses the base proposal. Edits apply from the last document position to
 * the first, and a deeper path applies before its ancestor, so that no edit moves the target of
 * another edit. At one path, a replace or a remove applies before the adds, and the adds keep
 * their given order.
 */
function applicationOrder(edits: readonly Edit[]): Edit[] {
  return edits
    .map((edit, index) => ({ edit, index }))
    .sort((left, right) => {
      const [a, b] = [left.edit.keys, right.edit.keys];
      for (let key = 0; key < Math.min(a.length, b.length); key++) {
        const order = compareKey(a[key]!, b[key]!);
        if (order !== 0) return -order;
      }
      if (a.length !== b.length) return b.length - a.length;
      const adds = Number(left.edit.op === "add") - Number(right.edit.op === "add");
      return adds !== 0 ? adds : right.index - left.index;
    })
    .map(({ edit }) => edit);
}

/** Basalt kept the base, because it could not apply the edits of a correction. */
export class CorrectionNotApplied extends Error {
  constructor(reason: string) {
    super(`Basalt did not apply your edits, so the base did not change: ${reason}`);
    this.name = "CorrectionNotApplied";
  }
}

/** Apply to a clone; callers must decode and fully validate the resulting proposal. */
export function applyCorrection(part: CorrectionPart, base: unknown, raw: unknown): unknown {
  const name = PART_NAMES[part];
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${name} correction must contain objects`);
    return value as Record<string, unknown>;
  };
  const correction = record(raw);
  assertExactRecordKeys(correction, ["baseHash", "edits"], `${name.toLowerCase()} correction`);
  if (correction.baseHash !== hashJson(base)) throw new Error(`${name} correction base changed`);
  if (!Array.isArray(correction.edits) || !correction.edits.length || correction.edits.length > 32)
    throw new Error(`${name} correction requires one to 32 edits`);
  const roots = CORRECTION_ROOTS[part] as readonly string[];
  const edits = correction.edits.flatMap((rawEdit, index): Edit[] => {
    const edit = { ...record(rawEdit) };
    const where = `${name} correction edit ${index} (${String(edit.op)} ${String(edit.path)})`;
    // A field that names a part of the proposal is a separate replacement of that part.
    const parts = Object.keys(edit).filter((key) => roots.includes(key));
    const replacements = parts.map((key): Edit => ({
      index,
      op: Object.hasOwn(record(base), key) ? "replace" : "add",
      path: `/${key}`,
      keys: [key],
      value: edit[key],
    }));
    for (const key of parts) delete edit[key];
    // As in JSON Patch, a remove can omit its value.
    if (edit.op === "remove" && !Object.hasOwn(edit, "value")) edit.value = null;
    const missing = ["op", "path", "value"].filter((key) => !Object.hasOwn(edit, key));
    const extra = Object.keys(edit).filter((key) => !["op", "path", "value"].includes(key));
    if (missing.length || extra.length)
      throw new Error(
        `${where}: an edit has exactly the fields op, path and value; missing [${missing.join(", ")}]; extra [${extra.join(", ")}]`,
      );
    if (!["add", "replace", "remove"].includes(String(edit.op)))
      throw new Error(`${where}: op must be add, replace or remove`);
    if (
      typeof edit.path !== "string" ||
      edit.path.length > 1024 ||
      !edit.path.startsWith("/") ||
      /~(?![01])/u.test(edit.path)
    )
      throw new Error(`${where}: path must be a JSON Pointer`);
    const keys = edit.path
      .slice(1)
      .split("/")
      .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
    // A remove can also delete an extra top-level field, which the shape check reports.
    const extraField =
      edit.op === "remove" && keys.length === 1 && Object.hasOwn(record(base), keys[0]!);
    if (
      (!roots.includes(keys[0]!) && !extraField) ||
      keys.some((key) => !key || ["__proto__", "prototype", "constructor"].includes(key))
    )
      throw new Error(`${where}: path must stay within ${roots.join(", ")}`);
    if (edit.op === "remove" && edit.value !== null)
      throw new Error(`${where}: a remove must use the value null`);
    return [
      { index, op: edit.op as Edit["op"], path: edit.path, keys, value: edit.value },
      ...replacements,
    ];
  });
  const targets = new Set<string>();
  for (const edit of edits) {
    if (edit.op === "add") continue;
    if (targets.has(edit.path))
      throw new Error(
        `${name} correction has more than one replace or remove at ${edit.path}. Each path addresses the base proposal, so use one edit for one location`,
      );
    targets.add(edit.path);
  }
  const output = structuredClone(base);
  for (const edit of applicationOrder(edits)) {
    const where = `${name} correction edit ${edit.index} (${edit.op} ${edit.path})`;
    let parent: unknown = output;
    for (const key of edit.keys.slice(0, -1)) {
      if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key))
        throw new Error(
          `${where} traverses missing field ${key}` +
            (Array.isArray(parent)
              ? `; that array has ${parent.length} items, with indexes from 0 to ${parent.length - 1}`
              : parent && typeof parent === "object"
                ? `; the fields there are [${Object.keys(parent).sort().join(", ")}]`
                : ""),
        );
      if (Array.isArray(parent) && !/^(0|[1-9][0-9]*)$/u.test(key))
        throw new Error(`${where}: ${key} is not an array index`);
      parent = (parent as Record<string, unknown>)[key];
    }
    const key = edit.keys.at(-1)!;
    if (Array.isArray(parent)) {
      const index = key === "-" && edit.op === "add" ? parent.length : Number(key);
      if (
        (key !== "-" && !/^(0|[1-9][0-9]*)$/u.test(key)) ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index > parent.length ||
        (edit.op !== "add" && index === parent.length)
      )
        throw new Error(
          `${where}: the array has ${parent.length} items, so ${edit.op === "add" ? `an add can use indexes from 0 to ${parent.length} or -` : `the indexes are from 0 to ${parent.length - 1}`}`,
        );
      if (edit.op === "add") parent.splice(index, 0, structuredClone(edit.value));
      else if (edit.op === "remove") parent.splice(index, 1);
      else parent[index] = structuredClone(edit.value);
    } else {
      const target = record(parent);
      // For an object field, add and replace both set the field. A remove needs the field.
      if (edit.op === "remove" && !Object.hasOwn(target, key))
        throw new Error(
          `${where}: the field to remove is absent; parent fields are [${Object.keys(target).sort().join(", ")}]`,
        );
      if (edit.op === "remove") delete target[key];
      else target[key] = structuredClone(edit.value);
    }
  }
  return output;
}
