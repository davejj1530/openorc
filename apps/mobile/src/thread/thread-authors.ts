import { personFirst } from "@openorc/client";
import { placeOf, type ThreadAuthors, type ThreadSummary } from "@openorc/protocol";
import { createContext, useContext } from "react";
import { useRpc } from "../client";

/** Who wrote what in the open thread, as OpenOrc Cloud tells it; null for a thread of this Mac, which only its person writes in. */
export const AuthorsContext = createContext<ThreadAuthors | null>(null);

/** An OpenOrc Cloud thread's senders and authors, read again as its log is and as someone new writes. */
export function useThreadAuthors(thread: ThreadSummary | null): ThreadAuthors | null {
  const cloud = thread !== null && placeOf(thread).elsewhere;
  return useRpc("threads.authors", { threadId: thread?.id ?? "" }, { enabled: cloud }).data ?? null;
}

/**
 * The first name over a message someone else wrote, as the Mac heads a teammate's words with their face. Null for the
 * reader's own, and for a message whose author the server has not named. Someone whose account is gone is a former member.
 */
export function otherAuthor(authors: ThreadAuthors | null, messageId: string): string | null {
  if (!authors || !(messageId in authors.authors)) return null;
  const author = authors.authors[messageId] ?? null;
  return author && author.id === authors.viewer?.id ? null : personFirst(author);
}

export const useOtherAuthor = (messageId: string): string | null => otherAuthor(useContext(AuthorsContext), messageId);
