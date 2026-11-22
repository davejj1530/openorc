import { claudeAccounts, runs, threads, type Db } from "@openorc/db";
import { DEFAULT_CLAUDE_ACCOUNT, type Task, type Thread } from "@openorc/protocol";
import { AppSettingsService } from "./settings.js";

export const ACCOUNTS_KEPT_SEPARATE = "Settings keeps Claude accounts separate";
/** Why no one, the person included, moves a conversation to another account while accounts are kept separate. */
export const STAYS_ON_ITS_ACCOUNT = `${ACCOUNTS_KEPT_SEPARATE}, so a conversation stays on the account it started on.`;

/** Whether Settings keeps Claude accounts separate, so work on one never sees or reaches work on another. */
export function accountsSeparate(db: Db): boolean {
  return new AppSettingsService(db).get().claudeAccountsSeparate;
}

/** The Claude account a thread's work belongs to. Another agent's thread belongs to the account it was started under. */
export function threadAccount(thread: Pick<Thread, "claudeAccountId">): string {
  return thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
}

/** A thread's title, kept back when the thread is on an account the speaker can't reach. */
export function reachableTitle(reach: (account: string) => boolean, thread: Pick<Thread, "title" | "claudeAccountId"> | null | undefined): string | undefined {
  return thread && reach(threadAccount(thread)) ? thread.title : undefined;
}

/** The account a run's agent speaks for: the one it runs on, else its thread's. */
export function runAccount(db: Db, runId: string, thread: Pick<Thread, "claudeAccountId"> | null): string {
  return runs.get(db, runId)?.claudeAccountId ?? (thread ? threadAccount(thread) : DEFAULT_CLAUDE_ACCOUNT);
}

/** Which accounts' work a speaker on `from` may see and reach: any, or only its own while accounts are kept separate. */
export function accountReach(db: Db, from: string): (account: string) => boolean {
  if (!accountsSeparate(db)) return () => true;
  return (account) => account === from;
}

/** The thread list filter that keeps a speaker on `from` to its own account while accounts are kept separate. */
export function listedAccount(db: Db, from: string): { claudeAccountId?: string } {
  return accountsSeparate(db) ? { claudeAccountId: from } : {};
}

/** The account a task belongs to: the one of the thread it runs in, else of the thread that saved it; none with neither. */
export function taskOwnerAccount(db: Db, task: Pick<Task, "executionThreadId" | "threadId">): string | null {
  const owner = task.executionThreadId ?? task.threadId;
  const thread = owner ? threads.get(db, owner) : null;
  return thread ? threadAccount(thread) : null;
}

/** A task belongs to the account of the thread it runs in, else of the thread that saved it; one with neither is anyone's. */
export function reachesTask(db: Db, reach: (account: string) => boolean, task: Pick<Task, "executionThreadId" | "threadId">): boolean {
  const account = taskOwnerAccount(db, task);
  return account === null || reach(account);
}

/** The account a task's new threads and Refines stay on while accounts are kept separate; none when any will do. */
export function keptTaskAccount(db: Db, task: Pick<Task, "executionThreadId" | "threadId">): string | null {
  return accountsSeparate(db) ? taskOwnerAccount(db, task) : null;
}

/** Refuses work on a task on another account than the one it belongs to, while accounts are kept separate. */
export function assertOnTaskAccount(db: Db, task: Pick<Task, "executionThreadId" | "threadId">, account: string): void {
  const kept = keptTaskAccount(db, task);
  if (!kept || kept === account) return;
  const name = claudeAccounts.list(db).find((candidate) => candidate.id === kept)?.name ?? "another Claude account";
  throw new Error(`This task is on ${name}, and ${ACCOUNTS_KEPT_SEPARATE}, so its work stays there.`);
}
