import type { TaskActor, TaskEvent, Thread } from "@openorc/protocol";
import type { Db } from "./database.js";

/**
 * What happened to a task, in order: who made it, where it was moved and what was started for it. A task's events go
 * with it. Tasks from before the history begin it with their making.
 */
export const taskEventsMigration = `
CREATE TABLE task_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 actor TEXT NOT NULL,
 data TEXT NOT NULL DEFAULT '{}',
 created_at INTEGER NOT NULL
);
CREATE INDEX task_events_task ON task_events(task_id, id);
INSERT INTO task_events (task_id, kind, actor, data, created_at)
 SELECT id, 'created', CASE origin WHEN 'agent' THEN '{"kind":"app"}' ELSE '{"kind":"user"}' END, '{}', created_at FROM tasks;
`;

interface TaskEventRow {
  id: number;
  task_id: string;
  kind: TaskEvent["kind"];
  actor: string;
  data: string;
  created_at: number;
}
const FIELDS = "id, task_id, kind, actor, data, created_at";
const fromRow = (row: TaskEventRow): TaskEvent =>
  ({ ...(JSON.parse(row.data) as object), id: row.id, taskId: row.task_id, at: row.created_at, actor: JSON.parse(row.actor) as TaskActor, kind: row.kind }) as TaskEvent;

type Recorded<E> = E extends TaskEvent ? Omit<E, "id" | "taskId" | "at" | "actor"> : never;
/** One event as it is recorded: its kind and what that kind holds. */
export type NewTaskEvent = Recorded<TaskEvent>;

/** An agent acts from its thread; work with no thread behind it is the app's own. */
export const taskActor = (thread: Pick<Thread, "id" | "agent"> | null | undefined): TaskActor => (thread ? { kind: "agent", agent: thread.agent, threadId: thread.id } : { kind: "app" });

export const taskEvents = {
  record(db: Db, taskId: string, actor: TaskActor, { kind, ...data }: NewTaskEvent): number {
    const added = db.stmt("INSERT INTO task_events (task_id, kind, actor, data, created_at) VALUES (?, ?, ?, ?, ?)").run(taskId, kind, JSON.stringify(actor), JSON.stringify(data), Date.now());
    return Number(added.lastInsertRowid);
  },
  list(db: Db, taskId: string): TaskEvent[] {
    return (db.stmt(`SELECT ${FIELDS} FROM task_events WHERE task_id = ? ORDER BY id`).all(taskId) as unknown as TaskEventRow[]).map(fromRow);
  },
  get(db: Db, id: number): TaskEvent | null {
    const row = db.stmt(`SELECT ${FIELDS} FROM task_events WHERE id = ?`).get(id) as unknown as TaskEventRow | undefined;
    return row ? fromRow(row) : null;
  },
  /** An event with what it holds changed, in its place in the history. */
  replace(db: Db, id: number, { kind, ...data }: NewTaskEvent): void {
    db.stmt("UPDATE task_events SET data = ? WHERE id = ? AND kind = ?").run(JSON.stringify(data), id, kind);
  },
  /** What each task's newest update asks the person, for those that offered replies and have none yet. An update after it withdraws the ask. */
  asking(db: Db): Map<string, string> {
    const rows = db
      .stmt(
        `SELECT e.task_id, json_extract(e.data, '$.message') AS message FROM task_events e
         WHERE e.kind = 'update' AND json_extract(e.data, '$.replies') IS NOT NULL AND json_extract(e.data, '$.answer') IS NULL
         AND e.id = (SELECT max(l.id) FROM task_events l WHERE l.task_id = e.task_id AND l.kind = 'update')`,
      )
      .all() as unknown as { task_id: string; message: string }[];
    return new Map(rows.map((row) => [row.task_id, row.message]));
  },
};
