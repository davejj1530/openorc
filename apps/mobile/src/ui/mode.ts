import { useUniwind } from "uniwind";
import { colors } from "../generated/tokens";

export type Mode = keyof typeof colors;

/** The appearance on screen. The app follows the system; Uniwind switches every class with it. */
export function useMode(): Mode {
  return useUniwind().theme;
}

/** Palette values for places classes cannot reach: native screen options, SVG paints, Reanimated. */
export function useColors(): (typeof colors)[Mode] {
  return colors[useMode()];
}
