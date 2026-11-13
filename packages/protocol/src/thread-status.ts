import type { ThreadSummary } from "./domain.js";

/** What a thread reports while there is something to say, most urgent first: in a row's lead, a tab, or to an Orcling. */
export type ThreadStatus = { kind: "waiting" | "running" | "failed" | "unread" | "background"; label: string };

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
