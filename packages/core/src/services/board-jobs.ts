import { audit, boardColumns, projects, runs, taskActor, taskEvents, taskThreads, tasks, threads as threadRows, type BoardColumnInput, type Db } from "@openorc/db";
import { DEFAULT_BOARD_COLUMNS, READY_MADE_AUTOMATIONS, type BoardColumn, type Task, type TaskActor, type TaskButton, type Thread } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import { AttachmentService } from "./attachments.js";
import type { Notification } from "./run-types.js";
import type { TaskReports } from "./task-reports.js";
import type { ThreadService } from "./threads.js";

/** How often agents may bring a card to a column between themselves. The arrival after that starts nothing and waits for the person. */
const ROUNDS = 3;

/** What the person can tell the agent that keeps sending a card back, once it has gone round too often. */
const SETTLE = ["Be more lenient", "Resolve it yourself"];

/** A column's agent runs with nobody watching its thread, so it says where the work stands on the task, where the person follows it. */
const REPORT = "Post where the work stands on this task with task_report, which the person reads on the task's page.";

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** How a card came to a column: the column it left, and who moved it. */
export type Arrival = { from: string | null; by: TaskActor };

/**
 * What a column's agent is told beyond its own instructions: where the card came from, to say where the work stands,
 * and where the card goes. The agent moves the card itself, forward when its work is done or back when the work it was
 * given needs more, since only it knows which.
 */
function standing(from: BoardColumn | null, next: BoardColumn | null): string {
  return [
    from ? `This task came here from the "${from.name}" column.` : null,
    REPORT,
    next ? `When your work on it is finished, move it to the "${next.name}" column with task_update (column: "${next.name}").` : null,
    "A task whose work needs more can be moved back to an earlier column the same way. Leave it where it is until you have decided.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The agents a board's columns start. A column holds what its agent is told and the model it runs on; a card put in
 * the column starts that agent in a thread of its own for the task, which works where the task's work is, and a card
 * that comes back continues the same thread. Agents pass a card between columns until its work is right, and the person
 * is brought in when they have not settled it in three rounds.
 */
export class BoardJobs {
  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly threads: Pick<ThreadService, "runTaskButton" | "queue">,
    private readonly reports: Pick<TaskReports, "ask">,
    private readonly invalidate: (keys: string[]) => void,
    private readonly notify: (n: Omit<Notification, "type">) => void,
    private readonly log: Logger,
  ) {}

  /** A card was put in a column. Its agent starts in its own time; one that cannot start says why. */
  arrived(taskId: string, columnId: string, how: Arrival): void {
    void this.start(taskId, columnId, how).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      this.log.warn(`the agent of column ${columnId} did not start for task ${taskId}: ${reason}`);
      this.notify({ kind: "error", threadId: null, taskId, title: tasks.get(this.db, taskId)?.title ?? "Task", body: `Its column's agent did not start: ${reason}` });
    });
  }

  /** An agent's move, to a column by its name: forward when its work is done, or back when the work it was given needs more. */
  move(taskId: string, name: string, runId: string): Task {
    const task = tasks.get(this.db, taskId);
    if (!task) throw new Error("Task not found.");
    const columns = boardColumns.list(this.db, task.projectId);
    if (columns.length === 0) throw new Error("This project's board has no columns of its own. Set the task's status instead.");
    const column = columns.find((each) => sameName(each.name, name));
    if (!column) throw new Error(`No column is named "${name}". This board's columns: ${columns.map((each) => each.name).join(", ")}.`);
    if (column.id === task.columnId) throw new Error(`This task is already in "${column.name}".`);
    const run = runs.get(this.db, runId);
    const by = taskActor(run?.threadId ? threadRows.get(this.db, run.threadId) : null);
    const moved = tasks.update(this.db, task.id, { columnId: column.id, status: column.stage, completedAt: column.stage === "done" ? Date.now() : null }, { explicitStatus: true, by });
    audit.record(this.db, { actor: "agent", action: "task.update", resourceType: "task", resourceId: task.id, metadata: { runId, patch: { column: column.name } } });
    this.invalidate(["tasks", "inbox", `task:${task.id}`]);
    this.arrived(task.id, column.id, { from: task.columnId ?? null, by });
    return moved;
  }

  /** The columns that start an agent, of one project or of all. */
  list(projectId?: string): BoardColumn[] {
    return boardColumns.withJobs(this.db, projectId);
  }

  switch(columnId: string, enabled: boolean): void {
    boardColumns.setJobEnabled(this.db, columnId, enabled);
    this.invalidate(["board"]);
  }

  /**
   * Adds a ready-made board automation to a project: its columns, each with what its agent is told, where they belong.
   * Columns for the work itself take the place of the board's untouched In progress column, or go before the first
   * column that waits on the person; a column for before the work goes ahead of the first working one. Each new column
   * hands its cards to the column after it. Adding one the board already has changes nothing.
   */
  addReadyMade(projectId: string, id: string): BoardColumn[] {
    const made = READY_MADE_AUTOMATIONS.find((each) => each.id === id);
    if (made?.kind !== "board" || !projects.get(this.db, projectId)) throw new Error("This automation is no longer available.");
    const kept = boardColumns.list(this.db, projectId);
    const board: BoardColumnInput[] = kept.length > 0 ? kept.map((column) => ({ ...column })) : DEFAULT_BOARD_COLUMNS.map((column) => ({ ...column }));
    const has = (name: string) => board.some((each) => each.job && sameName(each.name, name));
    const fresh = made.columns.filter((column) => !has(column.name)).map((column) => ({ name: column.name, stage: "in_progress" as const, job: { prompt: column.prompt, choice: null } }));
    if (fresh.length === 0) return kept;
    const untouched = made.place === "work" ? board.findIndex((column) => column.stage === "in_progress" && !column.job && column.name === "In progress") : -1;
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
    const handsOn = (column: BoardColumn, index: number) => fresh.some((each) => sameName(each.name, column.name)) && ["in_progress", "review"].includes(placed[index + 1]?.stage ?? "");
    const saved = boardColumns.save(
      this.db,
      projectId,
      placed.map((column, index) => (handsOn(column, index) ? { ...column, nextColumnId: placed[index + 1]!.id } : column)),
    );
    this.invalidate(["board", "tasks"]);
    return saved;
  }

  private async start(taskId: string, columnId: string, how: Arrival): Promise<void> {
    const column = boardColumns.get(this.db, columnId);
    const task = tasks.get(this.db, taskId);
    if (!task || !column?.job || !column.jobEnabled) return;
    const rounds = taskEvents.arrivals(this.db, taskId, columnId);
    // A person's own move always starts the agent: the limit is on what agents do between themselves.
    if (how.by.kind === "agent" && rounds > ROUNDS) return this.bringInThePerson(task, column, rounds, how.by.threadId);
    const from = how.from ? boardColumns.get(this.db, how.from) : null;
    const next = column.nextColumnId ? boardColumns.get(this.db, column.nextColumnId) : null;
    const told = `${column.job.prompt}\n\n${standing(from, next)}`;
    const earlier = this.threadOf(taskId, column);
    // A card that comes back continues the thread that worked on it here, with what was said about it since.
    if (earlier) {
      const notes = this.latestNotes(taskId, earlier.id);
      this.threads.queue(earlier.id, [`This task is back in the "${column.name}" column.`, notes ? `The latest notes on it:\n${notes}` : null, told].filter(Boolean).join("\n\n"));
    }
    const thread = earlier ?? (await this.open(task, column, told));
    if (!thread) return;
    taskEvents.record(this.db, taskId, { kind: "app" }, { kind: "started", label: column.name, agent: thread.agent, threadId: thread.id });
    this.invalidate(["tasks", `task:${taskId}`]);
  }

  /** The thread the column's agent already works on this task in, while it is there to continue. */
  private threadOf(taskId: string, column: BoardColumn): Thread | null {
    const link = taskThreads.list(this.db, taskId).find((each) => each.label === column.name);
    const thread = link ? threadRows.get(this.db, link.threadId) : null;
    return thread && !thread.archivedAt ? thread : null;
  }

  /** A new thread for the column's agent, linked to the task under the column's name and working where the task's work is. */
  private async open(task: Task, column: BoardColumn, told: string): Promise<Thread | null> {
    const { choice } = column.job!;
    const press: TaskButton = { id: `column:${column.id}`, label: column.name, prompt: told, runsIn: "new", mode: "thread", ...(choice ? { choice } : {}) };
    const images = await new AttachmentService(this.dataDir).forTask(task.spec ?? "");
    const pressed = await this.threads.runTaskButton(task.id, press, images);
    return threadRows.get(this.db, pressed.threadId);
  }

  /** What another agent last posted on the task, as words: its message and, for a checklist, each item with whether it is done. */
  private latestNotes(taskId: string, readerThreadId: string): string | null {
    const update = taskEvents
      .list(this.db, taskId)
      .reverse()
      .find((event) => event.kind === "update" && event.actor.kind === "agent" && event.actor.threadId !== readerThreadId);
    if (update?.kind !== "update") return null;
    const items = update.card?.kind === "checklist" ? update.card.items.map((item) => `- [${item.done ? "x" : " "}] ${item.text}${item.detail ? ` (${item.detail})` : ""}`) : [];
    return [update.message, ...items].join("\n");
  }

  /** The agents have not settled it: nothing starts, and the task asks the person, whose answer goes to the agent that sent it back. */
  private bringInThePerson(task: Task, column: BoardColumn, rounds: number, senderThreadId: string | null): void {
    this.reports.ask(task.id, `This task has been sent to "${column.name}" ${rounds} times and is not settled. Nothing started this time.`, senderThreadId ? SETTLE : undefined, senderThreadId);
  }
}
