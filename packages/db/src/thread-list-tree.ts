import { retiredThreadIds } from "./retired-teams.js";

/** Independent conversations obey filters; native children inherit their owner's visibility. */
export function threadTreeSql(where: string, order: string, limit: string): string {
  return `WITH RECURSIVE
    ancestry(id, parent_thread_id) AS (
      SELECT id, parent_thread_id FROM threads WHERE id = ?
      UNION SELECT t.id, t.parent_thread_id FROM threads t JOIN ancestry a ON a.parent_thread_id = t.id
    ),
    eligible AS (
      SELECT threads.* FROM threads WHERE COALESCE(parent_relation, '') != 'subagent' AND ${where}
        AND NOT EXISTS (SELECT 1 FROM orclings WHERE orclings.thread_id = threads.id)
    ),
    parents(child, id) AS (
      SELECT id, parent_thread_id FROM eligible WHERE parent_thread_id IS NOT NULL
      UNION ALL SELECT p.child, t.parent_thread_id FROM parents p JOIN threads t ON t.id = p.id
        WHERE t.parent_relation = 'subagent' AND t.parent_thread_id IS NOT NULL
    ),
    roots AS (
      SELECT * FROM eligible WHERE id NOT IN (SELECT p.child FROM parents p JOIN eligible owner ON owner.id = p.id)
    ),
    forest(root_id, id, last_activity_at) AS (
      SELECT id, id, last_activity_at FROM roots
      UNION ALL SELECT f.root_id, t.id, t.last_activity_at FROM threads t INDEXED BY threads_parent JOIN forest f ON t.parent_thread_id = f.id
        WHERE t.parent_thread_id IS NOT NULL AND (t.id IN (SELECT id FROM eligible)
          OR (t.parent_relation = 'subagent' AND t.id NOT IN (${retiredThreadIds})))
    ),
    latest AS (
      SELECT root_id, MAX(last_activity_at) AS tree_activity FROM forest GROUP BY root_id
    ),
    page AS (SELECT roots.*, latest.tree_activity FROM roots JOIN latest ON latest.root_id = roots.id
      ORDER BY ${order.replaceAll("last_activity_at", "tree_activity")}${limit})
    SELECT threads.* FROM threads WHERE id IN (SELECT id FROM forest WHERE root_id IN (
      SELECT id FROM page UNION SELECT id FROM roots WHERE id IN (SELECT id FROM ancestry)
    )) ORDER BY ${order}`;
}
