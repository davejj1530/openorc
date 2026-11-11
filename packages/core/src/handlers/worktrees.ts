import type { WorktreeCleanup } from "../services/worktree-cleanup.js";
import type { Handlers } from "./types.js";

export function createWorktreeHandlers({ worktrees }: { worktrees: Pick<WorktreeCleanup, "list" | "remove"> }): Pick<Handlers, "worktrees.list" | "worktrees.remove"> {
  return {
    "worktrees.list": async () => ({ worktrees: await worktrees.list() }),
    "worktrees.remove": ({ owners }) => worktrees.remove(owners),
  };
}
