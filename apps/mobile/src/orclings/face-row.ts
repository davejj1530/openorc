import { useSyncExternalStore } from "react";
import { storage } from "../client";

/**
 * Whether Threads shows the Orclings' faces in a row at its top, kept on this phone as the desktop keeps its rail's
 * choice. On unless turned off.
 */
const KEY = "orcling-faces";
const listeners = new Set<() => void>();

export const showsOrclingFaces = (): boolean => storage.getString(KEY) !== "off";

export function setOrclingFaces(shown: boolean): void {
  if (shown) storage.remove(KEY);
  else storage.set(KEY, "off");
  listeners.forEach((listener) => listener());
}

storage.onDropped(() => listeners.forEach((listener) => listener()));

export function useOrclingFaces(): boolean {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, showsOrclingFaces);
}
