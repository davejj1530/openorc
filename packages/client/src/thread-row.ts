import { STATUS_PRIORITY, threadStatus, WORKSPACE_ID, type PrState, type ThreadStatus, type ThreadSummary } from "@openorc/protocol";

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
