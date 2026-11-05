import { frozenMoving, runs, tasks, type Db } from "@openorc/db";
import { MOVING_WORDS, ownerRoute, ROUTED_READS, type RpcMethod, type Task } from "@openorc/protocol";

/** Refuses a write to a thread frozen on this host while it relocates. */
export function assertNotMoving(db: Db, threadId: string): void {
  const moving = frozenMoving(db, threadId);
  if (moving) throw new Error(MOVING_WORDS[moving.to]);
}

/** Refuses a write to a task whose thread is frozen while it relocates: the task moves with the thread doing its work. */
export function assertTaskNotMoving(db: Db, task: Pick<Task, "threadId" | "executionThreadId">): void {
  const owner = task.executionThreadId ?? task.threadId;
  if (owner) assertNotMoving(db, owner);
}

/** Marking a thread seen changes nothing a move carries, so a moving thread is read as before. */
const marksSeen = (method: RpcMethod, params: Record<string, unknown>) => method === "threads.update" && Object.keys((params["patch"] as object | undefined) ?? {}).every((key) => key === "seen");

/**
 * Refuses a routed write naming a thread frozen here, or a run or task of one: the one fence every window's, phone's and
 * owner session's call passes, so a new write path cannot miss it. It reads the names that make a method routed.
 */
export function assertRouteNotMoving(db: Db, method: RpcMethod, params: Record<string, unknown>): void {
  const route = ownerRoute(method);
  if (!route || route.by === "here" || route.by === "start" || ROUTED_READS.has(method) || marksSeen(method, params)) return;
  const name = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : null);
  const threadId = name("threadId") ?? (method.startsWith("threads.") ? name("id") : null);
  if (threadId) assertNotMoving(db, threadId);
  const runId = name("runId");
  const runThread = runId ? runs.get(db, runId)?.threadId : null;
  if (runThread) assertNotMoving(db, runThread);
  const taskId = name("taskId") ?? (method.startsWith("tasks.") ? name("id") : null);
  const task = taskId ? tasks.get(db, taskId) : null;
  if (task) assertTaskNotMoving(db, task);
}
