/** The stand-in's thread log as the server answers it: where turns end, pages of events, and each message's row. */
import { userOf } from "./stand-in-spaces.js";
import type { Message, Stored, Thread } from "./stand-in-thread-types.js";

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

/** A tool call's whole output, as its `tool.completed` kept it; null for a call that never ended. */
export const toolOutputOf = (thread: Thread, toolCallId: string) => ({
  output: thread.events.findLast((stored) => stored.event["type"] === "tool.completed" && stored.event["toolCallId"] === toolCallId)?.event["output"] ?? null,
});

/**
 * A stretch of the log: from a turn, from the newest turns, or after a seq, at most `limit` events, with the head. A
 * server that doesn't read the newest turns (`newestTurns` false) answers an ask for them as one with no bound: the
 * newest events, with no `fromTurn`.
 */
export function pageOf(thread: Thread, query: URLSearchParams, newestTurns: boolean) {
  const limit = Number(query.get("limit") ?? 500);
  const ends = turnEnds(thread);
  const lastTurns = newestTurns && query.has("lastTurns") ? Number(query.get("lastTurns")) : null;
  const fromLast = lastTurns !== null ? Math.max(0, ends.length - lastTurns) : undefined;
  const fromTurn = query.has("fromTurn") ? Math.min(Number(query.get("fromTurn")), ends.length) : fromLast;
  if (query.has("before") || (!newestTurns && query.has("lastTurns"))) {
    const before = query.has("before") ? Number(query.get("before")) : headOf(thread) + 1;
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

/** A turn's end as its host writes it: one that ended on an ask nobody answered parks, and its end says so. */
export const turnEnd = (turnId: string, status: "success" | "cancelled", parks: boolean) => ({
  type: "turn.completed",
  ts: Date.now(),
  turnId,
  ...(parks ? { status: "cancelled", parked: true } : { status }),
  durationMs: 1000,
});
