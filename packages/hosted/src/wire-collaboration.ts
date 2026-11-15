/**
 * The server's reads of working together in a thread: who reads, whose turn is live, whose ask waits, who waits in the
 * queue, who sent each turn and who can be tagged. Parsed where they enter; collaboration.ts turns them into the app's.
 * Words a newer server may add to (`send`, an ask's `state` and `answer`, a block's `code`) are read as strings and
 * settled to the nearest safe one here.
 */
import type { ThreadCollaboration, ThreadNote, ThreadPerson } from "@openorc/protocol";
import { z } from "zod";
import type { Route } from "./wire.js";
import { toImage } from "./translate.js";

const iso = z.iso.datetime();
const person = z.object({ id: z.string(), name: z.string(), image: z.string().nullish() });
type WirePerson = z.infer<typeof person>;

const note = z.object({ to: person, text: z.string(), mention: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }) });
const block = z.object({ code: z.string(), message: z.string(), responsible: person.nullable(), commandIds: z.array(z.string()), retrySave: z.boolean(), note: note.nullish() });

export const wireCollaboration = z.object({
  version: z.number(),
  viewer: person,
  canWrite: z.boolean(),
  live: z.object({ id: z.string(), sender: person.nullable(), startedAt: iso, stopping: z.boolean() }).nullable(),
  send: z.string(),
  handoff: block.nullable(),
  canPostNote: z.boolean(),
  canStop: z.boolean(),
  ask: z.object({ id: z.string(), turnId: z.string(), state: z.string(), sender: person.nullable(), answer: z.string(), canDecline: z.boolean(), reason: z.string().nullable() }).nullable(),
  queue: z.array(
    z.object({
      messageId: z.string(),
      author: person.nullable(),
      paused: z.boolean(),
      canEdit: z.boolean(),
      canRemove: z.boolean(),
      canStart: z.boolean(),
      task: z.object({ id: z.string(), ifRevision: z.number().int() }).nullable().optional(),
      pause: z.object({ kind: z.string(), message: z.string() }).nullable().optional(),
    }),
  ),
  mentions: z.object({ unread: z.boolean(), firstUnreadNoteId: z.string().nullable() }),
  noteHead: z.number().int().nonnegative(),
});
export type WireCollaboration = z.infer<typeof wireCollaboration>;

export const wireTurnSenders = z.object({ turns: z.array(z.object({ id: z.string(), sender: person.nullable() })) });
export const wirePeople = z.object({ people: z.array(person.extend({ email: z.string() })) });

const wireNote = z.object({
  id: z.string(),
  seq: z.number().int(),
  threadId: z.string(),
  author: person.nullable(),
  text: z.string(),
  mentions: z.array(z.object({ person: person.nullable(), userId: z.string(), start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })),
  replyTo: z.string().nullable(),
  createdAt: iso,
  afterEventSeq: z.number().int().nonnegative(),
  mentionedYou: z.boolean(),
  read: z.boolean(),
});
type WireNote = z.infer<typeof wireNote>;
export const wireNotesPage = z.object({ notes: z.array(wireNote), head: z.number().int(), hasBefore: z.boolean(), hasAfter: z.boolean() });
export const wirePosted = z.object({ note: wireNote });

/** A note as a window draws it. */
export function toNote(wire: WireNote): ThreadNote {
  const nullable = (each: WirePerson | null) => (each ? toPerson(each) : null);
  return {
    id: wire.id,
    seq: wire.seq,
    author: nullable(wire.author),
    text: wire.text,
    mentions: wire.mentions.map((mention) => ({ ...mention, person: nullable(mention.person) })),
    replyTo: wire.replyTo,
    createdAt: wire.createdAt,
    afterEventSeq: wire.afterEventSeq,
    mentionedYou: wire.mentionedYou,
    read: wire.read,
  };
}

/** The most turns one read of their senders names, as the server takes them. */
export const SENDERS_PER_READ = 100;

const route = <T>(path: string, reply: z.ZodType<T>): Route<T> => ({ method: "GET", path, reply });
const wireSent = z.discriminatedUnion("sent", [z.object({ sent: z.literal(true) }).loose(), z.object({ sent: z.literal(false), refusal: z.string() })]);
const thread = (id: string) => `/hosted/threads/${encodeURIComponent(id)}`;

export const COLLABORATION_ROUTES = {
  /** The thread's collaboration now. A 404 on a thread the person reads: a server that predates it. */
  collaboration: (id: string) => route(`${thread(id)}/collaboration`, wireCollaboration),
  /** Who sent each of these turns of the thread; ids of any other thread are left out. */
  turnSenders: (id: string, turnIds: readonly string[]) => route(`${thread(id)}/turn-senders?${new URLSearchParams({ turnIds: turnIds.join(",") })}`, wireTurnSenders),
  /** Members with the thread's project, by name. */
  people: (id: string, q: string) => route(`${thread(id)}/people?${new URLSearchParams({ q })}`, wirePeople),
  /** Starts the author's own paused message as their own turn, under an explicit request id kept across a lost reply. */
  startQueued: (id: string, messageId: string): Route<z.infer<typeof wireSent>> => ({ method: "POST", path: `${thread(id)}/messages/${encodeURIComponent(messageId)}/start`, reply: wireSent }),
  /** Saves the thread's work again after a failed save, as server recovery: no agent turn, no sign-in. Answered with nothing. */
  retrySave: (id: string): Route<null> => ({ method: "POST", path: `${thread(id)}/retry-save`, reply: null }),
  /** A page of the thread's notes, by one bound at most. */
  notes: (id: string, query: URLSearchParams) => route(`${thread(id)}/notes${query.size ? `?${query}` : ""}`, wireNotesPage),
  /** Posts a note; the same id again answers the note it made. */
  postNote: (id: string): Route<z.infer<typeof wirePosted>> => ({ method: "POST", path: `${thread(id)}/notes`, reply: wirePosted }),
  /** Marks the notes the reader saw read; answered with nothing. */
  readNotes: (id: string): Route<null> => ({ method: "PUT", path: `${thread(id)}/notes/read`, reply: null }),
};

/** A person as a window draws them: a picture only when it is held in a data URL. */
export function toPerson(wire: WirePerson): ThreadPerson {
  return { id: wire.id, name: wire.name, image: toImage(wire.image) };
}

const SEND = new Set(["now", "after", "blocked"]);
const BLOCKS = new Set(["handoff_command", "handoff_save", "handoff_unavailable"]);
const ANSWERS = new Set(["live", "start", "blocked"]);

/**
 * The server's collaboration as the app's, or null for a version this build does not read. A word this build does not
 * know closes what it would open: an unknown send or answer is blocked, an unknown block is the plain refusal, and an
 * ask in an unknown state is parked, which nothing here answers by itself.
 */
export function toCollaboration(wire: WireCollaboration): ThreadCollaboration | null {
  if (wire.version !== 1) return null;
  const nullable = (each: WirePerson | null) => (each ? toPerson(each) : null);
  const { ask, handoff, live } = wire;
  return {
    viewer: toPerson(wire.viewer),
    canWrite: wire.canWrite,
    live: live ? { id: live.id, sender: nullable(live.sender), startedAt: Date.parse(live.startedAt), stopping: live.stopping } : null,
    send: SEND.has(wire.send) ? (wire.send as ThreadCollaboration["send"]) : "blocked",
    handoff: handoff
      ? {
          code: BLOCKS.has(handoff.code) ? (handoff.code as NonNullable<ThreadCollaboration["handoff"]>["code"]) : "handoff_unavailable",
          message: handoff.message,
          responsible: nullable(handoff.responsible),
          commandIds: handoff.commandIds,
          retrySave: handoff.retrySave,
          note: handoff.note ? { to: toPerson(handoff.note.to), text: handoff.note.text, mention: handoff.note.mention } : null,
        }
      : null,
    canPostNote: wire.canPostNote,
    canStop: wire.canStop,
    ask: ask
      ? {
          id: ask.id,
          turnId: ask.turnId,
          state: ask.state === "waiting" ? "waiting" : "parked",
          sender: nullable(ask.sender),
          answer: ANSWERS.has(ask.answer) ? (ask.answer as NonNullable<ThreadCollaboration["ask"]>["answer"]) : "blocked",
          canDecline: ask.canDecline,
          reason: ask.reason,
        }
      : null,
    queue: wire.queue.map((queued) => ({ ...queued, author: nullable(queued.author), task: queued.task ?? null, pause: queued.pause ?? null })),
    mentions: wire.mentions,
    noteHead: wire.noteHead,
  };
}
