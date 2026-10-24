import { WORKSPACE_ID, type PrState, type ThreadSummary } from "@openorc/protocol";

/** What a thread row's lead reports while there is something to say, most urgent first. */
export type ThreadStatus = { kind: "waiting" | "running" | "failed" | "unread"; label: string };

/** A row's lead: its status, else the state of the thread's pull request. */
export type ThreadMark = ThreadStatus | { kind: "pull"; label: string; state: PrState };

/** Where a thread works, as its row's last line names it. */
export type ThreadPlace = { kind: "branch" | "pull" | "folder"; label: string };

export function pullRequestNumber(url: string | null): number | null {
  const match = url ? /\/pull\/(\d+)(?:[/?#]|$)/.exec(url) : null;
  return match ? Number(match[1]) : null;
}

/** Live activity first, then session health, then an unread result. Null when the thread has nothing to report. */
export function threadStatus(thread: Pick<ThreadSummary, "activity" | "session" | "unread">): ThreadStatus | null {
  if (thread.activity === "waiting") return { kind: "waiting", label: "Needs you" };
  if (thread.activity === "running") return { kind: "running", label: "Working" };
  if (thread.session.status === "lost" || thread.session.status === "error") {
    const status = thread.session.status === "lost" ? "Session lost" : "Failed";
    return { kind: "failed", label: thread.session.message ? `${status}: ${thread.session.message}` : status };
  }
  return thread.unread ? { kind: "unread", label: "Unread" } : null;
}

/** A resting thread's pull request, if it has one. */
export function pullRequestMark(thread: Pick<ThreadSummary, "prUrl" | "prState">): Extract<ThreadMark, { kind: "pull" }> | null {
  const pull = pullRequestNumber(thread.prUrl);
  if (pull === null) return null;
  const state = thread.prState ?? "open";
  return { kind: "pull", label: `Pull request #${pull}, ${state}`, state };
}

export function threadMark(thread: Pick<ThreadSummary, "activity" | "session" | "unread" | "prUrl" | "prState">): ThreadMark | null {
  return threadStatus(thread) ?? pullRequestMark(thread);
}

/** Its branch, else the pull request it reviews, else its folder. */
export function threadPlace(thread: Pick<ThreadSummary, "branch" | "prUrl" | "projectId">): ThreadPlace {
  if (thread.branch) return { kind: "branch", label: thread.branch };
  const pull = pullRequestNumber(thread.prUrl);
  if (pull !== null) return { kind: "pull", label: `PR #${pull}` };
  return { kind: "folder", label: thread.projectId === WORKSPACE_ID ? "Local" : "No branch" };
}
