import type { ThreadMessage } from "@openorc/protocol";
import type { Db } from "./database.js";

type MessageRow = Pick<ThreadMessage, "id" | "text" | "createdAt"> & { role: "user" | "assistant" };

/** SQLite's trim takes only spaces by default, and a message of blank lines says nothing either. */
const WHITESPACE = "char(32, 9, 10, 13)";

/** A run's newest message from the person or an agent, read from the run's end so its tool traffic is never scanned. */
const RUN_MESSAGE = `SELECT json_extract(body, '$.messageId') AS id, json_extract(body, '$.role') AS role, substr(json_extract(body, '$.text'), 1, ?) AS text, ts AS createdAt
  FROM (SELECT e.seq, e.ts, COALESCE(a.content, e.payload) AS body
        FROM events e LEFT JOIN artifacts a ON a.event_id = e.id AND a.kind = 'payload'
        WHERE e.run_id = ? AND e.kind = 'message.completed')
  WHERE json_extract(body, '$.role') IN ('user', 'assistant') AND trim(json_extract(body, '$.text'), ${WHITESPACE}) <> ''
  ORDER BY seq DESC LIMIT 1`;

const RECORDED_MESSAGE = `SELECT id, role, substr(text, 1, ?) AS text, created_at AS createdAt FROM thread_messages
  WHERE thread_id = ? AND role IN ('user', 'assistant') AND trim(text, ${WHITESPACE}) <> ''
  ORDER BY created_at DESC, rowid DESC LIMIT 1`;

/**
 * The newest thing the person or an agent said in a conversation, its text clipped to `maxChars` for a preview: a
 * message recorded on the thread, such as one from Slack, or the newest said in one of its runs. Runs can overlap,
 * as when an Orcling is asked in while the conversation's own agent is still answering, so they are asked
 * newest-ending first, open ones before all, until one ended before the newest message found so far.
 */
export function lastThreadMessage(db: Db, threadId: string, maxChars: number): ThreadMessage | null {
  let newest = db.stmt(RECORDED_MESSAGE).get(maxChars, threadId) as unknown as MessageRow | undefined;
  const runs = db.stmt("SELECT id, ended_at AS endedAt FROM runs WHERE thread_id = ? ORDER BY ended_at IS NOT NULL, ended_at DESC").all(threadId) as unknown as {
    id: string;
    endedAt: number | null;
  }[];
  for (const run of runs) {
    if (newest && run.endedAt !== null && run.endedAt < newest.createdAt) break;
    const message = db.stmt(RUN_MESSAGE).get(maxChars, run.id) as unknown as MessageRow | undefined;
    if (message && (!newest || message.createdAt > newest.createdAt)) newest = message;
  }
  return newest ?? null;
}
