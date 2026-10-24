import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

/**
 * Which folds of one open thread the reader opened or closed, by key. Kept above the list, so a row the list recycles
 * or scrolls out of memory comes back the way the reader left it.
 */
export function createDisclosure() {
  const chosen = new Map<string, boolean>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (key: string): boolean | undefined => chosen.get(key),
    set(key: string, open: boolean): void {
      chosen.set(key, open);
      listeners.get(key)?.forEach((listener) => listener());
    },
    subscribe(key: string, listener: () => void): () => void {
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => set.delete(listener);
    },
  };
}

export type Disclosure = ReturnType<typeof createDisclosure>;

export const DisclosureContext = createContext<Disclosure>(createDisclosure());

/** Open as the reader last chose for `key`, or `fallback` until they choose. */
export function useOpen(key: string, fallback: boolean): [boolean, (open: boolean) => void] {
  const disclosure = useContext(DisclosureContext);
  const chosen = useSyncExternalStore(
    useCallback((listener: () => void) => disclosure.subscribe(key, listener), [disclosure, key]),
    () => disclosure.get(key),
  );
  const set = useCallback((open: boolean) => disclosure.set(key, open), [disclosure, key]);
  return [chosen ?? fallback, set];
}
