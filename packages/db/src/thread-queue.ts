import { randomUUID } from "node:crypto";
import type { QueuedMessage } from "@openorc/protocol";
import type { Db } from "./database.js";

type QueueState = "pending" | "delivering" | "delivered" | "cancelled" | "interrupted";
interface QueueRow {
  id: string;
  thread_id: string;
  request_key: string;
  text: string;
  attachments: string;
  state: QueueState;
  error: string | null;
  created_at: number;
}
export interface ThreadQueueEntry extends QueuedMessage {
  id: string;
  state: QueueState;
}
function entry(row: QueueRow): ThreadQueueEntry {
  return { id: row.id, text: row.text, attachments: JSON.parse(row.attachments) as string[], queuedAt: row.created_at, state: row.state, error: row.error, interrupted: row.state === "interrupted" };
}

/** Persistent receipts prevent repeated requests from becoming repeated messages. */
export const threadQueue = {
  enqueue(db: Db, input: { threadId: string; text: string; attachments: string[]; requestKey: string }): ThreadQueueEntry {
    return db.transaction(() => {
      const previous = db.stmt("SELECT * FROM thread_queue WHERE thread_id = ? AND request_key = ?").get(input.threadId, input.requestKey) as unknown as QueueRow | undefined;
      const attachments = JSON.stringify(input.attachments);
      if (previous) {
        if (previous.text !== input.text || previous.attachments !== attachments) throw new Error("This message request key already identifies different content.");
        return entry(previous);
      }
      const id = randomUUID();
      const at = Date.now();
      db.stmt("INSERT INTO thread_queue (id, thread_id, request_key, text, attachments, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)").run(
        id,
        input.threadId,
        input.requestKey,
        input.text,
        attachments,
        at,
        at,
      );
      return { id, text: input.text, attachments: input.attachments, queuedAt: at, state: "pending", error: null, interrupted: false };
    });
  },
  list(db: Db, threadId: string): ThreadQueueEntry[] {
    return (db.stmt("SELECT * FROM thread_queue WHERE thread_id = ? AND state IN ('pending','delivering','interrupted') ORDER BY created_at, rowid").all(threadId) as unknown as QueueRow[]).map(entry);
  },
  update(db: Db, id: string, state: QueueState, error: string | null = null): void {
    db.stmt("UPDATE thread_queue SET state = ?, error = ?, updated_at = ? WHERE id = ?").run(state, error, Date.now(), id);
  },
  recover(db: Db): void {
    // A crash after provider acceptance is ambiguous. Never automatically replay
    // an in-flight message: keep it visible for an explicit retry or removal.
    db.stmt("UPDATE thread_queue SET state = 'interrupted', error = ?, updated_at = ? WHERE state = 'delivering'").run(
      "Delivery was interrupted. Check the conversation before retrying this message.",
      Date.now(),
    );
  },
  pendingThreads(db: Db): string[] {
    return (db.stmt("SELECT DISTINCT thread_id FROM thread_queue WHERE state = 'pending'").all() as { thread_id: string }[]).map((row) => row.thread_id);
  },
};
