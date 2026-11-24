import { router, type Href } from "expo-router";
import { createContext, useCallback, useContext } from "react";

/** The list's width beside what it opens: a phone's, which Home is drawn for. */
export const LIST_WIDTH = 375;

/** Whether a window this wide shows the list beside what it opens: once each of the two gets a phone's width. */
export const splits = (width: number): boolean => width >= 2 * LIST_WIDTH;

/** The side panel's least width beside a thread, the desktop's own least (`--width-panel-min`). */
const PANEL_MIN = 340;
const PANEL_MAX = 480;

/**
 * How wide a thread's side panel stands beside it in a window this wide: a share of what the list leaves, or nothing
 * while the thread would be left with less than a phone's width, as on an iPad held upright.
 */
export function panelWidth(width: number): number {
  const beside = width - LIST_WIDTH;
  if (!splits(width) || beside - PANEL_MIN < LIST_WIDTH) return 0;
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(beside * 0.42)));
}

const Split = createContext(false);

export const SplitProvider = Split.Provider;

/** Whether the window shows the list beside what it opens, as an iPad does, or one over the other, as a phone does. */
export const useSplit = (): boolean => useContext(Split);

/**
 * How the list opens a screen: beside it where the window splits, in place of whatever was open there, and over it
 * otherwise.
 */
export function useListOpen(): (href: Href) => void {
  const split = useSplit();
  return useCallback(
    (href: Href) => {
      if (split) router.dismissTo("/");
      router.push(href);
    },
    [split],
  );
}
