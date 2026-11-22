import { orclings, projects, pullReviews, runs, tasks, threads, type Db } from "@openorc/db";
import { resolveCommentMentions, type InboxList, type Orcling, type OrclingChatSummary, type OrclingDraft, type Task, type ThreadSummary } from "@openorc/protocol";
import { ACCOUNTS_KEPT_SEPARATE, STAYS_ON_ITS_ACCOUNT, accountReach, accountsSeparate, reachesTask, threadAccount } from "../services/claude-account-separation.js";
import { projectAccountPolicy } from "../services/project-claude-accounts.js";
import { reviewGoesOn } from "../services/pull-requests.js";
import type { RunService } from "../services/runs.js";
import { recipientCatalog } from "../services/task-side-runs.js";

type Reach = (account: string) => boolean;
/** Whether OpenOrc Cloud holds a thread or run. */
export type CloudHolds = (ref: { thread: string } | { run: string }) => boolean;

/**
 * The Orclings a comment asks by @name, in its text or, when it asks about the description, in its task's description,
 * read as the comment service reads them. A name it can't read fails here as it would there.
 */
export async function mentionedOrclings(db: Db, runService: Pick<RunService, "models">, method: string, params: Record<string, unknown>): Promise<string[]> {
  if (method !== "tasks.comments.post" || !accountsSeparate(db)) return [];
  const task = typeof params["taskId"] === "string" ? tasks.get(db, params["taskId"]) : null;
  const text = params["source"] === "description" ? (task?.spec ?? "") : String(params["body"] ?? "");
  if (!/(?:^|\s)@/.test(text)) return [];
  return resolveCommentMentions(text, await recipientCatalog(runService), orclings.list(db)).flatMap((recipient) => recipient.orclingId ?? []);
}

/**
 * While accounts are kept separate, what an Orcling does for the person stays on its own Claude account: it acts on no
 * thread, run, task, Orcling or review of another account, starts threads, reviews and Orclings only on its own, and
 * moves no conversation to another.
 */
export function separateAccountsRefusal(
  db: Db,
  self: Orcling,
  method: string,
  params: Record<string, unknown>,
  { inCloud, mentioned = [] }: { inCloud?: CloudHolds; mentioned?: readonly string[] } = {},
): string | null {
  if (!accountsSeparate(db)) return null;
  const named = namedAccountRefusal(self, method, params);
  if (named) return named;
  if (reachesCloud(method, params, inCloud)) return `${ACCOUNTS_KEPT_SEPARATE}, so you don't reach OpenOrc Cloud's threads and tasks, which no account here holds.`;
  if (method === "runs.start" && startsLooseTask(db, params))
    return `${ACCOUNTS_KEPT_SEPARATE}, so take up a task that has no conversation with orcling_thread_start, which starts it on your own Claude account.`;
  const reach = accountReach(db, self.claudeAccountId);
  const drafted = (params["draft"] as Partial<OrclingDraft> | undefined)?.claudeAccountId;
  if (drafted && !reach(drafted)) return `${ACCOUNTS_KEPT_SEPARATE}, so you keep Orclings on your own Claude account.`;
  const reviewOn = method === "pulls.review.start" ? reviewAccount(db, params) : null;
  if (reviewOn && !reach(reviewOn)) return `That review runs on another Claude account, and ${ACCOUNTS_KEPT_SEPARATE}.`;
  return reachesAll(db, reach, method, params, mentioned) ? null : `That belongs to another Claude account, and ${ACCOUNTS_KEPT_SEPARATE}.`;
}

/** Why a call that moves a conversation, or names a Claude account that is not the Orcling's own, is refused. */
function namedAccountRefusal(self: Orcling, method: string, params: Record<string, unknown>): string | null {
  const chosen = params["claudeAccountId"];
  const elsewhere = typeof chosen === "string" && chosen !== self.claudeAccountId;
  if (method === "threads.switchClaudeAccount" || (method === "runs.start" && elsewhere)) return STAYS_ON_ITS_ACCOUNT;
  if (method === "threads.start" && elsewhere) return `${ACCOUNTS_KEPT_SEPARATE}, so you start threads only on your own Claude account.`;
  if (method === "threads.list" && elsewhere) return `That belongs to another Claude account, and ${ACCOUNTS_KEPT_SEPARATE}.`;
  return null;
}

/** Whether a call reaches OpenOrc Cloud: a space's threads or tasks, a cloud thread started, or a thread or run the cloud holds. */
function reachesCloud(method: string, params: Record<string, unknown>, inCloud: CloudHolds | undefined): boolean {
  if (typeof params["spaceId"] === "string" || (method === "threads.start" && params["hosted"])) return true;
  const id = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : null);
  const threadIds = [id("threadId"), id("parentThreadId"), method.startsWith("threads.") ? id("id") : null];
  const runId = id("runId");
  return Boolean(inCloud && (threadIds.some((thread) => thread && inCloud({ thread })) || (runId && inCloud({ run: runId }))));
}

/** Whether the call starts a task that has no conversation yet: its thread would go on its project's default account. */
function startsLooseTask(db: Db, params: Record<string, unknown>): boolean {
  const { taskId, threadId } = params;
  if (typeof taskId !== "string" || typeof threadId === "string") return false;
  const task = tasks.get(db, taskId);
  return Boolean(task && !task.executionThreadId && !task.threadId);
}

/** The ids a call names inside an object or a list: the Orcling a start is handed to, a file scope's thread or task, and each Orcling a comment asks. */
function nestedIds(params: Record<string, unknown>): { threadIds: string[]; taskIds: string[]; orclingIds: string[] } {
  const target = params["executionTarget"] as { kind?: string; orclingId?: string } | null | undefined;
  const scope = params["scope"] as { kind?: string; id?: string } | undefined;
  const recipients = Array.isArray(params["recipients"]) ? (params["recipients"] as { orclingId?: string }[]) : [];
  const scoped = (kind: "thread" | "task") => (scope?.kind === kind && scope.id ? [scope.id] : []);
  return {
    threadIds: scoped("thread"),
    taskIds: scoped("task"),
    orclingIds: [...(target?.kind === "orcling" && target.orclingId ? [target.orclingId] : []), ...recipients.flatMap((recipient) => recipient.orclingId ?? [])],
  };
}

/** Every thread, run, task, Orcling and review the call names, by the parameter names the methods use, and each Orcling a comment asks by @name. */
function reachesAll(db: Db, reach: Reach, method: string, params: Record<string, unknown>, mentioned: readonly string[]): boolean {
  const id = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : null);
  const run = id("runId") ? runs.get(db, id("runId")!) : null;
  const review = method.startsWith("pulls.review.") ? reviewConversation(db, params) : null;
  const nested = nestedIds(params);
  const threadIds = [id("threadId"), id("parentThreadId"), method.startsWith("threads.") ? id("id") : null, run?.threadId ?? null, review?.id ?? null, ...nested.threadIds];
  const taskIds = [id("taskId"), method.startsWith("tasks.") ? id("id") : null, ...nested.taskIds];
  const orclingIds = [method.startsWith("orclings.") ? id("id") : null, id("orclingId"), ...nested.orclingIds, ...mentioned];
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
  if (reviewGoesOn(conversation)) return threadAccount(conversation);
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

/** The rows of another account, and OpenOrc Cloud's, left out of the lists an Orcling reads while accounts are kept separate. */
export function keptToOwnAccount(db: Db, self: Orcling, method: string, result: unknown): unknown {
  if (!accountsSeparate(db)) return result;
  const reach = accountReach(db, self.claudeAccountId);
  const local = (thread: Pick<ThreadSummary, "owner" | "claudeAccountId">) => thread.owner?.brain !== "hosted" && reach(threadAccount(thread));
  if (method === "threads.list") return (result as ThreadSummary[]).filter(local);
  if (method === "tasks.list") return (result as Task[]).filter((task) => reachesTask(db, reach, task));
  if (method === "orclings.chats") return (result as OrclingChatSummary[]).filter((chat) => reach(orclings.get(db, chat.id)?.claudeAccountId ?? ""));
  if (method === "inbox.list") {
    const inbox = result as InboxList;
    return { ...inbox, items: inbox.items.filter((item) => (item.kind === "thread" ? local(item.thread) : reachesTask(db, reach, item.task))) };
  }
  return result;
}
