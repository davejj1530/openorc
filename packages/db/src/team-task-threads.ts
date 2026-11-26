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

export const teamTaskThreads = {
  /** The thread a column's agent works the task in, by the column's name. */
  get(db: Db, spaceId: string, taskId: string, columnName: string): string | null {
    const row = db.stmt("SELECT thread_id FROM team_task_threads WHERE space_id = ? AND task_id = ? AND column_name = ?").get(spaceId, taskId, key(columnName)) as { thread_id: string } | undefined;
    return row?.thread_id ?? null;
  },
  link(db: Db, spaceId: string, taskId: string, columnName: string, threadId: string): void {
    db.stmt("INSERT OR REPLACE INTO team_task_threads (space_id, task_id, column_name, thread_id, created_at) VALUES (?, ?, ?, ?, ?)").run(spaceId, taskId, key(columnName), threadId, Date.now());
  },
};
