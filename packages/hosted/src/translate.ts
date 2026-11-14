/** Where the server's answers become the app's shapes. Pure functions, no I/O. */
import {
  AgentEvent,
  hostedRunId,
  isHostedAgent,
  isHostedRefusal,
  PRO_PERIODS,
  sendBlockWords,
  type AccountSignIn,
  type QueuedMessage,
  type AccountPlan,
  type AccountReach,
  type AccountSandbox,
  type BillingOffers,
  type CloudHours,
  type Frame,
  type Run,
  type RpcParams,
  type ThreadActivity,
  type ThreadSummary,
} from "@openorc/protocol";
import type { WireBilling, WireOffers, WireEvent, WireHostedSettings, WireProject, WireSignIn, WireThread } from "./wire.js";

/** The plan and the hours left. Free carries no hours; a Pro month not paid for yet carries packs alone. */
export function toPlan(billing: WireBilling): { plan: AccountPlan; hours: CloudHours | null } {
  const { pro } = billing;
  if (pro.status === "free") return { plan: { pro: false }, hours: null };
  const at = Date.parse(pro.standing === "live" ? pro.renewsAt : pro.until);
  const month = billing.monthly && billing.period ? { grantedSeconds: billing.monthly.grantedSeconds, leftSeconds: billing.monthly.leftSeconds, resetsAt: Date.parse(billing.period.endsAt) } : null;
  const packsLeftSeconds = billing.packs.reduce((sum, pack) => sum + pack.leftSeconds, 0);
  return {
    plan: { pro: true, standing: pro.standing, at },
    hours: { leftSeconds: (month?.leftSeconds ?? 0) + packsLeftSeconds, monthly: month, packsLeftSeconds },
  };
}

/** What can be bought, by the periods this app pays by; a period a newer server adds is left out. */
export function toOffers(offers: WireOffers): BillingOffers {
  return {
    monthlySeconds: offers.monthlySeconds,
    pro: PRO_PERIODS.flatMap((period) => offers.pro.filter((offer) => offer.plan === period).map((offer) => ({ period, price: offer.price }))),
    hours: offers.hours,
  };
}

/** Where cloud threads run, in the server's own names for its services. */
export function toSandbox(settings: WireHostedSettings): AccountSandbox {
  return { chosen: settings.service, fallback: settings.defaultService, services: settings.served.map(({ service, name }) => ({ id: service, name })) };
}

/** Which sign-in a turn runs on: the agent's, and for OpenCode the provider its model names. */
export const signInKey = (agent: string, provider: string | null): string => (provider ? `${agent}:${provider}` : agent);

/**
 * The person's sign-ins on OpenOrc Cloud, each ended when the server refused a turn on it as signed out and it has not
 * been set again since. Agents this build does not run on OpenOrc Cloud are left out.
 */
export function toSignIns(rows: readonly WireSignIn[], ended: readonly { key: string; checkedAt: string | null }[]): AccountSignIn[] {
  return rows.flatMap((row) => {
    if (!isHostedAgent(row.agent)) return [];
    const key = signInKey(row.agent, row.agent === "opencode" ? row.provider : null);
    return [{ agent: row.agent, provider: row.provider, label: row.label, ended: ended.some((each) => each.key === key && each.checkedAt === row.checkedAt) }];
  });
}

/** A picture a window can draw: only an image held in a data URL, since a window loads nothing from the network. */
export function toImage(image: string | null | undefined): string | null {
  return image && /^data:image\/(png|jpeg|webp);base64,/.test(image) ? image : null;
}

/*
 * The server's thread and the app's, and how each difference is settled here:
 *
 *   server                                    app                                   settled by
 *   one log per thread, ordered by seq        events read per run, paged by turn   the thread's log is one run: hostedRunId
 *   event runId: a process, message or turn   event runId: the run it is read in   rewritten to the thread's run
 *   eventId `${threadId}.${seq}`              eventId dedupes a page and frames    kept as it is
 *   status idle | working | needs_answer      activity idle | running | waiting    one to one; an unknown word reads idle;
 *                                                                                   out of reach, nothing reads as running
 *   ISO strings                               epoch ms                             parsed here
 *   a project: a GitHub repository            a Mac project                        matched by repository each time
 *   an event this build cannot read           AgentEvent is a closed union         one plain line in its place (UNREADABLE)
 *   a person's message id: a UUID             the window's echo: user-<UUID>        prefixed here, stripped on the way out
 *   an ask waits through turns and restarts   an approval expires with its turn    marked `durable`
 *   messages waiting, or refused later        ThreadSummary.queued                 toQueued
 *   a thread lives in one of several spaces   no spaces                            threads.ts keeps each row's space and
 *                                                                                   asks about a thread in it
 *   startedBy: whoever started the thread     owner.startedBy: a teammate only     starterOf
 */

/** What stands in the transcript for an event this build cannot read, so nothing in the log is hidden without a word. */
export const UNREADABLE = "Update OpenOrc to see this step.";

/** Where a thread lives here when no project on this Mac has its repository: a group of its own, named by the server. */
export const CLOUD_PROJECT = "openorc-cloud:";

/** What a row needs beyond itself. */
export interface RowContext {
  /** The Mac project with the row's repository, or the server project's own id when this Mac has none. */
  projectId: string;
  /** The server project's name, given only when no Mac project has its repository. */
  orphanOf: string | null;
  reach: AccountReach;
  heardAt: number;
  /** Who started a thread a teammate shares with the person; null for the person's own. */
  startedBy: { name: string; image: string | null } | null;
  /** Now, so a snooze that ran out reads as none, as this Mac's own snoozes wake. */
  now: number;
}

const ACTIVITY: Record<string, ThreadActivity> = { idle: "idle", working: "running", needs_answer: "waiting" };

/**
 * One server event as the app's, in the thread's run. An event of a type or shape this build cannot read becomes a line
 * from OpenOrc in the thread, of a type every build and every phone draws, so it is never silently left out.
 */
export function toAppEvent(threadId: string, wire: WireEvent): AgentEvent {
  const ids = { runId: hostedRunId(threadId), eventId: `${threadId}.${wire.seq}` };
  const parsed = AgentEvent.safeParse({ ...wire.event, ...ids });
  if (parsed.success) return appSide(parsed.data);
  const ts = typeof wire.event["ts"] === "number" ? wire.event["ts"] : 0;
  return { type: "message.completed", ...ids, ts, messageId: ids.eventId, role: "system", text: UNREADABLE };
}

/** The app's own ids for a person's message: the window shows it as sent under `user-<id>` before the server logs it. */
export const appMessageId = (id: string): string => (UUID.test(id) ? `user-${id}` : id);

/** The server's id for a message the window names: the id under `user-`, a bare UUID, or none. */
export function wireMessageId(id: string | undefined): string | null {
  const bare = id?.startsWith("user-") ? id.slice("user-".length) : id;
  return bare && UUID.test(bare) ? bare : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An event the app reads as the server wrote it, but for a person's message id and an ask, which outlives its turn. */
function appSide(event: AgentEvent): AgentEvent {
  if (event.type === "message.completed" && event.role === "user") return { ...event, messageId: appMessageId(event.messageId) };
  if (event.type === "approval.requested") return { ...event, durable: true };
  return event;
}

/**
 * The thread's waiting messages as the composer's queue shows them: those sent to wait for the running turn, and any
 * the server refused after taking it, with the words for why. A message sent now is in the log already.
 */
export function toQueued(row: WireThread): QueuedMessage[] {
  return row.waiting.flatMap((message) => {
    const refused = message.state === "refused";
    if (!refused && !(message.afterTurn && message.state === "pending")) return [];
    const words = refused ? refusalWords(message.refusal, row.settings.agent) : null;
    return [{ id: message.id, text: message.text, attachments: [], queuedAt: Date.parse(message.createdAt), error: words }];
  });
}

/** The words for a refusal the server named; one this build does not know still reads as a refusal. */
export function refusalWords(refusal: string | null, agent: string): string {
  return refusal && isHostedRefusal(refusal) ? sendBlockWords(refusal, agent) : "OpenOrc Cloud didn't take this message.";
}

/** A stretch of the log as one frame for the app's run store. */
export function toFrame(threadId: string, events: readonly WireEvent[]): Frame | null {
  return events.length ? { runId: hostedRunId(threadId), seq: events[0]!.seq, events: events.map((event) => toAppEvent(threadId, event)) } : null;
}

/**
 * The thread's row as the sidebar and the thread view read it. Every field the server has no counterpart for is written
 * here once, so no window special-cases a hosted row. Unread when the agent wrote past what the person has seen.
 */
export function toSummary(row: WireThread, context: RowContext): ThreadSummary {
  const activity = activityOf(row, context.reach);
  const lastActivityAt = Date.parse(row.lastActivityAt);
  return {
    id: row.id,
    projectId: context.projectId,
    title: row.title,
    agent: row.settings.agent,
    model: row.settings.model,
    effort: row.settings.effort,
    fastMode: false,
    mode: row.settings.mode,
    permissionMode: row.settings.permissionMode,
    workspaceMode: "worktree",
    branch: row.branch,
    worktreePath: null,
    baseSha: null,
    baseBranch: row.baseBranch,
    pinnedAt: at(row.pinnedAt),
    seenAt: null,
    doneAt: null,
    snoozedUntil: snoozedUntil(row, context.now),
    prUrl: row.pullRequest?.url ?? null,
    prState: row.pullRequest?.state ?? null,
    forkedFromId: null,
    forkedAtRunId: null,
    draft: null,
    importedFrom: null,
    parentThreadId: row.parentId,
    createdAt: Date.parse(row.createdAt),
    updatedAt: lastActivityAt,
    lastActivityAt,
    archivedAt: at(row.archivedAt),
    hasStarted: row.head > 0,
    activity,
    backgroundCommands: context.reach === "live" ? row.backgroundCommands : [],
    unread: activity === "idle" && row.lastAgentSeq > row.seenSeq,
    session: { status: activity === "running" ? "live" : "idle", message: null },
    context: null,
    queued: toQueued(row),
    lastAgentEventAt: activity === "running" ? lastActivityAt : null,
    liveRunId: activity === "idle" ? null : hostedRunId(row.id),
    taskCount: 0,
    openTaskCount: 0,
    owner: {
      brain: "hosted",
      reach: context.reach,
      heardAt: context.heardAt,
      ...(context.orphanOf !== null && { project: { name: context.orphanOf } }),
      ...(context.startedBy && { startedBy: context.startedBy }),
    },
  };
}

/**
 * What a row says the thread is doing. Out of reach, the app cannot vouch that a turn still runs, so nothing reads as
 * running; an ask stays waiting, since only an answer closes it.
 */
function activityOf(row: WireThread, reach: AccountReach): ThreadActivity {
  const activity = ACTIVITY[row.status] ?? "idle";
  return reach === "live" || activity !== "running" ? activity : "idle";
}

/**
 * Whether the thread's log is being written now: a turn is live, or work its agent left reporting back still runs. An
 * ask whose turn ended runs nothing, and out of reach the app cannot vouch for anything running.
 */
export function runsNow(row: WireThread, reach: AccountReach): boolean {
  return reach === "live" && (row.turn !== null || row.status === "working");
}

/** The thread's one run: running while its log is being written. None for a thread whose log is empty. */
export function toRuns(row: WireThread, reach: AccountReach): Run[] {
  if (row.head === 0) return [];
  const idle = !runsNow(row, reach);
  return [
    {
      id: hostedRunId(row.id),
      taskId: null,
      threadId: row.id,
      agent: row.settings.agent,
      model: row.settings.model,
      effort: row.settings.effort,
      fastMode: false,
      mode: row.settings.mode,
      permissionMode: row.settings.permissionMode,
      externalSessionId: null,
      state: idle ? "success" : "running",
      startedAt: Date.parse(row.createdAt),
      endedAt: idle ? Date.parse(row.lastActivityAt) : null,
      usage: null,
      resultText: null,
      error: null,
    },
  ];
}

/**
 * The teammate who started a thread, as a row names them; null for a thread the person started, and for every thread
 * while the app does not yet know who the person is.
 */
export function starterOf(row: WireThread, me: string | null): { name: string; image: string | null } | null {
  if (!row.startedBy || me === null || row.startedBy.id === me) return null;
  return { name: row.startedBy.name, image: toImage(row.startedBy.image) };
}

/** owner/name, lowercased, from an https or ssh GitHub remote; null for any other remote. */
export function githubRepoOf(remote: string | null): string | null {
  const match = remote ? /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(remote.trim()) : null;
  return match ? match[1]!.toLowerCase() : null;
}

/** The project a server project lives under here: the Mac's with its repository, or its own when this Mac has none. */
export function projectPairs(projects: readonly WireProject[], local: readonly { id: string; remote: string | null }[]): Map<string, { macId: string | null; name: string }> {
  const byRepo = new Map(local.flatMap((project) => (githubRepoOf(project.remote) ? [[githubRepoOf(project.remote)!, project.id] as const] : [])));
  return new Map(projects.map((project) => [project.id, { macId: byRepo.get(project.fullName.toLowerCase()) ?? null, name: project.name }]));
}

/** Whether a row belongs to a list across these Mac projects: its own project, or the cloud's own, which none here stands for. */
const inProjects = (row: ThreadSummary, projectIds: readonly string[], scoped = false) => projectIds.includes(row.projectId) || (!scoped && row.projectId.startsWith(CLOUD_PROJECT));

const at = (iso: string | null): number | null => (iso === null ? null : Date.parse(iso));

/** A snooze still running; one that ran out reads as none. */
function snoozedUntil(row: WireThread, now: number): number | null {
  const until = at(row.snoozedUntil);
  return until !== null && until > now ? until : null;
}

/**
 * How many of the rows Resolved holds, counted as this Mac's list counts its own: roots put there, and the unpinned,
 * unsnoozed ones quiet since before `quietBefore` that wait on nobody.
 */
export function resolvedCount(rows: readonly ThreadSummary[], params: RpcParams<"threads.resolvedCount">, now: number): number {
  return rows.filter((row) => {
    if (row.parentThreadId || !inProjects(row, params.projectIds, Boolean(params.spaceId))) return false;
    if (row.archivedAt !== null) return true;
    return !row.pinnedAt && !(row.snoozedUntil && row.snoozedUntil > now) && row.activity !== "waiting" && row.lastActivityAt < params.quietBefore;
  }).length;
}

/** Whether a row is in a list's part: the active rows, the ones put away, or all. Conversations stay continuable, so "done" holds none, as on this Mac. */
function inFilter(row: ThreadSummary, filter: NonNullable<RpcParams<"threads.list">["filter"]>): boolean {
  if (filter === "all") return true;
  if (filter === "archived") return row.archivedAt !== null;
  return filter === "active" && row.archivedAt === null;
}

/** The rows a list asked for, from every row the account has: the same filters the Mac's list applies, in memory. */
export function listRows(rows: readonly ThreadSummary[], params: RpcParams<"threads.list">): ThreadSummary[] {
  return rows.filter((row) => {
    if (params.projectIds ? !inProjects(row, params.projectIds, Boolean(params.spaceId)) : params.projectId && row.projectId !== params.projectId) return false;
    if (!inFilter(row, params.filter ?? "active")) return false;
    if (params.pinnedOnly && !row.pinnedAt) return false;
    if (!params.includeChildren && row.parentThreadId) return false;
    if (params.needsYou && !row.unread && row.activity === "idle") return false;
    return true;
  });
}
