import { useCallback, useId, useMemo, useSyncExternalStore } from "react";
import { readDraft, removeDraft, writeDraft } from "./drafts";

/** A passage picked out of a message, with what the person wrote about it. */
export interface Quote {
  id: string;
  text: string;
  note: string;
}

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

/** A message as the agent reads it: each passage quoted with its note under it, then the words written. */
export function quotedMessage(quotes: readonly Quote[], text: string): string {
  const passages = quotes.map((quote) => {
    const quoted = quote.text
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
    return quote.note ? `${quoted}\n${quote.note}` : quoted;
  });
  return [...passages, text].filter(Boolean).join("\n\n");
}

/** A message's words in runs: the passages it quotes, without the `>` each line starts with, and the words between them. */
export function quoteRuns(text: string): { quote: boolean; text: string }[] {
  const runs: { quote: boolean; text: string }[] = [];
  for (const line of text.split("\n")) {
    const quote = /^>(?: |$)/.test(line);
    const words = quote ? line.slice(2) : line;
    const last = runs.at(-1);
    if (last?.quote === quote) last.text += `\n${words}`;
    else runs.push({ quote, text: words });
  }
  return runs;
}
