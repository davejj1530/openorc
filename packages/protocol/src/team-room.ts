import { z } from "zod";

const id = z.string().min(1);
const time = z.number().int().nonnegative();

/** Who wrote a room message: the user, a conversation member (by actor id) or another thread. */
export const TeamRoomAuthorKind = z.enum(["user", "member", "thread"]);
export type TeamRoomAuthorKind = z.infer<typeof TeamRoomAuthorKind>;

/** How a message entered the room. Replies are a member's final answer; everything else was posted on purpose. */
export const TeamRoomSource = z.enum(["prompt", "chat", "say", "reply", "legacy"]);
export type TeamRoomSource = z.infer<typeof TeamRoomSource>;

/**
 * One public message of a team conversation. The room is an append-only log
 * per team instance: every message has a sequence, every member has a cursor,
 * and what a member's session has missed is exactly the messages after it.
 */
export const TeamRoomEvent = z.object({
  instanceId: id,
  seq: z.number().int().positive(),
  id,
  authorKind: TeamRoomAuthorKind,
  /** "user", a conversation actor id ("lead", "member:<key>") or "thread:<id>". */
  authorId: id,
  body: z.string(),
  attachments: z.array(z.string().min(1).max(4096)).max(20),
  /** Actor ids expected to respond promptly. Empty means the room at large. */
  addressees: z.array(id).max(50),
  replyTo: id.nullable(),
  /** The human request this message answers or follows; a human message is its own request. */
  requestId: id.nullable(),
  executionId: id.nullable(),
  source: TeamRoomSource,
  requestKey: z.string().max(200).nullable(),
  createdAt: time,
});
export type TeamRoomEvent = z.infer<typeof TeamRoomEvent>;

/** Where a member's session stands in the room. Delivery is transport; assessment is a finished turn that read through that point. */
export interface TeamRoomCursor {
  instanceId: string;
  actorId: string;
  /** Changes when the member's context is replaced, not merely when its process restarts. */
  epoch: number;
  deliveredSeq: number;
  assessedSeq: number;
  /** Set for sessions that predate the room log; their real position was never recorded. */
  unknown: boolean;
  updatedAt: number;
}

/** One handing of a contiguous range of room messages to one member's session. */
export interface TeamRoomDelivery {
  id: string;
  instanceId: string;
  actorId: string;
  epoch: number;
  fromSeq: number;
  toSeq: number;
  /** Input to a new turn, or live input into a running one. */
  operation: "turn" | "live";
  attemptId: string | null;
  runId: string | null;
  state: "queued" | "submitted" | "confirmed" | "uncertain" | "cancelled";
  error: string | null;
  createdAt: number;
  settledAt: number | null;
}
