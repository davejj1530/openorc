import { z } from "zod";

/**
 * Where a thread lives: this Mac, the person's own cloud brain, or OpenOrc Cloud. Every thread has exactly one. Only the
 * Mac's windows ever see "hosted": its rows are stamped by the Mac's place router, which phones never reach.
 */
export const Brain = z.enum(["mac", "cloud", "hosted"]);
export type Brain = z.infer<typeof Brain>;

/** The two ends a thread can move between. OpenOrc Cloud is not one. */
export const MoveTarget = z.enum(["mac", "cloud"]);
export type MoveTarget = z.infer<typeof MoveTarget>;

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
  /** Desktop only: an OpenOrc Cloud thread's project, when no project on this Mac has its repository. */
  project: z.object({ name: z.string() }).optional(),
  /** Desktop only: who started a thread someone else shares with the person, by name. */
  startedBy: z.object({ name: z.string(), image: z.string().nullable() }).optional(),
});
export type ThreadOwner = z.infer<typeof ThreadOwner>;

/** Where a move under way stands: packing the thread, waking the cloud brain, or sending it across. */
export const MoveStep = z.enum(["packing", "waking", "sending"]);
export type MoveStep = z.infer<typeof MoveStep>;

/** A thread frozen on this host while it relocates: reads answer, every write is refused. Derived from the journal. */
export const ThreadMoving = z.object({ to: MoveTarget, since: z.number(), step: MoveStep.optional() });

/** A move this Mac asked for that settled without happening, with the words that say why, and when it settled. */
export const MoveRefusal = z.object({ to: MoveTarget, reason: z.string(), at: z.number() });
export type MoveRefusal = z.infer<typeof MoveRefusal>;
export type ThreadMoving = z.infer<typeof ThreadMoving>;

export const MOVING_WORDS: Record<MoveTarget, string> = {
  cloud: "This conversation is moving to the cloud.",
  mac: "This conversation is moving to your Mac.",
};

/**
 * What differs between places, in one table, so a window asks a question of the place rather than naming one.
 *   mark       the quiet word for where it lives; null for the answering host's own rows
 *   elsewhere  its threads have no folder on this Mac (no terminal, files, fork or subthread) unless a copy is open
 *   brain      the person's own cloud brain: it sleeps and wakes, and threads move to and from it
 *   rowIcon    a sidebar row says where it lives with the cloud icon rather than in its words
 */
export interface Place {
  mark: string | null;
  elsewhere: boolean;
  brain: boolean;
  rowIcon: boolean;
}

export const PLACES: Record<Brain, Place> = {
  mac: { mark: null, elsewhere: false, brain: false, rowIcon: false },
  cloud: { mark: "Cloud", elsewhere: true, brain: true, rowIcon: false },
  hosted: { mark: "OpenOrc Cloud", elsewhere: true, brain: false, rowIcon: true },
};

/** The place a row lives in: its owner's, or this host when no owner is stamped. */
export function placeOf(thread: { owner?: { brain: Brain } | undefined }): Place {
  return PLACES[thread.owner?.brain ?? "mac"];
}

/**
 * A hosted thread reads as exactly one run, its log, whose id is made from the thread's, so which thread and which
 * place a run belongs to are read off the id.
 */
export type HostedRunId = `hosted:${string}`;

export function hostedRunId(threadId: string): HostedRunId {
  return `hosted:${threadId}`;
}

/** The hosted thread a run id names; null for any other run. */
export function hostedThreadOf(runId: string): string | null {
  return runId.startsWith("hosted:") ? runId.slice("hosted:".length) : null;
}

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
