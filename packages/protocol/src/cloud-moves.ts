import { z } from "zod";

/*
 * A thread moving between this Mac and OpenOrc Cloud, keeping its id (core `CloudMoves`). Window-only calls; the place a
 * thread is moving to, or why its last move stopped, rides on its summary (`ThreadSummary.moving`).
 */

/** What a thread moving to the cloud says where it would take a message: it takes none until it is there. */
export const MOVING_TO_CLOUD = "Moving to OpenOrc Cloud";

/** Where a thread is moving, or why its last move stopped and left it where it was. */
export const ThreadMoving = z.object({ to: z.enum(["cloud", "mac"]), failed: z.string().nullable() });
export type ThreadMoving = z.infer<typeof ThreadMoving>;

/** What a thread under way to `machine` or the cloud says where it would take a message or another move; null otherwise. */
export function movingHold(moving: ThreadMoving | null | undefined, machine: string): string | null {
  if (!moving || moving.failed !== null) return null;
  return moving.to === "cloud" ? MOVING_TO_CLOUD : `Moving to ${machine}`;
}

/**
 * Whether the thread can move from where it is now and where it would land, or why it cannot, held with the reason.
 * `space` is where a move to the cloud lands: a thread in an organization's space is read by its teammates there.
 * `ends`, coming to this Mac: what leaving its cloud machine would end, asked about first when there is any.
 * `none`: the thread never moves (a subagent's, a task's, an Orcling's, a chat with no project).
 */
export type CloudMoveCheck =
  { to: "cloud"; can: true; space: { id: string; personal: boolean } } | { to: "mac"; can: true; ends: string[] } | { to: "cloud" | "mac"; can: false; reason: string } | { to: "none" };

/** What asking a move came to: it started, or a question first because something running in the cloud would end. */
export type CloudMoveStart = { started: true } | { confirm: string[] };

const id = z.string().min(1).max(200);

export const cloudMovesRpcParams = {
  "threads.moveCheck": z.object({ threadId: id }).strict(),
  "threads.move": z.object({ threadId: id, endsOk: z.boolean() }).strict(),
  /** Puts away why the thread's last move stopped. */
  "threads.moveDismiss": z.object({ threadId: id }).strict(),
};
export interface CloudMovesRpcResults {
  "threads.moveCheck": CloudMoveCheck;
  "threads.move": CloudMoveStart;
  "threads.moveDismiss": null;
}
