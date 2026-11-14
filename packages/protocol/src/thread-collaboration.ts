import { z } from "zod";

/**
 * Working together in an OpenOrc Cloud thread, as the server tells the person reading it. Desktop windows only: none of
 * this enters a hello, a phone's methods or the agent event stream.
 *
 * Four identities stay apart: the thread's creator (`ThreadOwner.startedBy`, the row's face), the sender of each turn,
 * who is also its payer, the author of each message, and the reader. Every capability here is the server's snapshot,
 * never an authorization: the server checks again on every write.
 */

/** A person as a teammate sees them, with no address, plan or balance. */
export const ThreadPerson = z.object({ id: z.string(), name: z.string(), image: z.string().nullable() });
export type ThreadPerson = z.infer<typeof ThreadPerson>;

/** Why a new turn cannot start here now, in the server's words, and what this reader may do about it. */
export const ThreadHandoffBlock = z.object({
  code: z.enum(["handoff_command", "handoff_save", "handoff_unavailable"]),
  message: z.string(),
  responsible: ThreadPerson.nullable(),
  /** Commands of this thread that must end first. */
  commandIds: z.array(z.string()),
  /** Whether this reader may ask the server to save the thread's work again. */
  retrySave: z.boolean(),
});
export type ThreadHandoffBlock = z.infer<typeof ThreadHandoffBlock>;

/** The thread's waiting ask: whose turn asked it, and whether this reader may answer it now. */
export const ThreadAsk = z.object({
  id: z.string(),
  turnId: z.string(),
  /** waiting: its turn is live, and only its sender answers. parked: its turn ended; an answer starts a new turn. */
  state: z.enum(["waiting", "parked"]),
  sender: ThreadPerson.nullable(),
  answer: z.enum(["live", "start", "blocked"]),
  canDecline: z.boolean(),
  /** The server's words for why this reader cannot answer. */
  reason: z.string().nullable(),
});
export type ThreadAsk = z.infer<typeof ThreadAsk>;

/** One message waiting in the thread's queue, with its author and what this reader may do to it. */
export const ThreadQueued = z.object({
  messageId: z.string(),
  author: ThreadPerson.nullable(),
  paused: z.boolean(),
  canEdit: z.boolean(),
  canRemove: z.boolean(),
  canStart: z.boolean(),
});
export type ThreadQueued = z.infer<typeof ThreadQueued>;

export const ThreadCollaboration = z.object({
  viewer: ThreadPerson,
  /** May write here at all: project access and the organization's access, never the reader's own hours. */
  canWrite: z.boolean(),
  /** The live turn and its sender, who pays for it. */
  live: z.object({ id: z.string(), sender: ThreadPerson.nullable(), startedAt: z.number(), stopping: z.boolean() }).nullable(),
  /** now: a message joins the live turn, or starts one. after: it waits for the turn that is stopping. blocked: neither. */
  send: z.enum(["now", "after", "blocked"]),
  handoff: ThreadHandoffBlock.nullable(),
  canPostNote: z.boolean(),
  canStop: z.boolean(),
  ask: ThreadAsk.nullable(),
  queue: z.array(ThreadQueued),
  mentions: z.object({ unread: z.boolean(), firstUnreadNoteId: z.string().nullable() }),
  noteHead: z.number().int().nonnegative(),
});
export type ThreadCollaboration = z.infer<typeof ThreadCollaboration>;

/**
 * Who sent each turn and who wrote each message of the part of a thread's log read so far. `turnOf` names the turn of a
 * transcript block by its id (a message's or a call's); `senders` the sender of each turn the server named, null for a
 * former member; `authors` the author of each person's message, by the app's message id. A turn or message missing
 * from these is not known yet.
 */
export const ThreadAuthors = z.object({
  viewer: ThreadPerson.nullable(),
  turnOf: z.record(z.string(), z.string()),
  senders: z.record(z.string(), ThreadPerson.nullable()),
  authors: z.record(z.string(), ThreadPerson.nullable()),
});
export type ThreadAuthors = z.infer<typeof ThreadAuthors>;

/** Someone who can be tagged in the thread: a member with its project. `address` only tells apart people of one name. */
export const ThreadTaggable = ThreadPerson.extend({ address: z.string().nullable() });
export type ThreadTaggable = z.infer<typeof ThreadTaggable>;

export const threadCollaborationRpcParams = {
  /** The thread's collaboration now; unsupported on a server that predates it, and for any thread not on OpenOrc Cloud. */
  "threads.collaboration": z.object({ threadId: z.string() }).strict(),
  "threads.authors": z.object({ threadId: z.string() }).strict(),
  "threads.people": z.object({ threadId: z.string(), q: z.string().max(100).optional() }).strict(),
};

export interface ThreadCollaborationRpcResults {
  "threads.collaboration": { supported: false } | { supported: true; state: ThreadCollaboration };
  "threads.authors": ThreadAuthors;
  "threads.people": { people: ThreadTaggable[] };
}
