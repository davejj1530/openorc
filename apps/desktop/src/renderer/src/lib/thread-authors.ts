import { threadTogether, withOthers } from "@openorc/client";
import type { ThreadAuthors, ThreadPerson, ThreadSummary } from "@openorc/protocol";
import { createContext, useContext, useMemo } from "react";
import { useRpc } from "./client";

/** Who sent each turn and wrote each message, and whether anyone besides the reader is in the thread at all. */
export interface ThreadVoices {
  authors: ThreadAuthors;
  /** Names show only then: a thread nobody else is in reads as it always did. */
  shared: boolean;
}

export const ThreadVoicesContext = createContext<ThreadVoices | null>(null);

/**
 * The senders and authors of an OpenOrc Cloud thread whose server tells them, read again as its log is read and its row
 * moves. `failed`: the read failed, in its words, with `retry` to read again; names stay off meanwhile.
 */
export function useThreadVoices(thread: ThreadSummary | null): { voices: ThreadVoices | null; failed: string | null; retry: () => void } {
  const together = Boolean(threadTogether(thread));
  const read = useRpc("threads.authors", { threadId: thread?.id ?? "" }, { enabled: together });
  const authors = read.data;
  const others = withOthers(thread);
  const voices = useMemo(() => {
    if (!together || !authors) return null;
    const viewer = authors.viewer?.id;
    const people = [...Object.values(authors.senders), ...Object.values(authors.authors)];
    return { authors, shared: others || people.some((person) => person?.id !== viewer) };
  }, [together, authors, others]);
  return { voices, failed: together && read.error ? read.error.message : null, retry: () => void read.refetch() };
}

/** The sender of the turn these blocks make, when the thread has others in it and its sender is known. Null: a former member. */
export function useTurnSender(blocks: readonly { id: string }[] | undefined): ThreadPerson | null | undefined {
  const voices = useContext(ThreadVoicesContext);
  if (!voices?.shared || !blocks) return undefined;
  for (const block of blocks) {
    const turn = voices.authors.turnOf[block.id];
    if (turn !== undefined && turn in voices.authors.senders) return voices.authors.senders[turn];
  }
  return undefined;
}

/** Who wrote a person's message, when the thread has others in it and its author is known. Null: a former member. */
export function useMessageAuthor(messageId: string | undefined): ThreadPerson | null | undefined {
  const voices = useContext(ThreadVoicesContext);
  if (!voices?.shared || !messageId || !(messageId in voices.authors.authors)) return undefined;
  return voices.authors.authors[messageId];
}
