import { randomUUID } from "node:crypto";
import { CommentRecipient, TaskDocumentSnapshot, TaskRefineState, TaskSuggestion, type TaskRefine } from "@openorc/protocol";
import type { Db } from "./database.js";

type Row = Record<string, unknown>;
const refine = (r: Row): TaskRefine => ({
  id: String(r.id),
  taskId: String(r.task_id),
  state: TaskRefineState.parse(r.state),
  recipient: CommentRecipient.parse(JSON.parse(String(r.recipient))),
  instruction: String(r.instruction),
  base: TaskDocumentSnapshot.parse(JSON.parse(String(r.base))),
  suggestion: r.suggestion ? TaskSuggestion.parse(JSON.parse(String(r.suggestion))) : null,
  step: r.step as string | null,
  error: r.error as string | null,
  runId: r.run_id as string | null,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

type Patch = Partial<Pick<TaskRefine, "state" | "suggestion" | "step" | "error" | "runId">>;
const columns: Record<keyof Patch, string> = { state: "state", suggestion: "suggestion", step: "step", error: "error", runId: "run_id" };

export const taskRefines = {
  current(db: Db, taskId: string): TaskRefine | null {
    const r = db.stmt("SELECT * FROM task_refines WHERE task_id=? AND dismissed_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").get(taskId);
    return r ? refine(r) : null;
  },
  get(db: Db, id: string): TaskRefine | null {
    const r = db.stmt("SELECT * FROM task_refines WHERE id=?").get(id);
    return r ? refine(r) : null;
  },
  forRun(db: Db, runId: string): TaskRefine | null {
    const r = db.stmt("SELECT * FROM task_refines WHERE run_id=?").get(runId);
    return r ? refine(r) : null;
  },
  /** Starting a refine puts away the task's earlier ones, except a suggestion, which stays until the new one has its own. */
  insert(db: Db, input: Pick<TaskRefine, "taskId" | "recipient" | "instruction" | "base">): TaskRefine {
    const id = randomUUID();
    const now = Date.now();
    db.transaction(() => {
      db.stmt("UPDATE task_refines SET dismissed_at=? WHERE task_id=? AND dismissed_at IS NULL AND state<>'ready'").run(now, input.taskId);
      db.stmt("INSERT INTO task_refines (id,task_id,recipient,instruction,base,state,created_at,updated_at) VALUES (?,?,?,?,?,'running',?,?)").run(
        id,
        input.taskId,
        JSON.stringify(input.recipient),
        input.instruction,
        JSON.stringify(input.base),
        now,
        now,
      );
    });
    return taskRefines.get(db, id)!;
  },
  update(db: Db, id: string, patch: Patch): TaskRefine | null {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as [keyof Patch, unknown][];
    if (!entries.length) return taskRefines.get(db, id);
    const sets = entries.map(([key]) => `${columns[key]}=?`);
    const values = entries.map(([key, value]) => (key === "suggestion" && value !== null ? JSON.stringify(value) : (value as string | null)));
    db.stmt(`UPDATE task_refines SET ${[...sets, "updated_at=?"].join(",")} WHERE id=?`).run(...values, Date.now(), id);
    return taskRefines.get(db, id);
  },
  dismiss(db: Db, id: string): void {
    db.stmt("UPDATE task_refines SET dismissed_at=? WHERE id=? AND dismissed_at IS NULL").run(Date.now(), id);
  },
  /** The suggestion a newer refine of the task was started from, while it is still current behind it. */
  earlierSuggestion(db: Db, taskId: string, id: string): TaskRefine | null {
    const r = db.stmt("SELECT * FROM task_refines WHERE task_id=? AND id<>? AND state='ready' AND dismissed_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").get(taskId, id);
    return r ? refine(r) : null;
  },
  dismissOthers(db: Db, taskId: string, id: string): void {
    db.stmt("UPDATE task_refines SET dismissed_at=? WHERE task_id=? AND id<>? AND dismissed_at IS NULL").run(Date.now(), taskId, id);
  },
  running(db: Db): TaskRefine[] {
    return db
      .stmt("SELECT * FROM task_refines WHERE state='running'")
      .all()
      .map((r) => refine(r));
  },
};
