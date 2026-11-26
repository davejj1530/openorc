import { audit, boardColumns, projects, tasks, type Db } from "@openorc/db";
import type { BoardColumn, Task } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { AttachmentService } from "./attachments.js";
import type { Notification } from "./run-types.js";
import type { ThreadService } from "./threads.js";

/** The agent moves the card itself, since only it knows when its work is done: a review may take several turns to settle. */
const handOn = (next: BoardColumn): string =>
  `When your work on this task is finished, move it to the "${next.name}" column with task_update (column: "${next.name}"). Leave it where it is until then.`;

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A board column's job: one of its project's task buttons, pressed for a card when the card is put in the column. The
 * job runs as the button does, in the task's thread or in a thread of its own that works where the task's work is.
 */
export class BoardJobs {
  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly threads: Pick<ThreadService, "runTaskButton">,
    private readonly invalidate: (keys: string[]) => void,
    private readonly notify: (n: Omit<Notification, "type">) => void,
    private readonly log: Logger,
  ) {}

  /** A card was put in a column. Its job starts in its own time; one that cannot start says why. */
  arrived(taskId: string, columnId: string): void {
    void this.start(taskId, columnId).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      this.log.warn(`the job of column ${columnId} did not start for task ${taskId}: ${reason}`);
      this.notify({ kind: "error", threadId: null, taskId, title: tasks.get(this.db, taskId)?.title ?? "Task", body: `Its column's job did not start: ${reason}` });
    });
  }

  /**
   * An agent's move, to a column by its name. A task moves forward only, so two jobs cannot pass a card back and forth;
   * an agent that disagrees with another's work tells its thread.
   */
  moveForward(taskId: string, name: string, runId: string): Task {
    const task = tasks.get(this.db, taskId);
    if (!task) throw new Error("Task not found.");
    const columns = boardColumns.list(this.db, task.projectId);
    if (columns.length === 0) throw new Error("This project's board has no columns of its own. Set the task's status instead.");
    const to = columns.findIndex((column) => sameName(column.name, name));
    if (to < 0) throw new Error(`No column is named "${name}". This board's columns: ${columns.map((column) => column.name).join(", ")}.`);
    const from = columns.findIndex((column) => (task.columnId ? column.id === task.columnId : column.stage === task.status));
    if (to <= from) throw new Error(`A task moves forward only, and "${columns[to]!.name}" is not after its column. Tell the other thread what is wrong with thread_send.`);
    const column = columns[to]!;
    const moved = tasks.update(this.db, task.id, { columnId: column.id, status: column.stage, completedAt: column.stage === "done" ? Date.now() : null }, { explicitStatus: true });
    audit.record(this.db, { actor: "agent", action: "task.update", resourceType: "task", resourceId: task.id, metadata: { runId, patch: { column: column.name } } });
    this.invalidate(["tasks", "inbox", `task:${task.id}`]);
    this.arrived(task.id, column.id);
    return moved;
  }

  private async start(taskId: string, columnId: string): Promise<void> {
    const column = boardColumns.get(this.db, columnId);
    const task = tasks.get(this.db, taskId);
    if (!task || !column?.jobButtonId) return;
    const button = projects.get(this.db, column.projectId)?.settings.taskButtons?.find((each) => each.id === column.jobButtonId);
    if (!button) return;
    const next = column.nextColumnId ? boardColumns.get(this.db, column.nextColumnId) : null;
    const images = await new AttachmentService(this.dataDir).forTask(task.spec ?? "");
    await this.threads.runTaskButton(taskId, next ? { ...button, prompt: `${button.prompt}\n\n${handOn(next)}` } : button, images);
  }
}
