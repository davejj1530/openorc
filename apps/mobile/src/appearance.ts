import { useSyncExternalStore } from "react";
import { Uniwind } from "uniwind";
import { storage } from "./client";

/** How the phone draws OpenOrc: as the system does, or always light or dark. Kept on this phone, as the desktop keeps its own. */
export type AppearanceChoice = "system" | "light" | "dark";

export const APPEARANCES: readonly { choice: AppearanceChoice; label: string }[] = [
  { choice: "system", label: "System" },
  { choice: "light", label: "Light" },
  { choice: "dark", label: "Dark" },
];

const KEY = "appearance";
const listeners = new Set<() => void>();

export function savedAppearance(): AppearanceChoice {
  const saved = storage.getString(KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

/**
 * Applies a choice to the classes and to iOS itself, so headers, sheets, alerts and the keyboard follow, and keeps it.
 * At launch, `restoreAppearance` applies the kept one before the first frame.
 */
export function chooseAppearance(choice: AppearanceChoice): void {
  if (choice === "system") storage.remove(KEY);
  else storage.set(KEY, choice);
  Uniwind.setTheme(choice);
  listeners.forEach((listener) => listener());
}

// An appearance chosen in the demo goes with it: the kept one applies again, the system's included.
storage.onDropped(() => {
  Uniwind.setTheme(savedAppearance());
  listeners.forEach((listener) => listener());
});

export function restoreAppearance(): void {
  const saved = savedAppearance();
  if (saved !== "system") Uniwind.setTheme(saved);
}

export function useAppearance(): AppearanceChoice {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, savedAppearance);
}
