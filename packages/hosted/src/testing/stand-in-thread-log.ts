/** The stand-in's thread log as the server answers it: where turns end, pages of events, and each message's row. */
import { userOf } from "./stand-in-spaces.js";
import type { Message, Stored, Thread } from "./stand-in-threads.js";

export const lastAgentSeq = (thread: Thread) => thread.events.findLast((stored) => stored.by === null)?.seq ?? 0;
export const headOf = (thread: Thread) => thread.events.at(-1)?.seq ?? 0;
export const turnEnds = (thread: Thread) => thread.events.filter((stored) => stored.event["type"] === "turn.completed").map((stored) => stored.seq);
export const wire = (thread: Thread, stored: Stored) => ({ seq: stored.seq, turnId: stored.turnId, by: stored.by, event: { ...stored.event, eventId: `${thread.id}.${stored.seq}` } });

export function messageOf(message: Message) {
  return {
    id: message.id,
    authorId: userOf(message.author),
    text: message.text,
    files: message.files,
    state: message.state,
    delivery: message.state === "delivered" ? "started" : null,
    refusal: message.refusal,
    afterTurn: message.after,
    createdAt: message.createdAt,
  };
}

/** A stretch of the log: from a turn, or after a seq, at most `limit` events, with the head. */
export function pageOf(thread: Thread, query: URLSearchParams) {
  const limit = Number(query.get("limit") ?? 500);
  const ends = turnEnds(thread);
  const fromTurn = query.has("fromTurn") ? Math.min(Number(query.get("fromTurn")), ends.length) : undefined;
  if (query.has("before")) {
    const before = Number(query.get("before"));
    const events = thread.events.filter((stored) => stored.seq < before).slice(-limit);
    return { events: events.map((stored) => wire(thread, stored)), head: headOf(thread) };
  }
  const after = fromTurn === undefined ? Number(query.get("after") ?? 0) : (ends[fromTurn - 1] ?? 0);
  const events = thread.events
    .filter((stored) => stored.seq > after)
    .slice(0, limit)
    .map((stored) => wire(thread, stored));
  return { events, head: headOf(thread), ...(fromTurn !== undefined && { fromTurn }) };
}
