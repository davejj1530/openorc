import { z } from "zod";
import type { FileChange } from "./domain.js";

/** What a move or a restore would change, for its confirmation. `blocked` says why it cannot run at all. */
export interface ChangePreview {
  files: FileChange[];
  blocked: string | null;
}

/** What deleting a branch would lose: uncommitted files in its worktree, and commits no other branch, remote or tag holds. */
export const BranchLoss = z.object({ uncommitted: z.number().int().nonnegative(), commits: z.number().int().nonnegative() });
export type BranchLoss = z.infer<typeof BranchLoss>;

export interface RemovalImpact extends BranchLoss {
  branch: string | null;
}

/** What a conversation's changes are measured against: HEAD (uncommitted work), or where its worktree branched. */
export const ChangeComparison = z.enum(["head", "base"]);
export type ChangeComparison = z.infer<typeof ChangeComparison>;
/** A changes list names this many files at most; its totals still count every file. */
export const CHANGES_LISTED = 2_000;
/** One file's diff stops at this many lines, or this many bytes, at a line end. */
export const FILE_DIFF_LINES = 5_000;
export const FILE_DIFF_BYTES = 512 * 1024;

/** What a file's diff adds and removes, or why it has no text diff (untracked over 1 MB, a socket or a fifo). */
export type FileDiffBody = { kind: "text"; insertions: number; deletions: number } | { kind: "binary" } | { kind: "omitted"; reason: "large" | "special"; bytes: number | null };
export interface FileChangeStat extends FileChange {
  body: FileDiffBody;
}

/** A conversation's changes as a list: totals over every file, the first CHANGES_LISTED in git's order. */
export interface WorkspaceChanges {
  comparison: ChangeComparison;
  baseSha: string | null;
  totals: { files: number; insertions: number; deletions: number };
  files: FileChangeStat[];
  unlisted: number;
}

/** One file's hunks without git's header lines, cut at FILE_DIFF_LINES or FILE_DIFF_BYTES at a line end. */
export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: FileChange["status"];
  body: FileDiffBody;
  patch: string;
  cut: { shownLines: number; totalLines: number } | null;
}
