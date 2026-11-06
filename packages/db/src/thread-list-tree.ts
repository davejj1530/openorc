import { retiredThreadIds } from "./retired-teams.js";
import { THREAD_CHILD_PAGE, type RpcParams } from "@openorc/protocol";

export function threadTreeArgs(options: Pick<RpcParams<"threads.list">, "selectedId" | "childLimits"> & { attentionIds?: readonly string[] }): string[] {
  return [options.selectedId ?? "", JSON.stringify(options.childLimits ?? {}), JSON.stringify(options.attentionIds ?? [])];
}

/**
 * The roots a list shows and each one's latest work anywhere in its tree, as `roots` and `latest`. Independent
 * conversations obey `where`; native children inherit their owner's visibility.
 */
function forestSql(where: string): string {
  return `eligible AS (
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
    )`;
}

/** Independent conversations obey filters; native children inherit their owner's visibility. */
export function threadTreeSql(where: string, order: string, limit: string): string {
  return `WITH RECURSIVE
    options AS (SELECT ? AS selected_id, ? AS child_limits, ? AS attention_ids),
    ancestry(id, parent_thread_id) AS (
      SELECT id, parent_thread_id FROM threads WHERE id = (SELECT selected_id FROM options)
      UNION SELECT t.id, t.parent_thread_id FROM threads t JOIN ancestry a ON a.parent_thread_id = t.id
    ),
    required(id, parent_thread_id) AS (
      SELECT id, parent_thread_id FROM threads WHERE id IN (SELECT id FROM ancestry)
        OR id IN (SELECT thread_id FROM subagents WHERE status = 'running')
        OR id IN (SELECT value FROM json_each((SELECT attention_ids FROM options)))
      UNION SELECT t.id, t.parent_thread_id FROM threads t JOIN required r ON r.parent_thread_id = t.id
    ),
    ${forestSql(where)},
    page AS (SELECT roots.*, latest.tree_activity FROM roots JOIN latest ON latest.root_id = roots.id
      ORDER BY ${order.replaceAll("last_activity_at", "tree_activity")}${limit}),
    selected AS (SELECT * FROM threads WHERE id IN (SELECT id FROM forest WHERE root_id IN (
      SELECT id FROM page UNION SELECT id FROM roots WHERE id IN (SELECT id FROM ancestry)
    ))),
    ranked AS (SELECT id, parent_thread_id, ROW_NUMBER() OVER (PARTITION BY parent_thread_id ORDER BY COALESCE(parent_relation, '') = 'subagent', created_at DESC, id) AS position FROM selected),
    allowed AS (SELECT id, parent_thread_id FROM ranked WHERE position <= COALESCE(
      (SELECT value FROM json_each((SELECT child_limits FROM options)) WHERE key = ranked.parent_thread_id), ${THREAD_CHILD_PAGE})
      OR id IN (SELECT id FROM required)),
    visible(id) AS (
      SELECT id FROM roots WHERE id IN (SELECT id FROM selected)
      UNION SELECT a.id FROM allowed a JOIN visible v ON a.parent_thread_id = v.id
    ),
    hidden AS (SELECT parent_thread_id, COUNT(*) AS n FROM ranked WHERE id NOT IN (SELECT id FROM visible) GROUP BY parent_thread_id)
    SELECT threads.*, COALESCE(hidden.n, 0) AS hidden_children, latest.tree_activity FROM threads
      LEFT JOIN hidden ON hidden.parent_thread_id = threads.id LEFT JOIN latest ON latest.root_id = threads.id
      WHERE threads.id IN (SELECT id FROM visible) ORDER BY ${order}`;
}

/** How many roots `where` lists whose tree matches `rootWhere`, given `latest.tree_activity`. */
export function threadRootCountSql(where: string, rootWhere: string): string {
  return `WITH RECURSIVE ${forestSql(where)}
    SELECT COUNT(*) AS n FROM roots JOIN latest ON latest.root_id = roots.id WHERE ${rootWhere}`;
}
