import { audit, boardColumns, projects, runs, taskActor, taskEvents, tasks, threads as threadRows, type BoardColumnInput, type Db } from "@openorc/db";
import { DEFAULT_BOARD_COLUMNS, MAX_TASK_BUTTONS, READY_MADE_AUTOMATIONS, isHarnessId, type BoardColumn, type BoardJob, type Task } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { AttachmentService } from "./attachments.js";
import type { Notification } from "./run-types.js";
import type { ThreadService } from "./threads.js";

/** A job runs with nobody watching its thread, so it says where the work stands on the task, where the person follows it. */
const REPORT = "Post where the work stands on this task with task_report, which the person reads on the task's page.";

/** The agent moves the card itself, since only it knows when its work is done: a review may take several turns to settle. */
const handOn = (next: BoardColumn | null): string =>
  next ? `${REPORT} When your work on this task is finished, move it to the "${next.name}" column with task_update (column: "${next.name}"). Leave it where it is until then.` : REPORT;

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
    const run = runs.get(this.db, runId);
    const by = taskActor(run?.threadId ? threadRows.get(this.db, run.threadId) : null);
    const moved = tasks.update(this.db, task.id, { columnId: column.id, status: column.stage, completedAt: column.stage === "done" ? Date.now() : null }, { explicitStatus: true, by });
    audit.record(this.db, { actor: "agent", action: "task.update", resourceType: "task", resourceId: task.id, metadata: { runId, patch: { column: column.name } } });
    this.invalidate(["tasks", "inbox", `task:${task.id}`]);
    this.arrived(task.id, column.id);
    return moved;
  }

  /** Every column job with its button's name and agent. A job whose button the project no longer has is left out, since nothing would start. */
  list(projectId?: string): BoardJob[] {
    return boardColumns.withJobs(this.db, projectId).flatMap((column) => {
      const button = projects.get(this.db, column.projectId)?.settings.taskButtons?.find((each) => each.id === column.jobButtonId);
      const agent = button?.choice && isHarnessId(button.choice.agent) ? button.choice.agent : null;
      return button ? [{ column, label: button.label, agent }] : [];
    });
  }

  switch(columnId: string, enabled: boolean): void {
    boardColumns.setJobEnabled(this.db, columnId, enabled);
    this.invalidate(["board"]);
  }

  /**
   * Adds a ready-made board automation to a project: its task buttons, and its columns where they belong. Columns for
   * the work itself take the place of the board's untouched In progress column, or go before the first column that
   * waits on the person; a column for before the work goes ahead of the first working one. Each new column hands its
   * cards to the column after it. Adding one the board already has changes nothing.
   */
  addReadyMade(projectId: string, id: string): BoardColumn[] {
    const made = READY_MADE_AUTOMATIONS.find((each) => each.id === id);
    const project = projects.get(this.db, projectId);
    if (made?.kind !== "board" || !project) throw new Error("This automation is no longer available.");
    const kept = boardColumns.list(this.db, projectId);
    const board: BoardColumnInput[] = kept.length > 0 ? kept.map((column) => ({ ...column })) : DEFAULT_BOARD_COLUMNS.map((column) => ({ ...column }));
    const fresh = made.columns
      .filter((column) => !board.some((each) => each.jobButtonId === column.button.id))
      .map((column) => ({ name: column.name, stage: "in_progress" as const, jobButtonId: column.button.id }));
    if (fresh.length === 0) return kept;
    const buttons = project.settings.taskButtons ?? [];
    const added = made.columns.map((column) => column.button).filter((button) => !buttons.some((each) => each.id === button.id));
    if (buttons.length + added.length > MAX_TASK_BUTTONS) throw new Error(`A project keeps up to ${MAX_TASK_BUTTONS} task buttons. Remove one in the project's settings first.`);
    projects.updateSettings(this.db, projectId, { taskButtons: [...buttons, ...added] });
    const untouched = made.place === "work" ? board.findIndex((column) => column.stage === "in_progress" && !column.jobButtonId && column.name === "In progress") : -1;
    if (untouched >= 0) {
      const [first, ...rest] = fresh;
      board.splice(untouched, 1, { ...board[untouched]!, ...first! }, ...rest);
    } else {
      const ahead = (stages: readonly string[]) => board.findIndex((column) => stages.includes(column.stage));
      const at = made.place === "before_work" && ahead(["in_progress"]) >= 0 ? ahead(["in_progress"]) : ahead(["review", "done"]);
      board.splice(at < 0 ? board.length : at, 0, ...fresh);
    }
    // Saved twice: a column can name the one after it only once that one has its id.
    const placed = boardColumns.save(this.db, projectId, board);
    const handsOn = (column: BoardColumn, index: number) => fresh.some((each) => each.jobButtonId === column.jobButtonId) && ["in_progress", "review"].includes(placed[index + 1]?.stage ?? "");
    const saved = boardColumns.save(
      this.db,
      projectId,
      placed.map((column, index) => (handsOn(column, index) ? { ...column, nextColumnId: placed[index + 1]!.id } : column)),
    );
    this.invalidate(["board", "projects", "tasks"]);
    return saved;
  }

  private async start(taskId: string, columnId: string): Promise<void> {
    const column = boardColumns.get(this.db, columnId);
    const task = tasks.get(this.db, taskId);
    if (!task || !column?.jobButtonId || !column.jobEnabled) return;
    const button = projects.get(this.db, column.projectId)?.settings.taskButtons?.find((each) => each.id === column.jobButtonId);
    if (!button) return;
    const next = column.nextColumnId ? boardColumns.get(this.db, column.nextColumnId) : null;
    const images = await new AttachmentService(this.dataDir).forTask(task.spec ?? "");
    const pressed = await this.threads.runTaskButton(taskId, { ...button, prompt: `${button.prompt}\n\n${handOn(next)}` }, images);
    // A message left unsent in its thread has started nothing yet.
    const thread = "draft" in pressed && pressed.draft !== undefined ? null : threadRows.get(this.db, pressed.threadId);
    if (!thread) return;
    taskEvents.record(this.db, taskId, { kind: "app" }, { kind: "started", label: button.label, agent: thread.agent, threadId: thread.id });
    this.invalidate(["tasks", `task:${taskId}`]);
  }
}
