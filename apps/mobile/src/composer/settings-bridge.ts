import type { ClientState } from "@openorc/client";
import { useEffect, useSyncExternalStore } from "react";

/** What the model and mode sheets read and change: an open thread's settings, or a new thread's choices. */
export type ComposerSettings = Pick<ReturnType<ClientState["useConversationSettings"]>, "choice" | "mode" | "permission" | "selectModel" | "selectExecutionMode">;

/**
 * A composer's settings, for the model and mode sheets. A sheet is its own screen, but a choice made there must go
 * through the composer's one settings hook, so saves stay in order and a send waits for them. Each composer shares its
 * settings under its own id: the thread's id, or the new thread's.
 */
const shared = new Map<string, ComposerSettings>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useShareSettings(composerId: string, settings: ComposerSettings): void {
  useEffect(() => {
    shared.set(composerId, settings);
    listeners.forEach((listener) => listener());
  });
  useEffect(
    () => () => {
      shared.delete(composerId);
      listeners.forEach((listener) => listener());
    },
    [composerId],
  );
}

export function useSharedSettings(composerId: string): ComposerSettings | undefined {
  return useSyncExternalStore(subscribe, () => shared.get(composerId));
}
