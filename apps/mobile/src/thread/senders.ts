import type { ThreadAuthors, ThreadPerson } from "@openorc/protocol";

/**
 * Who wrote what in the open thread, as OpenOrc Cloud tells it: its senders and authors, whether anyone besides the
 * reader is in it (`shared`, else turns name nobody), and who sends the turn that runs now, as the server says it
 * before any of the turn's events do. Null for a thread of this Mac, which only its person writes in.
 */
export interface ThreadSenders {
  authors: ThreadAuthors;
  shared: boolean;
  live: ThreadPerson | null | undefined;
}

/** The senders a thread's authors make, `others` when its row already says someone besides the reader is in it. */
export function threadSenders(authors: ThreadAuthors, others: boolean, live: ThreadPerson | null | undefined): ThreadSenders {
  const viewer = authors.viewer?.id;
  const people = [...Object.values(authors.senders), ...Object.values(authors.authors)];
  return { authors, shared: others || people.some((person) => person?.id !== viewer), live };
}

/**
 * Who sent the turn these blocks make, in a thread others are in, where the server names them. Null: a former member.
 * A turn that runs now (`live`) is its server-named sender's before any of its events say so.
 */
export function turnSender(senders: ThreadSenders | null, blocks: readonly { id: string }[], live: boolean): ThreadPerson | null | undefined {
  if (!senders?.shared) return undefined;
  for (const block of blocks) {
    const turn = senders.authors.turnOf[block.id];
    if (turn !== undefined && turn in senders.authors.senders) return senders.authors.senders[turn];
  }
  return live ? senders.live : undefined;
}

/** Who wrote a person's message, in a thread others are in, where the server names them. Null: a former member. */
export function messageAuthor(senders: ThreadSenders | null, messageId: string | undefined): ThreadPerson | null | undefined {
  if (!senders?.shared || messageId === undefined || !(messageId in senders.authors.authors)) return undefined;
  return senders.authors.authors[messageId];
}
