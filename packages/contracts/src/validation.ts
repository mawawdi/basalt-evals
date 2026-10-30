/** Strict, shared boundary primitives. Objects never silently discard extra fields. */
export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function fields(value: unknown, keys: readonly string[], label: string) {
  const record = object(value, label);
  if (Object.keys(record).sort().join() !== [...keys].sort().join())
    throw new Error(`${label} has invalid fields`);
  return record;
}
export function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new Error(`${label} must contain 1 to ${maximum} characters.`);
  return value;
}
export function hash(value: unknown, label = "Content identity"): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error(`Invalid ${label}`);
  return value;
}
export function identity(value: unknown, label = "Record identity"): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,100}$/u.test(value))
    throw new Error(`Invalid ${label}`);
  return value;
}
export function money(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("The spending limit must be a number that is 0 or more.");
  return value;
}
export function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}
export function identifiers(
  value: unknown,
  maximum: number,
  label: string,
  content = false,
): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > maximum ||
    new Set(value).size !== value.length
  )
    throw new Error(`${label} needs between one and ${maximum} distinct identities`);
  return value.map((id) => (content ? hash(id, label) : identity(id, label)));
}
/** Small shared validation primitives; domain validators own their own rules. */
export function fail(label: string): never {
  throw new Error(`Invalid ${label}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function launchIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/u.test(value))
    throw new Error("Invalid launch identity");
  return value;
}

export function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function assertExactRecordKeys(
  value: Record<string, unknown>,
  keys: string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    const missing = expected.filter((key) => !actual.includes(key));
    const unexpected = actual.filter((key) => !expected.includes(key));
    const bounded = (items: string[]) =>
      items
        .slice(0, 8)
        .map((item) => item.slice(0, 80))
        .join(", ");
    throw new Error(
      `Invalid ${label}: missing [${bounded(missing)}]; unexpected [${bounded(unexpected)}]`,
    );
  }
}
