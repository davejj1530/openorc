/** Small runtime checks for values that arrive from the other end. */
export type Check = (value: unknown) => boolean;
export type Fields = Record<string, Check>;

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const text =
  (max: number): Check =>
  (value) =>
    typeof value === "string" && value.length > 0 && value.length <= max;
export const anyText: Check = (value) => typeof value === "string";
export const count: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 0;
export const present: Check = () => true;
export const oneOf =
  (...values: string[]): Check =>
  (value) =>
    typeof value === "string" && values.includes(value);
export const list =
  (item: Check, max: number): Check =>
  (value) =>
    Array.isArray(value) && value.length <= max && value.every(item);

/** Exactly these keys: every required one, any optional one, nothing else. */
export function shape(required: Fields, optional: Fields = {}): Check {
  return (value) =>
    isRecord(value) &&
    Object.keys(value).every((key) => Object.hasOwn(required, key) || Object.hasOwn(optional, key)) &&
    Object.entries(required).every(([key, check]) => Object.hasOwn(value, key) && check(value[key])) &&
    Object.entries(optional).every(([key, check]) => !Object.hasOwn(value, key) || check(value[key]));
}

export function variants(tag: string, table: Record<string, Check>): Check {
  return (value) => {
    if (!isRecord(value)) return false;
    const kind = value[tag];
    return typeof kind === "string" && Object.hasOwn(table, kind) && table[kind]!(value);
  };
}
