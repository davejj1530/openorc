import type { TaskStatus, ThreadSummary } from "@openorc/protocol";

/** The task states that still want a decision. Done and archived are not work. */
export const openStatuses: TaskStatus[] = ["backlog", "in_progress", "review"];
const LIMIT = 3;

export interface ArrivalActivity {
  waiting: ThreadSummary[];
  running: ThreadSummary[];
  tasks: { status: TaskStatus; count: number }[];
  recent: ThreadSummary[];
  any: boolean;
}

/**
 * What the arrival screen is about, as a pure function of the two lists the
 * shell already caches. Kept apart from the query layer so the states a QA
 * fixture rarely holds, waiting and running, are still testable.
 */
export function arrivalGroups(threads: ThreadSummary[], tasks: { projectId: string; status: TaskStatus }[], projectId: string | null): ArrivalActivity {
  const waiting = threads.filter((t) => t.activity === "waiting").slice(0, LIMIT);
  const running = threads.filter((t) => t.activity === "running").slice(0, LIMIT);
  const busy = new Set([...waiting, ...running].map((t) => t.id));
  const scoped = tasks.filter((t) => !projectId || t.projectId === projectId);
  const counts = openStatuses.map((status) => ({ status, count: scoped.filter((t) => t.status === status).length })).filter((group) => group.count > 0);
  const recent = [...threads]
    .filter((t) => !busy.has(t.id))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, LIMIT + 1);
  return {
    waiting,
    running,
    tasks: counts,
    recent,
    any: waiting.length + running.length + counts.length + recent.length > 0,
  };
}
