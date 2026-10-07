import { claudeAccounts, runs, threads, type Db } from "@openorc/db";
import { DEFAULT_CLAUDE_ACCOUNT } from "@openorc/protocol";
import type { StartRunInput } from "./run-types.js";

/** A saved conversation or earlier run keeps its account when the default changes. */
export function claudeRunAccount(db: Db, input: StartRunInput): string {
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
