import { orclings, projects, pullReviews, runs, tasks, threads, type Db } from "@openorc/db";
import {
  resolveCommentMentions,
  type CommentRecipient,
  type InboxList,
  type ModelExecutionSettings,
  type Orcling,
  type OrclingChatSummary,
  type OrclingDraft,
  type Task,
  type ThreadSummary,
} from "@openorc/protocol";
import { ACCOUNTS_KEPT_SEPARATE, STAYS_ON_ITS_ACCOUNT, accountReach, accountsSeparate, reachesTask, taskOwnerAccount, threadAccount } from "../services/claude-account-separation.js";
import { commentReplyAccount } from "../services/claude-run-account.js";
import { projectAccountPolicy } from "../services/project-claude-accounts.js";
import { reviewRound } from "../services/pull-requests.js";
import type { RunService } from "../services/runs.js";
import { recipientCatalog } from "../services/task-side-runs.js";

type Reach = (account: string) => boolean;
export type CloudHolds = (ref: { thread: string } | { run: string }) => boolean;

/**
 * The Orclings and models a comment asks by @name, in its text or, when it asks about the description, in its task's
 * description, read as the comment service reads them. A name it can't read fails here as it would there.
 */
export async function mentionedRecipients(db: Db, runService: Pick<RunService, "models">, method: string, params: Record<string, unknown>): Promise<CommentRecipient[]> {
  if (method !== "tasks.comments.post" || !accountsSeparate(db)) return [];
  const task = typeof params["taskId"] === "string" ? tasks.get(db, params["taskId"]) : null;
  const text = params["source"] === "description" ? (task?.spec ?? "") : String(params["body"] ?? "");
  if (!/(?:^|\s)@/.test(text)) return [];
  return resolveCommentMentions(text, await recipientCatalog(runService), orclings.list(db));
}

/**
 * While accounts are kept separate, why an Orcling's call is refused: it reaches another account's work or OpenOrc
 * Cloud, starts something on another account, or moves a conversation.
 */
export function separateAccountsRefusal(
  db: Db,
  self: Orcling,
  method: string,
  params: Record<string, unknown>,
  { inCloud, mentioned = [] }: { inCloud?: CloudHolds; mentioned?: readonly CommentRecipient[] } = {},
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
  if (reviewOn && !reach(reviewOn))
    return `That review runs on another Claude account, and ${ACCOUNTS_KEPT_SEPARATE}, so review it as yourself, with your own orclingId, which reviews on your own Claude account.`;
  if (!reachesAll(db, reach, method, params, mentioned)) return `That belongs to another Claude account, and ${ACCOUNTS_KEPT_SEPARATE}.`;
  const elsewhere = method === "tasks.comments.post" ? modelWorksElsewhere(db, self, params, mentioned) : null;
  return elsewhere ? `${elsewhere}, and ${ACCOUNTS_KEPT_SEPARATE}, so start the work with orcling_thread_start instead, which starts it on your own Claude account.` : null;
}

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
  const runId = stringParam(params, "runId");
  return Boolean(inCloud && (threadParams(method, params).some((thread) => thread && inCloud({ thread })) || (runId && inCloud({ run: runId }))));
}

function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === "string" ? value : null;
}

function threadParams(method: string, params: Record<string, unknown>): (string | null)[] {
  return [stringParam(params, "threadId"), stringParam(params, "parentThreadId"), method.startsWith("threads.") ? stringParam(params, "id") : null];
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

function reachesAll(db: Db, reach: Reach, method: string, params: Record<string, unknown>, mentioned: readonly CommentRecipient[]): boolean {
  const id = (key: string) => stringParam(params, key);
  const runId = id("runId");
  const run = runId ? runs.get(db, runId) : null;
  const review = method.startsWith("pulls.review.") ? reviewConversation(db, params) : null;
  const nested = nestedIds(params);
  const threadIds = [...threadParams(method, params), run?.threadId ?? null, review?.id ?? null, ...nested.threadIds];
  const taskIds = [id("taskId"), method.startsWith("tasks.") ? id("id") : null, ...nested.taskIds];
  const orclingIds = [method.startsWith("orclings.") ? id("id") : null, id("orclingId"), ...nested.orclingIds, ...mentioned.flatMap((recipient) => recipient.orclingId ?? [])];
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

function reviewConversation(db: Db, params: Record<string, unknown>) {
  const { projectId, number } = params;
  if (typeof projectId !== "string" || typeof number !== "number") return null;
  const threadId = pullReviews.get(db, { projectId, number })?.threadId;
  return threadId ? threads.get(db, threadId) : null;
}

/** The account a review would run on, as PullRequests.start decides; none for a project only OpenOrc Cloud has, whose review runs there. */
function reviewAccount(db: Db, params: Record<string, unknown>): string | null {
  const projectId = String(params["projectId"]);
  if (!projects.get(db, projectId)) return null;
  const orclingId = stringParam(params, "orclingId");
  const model = { agent: (params["reviewer"] as Pick<ModelExecutionSettings, "agent">).agent, claudeAccountId: stringParam(params, "claudeAccountId") ?? undefined };
  const round = reviewRound(db, reviewConversation(db, params), orclingId ? orclings.get(db, orclingId) : null, model);
  return round.claudeAccountId ?? projectAccountPolicy(db, projectId).defaultId;
}

/**
 * What a model a comment asks, by name or @name, would do on another account than the Orcling's, on a task with no
 * conversation: Claude would answer there, or work another agent agrees to would start the task's thread there.
 */
function modelWorksElsewhere(db: Db, self: Orcling, params: Record<string, unknown>, mentioned: readonly CommentRecipient[]): string | null {
  const task = typeof params["taskId"] === "string" ? tasks.get(db, params["taskId"]) : null;
  if (!task) return null;
  const named = Array.isArray(params["recipients"]) ? (params["recipients"] as CommentRecipient[]) : [];
  const models = [...named, ...mentioned].filter((recipient) => !recipient.orclingId);
  if (models.some((recipient) => recipient.agent === "claude") && commentReplyAccount(db, task) !== self.claudeAccountId) return "A Claude model would answer that comment on another Claude account";
  if (!models.some((recipient) => recipient.agent !== "claude") || taskOwnerAccount(db, task) !== null) return null;
  const startsOn = runs.listForTask(db, task.id).at(-1)?.claudeAccountId ?? projectAccountPolicy(db, task.projectId).defaultId;
  return startsOn === self.claudeAccountId ? null : "Work a model agrees to in that comment would start on another Claude account";
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
