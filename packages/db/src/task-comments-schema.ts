export const taskCommentsMigration = `
CREATE TABLE task_comments (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 request_key TEXT NOT NULL, body TEXT NOT NULL, recipients TEXT NOT NULL,
 reply_to TEXT, source TEXT NOT NULL, context TEXT NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(task_id, request_key)
);
CREATE INDEX task_comments_order ON task_comments(task_id, created_at);
CREATE TABLE task_comment_attempts (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 comment_id TEXT NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
 recipient_key TEXT NOT NULL, recipient TEXT NOT NULL, state TEXT NOT NULL,
 body TEXT NOT NULL DEFAULT '', error TEXT, run_id TEXT, thread_id TEXT, execution_run_id TEXT, intent TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(comment_id, recipient_key)
);
CREATE INDEX task_comment_attempts_task ON task_comment_attempts(task_id, state);
CREATE UNIQUE INDEX task_comment_attempts_run ON task_comment_attempts(run_id) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX task_comment_attempts_execution_run ON task_comment_attempts(execution_run_id) WHERE execution_run_id IS NOT NULL;
ALTER TABLE runs ADD COLUMN comment_turn_id TEXT REFERENCES task_comment_attempts(id) ON DELETE CASCADE;
CREATE INDEX runs_comment_turn ON runs(comment_turn_id);
`;
