import { sidebarFoldKey, sidebarSectionOpen, toggleSidebarFold } from "@openorc/client";
import { useSyncExternalStore } from "react";
import { shownMacId, storage } from "../client";
import { foldsKey } from "./fold-keys";

/*
 * Which of Home's sections the reader folded, per Mac, in the desktop sidebar's keys (project:, pinned:,
 * snoozed-open:). The desktop keeps its folds on the Mac's own screen and does not sync them, so neither does this.
 */

const NONE: readonly string[] = [];
const listeners = new Set<() => void>();
/** The last saved value read, so the same keys come back as the same list. */
let read: { raw: string | undefined; collapsed: readonly string[] } = { raw: undefined, collapsed: NONE };

function parse(raw: string | undefined): readonly string[] {
  if (raw === undefined) return NONE;
  try {
    const saved: unknown = JSON.parse(raw);
    return Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : NONE;
  } catch {
    return NONE;
  }
}

/** The shown Mac's saved fold keys. */
export function savedFolds(): readonly string[] {
  const macId = shownMacId();
  const raw = macId ? storage.getString(foldsKey(macId)) : undefined;
  if (raw !== read.raw) read = { raw, collapsed: parse(raw) };
  return read.collapsed;
}

/** Folds or opens the section `key` names, on the shown Mac. */
export function toggleFold(key: string): void {
  const macId = shownMacId();
  if (!macId) return;
  storage.set(foldsKey(macId), JSON.stringify(toggleSidebarFold(savedFolds(), key)));
  listeners.forEach((listener) => listener());
}

/** Opens a project that is folded, as a thread starts in it. */
export function unfoldProject(projectId: string): void {
  if (!sidebarSectionOpen(savedFolds(), "project", projectId)) toggleFold(sidebarFoldKey.project(projectId));
}

export function useFolds(): readonly string[] {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, savedFolds);
}
