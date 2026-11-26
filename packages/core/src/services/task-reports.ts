import { runs, taskActor, taskEvents, tasks, threads as threadRows, type Db } from "@openorc/db";
import type { TaskUpdate, Thread } from "@openorc/protocol";
import type { Notification } from "./run-types.js";
import type { ThreadService } from "./threads.js";

/**
 * Agents' updates on tasks: what an agent posts on a task's history for the person to read, and the reply the person
 * presses on one, which reaches the agent's thread as their message.
 */
export class TaskReports {
  constructor(
    private readonly db: Db,
    private readonly threads: Pick<ThreadService, "queue">,
    private readonly invalidate: (keys: string[]) => void,
    private readonly notify: (n: Omit<Notification, "type">) => void,
  ) {}

  /** A new update from the agent of run `runId`, or with `replaces` a change to one it posted before, in that one's place. */
  post(taskId: string, runId: string, update: TaskUpdate, replaces?: number): number {
    const task = tasks.get(this.db, taskId);
    if (!task) throw new Error("Task not found.");
    const run = runs.get(this.db, runId);
    const from = run?.threadId ? threadRows.get(this.db, run.threadId) : null;
    const id = replaces === undefined ? taskEvents.record(this.db, taskId, taskActor(from), { kind: "update", ...update, answer: null }) : this.change(taskId, from, replaces, update);
    this.invalidate(["tasks", "inbox", `task:${taskId}`]);
    if (update.replies) this.notify({ kind: "question", threadId: from?.id ?? null, taskId, title: task.title, body: update.message });
    return id;
  }

  /** The app's own word on a task, as when its agents have not settled it. The reply the person presses goes to `replyThreadId`. */
  ask(taskId: string, message: string, replies: string[] | undefined, replyThreadId: string | null): void {
    const task = tasks.get(this.db, taskId);
    if (!task) return;
    taskEvents.record(this.db, taskId, { kind: "app" }, { kind: "update", message, ...(replies ? { replies } : {}), answer: null, replyThreadId });
    this.invalidate(["tasks", "inbox", `task:${taskId}`]);
    this.notify({ kind: "question", threadId: replyThreadId, taskId, title: task.title, body: message });
  }

  /** An agent changes only its own update. An answer already given stays unless the change asks again. */
  private change(taskId: string, from: Thread | null, id: number, update: TaskUpdate): number {
    const before = taskEvents.get(this.db, id);
    const own = before?.kind === "update" && before.taskId === taskId && before.actor.kind === "agent" && before.actor.threadId === from?.id;
    if (!own) throw new Error("No update of yours on this task has that id. Leave out replaces to post a new one.");
    taskEvents.replace(this.db, id, { kind: "update", ...update, answer: update.replies ? null : before.answer });
    return id;
  }

  answer(taskId: string, eventId: number, reply: string): void {
    const event = taskEvents.get(this.db, eventId);
    if (event?.kind !== "update" || event.taskId !== taskId || !event.replies?.includes(reply)) throw new Error("This update no longer offers that reply.");
    if (event.answer) throw new Error("This update is already answered.");
    const threadId = event.replyThreadId ?? (event.actor.kind === "agent" ? event.actor.threadId : null);
    if (!threadId) throw new Error("The thread that asked is gone.");
    this.threads.queue(threadId, reply);
    const { id: _id, taskId: _taskId, at: _at, actor: _actor, ...held } = event;
    taskEvents.replace(this.db, eventId, { ...held, answer: { reply, at: Date.now() } });
    this.invalidate(["tasks", "inbox", `task:${taskId}`]);
  }
}
