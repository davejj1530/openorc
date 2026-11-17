import { useSyncExternalStore } from "react";
import { shownMacId, storage } from "../client";
import { hiddenKey } from "./filter-keys";

/** In an organization: the person's own threads, or everyone's. */
export type Ownership = "mine" | "everyone";

/**
 * Which threads Home lists, as the desktop sidebar's filter: every thread, or with `pinnedOnly` only the pinned ones;
 * in an organization the person's own or everyone's (`ownership`, by space id, everyone's until chosen); and the
 * workspaces the person unticked (`hidden`, per Mac and per space), whose threads leave the list until ticked again. Resolved threads
 * sit in their own part at the foot, not behind a filter. Pinned-only and ownership are not kept across launches; the
 * workspaces are, as on the desktop.
 */
export interface HomeFilter {
  pinnedOnly: boolean;
  ownership: Readonly<Record<string, Ownership>>;
  /** By space id, or "mac" for a Mac with no account. */
  hidden: Readonly<Record<string, readonly string[]>>;
}

export type FilterChoice = "all" | "pinned";

export const FILTER_CHOICES: readonly { choice: FilterChoice; label: string }[] = [
  { choice: "all", label: "All threads" },
  { choice: "pinned", label: "Pinned threads" },
];

/** Where the archive filter kept its choice, before Resolved took its place. */
const KEY = "home.filter";
storage.remove(KEY);

/** The filter's key for a Mac with no account, whose list is its own. */
export const MAC_SCOPE = "mac";

const listeners = new Set<() => void>();
const told = () => listeners.forEach((listener) => listener());
const NONE: readonly string[] = [];
const NOTHING: Readonly<Record<string, readonly string[]>> = {};
let pinnedOnly = false;
let ownership: Readonly<Record<string, Ownership>> = {};

/** The shown Mac's unticked workspaces by space, the same object while the saved value is the same. */
let read: { raw: string | undefined; hidden: Readonly<Record<string, readonly string[]>> } = { raw: undefined, hidden: NOTHING };
function savedHidden(): Readonly<Record<string, readonly string[]>> {
  const macId = shownMacId();
  const raw = macId ? storage.getString(hiddenKey(macId)) : undefined;
  if (raw === read.raw) return read.hidden;
  const hidden: Record<string, readonly string[]> = {};
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (value && typeof value === "object" && !Array.isArray(value))
      for (const [scope, ids] of Object.entries(value)) if (Array.isArray(ids)) hidden[scope] = ids.filter((id): id is string => typeof id === "string");
  } catch {
    // A value no build wrote reads as nothing hidden.
  }
  read = { raw, hidden };
  return hidden;
}

function saveHidden(scope: string, ids: readonly string[]): void {
  const macId = shownMacId();
  if (!macId) return;
  storage.set(hiddenKey(macId), JSON.stringify({ ...savedHidden(), [scope]: ids }));
  told();
}

let shown: HomeFilter = { pinnedOnly, ownership, hidden: NOTHING };
function current(): HomeFilter {
  const hidden = savedHidden();
  if (shown.pinnedOnly !== pinnedOnly || shown.ownership !== ownership || shown.hidden !== hidden) shown = { pinnedOnly, ownership, hidden };
  return shown;
}

export const filterChoice = ({ pinnedOnly: pinned }: Pick<HomeFilter, "pinnedOnly">): FilterChoice => (pinned ? "pinned" : "all");

/** The workspaces unticked in a space ("mac" for a Mac with no account). */
export const hiddenIn = (filter: Pick<HomeFilter, "hidden">, scope: string): readonly string[] => filter.hidden[scope] ?? NONE;

/** Whose threads a space lists: everyone's until the person chooses their own. */
export const ownershipIn = (filter: Pick<HomeFilter, "ownership">, spaceId: string): Ownership => filter.ownership[spaceId] ?? "everyone";

export function chooseFilter(choice: FilterChoice): void {
  pinnedOnly = choice === "pinned";
  // Touches the demo's scratch storage, so a choice made in the demo goes when it ends.
  storage.remove(KEY);
  told();
}

export function chooseOwnership(spaceId: string, chosen: Ownership): void {
  ownership = { ...ownership, [spaceId]: chosen };
  told();
}

/** Ticks or unticks a workspace of a space on the shown Mac. */
export function toggleWorkspace(scope: string, id: string): void {
  const hidden = savedHidden()[scope] ?? NONE;
  saveHidden(scope, hidden.includes(id) ? hidden.filter((each) => each !== id) : [...hidden, id]);
}

/** Forgets a space's unticked workspaces that no longer exist, so one removed and added again shows. */
export function pruneHidden(scope: string, known: ReadonlySet<string>): void {
  const hidden = savedHidden()[scope] ?? NONE;
  if (!hidden.every((id) => known.has(id)))
    saveHidden(
      scope,
      hidden.filter((id) => known.has(id)),
    );
}

// A filter chosen in the demo goes with it, as on a fresh install.
storage.onDropped(() => {
  pinnedOnly = false;
  ownership = {};
  told();
});

export function useHomeFilter(): HomeFilter {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, current);
}

/** How many filters narrow the list, for the button and its name: pins, one's own threads, unticked workspaces. */
export function filterLabel(filter: HomeFilter, scope: string, organization: boolean): { narrowed: boolean; label: string } {
  const hidden = hiddenIn(filter, scope).length;
  const parts = [
    filter.pinnedOnly ? "Pinned threads" : null,
    organization && ownershipIn(filter, scope) === "mine" ? "Mine" : null,
    hidden ? `${hidden} ${hidden === 1 ? "workspace" : "workspaces"} hidden` : null,
  ].filter(Boolean);
  return { narrowed: parts.length > 0, label: parts.length ? `Show, ${parts.join(", ")}` : "Show" };
}
