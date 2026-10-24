import { themePresets, type Mode, type ThemePreset } from "@openorc/client/theme";
import { paintPalette, resolveColor, toHex, type Declarations, type Hex } from "../../src/look/paint.ts";

export type { Declarations, Hex };
/** The two `:root` rules of app.css that every palette sits on: the light defaults and the dark overrides. */
export type Cascade = { root: Declarations; dark: Declarations };

// Not colors: widths, images and shadows stay with the desktop's CSS.
const notColors = new Set(["--hairline", "--surface-gradient", "--shadow-overlay"]);
// These change with the ground a control sits on (DESIGN.md, the Contextual Fill Rule), so the phone names its fills directly.
const contextualFills = new Set(["--current-row-fill", "--control-fill", "--float-fill"]);

const lchPattern = /lch\(([^)]*)\)/gi;
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

function colors(declarations: Declarations): Record<string, string> {
  return Object.fromEntries(Object.entries(declarations).flatMap(([name, value]) => (notColors.has(name) || contextualFills.has(name) ? [] : [[name, normalized(value)]])));
}

/** app.css's colors in a mode: its `:root` rule, with the dark one over it in dark. */
export function stylesheetColors(cascade: Cascade, mode: Mode): Record<string, string> {
  return colors(mode === "dark" ? { ...cascade.root, ...cascade.dark } : cascade.root);
}

/** One palette's own properties in a mode, which the phone paints over the stylesheet's at runtime. */
export function paletteColors(preset: ThemePreset, mode: Mode): Record<string, string> {
  const template = themePresets.find((candidate) => candidate.id === preset);
  if (!template) throw new Error(`Unknown palette ${preset}`);
  return colors(template.colors[mode]);
}

/** One palette in one mode with nothing changed on it, as the desktop paints it. */
export function resolvePalette(preset: ThemePreset, mode: Mode, cascade: Cascade): Record<string, Hex> {
  return paintPalette(paletteColors(preset, mode), stylesheetColors(cascade, mode));
}
