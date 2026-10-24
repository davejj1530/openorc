import { WORKSPACE_ID, type PrState, type ThreadSummary } from "@openorc/protocol";

/**
 * What a row's 16 pt lead says, in the desktop's order (ThreadStatusIndicator): live activity first, then session
 * health, then an unread result. A resting thread shows its pull request's state, if it has one.
 */
export type ThreadMark =
  { kind: "waiting"; label: string } | { kind: "running"; label: string } | { kind: "failed"; label: string } | { kind: "unread"; label: string } | { kind: "pull"; label: string; state: PrState };

/** Where a thread works, as its row's second line shows it. */
export type ThreadPlace = { kind: "branch" | "pull" | "folder"; label: string };

type MarkFields = Pick<ThreadSummary, "activity" | "session" | "unread" | "prUrl" | "prState">;
type PlaceFields = Pick<ThreadSummary, "branch" | "prUrl" | "projectId">;

export function pullRequestNumber(url: string | null): number | null {
  const match = url ? /\/pull\/(\d+)(?:[/?#]|$)/.exec(url) : null;
  return match ? Number(match[1]) : null;
}

export function threadMark(thread: MarkFields): ThreadMark | null {
  if (thread.activity === "waiting") return { kind: "waiting", label: "Needs you" };
  if (thread.activity === "running") return { kind: "running", label: "Working" };
  if (thread.session.status === "lost" || thread.session.status === "error") {
    const status = thread.session.status === "lost" ? "Session lost" : "Failed";
    return { kind: "failed", label: thread.session.message ? `${status}: ${thread.session.message}` : status };
  }
  if (thread.unread) return { kind: "unread", label: "Unread" };
  const pull = pullRequestNumber(thread.prUrl);
  if (pull === null) return null;
  const state = thread.prState ?? "open";
  return { kind: "pull", label: `Pull request #${pull}, ${state}`, state };
}

export function threadPlace(thread: PlaceFields): ThreadPlace {
  if (thread.branch) return { kind: "branch", label: thread.branch };
  const pull = pullRequestNumber(thread.prUrl);
  if (pull !== null) return { kind: "pull", label: `PR #${pull}` };
  return { kind: "folder", label: thread.projectId === WORKSPACE_ID ? "Local" : "No branch" };
}
