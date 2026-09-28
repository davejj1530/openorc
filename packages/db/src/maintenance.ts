import type { Db } from "./database.js";
import { FragmentTracker, STREAMED_KINDS } from "./fragments.js";

export interface LedgerSpace {
  /** Bytes in pages SQLite holds free inside the file. */
  freeBytes: number;
  fileBytes: number;
  pageBytes: number;
  /** Incremental mode can hand free pages back to the disk a few at a time; other modes need a full rebuild. */
  incremental: boolean;
}

/**
 * Keeps the ledger from growing without end. Native passthrough rows expire; the one full rebuild switches the file to
 * incremental vacuuming, after which free space goes back to the disk in small steps.
 */
export const ledgerMaintenance = {
  /**
   * Deletes up to `limit` raw rows older than `before`; their large payloads go with them. Callers repeat until it
   * returns less than `limit`, yielding between calls so the single writer is never held for long.
   */
  expireRaw(db: Db, before: number, limit = 2000): number {
    const result = db.stmt("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE kind = 'raw' AND ts < ? LIMIT ?)").run(before, limit);
    return Number(result.changes);
  },

  /**
   * Deletes the streamed rows of a run that later rows make redundant, by the rules the ledger writer applies live;
   * for history written before it did. Returns rows deleted.
   */
  clearSupersededFragments(db: Db, runId: string): number {
    // Large rows keep their JSON in artifacts; the facts come from there.
    const body = "COALESCE(a.content, e.payload)";
    const rows = db
      .stmt(
        `SELECT e.seq, e.kind,
           COALESCE(json_extract(${body}, '$.messageId'), json_extract(${body}, '$.toolCallId'), json_extract(${body}, '$.activityId')) AS item,
           CASE e.kind
             WHEN 'thinking.completed' THEN COALESCE(json_extract(${body}, '$.text'), '') <> ''
             WHEN 'tool.completed' THEN COALESCE(json_type(${body}, '$.output'), 'null') <> 'null'
             WHEN 'activity.updated' THEN json_type(${body}, '$.text') IS NOT NULL
             ELSE 1 END AS content,
           e.kind <> 'activity.updated' OR (json_type(${body}, '$.detail') IS NULL AND json_type(${body}, '$.activityKind') IS NULL
             AND json_type(${body}, '$.recovery') IS NULL AND json_type(${body}, '$.imagePath') IS NULL) AS plain
         FROM events e LEFT JOIN artifacts a ON a.event_id = e.id AND a.kind = 'payload'
         WHERE e.run_id = ? AND e.kind IN (${STREAMED_KINDS.map((kind) => `'${kind}'`).join(", ")}) AND json_valid(${body})
         ORDER BY e.seq`,
      )
      .all(runId) as Array<{ seq: number; kind: string; item: string | null; content: number; plain: number }>;
    const tracker = new FragmentTracker();
    const redundant = rows.flatMap((row) => tracker.add(runId, row.seq, { kind: row.kind, item: row.item ?? undefined, content: row.content === 1, plain: row.plain === 1 }));
    if (!redundant.length) return 0;
    return Number(db.stmt("DELETE FROM events WHERE run_id = ? AND seq IN (SELECT value FROM json_each(?))").run(runId, JSON.stringify(redundant)).changes);
  },

  /** Deletes search entries whose run is gone; the search index has no foreign key to cascade from. Returns rows deleted. */
  clearDeletedRunSearch(db: Db): number {
    return Number(db.stmt("DELETE FROM messages_fts WHERE run_id NOT IN (SELECT id FROM runs)").run().changes);
  },

  space(db: Db): LedgerSpace {
    const pragma = (name: string) => Number(Object.values(db.raw.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[0]);
    const pageBytes = pragma("page_size");
    return { freeBytes: pragma("freelist_count") * pageBytes, fileBytes: pragma("page_count") * pageBytes, pageBytes, incremental: pragma("auto_vacuum") === 2 };
  },

  /** Rewrites the whole file without its free space, switching it to incremental vacuuming. Blocks for as long as the rewrite takes. */
  compact(db: Db): void {
    db.raw.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.raw.exec("VACUUM");
  },

  /** Hands up to `pages` free pages back to the disk. Only an incrementally vacuumed file can; returns the pages freed. */
  reclaim(db: Db, pages: number): number {
    const before = ledgerMaintenance.space(db);
    if (!before.incremental || before.freeBytes === 0) return 0;
    db.raw.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`);
    return (before.freeBytes - ledgerMaintenance.space(db).freeBytes) / before.pageBytes;
  },
};
