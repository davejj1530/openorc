import { claudeAccounts, orclings, runs, threads, type Db } from "@openorc/db";
import { DEFAULT_CLAUDE_ACCOUNT, type Task } from "@openorc/protocol";
import { startingAccount } from "./project-claude-accounts.js";
import type { StartRunInput } from "./run-types.js";

/** Saved conversations keep their account; an Orcling speaks on its own account wherever it is asked. */
export function claudeRunAccount(db: Db, input: StartRunInput): string {
  const commentRun = input.scope.comment?.resumeRunId ? runs.get(db, input.scope.comment.resumeRunId) : null;
  if (commentRun?.agent === "claude") return commentRun.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
  const orcling = input.orclingId ? orclings.get(db, input.orclingId) : null;
  if (orcling) return orcling.claudeAccountId;
  if (input.scope.thread) return input.scope.thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
  if (input.claudeAccountId) return input.claudeAccountId;
  const task = input.scope.task ?? input.scope.comment?.task;
  return task ? taskAccount(db, task) : claudeAccounts.defaultId(db);
}

/** A task goes on with the account of its last Claude run, else of its conversation, else its project's default. */
function taskAccount(db: Db, task: Task): string {
  const previous = runs.listForTask(db, task.id).findLast((run) => run.agent === "claude");
  if (previous) return previous.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
  const threadId = task.executionThreadId ?? task.threadId;
  return threadId ? (threads.get(db, threadId)?.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT) : startingAccount(db, task.projectId, undefined);
}
