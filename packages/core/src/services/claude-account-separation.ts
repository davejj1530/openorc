import { claudeAccounts, runs, threads, type Db } from "@openorc/db";
import { ACCOUNTS_KEPT_SEPARATE, DEFAULT_CLAUDE_ACCOUNT, type Orcling, type Task, type Thread } from "@openorc/protocol";
import { AppSettingsService } from "./settings.js";

export { ACCOUNTS_KEPT_SEPARATE };
export const STAYS_ON_ITS_ACCOUNT = `${ACCOUNTS_KEPT_SEPARATE}, so a conversation stays on its account.`;

export function accountsSeparate(db: Db): boolean {
  return new AppSettingsService(db).get().claudeAccountsSeparate;
}

/** The Claude account a thread's work belongs to. Another agent's thread belongs to the account it was started under. */
export function threadAccount(thread: Pick<Thread, "claudeAccountId">): string {
  return thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT;
}

export function reachableTitle(reach: (account: string) => boolean, thread: Pick<Thread, "title" | "claudeAccountId"> | null | undefined): string | undefined {
  return thread && reach(threadAccount(thread)) ? thread.title : undefined;
}

export function runAccount(db: Db, runId: string, thread: Pick<Thread, "claudeAccountId"> | null): string {
  return runs.get(db, runId)?.claudeAccountId ?? (thread ? threadAccount(thread) : DEFAULT_CLAUDE_ACCOUNT);
}

/** Every account's work, as one shared function, so reachesTask can skip reading a task's thread when none is held back. */
const everyAccount = (): boolean => true;

/** Which accounts' work a speaker on `from` may see and reach: any, or only its own while accounts are kept separate. */
export function accountReach(db: Db, from: string): (account: string) => boolean {
  if (!accountsSeparate(db)) return everyAccount;
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

export function reachesTask(db: Db, reach: (account: string) => boolean, task: Pick<Task, "executionThreadId" | "threadId">): boolean {
  if (reach === everyAccount) return true;
  const account = taskOwnerAccount(db, task);
  return account === null || reach(account);
}

export function keptTaskAccount(db: Db, task: Pick<Task, "executionThreadId" | "threadId">): string | null {
  return accountsSeparate(db) ? taskOwnerAccount(db, task) : null;
}

export function assertOnTaskAccount(db: Db, task: Pick<Task, "executionThreadId" | "threadId">, account: string): void {
  const kept = keptTaskAccount(db, task);
  if (!kept || kept === account) return;
  const name = claudeAccounts.list(db).find((candidate) => candidate.id === kept)?.name ?? "another Claude account";
  throw new Error(`This task is on ${name}, and ${ACCOUNTS_KEPT_SEPARATE}, so its work stays there.`);
}

export function orclingOnAnotherAccount(db: Db, orcling: Pick<Orcling, "claudeAccountId">, thread: Pick<Thread, "claudeAccountId">): boolean {
  return accountsSeparate(db) && orcling.claudeAccountId !== threadAccount(thread);
}

export function assertOrclingOnTaskAccount(db: Db, task: Pick<Task, "executionThreadId" | "threadId">, orcling: Pick<Orcling, "name" | "claudeAccountId">): void {
  const kept = keptTaskAccount(db, task);
  if (kept && kept !== orcling.claudeAccountId) throw new Error(`${orcling.name} works on another Claude account than this task's, and ${ACCOUNTS_KEPT_SEPARATE}.`);
}
