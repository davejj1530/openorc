import { readLook, type Mode, type ThemePreset } from "@openorc/client/theme";
import type { AppLook, AppSettings } from "@openorc/protocol";
import type { QueryCache } from "@tanstack/react-query";
import { Uniwind } from "uniwind";
import { palettes, stylesheet } from "../generated/palettes";
import { colors, type ColorToken } from "../generated/tokens";
import { paintPalette } from "./paint";

/** One mode's colors by token, for places classes cannot reach: native screen options, SVG paints, Reanimated. */
export type Palette = Record<ColorToken, string>;

/** The palette the phone paints with, and its colors in each mode. */
export interface Look {
  preset: ThemePreset;
  colors: Record<Mode, Palette>;
}

const modes: readonly Mode[] = ["light", "dark"];
let current: Look = { preset: "openorc", colors };
const listeners = new Set<() => void>();

/** A Mac's look as this phone paints it; the default palette for none, or for a palette this phone does not have. */
function lookFor(look: AppLook | null): Look {
  const { preset, overrides } = readLook(look);
  const paint = (mode: Mode) => paintPalette(palettes[preset][mode], stylesheet[mode], overrides[mode]) as Palette;
  return { preset, colors: { light: paint("light"), dark: paint("dark") } };
}

/** Paints the phone with a Mac's look, or the default for none: every class through Uniwind's variables, and `useColors`. */
export function applyLook(look: AppLook | null): void {
  const next = lookFor(look);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  for (const mode of modes) Uniwind.updateCSSVariables(mode, Object.fromEntries(Object.entries(next.colors[mode]).map(([token, value]) => [`--color-${token}`, value])));
  listeners.forEach((listener) => listener());
}

export const currentLook = (): Look => current;

export function subscribeLook(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Paints whatever the cache holds of the shown Mac's `app.settings.get`: kept from the last launch (so a cold start
 * paints that Mac's look before it answers), answered, refetched after the Mac changes it, or gone when the phone
 * shows another Mac or none.
 */
export function followMacLook(cache: QueryCache): () => void {
  return cache.subscribe((event) => {
    if (event.query.queryKey[0] !== "app.settings.get") return;
    if (event.type === "removed") applyLook(null);
    else if (event.type === "updated" && event.action.type === "success") applyLook((event.query.state.data as AppSettings).look);
  });
}
