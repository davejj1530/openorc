import { threadTogether, withOthers } from "@openorc/client";
import type { ThreadAuthors, ThreadPerson, ThreadSummary } from "@openorc/protocol";
import { createContext, useContext, useMemo } from "react";
import { useRpc } from "./client";
import { useSpaceNavigation } from "./space-navigation";

/** Who sent each turn and wrote each message, and whether anyone besides the reader is in the thread at all. */
export interface ThreadVoices {
  authors: ThreadAuthors;
  /** Names show only then: in an organization's thread, which its project's members read, and in any thread someone else
   * is in. A Personal thread nobody else is in reads as it always did. */
  shared: boolean;
  /** Who sends the turn that runs now, as the server says it before any of the turn's events do. */
  live?: ThreadPerson | null | undefined;
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
  const id = thread?.id;
  const organization = useSpaceNavigation((state) => state.inventory.some((space) => !space.personal && space.threads.some((each) => each.id === id)));
  const live = threadTogether(thread)?.live?.sender;
  const voices = useMemo(() => {
    if (!together || !authors) return null;
    const viewer = authors.viewer?.id;
    const people = [...Object.values(authors.senders), ...Object.values(authors.authors)];
    return { authors, shared: organization || others || people.some((person) => person?.id !== viewer), live };
  }, [together, authors, organization, others, live]);
  return { voices, failed: together && read.error ? read.error.message : null, retry: () => void read.refetch() };
}

/**
 * The sender of the turn these blocks make, when the thread has others in it and its sender is known. Null: a former
 * member. A turn that runs now (`live`) is its server-named sender's before any of its events say so.
 */
export function useTurnSender(blocks: readonly { id: string }[] | undefined, live = false): ThreadPerson | null | undefined {
  const voices = useContext(ThreadVoicesContext);
  if (!voices?.shared || !blocks) return undefined;
  for (const block of blocks) {
    const turn = voices.authors.turnOf[block.id];
    if (turn !== undefined && turn in voices.authors.senders) return voices.authors.senders[turn];
  }
  return live ? voices.live : undefined;
}

/** Who wrote a person's message, when the thread has others in it and its author is known. Null: a former member. */
export function useMessageAuthor(messageId: string | undefined): ThreadPerson | null | undefined {
  const voices = useContext(ThreadVoicesContext);
  if (!voices?.shared || !messageId || !(messageId in voices.authors.authors)) return undefined;
  return voices.authors.authors[messageId];
}
