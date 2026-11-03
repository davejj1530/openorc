import type { ThreadSearchHit } from "@openorc/protocol";
import type { Db } from "./database.js";
import { retiredTaskIds, retiredThreadIds } from "./retired-teams.js";

interface HitRow {
  thread_id: string;
  thread_title: string;
  project_id: string;
  run_id: string;
  message_id: string;
  turn: number;
  role: "user" | "assistant";
  snippet: string;
  ts: number;
  task_id: string | null;
  task_title: string | null;
}

/** Turns free text into an FTS5 query: every word a prefix, all of them required. */
function messageQuery(text: string): string {
  const words = text
    .replace(/["*()]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 8);
  return words.map((w) => `"${w}"*`).join(" ");
}

/** Full-text search over what the user and the agents said, joined back to their threads. */
export const messages = {
  index(db: Db, m: { runId: string; messageId: string; role: "user" | "assistant"; text: string; ts: number }): void {
    if (m.text.trim().length === 0) return;
    db.stmt("INSERT INTO messages_fts (text, run_id, role, ts, message_id) VALUES (?, ?, ?, ?, ?)").run(m.text, m.runId, m.role, m.ts, m.messageId);
  },
  /** With `orclingId`, only what was said where that Orcling spoke: its own conversation, threads it works in, and its guest replies. */
  search(db: Db, query: string, options: { projectId?: string; orclingId?: string; limit?: number } = {}): ThreadSearchHit[] {
    const q = messageQuery(query);
    if (!q) return [];
    const args: (string | number)[] = [q];
    let where = "";
    if (options.projectId) {
      where = "AND t.project_id = ?";
      args.push(options.projectId);
    }
    if (options.orclingId) {
      where += " AND (r.orcling_id = ? OR t.orcling_id = ?)";
      args.push(options.orclingId, options.orclingId);
    }
    args.push(options.limit ?? 30);
    // A message's turn is the turns its run completed before it. One that ended in the same millisecond is not
    // counted, which can only start the load a turn early.
    const rows = db
      .stmt(
        `SELECT t.id AS thread_id, t.title AS thread_title, t.project_id, f.run_id, f.message_id, f.role, snippet(messages_fts, 0, '', '', '…', 18) AS snippet, f.ts,
                (SELECT COUNT(*) FROM events d WHERE d.run_id = f.run_id AND d.kind = 'turn.completed' AND d.ts < f.ts) AS turn,
                k.id AS task_id, k.title AS task_title
         FROM messages_fts f
         JOIN runs r ON r.id = f.run_id
         LEFT JOIN tasks k ON k.id = r.task_id
         JOIN threads t ON t.id = COALESCE(r.thread_id, k.thread_id)
         WHERE messages_fts MATCH ? ${where}
           AND t.id NOT IN (${retiredThreadIds})
           AND (k.id IS NULL OR k.id NOT IN (${retiredTaskIds}))
         ORDER BY bm25(messages_fts), f.ts DESC
         LIMIT ?`,
      )
      .all(...args) as unknown as HitRow[];
    return rows.map((r) => ({
      threadId: r.thread_id,
      threadTitle: r.thread_title,
      projectId: r.project_id,
      runId: r.run_id,
      messageId: r.message_id,
      turn: r.turn,
      role: r.role,
      snippet: r.snippet,
      ts: r.ts,
      taskId: r.task_id,
      taskTitle: r.task_title,
      member: null,
    }));
  },
};
