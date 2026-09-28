import type { ThreadSearchHit } from "@openorc/protocol";
import type { Db } from "./database.js";

interface HitRow {
  thread_id: string;
  thread_title: string;
  project_id: string;
  run_id: string;
  role: "user" | "assistant";
  snippet: string;
  ts: number;
  task_id: string | null;
  task_title: string | null;
  member_key: string | null;
  member_name: string | null;
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
  search(db: Db, query: string, options: { projectId?: string; limit?: number } = {}): ThreadSearchHit[] {
    const q = messageQuery(query);
    if (!q) return [];
    const args: (string | number)[] = [q];
    let where = "";
    if (options.projectId) {
      where = "AND t.project_id = ?";
      args.push(options.projectId);
    }
    args.push(options.limit ?? 30);
    const rows = db
      .stmt(
        `SELECT t.id AS thread_id, t.title AS thread_title, t.project_id, f.run_id, f.role, snippet(messages_fts, 0, '', '', '…', 18) AS snippet, f.ts,
                k.id AS task_id, k.title AS task_title, m.member_key, m.name AS member_name
         FROM messages_fts f
         JOIN runs r ON r.id = f.run_id
         LEFT JOIN tasks k ON k.id = r.task_id
         JOIN threads t ON t.id = COALESCE(r.thread_id, k.thread_id)
         LEFT JOIN team_run_bindings b ON b.run_id = r.id
         LEFT JOIN team_executions e ON e.id = b.execution_id
         LEFT JOIN team_actors a ON a.execution_id = b.execution_id AND a.id = b.actor_id
         LEFT JOIN orchestration_team_instances i ON i.id = e.instance_id
         LEFT JOIN orchestration_team_members m ON m.revision_id = i.team_revision_id AND m.member_key = a.member_key
         WHERE messages_fts MATCH ? ${where}
           AND NOT EXISTS (SELECT 1 FROM team_deleted_threads hidden WHERE hidden.thread_id = t.id)
         ORDER BY bm25(messages_fts), f.ts DESC
         LIMIT ?`,
      )
      .all(...args) as unknown as HitRow[];
    // Team assignment runs belong to their task; the task's thread is the conversation the user knows.
    return rows.map((r) => ({
      threadId: r.thread_id,
      threadTitle: r.thread_title,
      projectId: r.project_id,
      runId: r.run_id,
      role: r.role,
      snippet: r.snippet,
      ts: r.ts,
      taskId: r.task_id,
      taskTitle: r.task_title,
      member: r.member_key !== null && r.member_name !== null ? { key: r.member_key, name: r.member_name } : null,
    }));
  },
};
