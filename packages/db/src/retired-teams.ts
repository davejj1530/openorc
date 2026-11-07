import type { Db } from "./database.js";

const hiddenRecords = `WITH RECURSIVE hidden(kind, id) AS (
  SELECT 'thread', thread_id FROM orchestration_team_instances
  UNION SELECT 'thread', thread_id FROM team_deleted_threads
  UNION SELECT 'task', task_id FROM team_assignment_bindings
  UNION SELECT 'task', t.id FROM tasks t JOIN team_task_intents i ON i.task_id = t.id
  UNION SELECT 'task', t.id FROM tasks t JOIN settings s ON s.key = 'task.forwarding.target.' || t.id
  UNION SELECT 'thread', t.id FROM threads t JOIN hidden h ON h.kind = 'thread' AND t.parent_thread_id = h.id
  UNION SELECT 'task', t.id FROM tasks t JOIN hidden h ON h.kind = 'thread' AND t.thread_id = h.id
  UNION SELECT 'task', t.id FROM tasks t JOIN hidden h ON h.kind = 'task' AND t.parent_task_id = h.id
  UNION SELECT 'thread', t.execution_thread_id FROM tasks t JOIN hidden h ON h.kind = 'task' AND t.id = h.id
    WHERE t.execution_thread_id IS NOT NULL AND t.execution_thread_id IS NOT t.thread_id
  UNION SELECT 'thread', a.thread_id FROM task_comment_attempts a JOIN hidden h ON h.kind = 'task' AND a.task_id = h.id
    WHERE a.thread_id IS NOT NULL
)`;

export const retiredTaskIds = `${hiddenRecords} SELECT id FROM hidden WHERE kind = 'task'`;
export const retiredThreadIds = `${hiddenRecords} SELECT id FROM hidden WHERE kind = 'thread'`;

/** Internal fences only. Retired records never appear in app inventories or search. */
export const retiredTeams = {
  hasThread(db: Db, threadId: string): boolean {
    return Boolean(db.stmt("SELECT 1 FROM orchestration_team_instances WHERE thread_id = ?").get(threadId));
  },
  isHidden(db: Db, threadId: string): boolean {
    return Boolean(db.stmt(`SELECT 1 FROM (${retiredThreadIds}) WHERE id = ?`).get(threadId));
  },
  isDeleted(db: Db, threadId: string): boolean {
    return Boolean(db.stmt("SELECT 1 FROM team_deleted_threads WHERE thread_id = ?").get(threadId));
  },
  hasRun(db: Db, runId: string): boolean {
    return Boolean(
      db
        .stmt(
          `${hiddenRecords} SELECT 1 FROM runs r JOIN hidden h
      ON (h.kind = 'thread' AND h.id = r.thread_id) OR (h.kind = 'task' AND h.id = r.task_id)
      WHERE r.id = ?`,
        )
        .get(runId),
    );
  },
  hasTask(db: Db, taskId: string): boolean {
    return Boolean(db.stmt(`SELECT 1 FROM (${retiredTaskIds}) WHERE id = ?`).get(taskId));
  },
};
