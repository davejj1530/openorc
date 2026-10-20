import { claudeAccounts, runs, threads, type Db } from "@openorc/db";
import { DEFAULT_CLAUDE_ACCOUNT } from "@openorc/protocol";
import type { StartRunInput } from "./run-types.js";

/**
 * A saved conversation or earlier run keeps its account when the default changes. A team member that names its own
 * account runs on it, in the conversation as in its tasks.
 */
export function claudeRunAccount(db: Db, input: StartRunInput): string {
  const member = teamMemberAccount(input);
  if (member) return member;
  if (input.scope.thread) return input.scope.thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
  const commentRun = input.scope.comment?.resumeRunId ? runs.get(db, input.scope.comment.resumeRunId) : null;
  if (commentRun?.agent === "claude") return commentRun.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
  if (input.claudeAccountId) return input.claudeAccountId;
  const task = input.scope.task ?? input.scope.comment?.task;
  if (task) {
    const previous = runs.listForTask(db, task.id).findLast((run) => run.agent === "claude");
    if (previous) return previous.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
    const threadId = task.executionThreadId ?? task.threadId;
    if (threadId) return threads.get(db, threadId)?.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
  }
  return claudeAccounts.defaultId(db);
}

/** The account a team member's turn names for itself, if any. */
function teamMemberAccount(input: StartRunInput): string | null {
  return input.teamAttemptId ? (input.claudeAccountId ?? null) : null;
}
