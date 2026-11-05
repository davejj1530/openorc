import { z } from "zod";

/** The two brains. Every thread has exactly one of them as owner. */
export const Brain = z.enum(["mac", "cloud"]);
export type Brain = z.infer<typeof Brain>;

/** How far a reader that merged another host's rows in can reach that host now. */
export const OwnerReach = z.enum(["live", "asleep", "waking", "offline"]);
export type OwnerReach = z.infer<typeof OwnerReach>;

/**
 * Set on a row by whoever merged it in from another host: the Mac's router for its windows (cloud rows only), the
 * phone's Home (every row it merged). Absent: the host that answered owns the thread. Never stored.
 */
export const ThreadOwner = z.object({
  brain: Brain,
  reach: OwnerReach,
  /** When the owner last answered for this row; older than now when it came from the last answer kept. */
  heardAt: z.number(),
  /** Desktop only: the Mac has a read-only copy of the code (Open on Mac). */
  mirror: z.boolean().optional(),
});
export type ThreadOwner = z.infer<typeof ThreadOwner>;

/** Where a move under way stands: packing the thread, waking the cloud brain, or sending it across. */
export const MoveStep = z.enum(["packing", "waking", "sending"]);
export type MoveStep = z.infer<typeof MoveStep>;

/** A thread frozen on this host while it relocates: reads answer, every write is refused. Derived from the journal. */
export const ThreadMoving = z.object({ to: Brain, since: z.number(), step: MoveStep.optional() });

export type ThreadMoving = z.infer<typeof ThreadMoving>;

export const MOVING_WORDS: Record<Brain, string> = {
  cloud: "This conversation is moving to the cloud.",
  mac: "This conversation is moving to your Mac.",
};

/** A cloud thread's code as its brain holds it now, for its read-only copy on the Mac (Open on Mac). */
export interface MirrorSnapshot {
  /** The working tree as one commit on `head`, uncommitted and untracked work included. */
  snapshot: string;
  tree: string;
  head: string | null;
  branch: string | null;
  /** A git bundle of what the Mac lacks, base64; null when it has the snapshot already. */
  bundle: string | null;
}
