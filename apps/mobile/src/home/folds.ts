import { liveSidebarFold, pruneThreadFolds, toggleSidebarFold, toggleThreadTree } from "@openorc/client";
import { useSyncExternalStore } from "react";
import { shownMacId, storage } from "../client";
import { foldsKey } from "./fold-keys";

/*
 * Which of Home's parts the reader folded, per host, in the desktop sidebar's keys (days, the list's pinned and snoozed
 * parts, sub thread trees). The desktop keeps its folds on the Mac's own screen and does not sync them, so neither does
 * this. Keys of the project groups Home used to show are dropped as they are read.
 * Each function takes the host whose section it is (a scope's host), null for the shown one.
 */

const NONE: readonly string[] = [];
const listeners = new Set<() => void>();
/** The last saved value read per host, so the same keys come back as the same list. */
const read = new Map<string, { raw: string | undefined; collapsed: readonly string[] }>();
const hostOf = (host: string | null) => host ?? shownMacId();

function parse(raw: string | undefined): readonly string[] {
  if (raw === undefined) return NONE;
  try {
    const saved: unknown = JSON.parse(raw);
    return Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string" && liveSidebarFold(key)) : NONE;
  } catch {
    return NONE;
  }
}

/** A host's saved fold keys. */
export function savedFolds(host: string | null = null): readonly string[] {
  const macId = hostOf(host);
  if (!macId) return NONE;
  const raw = storage.getString(foldsKey(macId));
  const last = read.get(macId);
  if (last && last.raw === raw) return last.collapsed;
  const collapsed = parse(raw);
  read.set(macId, { raw, collapsed });
  return collapsed;
}

function save(host: string | null, next: (saved: readonly string[]) => readonly string[]): void {
  const macId = hostOf(host);
  if (!macId) return;
  const saved = savedFolds(macId);
  const changed = next(saved);
  if (changed === saved) return;
  storage.set(foldsKey(macId), JSON.stringify(changed));
  listeners.forEach((listener) => listener());
}

/** Folds or opens the section `key` names. */
export function toggleFold(key: string, host: string | null = null): void {
  save(host, (saved) => toggleSidebarFold(saved, key));
}

export function toggleThreadChildren(id: string, expanded: boolean, host: string | null = null): void {
  save(host, (saved) => toggleThreadTree(saved, id, expanded));
}

export function pruneMissingFolds(missing: ReadonlySet<string>, host: string | null = null): void {
  save(host, (saved) => {
    const next = pruneThreadFolds(saved, missing);
    return next.length === saved.length ? saved : next;
  });
}

export function useFolds(host: string | null = null): readonly string[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => savedFolds(host),
  );
}
