import { placeOf, STATUS_PRIORITY, threadStatus, WORKSPACE_ID, type PrState, type ThreadStatus, type ThreadSummary, type WorkspaceMode } from "@openorc/protocol";

export { STATUS_PRIORITY, threadStatus, type ThreadStatus };

/** A row's lead: its status, else the state of the thread's pull request. */
export type ThreadMark = ThreadStatus | { kind: "pull"; label: string; state: PrState };

/** Where a thread works, as its row's hover title and spoken label name it. */
export type ThreadPlace = { kind: "branch" | "pull" | "folder"; label: string };

export function pullRequestNumber(url: string | null): number | null {
  const match = url ? /\/pull\/(\d+)(?:[/?#]|$)/.exec(url) : null;
  return match ? Number(match[1]) : null;
}

/**
 * A parent row's mark: its own status, unless its sub threads say something more pressing. On a tie its own wins, so a
 * working parent reads "Working" however many sub threads work with it.
 */
export function threadTreeStatus(own: ThreadStatus | null, below: ThreadStatus | null): ThreadStatus | null {
  if (!own || !below) return own ?? below;
  return STATUS_PRIORITY.indexOf(below.kind) < STATUS_PRIORITY.indexOf(own.kind) ? below : own;
}

/** A resting thread's pull request, if it has one. */
export function pullRequestMark(thread: Pick<ThreadSummary, "prUrl" | "prState">): Extract<ThreadMark, { kind: "pull" }> | null {
  const pull = pullRequestNumber(thread.prUrl);
  if (pull === null) return null;
  const state = thread.prState ?? "open";
  return { kind: "pull", label: `Pull request #${pull}, ${state}`, state };
}

export function threadMark(thread: Pick<ThreadSummary, "activity" | "session" | "unread" | "backgroundCommands" | "prUrl" | "prState">): ThreadMark | null {
  return threadStatus(thread) ?? pullRequestMark(thread);
}

/** Its branch, else the pull request it reviews, else its folder. */
export function threadPlace(thread: Pick<ThreadSummary, "branch" | "prUrl" | "projectId">): ThreadPlace {
  if (thread.branch) return { kind: "branch", label: thread.branch };
  const pull = pullRequestNumber(thread.prUrl);
  if (pull !== null) return { kind: "pull", label: `PR #${pull}` };
  return { kind: "folder", label: thread.projectId === WORKSPACE_ID ? "Local" : "No branch" };
}

/**
 * The word a root row puts after its project for where its thread works: the cloud, a worktree of its own, the
 * checkout's branch, or the checkout itself when it is on none. A thread in no project names its folder. A pull request
 * already says where the work is, so beside one only the cloud shows, where the next turn runs.
 */
export function workspaceLabel(thread: Pick<ThreadSummary, "workspaceMode" | "branch" | "prUrl" | "cloud" | "owner" | "projectId" | "workingDirectory">): string | null {
  if (thread.cloud || placeOf(thread).brain) return "cloud";
  if (pullRequestNumber(thread.prUrl) !== null) return null;
  if (thread.workspaceMode === "worktree") return "worktree";
  if (thread.branch) return thread.branch;
  if (thread.projectId === WORKSPACE_ID) return thread.workingDirectory?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  return "checkout";
}

/**
 * Where a sidebar row says its thread works, said only when that is not where its project's new threads start:
 *   cloud     the person's own cloud (the glyph alone) or OpenOrc Cloud (the glyph and its name); a cloud-only project's
 *             label already wears the cloud, so its rows say nothing
 *   branch    the checkout, by its branch, when new threads start in a worktree
 *   worktree  a worktree of its own, when new threads start in the checkout
 *   folder    a thread in no project, by its folder
 */
export type RowPlace = { kind: "cloud"; label: string; word: string | null } | { kind: "branch" | "worktree" | "folder"; word: string };

export function rowPlace(thread: Pick<ThreadSummary, "workspaceMode" | "branch" | "cloud" | "owner" | "projectId" | "workingDirectory">, usual: WorkspaceMode): RowPlace | null {
  const place = placeOf(thread);
  if (place.rowIcon) return thread.owner?.project ? null : { kind: "cloud", label: "OpenOrc Cloud", word: "OpenOrc Cloud" };
  if (thread.cloud || place.brain) return { kind: "cloud", label: "Your own cloud", word: null };
  if (thread.projectId === WORKSPACE_ID) {
    const folder = thread.workingDirectory?.split(/[\\/]/).filter(Boolean).at(-1);
    return folder ? { kind: "folder", word: folder } : null;
  }
  if (thread.workspaceMode === usual) return null;
  return thread.workspaceMode === "worktree" ? { kind: "worktree", word: "worktree" } : { kind: "branch", word: thread.branch ?? "checkout" };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** How long since a row's latest activity, at a glance: "now", "12m", "2h", "3d", "3w", "2mo", "1y". */
export function rowAge(at: number, now: number): string {
  const ago = Math.max(0, now - at);
  if (ago < MINUTE) return "now";
  if (ago < 60 * MINUTE) return `${Math.floor(ago / MINUTE)}m`;
  if (ago < DAY) return `${Math.floor(ago / (60 * MINUTE))}h`;
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)}d`;
  if (ago < 30 * DAY) return `${Math.floor(ago / (7 * DAY))}w`;
  if (ago < 365 * DAY) return `${Math.floor(ago / (30 * DAY))}mo`;
  return `${Math.floor(ago / (365 * DAY))}y`;
}

/** When a thread last saw work: a turn starting or ending, a message, its agent's latest event, or a sub thread's. */
export function latestActivity(thread: Pick<ThreadSummary, "lastActivityAt" | "treeActivityAt" | "lastAgentEventAt">): number {
  return Math.max(thread.lastActivityAt, thread.treeActivityAt ?? 0, thread.lastAgentEventAt ?? 0);
}

/** The teammate who started a thread the person shares, with the first name a row has room for; null for their own. */
export function rowStarter(thread: Pick<ThreadSummary, "owner">): { name: string; first: string; image: string | null } | null {
  const starter = thread.owner?.startedBy;
  if (!starter) return null;
  return { ...starter, first: starter.name.trim().split(/\s+/)[0] ?? starter.name };
}

/** The title a rename saves: what was typed, trimmed, or null when it is empty or unchanged and nothing should save. */
export function renamedTitle(current: string, typed: string): string | null {
  const next = typed.trim();
  return next && next !== current ? next : null;
}
