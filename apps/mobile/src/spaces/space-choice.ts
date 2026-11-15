import { useSyncExternalStore } from "react";
import { shownMacId, storage } from "../client";
import { spaceKey } from "./space-key";

/*
 * Which space Home shows, per Mac: the person's own choice on this phone, kept across launches. It never follows the
 * space a window on the Mac shows, and nothing tells the Mac of it but the id each list is asked for.
 */

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

/** The space chosen for the shown Mac, by its id; null until the person chooses one, which reads as Personal. */
export function chosenSpace(): string | null {
  const macId = shownMacId();
  return macId ? (storage.getString(spaceKey(macId)) ?? null) : null;
}

export function chooseSpace(spaceId: string): void {
  const macId = shownMacId();
  if (!macId || chosenSpace() === spaceId) return;
  storage.set(spaceKey(macId), spaceId);
  changed();
}

// A space chosen in the demo goes with it.
storage.onDropped(changed);

export function useChosenSpace(): string | null {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, chosenSpace);
}
