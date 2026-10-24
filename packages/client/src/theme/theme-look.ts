import type { AppLook } from "@openorc/protocol";
import { acceptedColors, overridesFor, type CustomColors, type TokenOverrides } from "./theme-custom.js";
import { themePresets, type Mode, type ThemePreset } from "./theme-palettes.js";

/** A look as a client paints it: a palette it has, and the overrides it accepts in each mode. */
export interface PaletteLook {
  preset: ThemePreset;
  overrides: Record<Mode, TokenOverrides>;
}

const modes: readonly Mode[] = ["light", "dark"];

/** What app settings carry of the desktop's theme: the palette on screen and the colors changed on it. */
export function lookOf(preset: ThemePreset, custom: CustomColors): AppLook {
  return { palette: preset, colors: custom[preset] ?? {} };
}

/** The default palette when there is no look, or its palette is one this client does not have, with its colors dropped. */
export function readLook(look: AppLook | null): PaletteLook {
  const preset = themePresets.find((candidate) => candidate.id === look?.palette)?.id;
  if (!look || !preset) return { preset: "openorc", overrides: { light: {}, dark: {} } };
  const custom = acceptedColors({ [preset]: look.colors });
  return { preset, overrides: { light: overridesFor(custom, preset, "light"), dark: overridesFor(custom, preset, "dark") } };
}

export function sameLook(a: AppLook | null, b: AppLook | null): boolean {
  if (!a || !b) return a === b;
  const entries = (colors: TokenOverrides | undefined) => JSON.stringify(Object.entries(colors ?? {}).sort(([x], [y]) => (x < y ? -1 : 1)));
  return a.palette === b.palette && modes.every((mode) => entries(a.colors[mode]) === entries(b.colors[mode]));
}
