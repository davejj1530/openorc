import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Creation history and execution ownership are independent. Reading a diff cannot assign work. */
export function taskExecutionMigration(raw: DatabaseSync): void {
  raw.exec(`
    ALTER TABLE tasks ADD COLUMN execution_thread_id TEXT;
    CREATE INDEX tasks_execution_thread ON tasks(execution_thread_id);
    CREATE TABLE thread_queue (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      request_key TEXT NOT NULL,
      text TEXT NOT NULL,
      attachments TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','delivering','delivered','cancelled','interrupted')),
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(thread_id, request_key)
    );
    CREATE INDEX thread_queue_pending ON thread_queue(thread_id, state, created_at);
  `);

  // Prefer actual comment execution and previously imported task conversations.
  raw.exec(`
    UPDATE tasks SET execution_thread_id = (
      SELECT a.thread_id FROM task_comment_attempts a JOIN threads t ON t.id = a.thread_id
      WHERE a.task_id = tasks.id AND a.execution_run_id IS NOT NULL AND t.project_id = tasks.project_id
      ORDER BY a.updated_at DESC LIMIT 1
    );
    UPDATE tasks SET execution_thread_id = (
      SELECT t.id FROM threads t WHERE t.imported_from = 'task:' || tasks.id AND t.project_id = tasks.project_id LIMIT 1
    ) WHERE execution_thread_id IS NULL;
  `);

  // Legacy standalone task agents already own files. Retain those files in a
  // conversation without preparing a workspace or moving anything on disk.
  const legacy = raw
    .prepare(
      `SELECT t.* FROM tasks t
    WHERE execution_thread_id IS NULL
    AND (worktree_path IS NOT NULL OR EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id))
    AND NOT EXISTS (SELECT 1 FROM orchestration_team_instances o WHERE o.thread_id = t.thread_id)`,
    )
    .all();
  for (const task of legacy) {
    const previous = raw.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1").get(task.id!);
    const owner = task.thread_id ? raw.prepare("SELECT * FROM threads WHERE id = ?").get(task.thread_id) : undefined;
    const id = randomUUID();
    raw
      .prepare(
        `INSERT INTO threads
      (id, project_id, title, agent, model, effort, fast_mode, mode, permission_mode, workspace_mode,
       worktree_path, branch, base_sha, forked_from_id, imported_from, draft, created_at, updated_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'act', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        task.project_id!,
        task.title!,
        previous?.agent ?? owner?.agent ?? "codex",
        previous?.model ?? owner?.model ?? null,
        previous?.effort ?? owner?.effort ?? null,
        previous?.fast_mode ?? owner?.fast_mode ?? 0,
        previous?.permission_mode ?? owner?.permission_mode ?? "review",
        task.workspace_mode!,
        task.worktree_path ?? null,
        task.branch ?? null,
        task.base_sha ?? null,
        task.thread_id ?? null,
        `task:${task.id}`,
        `Work on task "${task.title}" (${task.id}).\n\n${task.spec ?? ""}`,
        task.created_at!,
        task.updated_at!,
        task.updated_at!,
      );
    raw.prepare("UPDATE tasks SET execution_thread_id = ? WHERE id = ?").run(id, task.id!);
  }

  // task_start works in a conversation and creates no task run. Its durable
  // audit evidence survives a later move back to backlog. Older progressed
  // tasks without an audit record retain their linked conversation too.
  raw.exec(`
    UPDATE tasks SET execution_thread_id = COALESCE(
      (SELECT COALESCE(json_extract(a.metadata, '$.threadId'), r.thread_id)
       FROM audit_events a LEFT JOIN runs r ON r.id = json_extract(a.metadata, '$.runId')
       JOIN threads t ON t.id = COALESCE(json_extract(a.metadata, '$.threadId'), r.thread_id)
       WHERE a.action = 'task.start' AND a.resource_id = tasks.id AND t.project_id = tasks.project_id
       ORDER BY a.created_at DESC LIMIT 1),
      CASE WHEN status IN ('in_progress','review','done') OR completed_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM orchestration_team_instances o WHERE o.thread_id = tasks.thread_id)
        THEN thread_id ELSE NULL END
    ) WHERE execution_thread_id IS NULL;
  `);
}
