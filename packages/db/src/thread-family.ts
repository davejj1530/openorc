import type { Db } from "./database.js";

/**
 * Resolves a thread with the open threads started under it, all at `at`, so a reopen knows which went with it.
 * Subagents are walked through but left unmarked; a pinned or snoozed thread stays out with everything under it.
 */
export function resolveThread(db: Db, id: string, at: number): void {
  db.stmt(
    `WITH RECURSIVE family(id) AS (
      SELECT ?1 UNION SELECT t.id FROM threads t INDEXED BY threads_parent JOIN family f ON t.parent_thread_id = f.id
        WHERE t.parent_thread_id IS NOT NULL AND t.pinned_at IS NULL AND (t.snoozed_until IS NULL OR t.snoozed_until <= ?2)
    )
    UPDATE threads SET archived_at = ?2, updated_at = ?2
      WHERE id IN (SELECT id FROM family) AND archived_at IS NULL AND (id = ?1 OR COALESCE(parent_relation, '') != 'subagent')`,
  ).run(id, at);
}

/**
 * Brings a thread back from Resolved with the threads under it that were resolved along with it. That counts as
 * activity, so a thread resolved by its age comes back too; a read thread stays read.
 */
export function reopenThread(db: Db, id: string): void {
  const at = Date.now();
  db.transaction(() => {
    // The threads under it first: their walk matches the root's archived_at, which the root's update clears.
    db.stmt(
      `WITH RECURSIVE family(id) AS (
        SELECT id FROM threads WHERE id = ?1 AND archived_at IS NOT NULL
        UNION SELECT t.id FROM threads t INDEXED BY threads_parent JOIN family f ON t.parent_thread_id = f.id
          WHERE t.parent_thread_id IS NOT NULL AND (t.parent_relation = 'subagent' OR t.archived_at = (SELECT archived_at FROM threads WHERE id = ?1))
      )
      UPDATE threads SET archived_at = NULL, updated_at = ?2 WHERE id IN (SELECT id FROM family) AND id != ?1 AND COALESCE(parent_relation, '') != 'subagent'`,
    ).run(id, at);
    db.stmt("UPDATE threads SET archived_at = NULL, seen_at = CASE WHEN seen_at >= last_activity_at THEN ? ELSE seen_at END, last_activity_at = ?, updated_at = ? WHERE id = ?").run(at, at, at, id);
  });
}
