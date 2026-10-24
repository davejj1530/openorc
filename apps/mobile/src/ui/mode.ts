import { useSyncExternalStore } from "react";
import { useUniwind } from "uniwind";
import { currentLook, subscribeLook, type Palette } from "../look/look";

export type Mode = "light" | "dark";
export type { Palette };

/** The appearance on screen. The app follows the system; Uniwind switches every class with it. */
export function useMode(): Mode {
  return useUniwind().theme;
}

/** The colors on screen, the shown Mac's palette in the current appearance, for places classes cannot reach. */
export function useColors(): Palette {
  return useSyncExternalStore(subscribeLook, currentLook).colors[useMode()];
}
