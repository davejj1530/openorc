import { WORKSPACE_ID, type PrState, type ThreadSummary } from "@openorc/protocol";

/** What a thread row's lead reports while there is something to say, most urgent first. */
export type ThreadStatus = { kind: "waiting" | "running" | "failed" | "unread" | "background"; label: string };

/** A row's lead: its status, else the state of the thread's pull request. */
export type ThreadMark = ThreadStatus | { kind: "pull"; label: string; state: PrState };

/** Where a thread works, as its row's hover title and spoken label name it. */
export type ThreadPlace = { kind: "branch" | "pull" | "folder"; label: string };

export function pullRequestNumber(url: string | null): number | null {
  const match = url ? /\/pull\/(\d+)(?:[/?#]|$)/.exec(url) : null;
  return match ? Number(match[1]) : null;
}

/**
 * Live activity first, then session health, then an unread result, then commands the agent left running after its
 * turn, such as a dev server. Null when the thread has nothing to report.
 */
export function threadStatus(thread: Pick<ThreadSummary, "activity" | "session" | "unread" | "backgroundCommands">): ThreadStatus | null {
  if (thread.activity === "waiting") return { kind: "waiting", label: "Needs you" };
  if (thread.activity === "running") return { kind: "running", label: "Working" };
  if (thread.session.status === "lost" || thread.session.status === "error") {
    const status = thread.session.status === "lost" ? "Session lost" : "Failed";
    return { kind: "failed", label: thread.session.message ? `${status}: ${thread.session.message}` : status };
  }
  if (thread.unread) return { kind: "unread", label: "Unread" };
  const commands = thread.backgroundCommands?.length ?? 0;
  return commands ? { kind: "background", label: commands === 1 ? "A background command is running" : `${commands} background commands are running` } : null;
}

/**
 * How a mark that speaks for more than one thread picks: one that needs you, a failure, work under way, a result
 * waiting, then commands left running.
 */
export const STATUS_PRIORITY: readonly ThreadStatus["kind"][] = ["waiting", "failed", "running", "unread", "background"];

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
 * The word a root row puts after its project for where its thread works: the cloud, a worktree of its own, or the
 * checkout's branch. A pull request already says where the work is, so beside one only the cloud shows, where the next
 * turn runs.
 */
export function workspaceLabel(thread: Pick<ThreadSummary, "workspaceMode" | "branch" | "prUrl" | "cloud" | "owner">): string | null {
  if (thread.cloud || thread.owner?.brain === "cloud") return "cloud";
  if (pullRequestNumber(thread.prUrl) !== null) return null;
  return thread.workspaceMode === "worktree" ? "worktree" : thread.branch;
}

/** The title a rename saves: what was typed, trimmed, or null when it is empty or unchanged and nothing should save. */
export function renamedTitle(current: string, typed: string): string | null {
  const next = typed.trim();
  return next && next !== current ? next : null;
}
