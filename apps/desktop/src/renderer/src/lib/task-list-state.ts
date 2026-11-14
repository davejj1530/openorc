import { useState, useSyncExternalStore } from "react";
import type { TaskStatus } from "@openorc/protocol";
import type { TaskOnlineScope } from "./task-online-query";

export type TaskShelf = "active" | "done" | "archived";
type Filters = { shelf: TaskShelf; stage: TaskStatus | null; assigned: boolean };
const initial: Filters = { shelf: "active", stage: null, assigned: false };
const saved = new Map<string, Filters>();
const positions = new Map<string, number>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const taskListScroll = (key: string): number => positions.get(key) ?? 0;
export const keepTaskListScroll = (key: string, value: number): void => {
  positions.set(key, value);
};

/** Organization preferences stay with the account and space; Personal keeps its existing component state. */
export function useTaskListFilters(scope: TaskOnlineScope | null) {
  const key = scope ? JSON.stringify([scope.accountId, scope.spaceId]) : null;
  const [local, setLocal] = useState(initial);
  const online = useSyncExternalStore(subscribe, () => (key ? (saved.get(key) ?? initial) : initial));
  const value = key ? online : local;
  const patch = (next: Partial<Filters>) => {
    if (!key) {
      setLocal((current) => ({ ...current, ...next }));
      return;
    }
    saved.set(key, { ...(saved.get(key) ?? initial), ...next });
    listeners.forEach((listener) => listener());
  };
  return { ...value, key, patch };
}
