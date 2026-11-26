import type { Db } from "./database.js";

/**
 * The threads this computer's agents work team tasks in, one for each column of the task whose agent it is: a card that
 * comes back to a column continues its thread there.
 */
export const teamTaskThreadsMigration = `
CREATE TABLE team_task_threads (
 space_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 column_name TEXT NOT NULL,
 thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL,
 PRIMARY KEY (space_id, task_id, column_name)
) WITHOUT ROWID;
CREATE INDEX team_task_threads_thread ON team_task_threads(thread_id);
`;

const key = (name: string) => name.trim().toLowerCase();

/** The name a task's own thread is kept under, beside its columns' agents' threads. */
export const TASK_OWN_THREAD = "";

export const teamTaskThreads = {
  /** The thread a column's agent works the task in, by the column's name. */
  get(db: Db, spaceId: string, taskId: string, columnName: string): string | null {
    const row = db.stmt("SELECT thread_id FROM team_task_threads WHERE space_id = ? AND task_id = ? AND column_name = ?").get(spaceId, taskId, key(columnName)) as { thread_id: string } | undefined;
    return row?.thread_id ?? null;
  },
  /** The team task a thread works, and under which column's name: none for a thread of this computer's own. */
  ofThread(db: Db, threadId: string): { spaceId: string; taskId: string; columnName: string } | null {
    const row = db.stmt("SELECT space_id, task_id, column_name FROM team_task_threads WHERE thread_id = ? LIMIT 1").get(threadId) as
      { space_id: string; task_id: string; column_name: string } | undefined;
    return row ? { spaceId: row.space_id, taskId: row.task_id, columnName: row.column_name } : null;
  },
  link(db: Db, spaceId: string, taskId: string, columnName: string, threadId: string): void {
    db.stmt("INSERT OR REPLACE INTO team_task_threads (space_id, task_id, column_name, thread_id, created_at) VALUES (?, ?, ?, ?, ?)").run(spaceId, taskId, key(columnName), threadId, Date.now());
  },
};
