/**
 * The writes working together adds to a hosted thread: an author starting their own paused message, and asking the
 * server to save the thread's work again. Each is the server's to allow; it answers in its own words when it does not.
 */
import type { RpcParams } from "@openorc/protocol";
import { refuse, type Calls } from "./sends.js";
import { Refused } from "./session.js";
import { COLLABORATION_ROUTES } from "./wire-collaboration.js";
import { TASK_ROUTES } from "./wire-tasks.js";

/** One explicit Start, kept until the server answers: its request id and the task revision it carries, if any. */
export type QueuedStart = { requestId: string; task?: { id: string; ifRevision: number } };

/**
 * threads.startQueued: the author's paused message starts their own turn. Every explicit Start has its own request id,
 * kept until the server answers, so pressing again after a lost reply is the same Start and never a second turn. A
 * message paused because its task changed starts on the revision the task has now, which that Start keeps.
 */
export async function startQueued(calls: Calls & { starts: Map<string, QueuedStart> }, { threadId, messageId }: RpcParams<"threads.startQueued">): Promise<null> {
  const row = calls.row(threadId);
  const key = `${threadId}:${messageId}`;
  const start = calls.starts.get(key) ?? { requestId: crypto.randomUUID(), ...(await taskNow(calls, threadId, messageId)) };
  calls.starts.set(key, start);
  const reply = await calls.on(threadId).request(COLLABORATION_ROUTES.startQueued(threadId, messageId), start);
  calls.starts.delete(key);
  if (!reply.sent) return refuse(calls, reply.refusal, { agent: row.settings.agent, model: row.settings.model });
  await calls.refresh();
  return null;
}

/** The task a message paused for its task's change carries now: its id at the revision the task has. None for any other. */
async function taskNow(calls: Calls, threadId: string, messageId: string): Promise<Pick<QueuedStart, "task">> {
  const queued = calls.row(threadId).collaboration?.queue.find((each) => each.messageId === messageId);
  if (queued?.pause?.kind !== "task" || !queued.task) return {};
  const { task } = await calls.on(threadId).request(TASK_ROUTES.get(queued.task.id));
  return { task: { id: task.id, ifRevision: task.revision } };
}

/**
 * threads.stopWork: the server stops the work that reports back and holds the next turn. Work that has already ended
 * (as after a lost reply) is what was asked for, so it is done; the row's blocker says how it went.
 */
export async function stopWork(calls: Calls, { threadId }: RpcParams<"threads.stopWork">): Promise<null> {
  await calls
    .on(threadId)
    .request(COLLABORATION_ROUTES.stopWork(threadId), {})
    .catch((error: unknown) => {
      if (!(error instanceof Refused && error.code === "work_changed")) throw error;
    });
  await calls.refresh();
  return null;
}

/** threads.retrySave: the server saves the thread's work again; the row's blocker says how it went. */
export async function retrySave(calls: Calls, { threadId }: RpcParams<"threads.retrySave">): Promise<null> {
  await calls.on(threadId).request(COLLABORATION_ROUTES.retrySave(threadId), {});
  await calls.refresh();
  return null;
}
