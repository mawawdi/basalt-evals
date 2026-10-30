import { isRecord } from "../../contracts/src/validation.js";

type Schema = Record<string, unknown>;

/** The limits that OpenAI publishes for one strict schema. */
const STRICT_SCHEMA_LIMITS = {
  objectNesting: 10,
  properties: 5_000,
  enumValues: 1_000,
  /** The total length of all property names and all string enum values. */
  stringLength: 120_000,
  /** One enum with more values than this has a smaller limit for its string length. */
  largeEnumValues: 250,
  largeEnumStringLength: 15_000,
} as const;

const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

/** Keywords that strict mode accepts. The transform keeps them on the wire. */
const KEPT = new Set([
  "type",
  "description",
  "enum",
  "anyOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
]);

/**
 * Bound keywords that strict mode does not accept, in the sequence of their sentences. The
 * transform removes them from the wire schema and writes each one into the description of its
 * field, so the model still knows the bound. The local validators keep the declared schema and
 * still check each of them.
 */
const BOUNDS: ReadonlyArray<[string, (value: unknown, schema: Schema) => string | null]> = [
  ["minimum", (value) => `The value is ${String(value)} or more.`],
  ["exclusiveMinimum", (value) => `The value is more than ${String(value)}.`],
  ["maximum", (value) => `The value is ${String(value)} or less.`],
  ["exclusiveMaximum", (value) => `The value is less than ${String(value)}.`],
  ["multipleOf", (value) => `The value is a multiple of ${String(value)}.`],
  ["minLength", (value) => `The text has ${String(value)} or more characters.`],
  ["maxLength", (value) => `The text has ${String(value)} or fewer characters.`],
  ["pattern", (value) => `The text matches the regular expression \`${String(value)}\`.`],
  ["format", (value) => `The text has the format ${String(value)}.`],
  ["minItems", (value) => `The list has ${String(value)} or more items.`],
  ["maxItems", (value) => `The list has ${String(value)} or fewer items.`],
  ["uniqueItems", (value) => (value === true ? "All items in the list are different." : null)],
  [
    "contains",
    (value, schema) => {
      const least = String(schema.minContains ?? 1);
      const count =
        schema.maxContains === undefined
          ? `${least} or more items`
          : `From ${least} to ${String(schema.maxContains)} items`;
      return `${count} in the list match this schema: ${JSON.stringify(value)}.`;
    },
  ],
  ["minProperties", (value) => `The object has ${String(value)} or more properties.`],
  ["maxProperties", (value) => `The object has ${String(value)} or fewer properties.`],
];

/**
 * Keywords that strict mode does not accept. The transform removes them from the wire schema
 * only. The bounds among them go into the description. `minContains` and `maxContains` go into
 * the sentence of `contains`. The other keywords are notes that do not limit a value.
 */
const REMOVED = new Set([
  ...BOUNDS.map(([key]) => key),
  "minContains",
  "maxContains",
  "default",
  "examples",
  "title",
  "$comment",
  "$schema",
  "readOnly",
  "writeOnly",
  "deprecated",
]);

interface Totals {
  properties: number;
  enumValues: number;
  stringLength: number;
}

/**
 * Make the wire schema of a strict tool with one fixed, pure transform of its declared schema.
 * `oneOf` becomes `anyOf`, and `const` becomes an `enum` with one value. The transform removes
 * the constraints that strict mode does not accept, and it writes each removed bound into the
 * description of its field. It refuses a schema that strict mode cannot express, and the error
 * names the location of the problem.
 */
export function strictToolWireSchema(schema: unknown): Schema {
  if (!isRecord(schema) || schema.type !== "object")
    refuse("#", "is not an object schema. The root of a strict tool schema must be an object");
  const totals: Totals = { properties: 0, enumValues: 0, stringLength: 0 };
  const wire = strictNode(schema, "#", 0, totals);
  if (totals.properties > STRICT_SCHEMA_LIMITS.properties)
    refuse(
      "#",
      `has ${totals.properties} object properties. Strict mode accepts ${STRICT_SCHEMA_LIMITS.properties} or fewer`,
    );
  if (totals.enumValues > STRICT_SCHEMA_LIMITS.enumValues)
    refuse(
      "#",
      `has ${totals.enumValues} enum values. Strict mode accepts ${STRICT_SCHEMA_LIMITS.enumValues} or fewer`,
    );
  if (totals.stringLength > STRICT_SCHEMA_LIMITS.stringLength)
    refuse(
      "#",
      `has ${totals.stringLength} characters in property names and enum values. Strict mode accepts ${STRICT_SCHEMA_LIMITS.stringLength} or fewer`,
    );
  return wire;
}

/** `depth` is the number of object schemas that contain this schema. */
function strictNode(value: unknown, location: string, depth: number, totals: Totals): Schema {
  if (!isRecord(value)) refuse(location, "is not a JSON Schema object");
  const keys = Object.keys(value);
  if (keys.length === 0) refuse(location, "is empty");
  for (const key of keys)
    if (!KEPT.has(key) && !REMOVED.has(key) && key !== "oneOf" && key !== "const")
      refuse(location, `uses the keyword ${key}, which strict mode does not accept`);
  if ("anyOf" in value && "oneOf" in value) refuse(location, "has both anyOf and oneOf");
  if ("enum" in value && "const" in value) refuse(location, "has both enum and const");
  const alternatives = "anyOf" in value ? "anyOf" : "oneOf" in value ? "oneOf" : null;
  if (alternatives !== null) {
    for (const key of [
      "type",
      "enum",
      "const",
      "properties",
      "required",
      "additionalProperties",
      "items",
    ])
      if (key in value) refuse(location, `combines ${alternatives} with ${key}`);
  } else if (!("type" in value) && !("enum" in value) && !("const" in value))
    refuse(location, "has no type, enum or anyOf");

  const types = schemaTypes(value.type, location);
  const object =
    types.includes("object") ||
    "properties" in value ||
    "required" in value ||
    "additionalProperties" in value;
  if (object && !types.includes("object"))
    refuse(location, "has object keywords without the object type");
  if ("items" in value && !types.includes("array"))
    refuse(location, "has items without the array type");
  if (types.includes("array") && !("items" in value)) refuse(location, "is an array without items");
  const level = object ? depth + 1 : depth;
  if (level > STRICT_SCHEMA_LIMITS.objectNesting)
    refuse(
      location,
      `is at object level ${level}. Strict mode accepts ${STRICT_SCHEMA_LIMITS.objectNesting} levels of object nesting or fewer`,
    );
  const names = object ? objectPropertyNames(value, location) : [];

  if ("description" in value && typeof value.description !== "string")
    refuse(location, "has a description that is not a string");
  const description = [
    ...("description" in value ? [value.description as string] : []),
    ...BOUNDS.flatMap(([key, sentence]) => (key in value ? [sentence(value[key], value)] : [])),
  ]
    .filter((text) => text !== null)
    .join(" ");

  // The wire schema keeps the key sequence of the declared schema. A field without its own
  // description gets the description of its bounds at the end.
  const wire: Schema = {};
  for (const [key, entry] of Object.entries(value)) {
    if (REMOVED.has(key)) continue;
    switch (key) {
      case "type":
        wire.type = entry;
        break;
      case "description":
        wire.description = description;
        break;
      case "enum":
        wire.enum = enumValues(entry, location, totals);
        break;
      case "const":
        wire.enum = enumValues([entry], location, totals);
        break;
      case "anyOf":
      case "oneOf":
        if (!Array.isArray(entry) || entry.length === 0)
          refuse(location, `has a ${key} that is not a list of schemas`);
        wire.anyOf = entry.map((branch, index) =>
          strictNode(branch, `${location}/${key}/${index}`, depth, totals),
        );
        break;
      case "properties": {
        const properties = entry as Schema;
        wire.properties = Object.fromEntries(
          names.map((name) => [
            name,
            strictNode(
              properties[name],
              `${location}/properties/${pointerToken(name)}`,
              level,
              totals,
            ),
          ]),
        );
        break;
      }
      case "required":
        wire.required = entry;
        break;
      case "additionalProperties":
        wire.additionalProperties = false;
        break;
      case "items":
        wire.items = strictNode(entry, `${location}/items`, level, totals);
        break;
    }
  }
  if (!("description" in wire) && description.length > 0) wire.description = description;
  totals.properties += names.length;
  for (const name of names) totals.stringLength += name.length;
  return wire;
}

function schemaTypes(value: unknown, location: string): string[] {
  if (value === undefined) return [];
  const types = typeof value === "string" ? [value] : value;
  if (
    !Array.isArray(types) ||
    types.length === 0 ||
    new Set(types).size !== types.length ||
    types.some((type) => typeof type !== "string" || !TYPES.has(type))
  )
    refuse(location, "has a type that is not a JSON Schema type or a list of distinct types");
  return types as string[];
}

/** An object must forbid other properties and must require each property that it declares. */
function objectPropertyNames(value: Schema, location: string): string[] {
  if (value.additionalProperties !== false)
    refuse(location, "is an object without additionalProperties: false");
  const properties = value.properties;
  if (properties === undefined) refuse(location, "is an object without properties");
  if (!isRecord(properties)) refuse(location, "has properties that are not an object");
  const required = value.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some((name) => typeof name !== "string") ||
    new Set(required).size !== required.length
  )
    refuse(location, "has a required list that is not a list of distinct names");
  const names = Object.keys(properties);
  const requiredNames = new Set<unknown>(required);
  for (const name of names)
    if (!requiredNames.has(name))
      refuse(location, `is an object whose property ${name} is not in required`);
  for (const name of required as string[])
    if (!Object.hasOwn(properties, name))
      refuse(location, `requires ${name}, which is not a property`);
  return names;
}

function enumValues(value: unknown, location: string, totals: Totals): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => item !== null && !["string", "number", "boolean"].includes(typeof item))
  )
    refuse(
      location,
      "has an enum or const that is not a list of strings, numbers, booleans or null",
    );
  const length = value.reduce<number>(
    (sum, item) => sum + (typeof item === "string" ? item.length : 0),
    0,
  );
  if (
    value.length > STRICT_SCHEMA_LIMITS.largeEnumValues &&
    length > STRICT_SCHEMA_LIMITS.largeEnumStringLength
  )
    refuse(
      location,
      `has ${value.length} enum values with ${length} characters. Strict mode accepts ${STRICT_SCHEMA_LIMITS.largeEnumStringLength} characters or fewer in an enum with more than ${STRICT_SCHEMA_LIMITS.largeEnumValues} values`,
    );
  totals.enumValues += value.length;
  totals.stringLength += length;
  return [...value];
}

/** One reference token of a JSON Pointer (RFC 6901). */
function pointerToken(name: string): string {
  return name.replaceAll("~", "~0").replaceAll("/", "~1");
}

function refuse(location: string, problem: string): never {
  throw new Error(`The schema at ${location} ${problem}.`);
}
