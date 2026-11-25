import { themePresets, type Mode, type ThemePreset } from "@openorc/client/theme";
import { paintPalette, resolveColor, toHex, type Declarations, type Hex } from "../../src/look/paint.ts";

export type { Declarations, Hex };
/** The two `:root` rules of app.css that every palette sits on: the light defaults and the dark overrides. */
export type Cascade = { root: Declarations; dark: Declarations };

// These change with the ground a control sits on (DESIGN.md, the Contextual Fill Rule), so the phone names its fills directly.
const contextualFills = new Set(["--current-row-fill", "--control-fill", "--float-fill"]);

const lchPattern = /lch\(([^)]*)\)/gi;
const hexPattern = /^#[0-9a-f]{3,8}$/i;
const referencePattern = /^var\(\s*(--[a-z0-9-]+)\s*(?:,\s*(.+))?\)$/i;
// Every CSS color function, the ones the painter cannot resolve too, so an unsupported color fails there instead of
// going missing here.
const colorFunctions = new Set(["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix"]);

/** The function's name when the whole value is one call, such as `lch(...)`; null for a list, a keyword or a length. */
function soleCall(value: string): string | null {
  const open = value.indexOf("(");
  if (open < 1 || !value.endsWith(")")) return null;
  let depth = 0;
  for (let index = open; index < value.length - 1; index++) {
    if (value[index] === "(") depth++;
    else if (value[index] === ")" && --depth === 0) return null;
  }
  return value.slice(0, open).toLowerCase();
}

/**
 * Whether a property holds a color, read from its value: a hex, one color function, or a reference to a property that
 * holds one. Widths, shadows, images and filters are none of these and stay with the desktop's CSS. An empty value
 * unsets a property and says nothing of its kind, so it passes.
 */
function isColor(value: string, scope: Declarations, seen: readonly string[] = []): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || hexPattern.test(trimmed)) return true;
  const reference = referencePattern.exec(trimmed);
  if (reference) {
    const [, name, fallback] = reference as unknown as [string, string, string | undefined];
    const target = seen.includes(name) ? undefined : scope[name] || fallback;
    if (!target) throw new Error(`${name} is not defined or names itself (in ${value})`);
    return isColor(target, scope, [...seen, name]);
  }
  const call = soleCall(trimmed);
  return call !== null && colorFunctions.has(call);
}

// CSS Color 4: Lab is relative to D50; sRGB to D65, reached through Bradford adaptation.
const d50 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585] as const;
const d50ToD65 = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
] as const;
const xyzToLinearSrgb = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
] as const;
const times = (matrix: readonly (readonly number[])[], vector: readonly number[]) => matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index]!, 0));

function component(token: string | undefined, percent: number, value: string): number {
  const match = token && /^(-?\d*\.?\d+)(%|deg)?$/.exec(token);
  if (!match) throw new Error(`Unsupported lch(): ${value}`);
  return match[2] === "%" ? (Number(match[1]) / 100) * percent : Number(match[1]);
}

/** `lch(L C H / A)` in sRGB, clipped to its gamut as Chromium paints it, so the phone draws what the desktop shows. */
export function lchToHex(value: string): Hex {
  const body = /^lch\(([^)]*)\)$/i.exec(value.trim())?.[1];
  if (body === undefined) throw new Error(`Unsupported lch(): ${value}`);
  const [channels, alpha] = body.split("/").map((part) => part.trim()) as [string, string | undefined];
  const [lightness, chroma, hue] = channels.split(/\s+/);
  const l = component(lightness, 100, value);
  const c = component(chroma, 150, value);
  const h = (component(hue, 360, value) * Math.PI) / 180;
  const [a, b] = [c * Math.cos(h), c * Math.sin(h)];
  const kappa = 24389 / 27;
  const epsilon = 216 / 24389;
  const fy = (l + 16) / 116;
  const [fx, fz] = [a / 500 + fy, fy - b / 200];
  const lab = [fx ** 3 > epsilon ? fx ** 3 : (116 * fx - 16) / kappa, l > kappa * epsilon ? fy ** 3 : l / kappa, fz ** 3 > epsilon ? fz ** 3 : (116 * fz - 16) / kappa];
  const linear = times(
    xyzToLinearSrgb,
    times(
      d50ToD65,
      lab.map((value, index) => value * d50[index]!),
    ),
  );
  const gamma = (value: number) => Math.sign(value) * (Math.abs(value) <= 0.0031308 ? 12.92 * Math.abs(value) : 1.055 * Math.abs(value) ** (1 / 2.4) - 0.055);
  const [r, g, bl] = linear.map((value) => Math.min(1, Math.max(0, gamma(value))) * 255) as [number, number, number];
  return toHex({ r, g, b: bl, a: alpha === undefined ? 1 : Math.min(1, Math.max(0, component(alpha, 1, value))) });
}

/** A value the phone resolves at runtime: lch() written as hex, and one that names no other property resolved outright. */
function normalized(value: string): string {
  if (value === "") return value;
  const plain = value.replace(lchPattern, (lch) => lchToHex(lch));
  return /var\(/i.test(plain) ? plain : toHex(resolveColor(plain, {}));
}

/** The colors among the declarations, whose references are read against `scope`: every property in force where they apply. */
function colors(declarations: Declarations, scope: Declarations): Record<string, string> {
  return Object.fromEntries(Object.entries(declarations).flatMap(([name, value]) => (contextualFills.has(name) || !isColor(value, scope) ? [] : [[name, normalized(value)]])));
}

const inMode = (cascade: Cascade, mode: Mode): Declarations => (mode === "dark" ? { ...cascade.root, ...cascade.dark } : cascade.root);

/** app.css's colors in a mode: its `:root` rule, with the dark one over it in dark. */
export function stylesheetColors(cascade: Cascade, mode: Mode): Record<string, string> {
  const sheet = inMode(cascade, mode);
  return colors(sheet, sheet);
}

/** One palette's own properties in a mode, which the phone paints over the stylesheet's at runtime. */
export function paletteColors(preset: ThemePreset, mode: Mode, cascade: Cascade): Record<string, string> {
  const template = themePresets.find((candidate) => candidate.id === preset);
  if (!template) throw new Error(`Unknown palette ${preset}`);
  return colors(template.colors[mode], { ...inMode(cascade, mode), ...template.colors[mode] });
}

/** One palette in one mode with nothing changed on it, as the desktop paints it. */
export function resolvePalette(preset: ThemePreset, mode: Mode, cascade: Cascade): Record<string, Hex> {
  return paintPalette(paletteColors(preset, mode, cascade), stylesheetColors(cascade, mode));
}
