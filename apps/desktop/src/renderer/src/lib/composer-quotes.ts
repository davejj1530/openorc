import type { Quote } from "@openorc/client";
import { useCallback, useId, useMemo, useSyncExternalStore } from "react";
import { readDraft, removeDraft, writeDraft } from "./drafts";

const NONE: readonly Quote[] = [];
const held = new Map<string, readonly Quote[]>();
const listeners = new Map<string, Set<() => void>>();
const saved = (draftKey: string) => `${draftKey}.quotes`;

function read(key: string, draftKey: string | undefined): readonly Quote[] {
  let quotes = held.get(key);
  if (!quotes) {
    quotes = draftKey ? readDraft(saved(draftKey), { quotes: NONE }).quotes : NONE;
    held.set(key, quotes);
  }
  return quotes;
}

function write(key: string, draftKey: string | undefined, quotes: readonly Quote[]): void {
  held.set(key, quotes);
  if (draftKey && quotes.length) writeDraft(saved(draftKey), { quotes });
  else if (draftKey) removeDraft(saved(draftKey));
  listeners.get(key)?.forEach((listener) => listener());
}

/** A draft's quotes, kept with the draft across navigation. A send that lands after the view is gone still removes its own. */
export function useComposerQuotes(draftKey?: string) {
  const instanceId = useId();
  const key = draftKey ? `draft:${draftKey}` : `instance:${instanceId}`;
  const subscribe = useCallback(
    (listener: () => void) => {
      const group = listeners.get(key) ?? new Set<() => void>();
      group.add(listener);
      listeners.set(key, group);
      return () => {
        group.delete(listener);
        if (group.size) return;
        listeners.delete(key);
        held.delete(key);
      };
    },
    [key],
  );
  const quotes = useSyncExternalStore(
    subscribe,
    useCallback(() => read(key, draftKey), [key, draftKey]),
  );
  const actions = useMemo(() => {
    const change = (update: (quotes: readonly Quote[]) => readonly Quote[]) => write(key, draftKey, update(read(key, draftKey)));
    return {
      add: (text: string, note: string) => change((quotes) => [...quotes, { id: crypto.randomUUID(), text, note }]),
      edit: (id: string, note: string) => change((quotes) => quotes.map((quote) => (quote.id === id ? { ...quote, note } : quote))),
      remove: (ids: readonly string[]) => change((quotes) => quotes.filter((quote) => !ids.includes(quote.id))),
    };
  }, [key, draftKey]);
  return { quotes, ...actions };
}
