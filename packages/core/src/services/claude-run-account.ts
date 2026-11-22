import { claudeAccounts, orclings, runs, type Db } from "@openorc/db";
import { DEFAULT_CLAUDE_ACCOUNT, type Task } from "@openorc/protocol";
import { keptTaskAccount, taskOwnerAccount } from "./claude-account-separation.js";
import { startingAccount } from "./project-claude-accounts.js";
import type { StartRunInput } from "./run-types.js";

/** Saved conversations keep their account; an Orcling speaks on its own account wherever it is asked. */
export function claudeRunAccount(db: Db, input: Pick<StartRunInput, "scope" | "orclingId" | "claudeAccountId">): string {
  const resumed = resumedReplyAccount(db, input.scope.comment?.resumeRunId);
  if (resumed) return resumed;
  const orcling = input.orclingId ? orclings.get(db, input.orclingId) : null;
  if (orcling) return orcling.claudeAccountId;
  if (input.scope.thread) return input.scope.thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
  if (input.claudeAccountId) return input.claudeAccountId;
  const task = input.scope.task ?? input.scope.comment?.task;
  return task ? taskAccount(db, task) : claudeAccounts.defaultId(db);
}

/** The account a fresh reply to a comment on the task runs on, as claudeRunAccount gives it: an Orcling's own, else the task's. */
export function commentReplyAccount(db: Db, task: Task, orclingId?: string): string {
  const orcling = orclingId ? orclings.get(db, orclingId) : null;
  return orcling ? orcling.claudeAccountId : taskAccount(db, task);
}

function resumedReplyAccount(db: Db, runId: string | undefined): string | null {
  const run = runId ? runs.get(db, runId) : null;
  return run?.agent === "claude" ? (run.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT) : null;
}

/**
 * A task goes on with the account it is on while accounts are kept separate; else with the account of its last Claude
 * run, else of its conversation, else its project's default.
 */
function taskAccount(db: Db, task: Task): string {
  const kept = keptTaskAccount(db, task);
  if (kept) return kept;
  const previous = runs.listForTask(db, task.id).findLast((run) => run.agent === "claude");
  if (previous) return previous.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
  return taskOwnerAccount(db, task) ?? startingAccount(db, task.projectId, undefined);
}
