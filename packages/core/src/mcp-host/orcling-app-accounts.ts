import { runs, tasks, threads, type Db } from "@openorc/db";
import type { InboxList, Orcling, Task, ThreadSummary } from "@openorc/protocol";
import { ACCOUNTS_KEPT_SEPARATE, accountReach, accountsSeparate, reachesTask, threadAccount } from "../services/claude-account-separation.js";

type Reach = (account: string) => boolean;

/**
 * While accounts are kept separate, what an Orcling does for the person stays on its own Claude account: it acts on no
 * thread, run or task of another account, starts threads only on its own, and moves no conversation to another.
 */
export function separateAccountsRefusal(db: Db, self: Orcling, method: string, params: Record<string, unknown>): string | null {
  if (!accountsSeparate(db)) return null;
  if (method === "threads.switchClaudeAccount") return `${ACCOUNTS_KEPT_SEPARATE}, so only the person moves a conversation to another account.`;
  const chosen = params["claudeAccountId"];
  if (method === "threads.start" && typeof chosen === "string" && chosen !== self.claudeAccountId) return `${ACCOUNTS_KEPT_SEPARATE}, so you start threads only on your own Claude account.`;
  return reachesAll(db, accountReach(db, self.claudeAccountId), method, params) ? null : `That belongs to another Claude account, and ${ACCOUNTS_KEPT_SEPARATE}.`;
}

/** Every thread, run and task the call names, by the parameter names the methods use. */
function reachesAll(db: Db, reach: Reach, method: string, params: Record<string, unknown>): boolean {
  const id = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : null);
  const run = id("runId") ? runs.get(db, id("runId")!) : null;
  const threadIds = [id("threadId"), id("parentThreadId"), method.startsWith("threads.") ? id("id") : null, run?.threadId ?? null];
  const taskIds = [id("taskId"), method.startsWith("tasks.") ? id("id") : null];
  const named = threadIds.flatMap((threadId) => (threadId ? [threads.get(db, threadId)] : [])).filter((thread) => thread !== null);
  if (run && !run.threadId && run.claudeAccountId && !reach(run.claudeAccountId)) return false;
  if (!named.every((thread) => reach(threadAccount(thread)))) return false;
  return taskIds.every((taskId) => {
    const task = taskId ? tasks.get(db, taskId) : null;
    return !task || reachesTask(db, reach, task);
  });
}

/** A thread an Orcling starts for the person goes on its own account while accounts are kept separate. */
export function onOwnAccount<P>(db: Db, self: Orcling, method: string, params: P): P {
  if (method !== "threads.start" || !accountsSeparate(db)) return params;
  const given = params as Record<string, unknown>;
  return (given["claudeAccountId"] ? params : { ...given, claudeAccountId: self.claudeAccountId }) as P;
}

/** The rows of another account left out of the lists an Orcling reads while accounts are kept separate. */
export function keptToOwnAccount(db: Db, self: Orcling, method: string, result: unknown): unknown {
  if (!accountsSeparate(db)) return result;
  const reach = accountReach(db, self.claudeAccountId);
  if (method === "threads.list") return (result as ThreadSummary[]).filter((thread) => reach(threadAccount(thread)));
  if (method === "tasks.list") return (result as Task[]).filter((task) => reachesTask(db, reach, task));
  if (method === "inbox.list") {
    const inbox = result as InboxList;
    return { ...inbox, items: inbox.items.filter((item) => (item.kind === "thread" ? reach(threadAccount(item.thread)) : reachesTask(db, reach, item.task))) };
  }
  return result;
}
