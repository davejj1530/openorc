import { z } from "zod";
import { ThreadCollaboration } from "./thread-collaboration.js";

/**
 * Where a thread lives: this Mac or OpenOrc Cloud. Every thread has exactly one. Only the Mac's windows ever see
 * "hosted": its rows are stamped by the Mac's place router, which phones never reach.
 */
export const Brain = z.enum(["mac", "hosted"]);
export type Brain = z.infer<typeof Brain>;

/** Whether a reader that merged another place's rows in can reach that place now. */
export const OwnerReach = z.enum(["live", "offline"]);
export type OwnerReach = z.infer<typeof OwnerReach>;

/**
 * Set on a row by the Mac's place router, which merges OpenOrc Cloud's rows in for its windows. Absent: this Mac owns
 * the thread. Never stored.
 */
export const ThreadOwner = z.object({
  brain: Brain,
  reach: OwnerReach,
  /** When the owner last answered for this row; older than now when it came from the last answer kept. */
  heardAt: z.number(),
  /** Desktop only: an OpenOrc Cloud thread's project, when no project on this Mac has its repository. */
  project: z.object({ name: z.string() }).optional(),
  /** Desktop only: who started a thread someone else shares with the person, by name. */
  startedBy: z.object({ name: z.string(), image: z.string().nullable() }).optional(),
  /** Desktop only: an OpenOrc Cloud thread's collaboration as its reader's list last heard it; absent from an older server. */
  collaboration: ThreadCollaboration.optional(),
});
export type ThreadOwner = z.infer<typeof ThreadOwner>;

/**
 * What differs between places, in one table, so a window asks a question of the place rather than naming one.
 *   mark       the quiet word for where it lives; null for the answering host's own rows
 *   elsewhere  its threads have no folder on this Mac (no terminal, files, fork or subthread)
 *   rowIcon    a sidebar row says where it lives with the cloud icon rather than in its words
 */
export interface Place {
  mark: string | null;
  elsewhere: boolean;
  rowIcon: boolean;
}

export const PLACES: Record<Brain, Place> = {
  mac: { mark: null, elsewhere: false, rowIcon: false },
  hosted: { mark: "OpenOrc Cloud", elsewhere: true, rowIcon: true },
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

/**
 * A thread's code as the place that holds it has it now, for a read-only copy on this Mac. Kept from the person's own
 * cloud for OpenOrc Cloud's code coming back to the Mac; nothing sends one today.
 */
export interface MirrorSnapshot {
  /** The working tree as one commit on `head`, uncommitted and untracked work included. */
  snapshot: string;
  tree: string;
  head: string | null;
  branch: string | null;
  /** A git bundle of what the Mac lacks, base64; null when it has the snapshot already. */
  bundle: string | null;
}
