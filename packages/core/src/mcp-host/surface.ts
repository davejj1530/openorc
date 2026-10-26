import { runs, tasks, teamDeletedThreads, threads, type Db } from "@openorc/db";
import type { RunService } from "../services/runs.js";

/**
 * The conversation an app tool acts in, derived from the run and never from the agent's input: a thread, or a task
 * that has no thread. `tool` names the tool in the refusals.
 */
export function conversationSurface(db: Db, runService: Pick<RunService, "isBusy">, runId: string, tool: "Browser" | "Device"): `thread:${string}` | `task:${string}` {
  const run = runs.get(db, runId);
  if (!run || run.commentTurnId || !runService.isBusy(runId)) throw new Error(`${tool} access requires an active conversation turn.`);
  const task = run.taskId ? tasks.get(db, run.taskId) : null;
  const threadId = run.threadId ?? task?.threadId;
  if (threadId && (!threads.get(db, threadId) || teamDeletedThreads.has(db, threadId))) throw new Error(`The ${tool.toLowerCase()}'s conversation no longer exists.`);
  if (threadId) return `thread:${threadId}`;
  if (task) return `task:${task.id}`;
  throw new Error(`This run has no conversation for the ${tool.toLowerCase()}.`);
}
