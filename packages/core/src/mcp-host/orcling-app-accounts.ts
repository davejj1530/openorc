import { orclings, projects, pullReviews, runs, tasks, threads, type Db } from "@openorc/db";
import type { InboxList, Orcling, OrclingChatSummary, OrclingDraft, Task } from "@openorc/protocol";
import { ACCOUNTS_KEPT_SEPARATE, accountReach, accountsSeparate, reachesTask, threadAccount } from "../services/claude-account-separation.js";
import { projectAccountPolicy } from "../services/project-claude-accounts.js";

type Reach = (account: string) => boolean;

/**
 * While accounts are kept separate, what an Orcling does for the person stays on its own Claude account: it acts on no
 * thread, run, task, Orcling or review of another account, starts threads, reviews and Orclings only on its own, and
 * moves no conversation to another.
 */
export function separateAccountsRefusal(db: Db, self: Orcling, method: string, params: Record<string, unknown>): string | null {
  if (!accountsSeparate(db)) return null;
  if (method === "threads.switchClaudeAccount") return `${ACCOUNTS_KEPT_SEPARATE}, so only the person moves a conversation to another account.`;
  const chosen = params["claudeAccountId"];
  if (method === "threads.start" && typeof chosen === "string" && chosen !== self.claudeAccountId) return `${ACCOUNTS_KEPT_SEPARATE}, so you start threads only on your own Claude account.`;
  const reach = accountReach(db, self.claudeAccountId);
  const drafted = (params["draft"] as Partial<OrclingDraft> | undefined)?.claudeAccountId;
  if (drafted && !reach(drafted)) return `${ACCOUNTS_KEPT_SEPARATE}, so you keep Orclings on your own Claude account.`;
  const reviewOn = method === "pulls.review.start" ? reviewAccount(db, params) : null;
  if (reviewOn && !reach(reviewOn)) return `That review runs on another Claude account, and ${ACCOUNTS_KEPT_SEPARATE}.`;
  const listedElsewhere = method === "threads.list" && typeof chosen === "string" && chosen !== self.claudeAccountId;
  return !listedElsewhere && reachesAll(db, reach, method, params) ? null : `That belongs to another Claude account, and ${ACCOUNTS_KEPT_SEPARATE}.`;
}

/** Every thread, run, task, Orcling and review the call names, by the parameter names the methods use. */
function reachesAll(db: Db, reach: Reach, method: string, params: Record<string, unknown>): boolean {
  const id = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : null);
  const run = id("runId") ? runs.get(db, id("runId")!) : null;
  const review = method.startsWith("pulls.review.") ? reviewConversation(db, params) : null;
  const threadIds = [id("threadId"), id("parentThreadId"), method.startsWith("threads.") ? id("id") : null, run?.threadId ?? null, review?.id ?? null];
  const taskIds = [id("taskId"), method.startsWith("tasks.") ? id("id") : null];
  const orclingIds = [method.startsWith("orclings.") ? id("id") : null, id("orclingId")];
  const named = threadIds.flatMap((threadId) => (threadId ? [threads.get(db, threadId)] : [])).filter((thread) => thread !== null);
  const others = orclingIds.flatMap((orclingId) => (orclingId ? [orclings.get(db, orclingId)] : [])).filter((orcling) => orcling !== null);
  if (run && !run.threadId && run.claudeAccountId && !reach(run.claudeAccountId)) return false;
  if (!named.every((thread) => reach(threadAccount(thread)))) return false;
  if (!others.every((orcling) => reach(orcling.claudeAccountId))) return false;
  return taskIds.every((taskId) => {
    const task = taskId ? tasks.get(db, taskId) : null;
    return !task || reachesTask(db, reach, task);
  });
}

/** The conversation a pull request's review keeps, when it has one on this Mac. */
function reviewConversation(db: Db, params: Record<string, unknown>) {
  const { projectId, number } = params;
  if (typeof projectId !== "string" || typeof number !== "number") return null;
  const threadId = pullReviews.get(db, { projectId, number })?.threadId;
  return threadId ? threads.get(db, threadId) : null;
}

/**
 * The account a review would run on, as PullRequests.start decides: another round in its open conversation, else a new
 * one on the project's default. None for a project only OpenOrc Cloud has, whose review runs there.
 */
function reviewAccount(db: Db, params: Record<string, unknown>): string | null {
  const projectId = String(params["projectId"]);
  if (!projects.get(db, projectId)) return null;
  const conversation = reviewConversation(db, params);
  if (conversation && conversation.archivedAt === null && conversation.worktreePath) return threadAccount(conversation);
  return projectAccountPolicy(db, projectId).defaultId;
}

/** Threads an Orcling starts or lists, and Orclings it makes, are on its own account while accounts are kept separate. */
export function onOwnAccount<P>(db: Db, self: Orcling, method: string, params: P): P {
  if (!accountsSeparate(db)) return params;
  const given = params as Record<string, unknown>;
  if (method === "threads.start" || method === "threads.list") return (given["claudeAccountId"] ? params : { ...given, claudeAccountId: self.claudeAccountId }) as P;
  const draft = given["draft"] as Partial<OrclingDraft> | undefined;
  if (method === "orclings.create" && draft && !draft.claudeAccountId) return { ...given, draft: { ...draft, claudeAccountId: self.claudeAccountId } } as P;
  return params;
}

/** The rows of another account left out of the lists an Orcling reads while accounts are kept separate. */
export function keptToOwnAccount(db: Db, self: Orcling, method: string, result: unknown): unknown {
  if (!accountsSeparate(db)) return result;
  const reach = accountReach(db, self.claudeAccountId);
  if (method === "tasks.list") return (result as Task[]).filter((task) => reachesTask(db, reach, task));
  if (method === "orclings.chats") return (result as OrclingChatSummary[]).filter((chat) => reach(orclings.get(db, chat.id)?.claudeAccountId ?? ""));
  if (method === "inbox.list") {
    const inbox = result as InboxList;
    return { ...inbox, items: inbox.items.filter((item) => (item.kind === "thread" ? reach(threadAccount(item.thread)) : reachesTask(db, reach, item.task))) };
  }
  return result;
}
