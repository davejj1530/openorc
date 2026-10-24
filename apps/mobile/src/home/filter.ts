import type { SidebarFilter } from "@openorc/client";
import { useSyncExternalStore } from "react";
import { storage } from "../client";

/**
 * Which threads Home lists, as the desktop sidebar's filter: orcmode's working set, every active thread, or the
 * archive; `pinnedOnly` narrows the active ones to pins. The filter is kept on the phone across launches; pinned-only
 * is not, as on the desktop.
 */
export interface HomeFilter {
  filter: SidebarFilter;
  pinnedOnly: boolean;
}

export type FilterChoice = SidebarFilter | "pinned";

export const FILTER_CHOICES: readonly { choice: FilterChoice; label: string }[] = [
  { choice: "orc", label: "Orcmode" },
  { choice: "active", label: "Active threads" },
  { choice: "archived", label: "Archived threads" },
  { choice: "pinned", label: "Pinned threads" },
];

const KEY = "home.filter";
const listeners = new Set<() => void>();
let shown: HomeFilter = { filter: readFilter(), pinnedOnly: false };

function readFilter(): SidebarFilter {
  const saved = storage.getString(KEY);
  return saved === "orc" || saved === "archived" ? saved : "active";
}

export const filterChoice = ({ filter, pinnedOnly }: HomeFilter): FilterChoice => (pinnedOnly ? "pinned" : filter);

/** Chooses what Home lists. Pinned threads are the active ones narrowed, so choosing them keeps the filter on Active. */
export function chooseFilter(choice: FilterChoice): void {
  shown = choice === "pinned" ? { filter: "active", pinnedOnly: true } : { filter: choice, pinnedOnly: false };
  if (shown.filter === "active") storage.remove(KEY);
  else storage.set(KEY, shown.filter);
  listeners.forEach((listener) => listener());
}

export function useHomeFilter(): HomeFilter {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => shown,
  );
}
