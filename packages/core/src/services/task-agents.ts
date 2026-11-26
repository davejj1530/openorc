import { taskThreads, threads as threadRows, type Db } from "@openorc/db";
import type { Task, TaskButton, Thread, ThreadChoice } from "@openorc/protocol";
import { AttachmentService } from "./attachments.js";
import type { ThreadService } from "./threads.js";

/** Who is given the work: an id of its own, the name its thread is listed under on the task, and the model when one was chosen. */
export type TaskAgent = { id: string; name: string; choice: ThreadChoice | null };

/**
 * The agents the app itself gives work on a task: a board column's, or an automation's. Each works in a thread of its
 * own for the task, linked under its name and working where the task's work is, and is told again in that thread when
 * there is more for it.
 */
export class TaskAgents {
  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly threads: Pick<ThreadService, "runTaskButton" | "queue">,
  ) {}

  /** The thread already working on the task under this name, while it is there to continue. */
  threadOf(taskId: string, name: string): Thread | null {
    const link = taskThreads.list(this.db, taskId).find((each) => each.label === name);
    const thread = link ? threadRows.get(this.db, link.threadId) : null;
    return thread && !thread.archivedAt ? thread : null;
  }

  /** A new thread for the agent, sent what it is told with the task. */
  async open(task: Task, agent: TaskAgent, told: string): Promise<Thread | null> {
    const press: TaskButton = { id: agent.id, label: agent.name, prompt: told, runsIn: "new", mode: "thread", ...(agent.choice ? { choice: agent.choice } : {}) };
    const images = await new AttachmentService(this.dataDir).forTask(task.spec ?? "");
    const pressed = await this.threads.runTaskButton(task.id, press, images);
    return threadRows.get(this.db, pressed.threadId);
  }

  /** More for an agent already at work, as the next message of its thread. */
  tell(threadId: string, text: string): void {
    this.threads.queue(threadId, text);
  }
}
