import { useSyncExternalStore } from "react";
import { storage } from "../client";

/**
 * Which threads Home lists, as the desktop sidebar's filter: every thread, or with `pinnedOnly` only the pinned ones.
 * Resolved threads sit in their own part at the foot, not behind a filter. Pinned-only is not kept across launches, as on
 * the desktop.
 */
export interface HomeFilter {
  pinnedOnly: boolean;
}

export type FilterChoice = "all" | "pinned";

export const FILTER_CHOICES: readonly { choice: FilterChoice; label: string }[] = [
  { choice: "all", label: "All threads" },
  { choice: "pinned", label: "Pinned threads" },
];

/** Where the archive filter kept its choice, before Resolved took its place. */
const KEY = "home.filter";
storage.remove(KEY);

const listeners = new Set<() => void>();
let shown: HomeFilter = { pinnedOnly: false };

export const filterChoice = ({ pinnedOnly }: HomeFilter): FilterChoice => (pinnedOnly ? "pinned" : "all");

export function chooseFilter(choice: FilterChoice): void {
  shown = { pinnedOnly: choice === "pinned" };
  // Touches the demo's scratch storage, so a choice made in the demo goes when it ends.
  storage.remove(KEY);
  listeners.forEach((listener) => listener());
}

// A filter chosen in the demo goes with it, as on a fresh install.
storage.onDropped(() => {
  shown = { pinnedOnly: false };
  listeners.forEach((listener) => listener());
});

export function useHomeFilter(): HomeFilter {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => shown,
  );
}
