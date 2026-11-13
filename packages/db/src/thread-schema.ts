import type { DatabaseSync } from "node:sqlite";

/**
 * Threads: the conversation a user has with an agent in the project root.
 * Runs and summaries now belong to a thread or a task; tasks remember the
 * thread that spawned them. task_id loses NOT NULL, which SQLite can only do
 * by rebuilding the table, so the runner keeps foreign keys off meanwhile.
 */
export function threadsMigration(raw: DatabaseSync): void {
  raw.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      agent TEXT NOT NULL,
      model TEXT,
      mode TEXT NOT NULL DEFAULT 'act',
      permission_mode TEXT NOT NULL DEFAULT 'trusted',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE INDEX threads_project ON threads(project_id, last_activity_at DESC);

    CREATE TABLE runs_new (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
      agent TEXT NOT NULL,
      model TEXT,
      mode TEXT NOT NULL DEFAULT 'act',
      permission_mode TEXT NOT NULL DEFAULT 'trusted',
      external_session_id TEXT,
      state TEXT NOT NULL DEFAULT 'starting',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      usage TEXT,
      result_text TEXT
    );
    INSERT INTO runs_new (id, task_id, agent, model, mode, permission_mode, external_session_id, state, started_at, ended_at, usage, result_text)
      SELECT id, task_id, agent, model, mode, permission_mode, external_session_id, state, started_at, ended_at, usage, result_text FROM runs;
    DROP TABLE runs;
    ALTER TABLE runs_new RENAME TO runs;
    CREATE INDEX runs_task ON runs(task_id, started_at);
    CREATE INDEX runs_thread ON runs(thread_id, started_at);

    CREATE TABLE session_summaries_new (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      request TEXT NOT NULL,
      work_done TEXT NOT NULL,
      outcome TEXT NOT NULL,
      open_items TEXT NOT NULL DEFAULT '[]',
      model TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO session_summaries_new (run_id, task_id, project_id, request, work_done, outcome, open_items, model, created_at)
      SELECT run_id, task_id, project_id, request, work_done, outcome, open_items, model, created_at FROM session_summaries;
    DROP TABLE session_summaries;
    ALTER TABLE session_summaries_new RENAME TO session_summaries;
    CREATE INDEX session_summaries_project ON session_summaries(project_id, created_at DESC);

    ALTER TABLE tasks ADD COLUMN thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL;
    ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';
    CREATE INDEX tasks_thread ON tasks(thread_id, created_at);
  `);
}
