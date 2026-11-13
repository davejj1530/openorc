/** Where the server's answers become the app's shapes. Pure functions, no I/O. */
import {
  AgentEvent,
  hostedRunId,
  type AccountPlan,
  type AccountReach,
  type AccountSandbox,
  type CloudHours,
  type Frame,
  type Run,
  type RpcParams,
  type ThreadActivity,
  type ThreadSummary,
} from "@openorc/protocol";
import type { WireBilling, WireEvent, WireHostedSettings, WireProject, WireThread } from "./wire.js";

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

/** Where cloud threads run, in the server's own names for its services. */
export function toSandbox(settings: WireHostedSettings): AccountSandbox {
  return { chosen: settings.service, fallback: settings.defaultService, services: settings.served.map(({ service, name }) => ({ id: service, name })) };
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
}

const ACTIVITY: Record<string, ThreadActivity> = { idle: "idle", working: "running", needs_answer: "waiting" };

/**
 * One server event as the app's, in the thread's run. An event of a type or shape this build cannot read becomes a line
 * from OpenOrc in the thread, of a type every build and every phone draws, so it is never silently left out.
 */
export function toAppEvent(threadId: string, wire: WireEvent): AgentEvent {
  const ids = { runId: hostedRunId(threadId), eventId: `${threadId}.${wire.seq}` };
  const parsed = AgentEvent.safeParse({ ...wire.event, ...ids });
  if (parsed.success) return parsed.data;
  const ts = typeof wire.event["ts"] === "number" ? wire.event["ts"] : 0;
  return { type: "message.completed", ...ids, ts, messageId: ids.eventId, role: "system", text: UNREADABLE };
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
    pinnedAt: null,
    seenAt: null,
    doneAt: null,
    snoozedUntil: null,
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
    archivedAt: null,
    hasStarted: row.head > 0,
    activity,
    backgroundCommands: context.reach === "live" ? row.backgroundCommands : [],
    unread: activity === "idle" && row.lastAgentSeq > row.seenSeq,
    session: { status: activity === "running" ? "live" : "idle", message: null },
    context: null,
    queued: [],
    lastAgentEventAt: activity === "running" ? lastActivityAt : null,
    liveRunId: activity === "idle" ? null : hostedRunId(row.id),
    taskCount: 0,
    openTaskCount: 0,
    owner: { brain: "hosted", reach: context.reach, heardAt: context.heardAt, ...(context.orphanOf !== null && { project: { name: context.orphanOf } }) },
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

/** The thread's one run: running while the thread is not idle. None for a thread whose log is empty. */
export function toRuns(row: WireThread, reach: AccountReach): Run[] {
  if (row.head === 0) return [];
  const idle = activityOf(row, reach) === "idle";
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
const inProjects = (row: ThreadSummary, projectIds: readonly string[]) => projectIds.includes(row.projectId) || row.projectId.startsWith(CLOUD_PROJECT);

/**
 * How many of the rows Resolved holds, counted as the sidebar files them: roots quiet since before `quietBefore` that
 * wait on nobody. The account never puts a cloud thread there by hand yet, and pins and snoozes are not kept for it.
 */
export function resolvedCount(rows: readonly ThreadSummary[], params: RpcParams<"threads.resolvedCount">): number {
  return rows.filter((row) => !row.parentThreadId && inProjects(row, params.projectIds) && row.activity !== "waiting" && row.lastActivityAt < params.quietBefore).length;
}

/** The rows a list asked for, from every row the account has: the same filters the Mac's list applies, in memory. */
export function listRows(rows: readonly ThreadSummary[], params: RpcParams<"threads.list">): ThreadSummary[] {
  return rows.filter((row) => {
    if (params.projectIds ? !inProjects(row, params.projectIds) : params.projectId && row.projectId !== params.projectId) return false;
    if (params.filter === "archived" || params.filter === "done") return false;
    if (params.pinnedOnly) return false;
    if (!params.includeChildren && row.parentThreadId) return false;
    if (params.needsYou && !row.unread && row.activity === "idle") return false;
    return true;
  });
}
