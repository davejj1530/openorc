import type { DatabaseSync } from "node:sqlite";

/**
 * A review comment belongs to the conversation whose diff it annotates; its
 * task becomes a label. Existing comments move to their task's execution
 * conversation. Team review comments stay with their task: team review claims
 * them per assignment and delivers them through its own requests.
 */
export function conversationReviewCommentsMigration(raw: DatabaseSync): void {
  raw.exec(`
    CREATE TABLE review_comments_next (
      id TEXT PRIMARY KEY,
      thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      snapshot_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL,
      path TEXT NOT NULL,
      line INTEGER,
      side TEXT,
      line_text TEXT,
      body TEXT NOT NULL,
      sent_in_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      sent_message_id TEXT,
      created_at INTEGER NOT NULL,
      CHECK (thread_id IS NOT NULL OR task_id IS NOT NULL)
    );
    INSERT INTO review_comments_next (id, thread_id, task_id, snapshot_id, path, line, side, line_text, body, sent_in_run_id, sent_message_id, created_at)
    SELECT c.id,
      CASE
        WHEN EXISTS (SELECT 1 FROM team_review_claims claim WHERE claim.comment_id = c.id) THEN NULL
        WHEN EXISTS (SELECT 1 FROM team_assignment_bindings binding WHERE binding.task_id = c.task_id) THEN NULL
        WHEN EXISTS (SELECT 1 FROM team_task_intents intent WHERE intent.task_id = c.task_id) THEN NULL
        WHEN EXISTS (SELECT 1 FROM orchestration_team_instances team WHERE team.thread_id IN (task.thread_id, task.execution_thread_id)) THEN NULL
        ELSE task.execution_thread_id
      END,
      c.task_id, c.snapshot_id, c.path, c.line, c.side, NULL, c.body, c.sent_in_run_id, NULL, c.created_at
    FROM review_comments c LEFT JOIN tasks task ON task.id = c.task_id;
    DROP TABLE review_comments;
    ALTER TABLE review_comments_next RENAME TO review_comments;
    CREATE INDEX review_comments_thread ON review_comments(thread_id, created_at);
    CREATE INDEX review_comments_task ON review_comments(task_id, created_at);
  `);
}
