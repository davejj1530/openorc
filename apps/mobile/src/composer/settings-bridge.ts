import type { ClientState } from "@openorc/client";
import { useEffect, useSyncExternalStore } from "react";

type Settings = ReturnType<ClientState["useConversationSettings"]>;

/**
 * The open thread's settings, for the model and mode sheets. A sheet is its own screen, but a choice made there must go
 * through the thread's one settings hook, so saves stay in order and a send waits for them.
 */
const shared = new Map<string, Settings>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useShareSettings(threadId: string, settings: Settings): void {
  useEffect(() => {
    shared.set(threadId, settings);
    listeners.forEach((listener) => listener());
  });
  useEffect(
    () => () => {
      shared.delete(threadId);
      listeners.forEach((listener) => listener());
    },
    [threadId],
  );
}

export function useSharedSettings(threadId: string): Settings | undefined {
  return useSyncExternalStore(subscribe, () => shared.get(threadId));
}
