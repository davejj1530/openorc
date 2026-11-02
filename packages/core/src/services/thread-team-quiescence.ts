import { orchestration, runs as runRepo, tasks, teamRuntime, teamWorkspaces, type Db } from "@openorc/db";
import type { RunService } from "./runs.js";

/** Why organizing a team thread must wait, or null when nothing of the team is unfinished. Organization never hides unfinished team work. */
export function teamQuiescenceReason(db: Db, runs: Pick<RunService, "liveRunForThread" | "liveRunForTask" | "pending">, threadId: string): string | null {
  if (!orchestration.getInstance(db, threadId) && !teamRuntime.activeForThread(db, threadId)) return null;
  const rows = db.stmt("SELECT id FROM team_executions WHERE thread_id = ?").all(threadId) as { id: string }[];
  const executions = rows.map((row) => teamRuntime.get(db, row.id)!);
  if (executions.some((execution) => !["completed", "stopped"].includes(execution.state))) return "Finish or stop the team's unfinished execution before this action.";
  if (executions.some((execution) => execution.attempts.some((attempt) => ["starting", "running"].includes(attempt.state) || (attempt.state === "attention" && attempt.endedAt === null))))
    return "Wait for every team writer to finish closing before this action.";
  const owned = tasks.list(db, { threadId });
  if (runs.liveRunForThread(threadId) || owned.some((task) => runs.liveRunForTask(task.id))) return "Wait for every team writer to finish closing before this action.";
  const runIds = new Set([
    ...runRepo.listForThread(db, threadId).map((run) => run.id),
    ...owned.flatMap((task) => runRepo.listForTask(db, task.id).map((run) => run.id)),
    ...executions.flatMap((execution) => execution.attempts.flatMap((attempt) => (attempt.runId ? [attempt.runId] : []))),
  ]);
  if (runs.pending().some((approval) => runIds.has(approval.runId))) return "Resolve the team's pending requests before this action.";
  if (executions.some((execution) => teamWorkspaces.publications(db, execution.id).some((publication) => publication.state !== "applied")))
    return "Resolve the team's retained publication before this action.";
  return null;
}
