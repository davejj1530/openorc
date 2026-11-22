/** The newest refine not yet put away (dismissed_at) is the task's current one. */
export const taskRefineMigration = `
CREATE TABLE task_refines (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 recipient TEXT NOT NULL, instruction TEXT NOT NULL, base TEXT NOT NULL, state TEXT NOT NULL,
 suggestion TEXT, step TEXT, error TEXT, run_id TEXT, dismissed_at INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX task_refines_task ON task_refines(task_id, created_at);
CREATE UNIQUE INDEX task_refines_run ON task_refines(run_id) WHERE run_id IS NOT NULL;
ALTER TABLE runs ADD COLUMN refine_id TEXT REFERENCES task_refines(id) ON DELETE CASCADE;
CREATE INDEX runs_refine ON runs(refine_id) WHERE refine_id IS NOT NULL;
`;
