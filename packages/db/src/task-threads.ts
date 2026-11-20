import type { Db } from "./database.js";

export type TaskThreadRow = { threadId: string; taskId: string; label: string | null; createdAt: number };

export const taskThreads = {
  /** Linking a thread to the same task again keeps its first label. */
  link(db: Db, input: Pick<TaskThreadRow, "taskId" | "threadId" | "label">): void {
    db.stmt("INSERT OR IGNORE INTO task_threads (task_id, thread_id, label, created_at) VALUES (?, ?, ?, ?)").run(input.taskId, input.threadId, input.label, Date.now());
  },
  list(db: Db, taskId: string): TaskThreadRow[] {
    return db
      .stmt("SELECT * FROM task_threads WHERE task_id = ? ORDER BY created_at DESC, rowid DESC")
      .all(taskId)
      .map((r) => ({ threadId: String(r.thread_id), taskId: String(r.task_id), label: r.label === null ? null : String(r.label), createdAt: Number(r.created_at) }));
  },
};
