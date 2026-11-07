import { sidebarThreadPage, threadResolved, threadStatus, threadTreeRoot, type ThreadStatus } from "@openorc/client";
import { isSubagentThread, WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";

type StatusKind = ThreadStatus["kind"];

/**
 * A project's marks in the filter, from most to least pressing: a thread that needs you, a failure, work under way, a result waiting,
 * then commands an agent left running after its turn.
 */
const PRIORITY: readonly StatusKind[] = ["waiting", "failed", "running", "unread", "background"];

/** How a project's description counts each kind of thread. */
const SUMMARY: Record<StatusKind, string> = { waiting: "needs you", failed: "failed", running: "working", unread: "unread", background: "with commands running" };

/** What a project's threads have to say: how many of each kind, and the most pressing kind the corner shows. */
export type WorkspaceMark = { kind: StatusKind; counts: Partial<Record<StatusKind, number>> };

/**
 * Each project's mark from the threads the sidebar read, sub threads included: only threads the list still holds open
 * count, so resolved trees and hidden threads (Orclings' own conversations) stay quiet. A subagent's unread result is
 * its parent's to read, so it never counts.
 */
export function workspaceMarks(rows: readonly ThreadSummary[] | undefined, now: number, hidden?: ReadonlySet<string>): Map<string, WorkspaceMark> {
  const { list } = sidebarThreadPage({ projectId: WORKSPACE_ID, fetched: rows, selected: null, filter: "active", limit: Number.MAX_SAFE_INTEGER, now, hidden });
  const byId = new Map(list.map((thread) => [thread.id, thread]));
  const marks = new Map<string, WorkspaceMark>();
  for (const thread of list) {
    const root = threadTreeRoot(thread, byId);
    if (!root || threadResolved(root, now)) continue;
    const kind = threadStatus(thread)?.kind;
    if (!kind || (kind === "unread" && isSubagentThread(thread))) continue;
    const mark = marks.get(thread.projectId) ?? { kind, counts: {} };
    mark.counts[kind] = (mark.counts[kind] ?? 0) + 1;
    if (PRIORITY.indexOf(kind) < PRIORITY.indexOf(mark.kind)) mark.kind = kind;
    marks.set(thread.projectId, mark);
  }
  return marks;
}

/** The tooltip's second line, such as "1 needs you · 2 unread", leaving out what has none. */
export function workspaceSummary(mark: WorkspaceMark | undefined): string {
  if (!mark) return "";
  return PRIORITY.flatMap((kind) => (mark.counts[kind] ? [`${mark.counts[kind]} ${SUMMARY[kind]}`] : [])).join(" · ");
}

/** A stand-in thread in the given state, so the corner shows the thread rows' own glyph with its plain label. */
export function markThread(kind: StatusKind): Pick<ThreadSummary, "activity" | "session" | "unread" | "doneAt" | "backgroundCommands"> {
  return {
    activity: kind === "waiting" || kind === "running" ? kind : "idle",
    session: { status: kind === "failed" ? "error" : "idle", message: null },
    unread: kind === "unread",
    doneAt: null,
    ...(kind === "background" ? { backgroundCommands: [{ id: "workspace-mark", description: "Background command" }] } : {}),
  };
}
