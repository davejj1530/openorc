import { z } from "zod";
import type { PrState } from "./domain.js";

/** The conversation, or legacy task, a worktree folder belongs to. */
export const WorktreeOwner = z.object({ kind: z.enum(["thread", "task"]), id: z.string() });
export type WorktreeOwner = z.infer<typeof WorktreeOwner>;

/**
 * Why a worktree cannot be removed now. `working`: a turn, an approval, a background command or a workspace operation
 * holds it. `shared`: a legacy task's saved review history or a hidden record lives in the same folder. `cloud`: the
 * folder follows a cloud sandbox.
 */
export type WorktreeBlock = "working" | "shared" | "cloud";

/** Why a blocked worktree stays, in the words both the refusal and the disabled row use. */
export const WORKTREE_BLOCK_WORDS: Record<WorktreeBlock, string> = {
  working: "In use. Wait for its turn, approval or background commands to finish.",
  shared: "Other saved work uses this folder.",
  cloud: "This folder follows a cloud sandbox.",
};

/** One worktree folder on this Mac's disk. Folders shared by forks and threads started in them are one row. */
export interface WorktreeEntry {
  owner: WorktreeOwner;
  title: string;
  projectId: string;
  projectName: string;
  path: string;
  branch: string | null;
  bytes: number;
  lastActivityAt: number;
  /** The facts the client reads to suggest what to clean up, as it reads them for the sidebar's Resolved. */
  archivedAt: number | null;
  pinnedAt: number | null;
  snoozedUntil: number | null;
  parentThreadId: string | null;
  prState: PrState | null;
  blocked: WorktreeBlock | null;
}

export interface WorktreeRemoval {
  removed: WorktreeOwner[];
  failed: { owner: WorktreeOwner; message: string }[];
}

export const worktreeRpcParams = {
  /** Every worktree folder that exists on this Mac, with its size. */
  "worktrees.list": z.object({}),
  /**
   * Removes worktree folders and keeps their branches, with uncommitted work committed first, and their conversations.
   * One failure leaves the rest to go ahead.
   */
  "worktrees.remove": z.object({ owners: z.array(WorktreeOwner).min(1).max(500) }),
};

export interface WorktreeRpcResults {
  "worktrees.list": { worktrees: WorktreeEntry[] };
  "worktrees.remove": WorktreeRemoval;
}
