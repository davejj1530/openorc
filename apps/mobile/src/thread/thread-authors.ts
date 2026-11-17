import { personFirst, withOthers } from "@openorc/client";
import { placeOf, type ThreadAuthors, type ThreadCollaboration, type ThreadSummary } from "@openorc/protocol";
import { createContext, useContext, useMemo } from "react";
import { useRpc } from "../client";
import { threadSenders, type ThreadSenders } from "./senders";

export const AuthorsContext = createContext<ThreadSenders | null>(null);

/** An OpenOrc Cloud thread's senders and authors, read again as its log is and as someone new writes. */
export function useThreadAuthors(thread: ThreadSummary | null, together: ThreadCollaboration | null): ThreadSenders | null {
  const cloud = thread !== null && placeOf(thread).elsewhere;
  const authors = useRpc("threads.authors", { threadId: thread?.id ?? "" }, { enabled: cloud }).data;
  const others = withOthers(thread);
  const live = together?.live?.sender;
  return useMemo(() => (authors ? threadSenders(authors, others, live) : null), [authors, others, live]);
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

export const useOtherAuthor = (messageId: string): string | null => otherAuthor(useContext(AuthorsContext)?.authors ?? null, messageId);
