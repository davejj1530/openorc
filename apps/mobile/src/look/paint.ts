import { resolveAccentColors } from "@openorc/client/theme";

/*
 * How a palette paints without a browser. design-sync uses it to write the default palette, and the phone to paint the
 * Mac's palette and colors at runtime, so both resolve exactly as the desktop's stylesheet does.
 */

/** Custom properties as authored, keyed with their leading dashes. */
export type Declarations = Readonly<Record<string, string>>;
export type Hex = `#${string}`;

type Rgba = { r: number; g: number; b: number; a: number };

const hexPattern = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;
const varPattern = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*(.+))?\)$/i;
const mixPattern = /^color-mix\((.+)\)$/i;

function parseHex(value: string): Rgba | null {
  const match = hexPattern.exec(value);
  if (!match) return null;
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(match[1]!.slice(offset, offset + 2), 16)) as [number, number, number];
  return { r, g, b, a: match[2] ? parseInt(match[2], 16) / 255 : 1 };
}

export function toHex({ r, g, b, a }: Rgba): Hex {
  const byte = (channel: number) => Math.round(channel).toString(16).padStart(2, "0");
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a * 255) : ""}`;
}

/** Splits a function's arguments at top-level commas, keeping nested calls whole. */
function splitArguments(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(body.slice(start).trim());
  return parts;
}

function mixOperand(operand: string): { color: string; weight: number | null } {
  const match = /^(.*\S)\s+(\d+(?:\.\d+)?)%$/.exec(operand);
  return match ? { color: match[1]!, weight: Number(match[2]) / 100 } : { color: operand, weight: null };
}

/** `color-mix(in srgb, a p%, b)` between opaque colors, as CSS Color 5 defines it. Anything else fails. */
function mix(body: string, resolve: (value: string) => Rgba, value: string): Rgba {
  const [space, ...operands] = splitArguments(body);
  if (space !== "in srgb" || operands.length !== 2) throw new Error(`Unsupported color-mix: ${value}`);
  const [first, second] = operands.map(mixOperand) as [ReturnType<typeof mixOperand>, ReturnType<typeof mixOperand>];
  const firstWeight = first.weight ?? (second.weight === null ? 0.5 : 1 - second.weight);
  const secondWeight = second.weight ?? 1 - firstWeight;
  if (Math.abs(firstWeight + secondWeight - 1) > 1e-9) throw new Error(`color-mix weights must add up to 100%: ${value}`);
  const [a, b] = [resolve(first.color), resolve(second.color)] as [Rgba, Rgba];
  if (a.a < 1 || b.a < 1) throw new Error(`color-mix of a translucent color is not supported: ${value}`);
  const channel = (key: "r" | "g" | "b") => a[key] * firstWeight + b[key] * secondWeight;
  return { r: channel("r"), g: channel("g"), b: channel("b"), a: 1 };
}

/** Resolves hex, 8-digit hex, `var()` and srgb `color-mix()` against the declarations. Any other syntax fails. */
export function resolveColor(value: string, declarations: Declarations, seen: readonly string[] = []): Rgba {
  const trimmed = value.trim();
  const hex = parseHex(trimmed);
  if (hex) return hex;
  const reference = varPattern.exec(trimmed);
  if (reference) {
    const [, name, fallback] = reference as unknown as [string, string, string | undefined];
    if (seen.includes(name)) throw new Error(`Circular color reference: ${[...seen, name].join(" -> ")}`);
    const target = declarations[name] || fallback;
    if (!target) throw new Error(`${name} is not defined (in ${value})`);
    return resolveColor(target, declarations, [...seen, name]);
  }
  const mixed = mixPattern.exec(trimmed);
  if (mixed) return mix(mixed[1]!, (operand) => resolveColor(operand, declarations, seen), value);
  throw new Error(`Unsupported color syntax: ${value}`);
}

/** Empty values mean "unset", as `style.setProperty(name, "")` does on the desktop. */
function withoutEmpty(declarations: Declarations): Declarations {
  return Object.fromEntries(Object.entries(declarations).filter(([, value]) => value !== ""));
}

/**
 * One palette in one mode with a person's overrides, as the desktop paints it: the stylesheet's colors, with the
 * palette's properties and the overrides applied over them by `resolveAccentColors`, exactly as lib/theme.ts does.
 * References stay live until the end, so an override reaches every color that names it. Keys drop their dashes; values
 * are `#rrggbb`, or `#rrggbbaa` when translucent.
 */
export function paintPalette(authored: Declarations, stylesheet: Declarations, overrides: Declarations = {}): Record<string, Hex> {
  const context = { ...stylesheet, ...withoutEmpty(authored), ...overrides };
  const toHexOf = (color: string | undefined) => (color ? toHex(resolveColor(color, context)) : null);
  const painted = { ...stylesheet, ...withoutEmpty(resolveAccentColors(authored, overrides, toHexOf)) };
  return Object.fromEntries(
    Object.keys(painted)
      .sort()
      .map((name) => [name.slice(2), toHex(resolveColor(painted[name]!, painted))]),
  );
}
