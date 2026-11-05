import { frozenMoving, subagents, tasks, threadQueue, type Db } from "@openorc/db";
import type { Thread, ThreadSummary } from "@openorc/protocol";
import type { RunService } from "./runs.js";
import type { WorkspaceService } from "./workspace.js";

export interface SummaryDeps {
  db: Db;
  runs: RunService;
  workspaces: Pick<WorkspaceService, "cloudState">;
}

/** A thread with what is happening on it right now, for lists and the sidebar. */
export function summarizeThread({ db, runs, workspaces }: SummaryDeps, t: Thread): ThreadSummary {
  const own = tasks.list(db, { threadId: t.id });
  const activity = runs.threadActivity(t.id);
  return {
    ...t,
    subagent: runs.subagents.summary(t.id),
    hasStarted: Boolean(db.stmt("SELECT 1 FROM runs WHERE thread_id = ? LIMIT 1").get(t.id)),
    teamInstanceId: null,
    agents: [t.agent],
    activity,
    backgroundCommands: runs.threadBackgroundCommands(t.id),
    // Activity the user has not looked at yet, once the agent is done with it.
    unread: activity === "idle" && (t.seenAt === null || t.lastActivityAt > t.seenAt),
    session: runs.threadSession(t.id),
    context: runs.threadContext(t.id),
    queued: threadQueue.list(db, t.id),
    cloud: workspaces.cloudState(t.id),
    moving: frozenMoving(db, t.id),
    lastAgentEventAt: runs.threadLastAgentEventAt(t.id),
    liveRunId: liveRunId(db, runs, t.id),
    taskCount: own.filter((x) => x.status !== "archived").length,
    openTaskCount: own.filter((x) => x.status === "proposed" || x.status === "backlog" || x.status === "in_progress" || x.status === "review").length,
  };
}

/** A hosted child's run belongs to its parent provider session. */
function liveRunId(db: Db, runs: RunService, threadId: string): string | null {
  const child = subagents.byThread(db, threadId);
  return child?.status === "running" ? child.runId : (runs.liveRunForThread(threadId)?.id ?? null);
}
