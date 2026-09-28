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
