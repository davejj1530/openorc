import { randomUUID } from "node:crypto";
import type { ReviewComment } from "@openorc/protocol";
import type { Db } from "./database.js";

const now = () => Date.now();

interface CommentRow {
  id: string;
  thread_id: string | null;
  task_id: string | null;
  snapshot_id: string | null;
  path: string;
  start_line: number | null;
  start_side: "old" | "new" | null;
  line: number | null;
  side: "old" | "new" | null;
  line_text: string | null;
  body: string;
  sent_in_run_id: string | null;
  sent_message_id: string | null;
  created_at: number;
  /** The state of the queued message that accepted the comment. */
  message_state: string | null;
}

/** A comment stays sent while its message stands; removing that message from the queue returns the comment to its review. */
const COMMENT_ROWS = "SELECT c.*, q.state AS message_state FROM review_comments c LEFT JOIN thread_queue q ON q.id = c.sent_message_id";

function commentFromRow(r: CommentRow): ReviewComment {
  return {
    id: r.id,
    threadId: r.thread_id,
    taskId: r.task_id,
    snapshotId: r.snapshot_id,
    path: r.path,
    startLine: r.start_line,
    startSide: r.start_side,
    line: r.line,
    side: r.side,
    lineText: r.line_text,
    body: r.body,
    sentInRunId: r.sent_in_run_id,
    sentMessageId: r.message_state === "cancelled" ? null : r.sent_message_id,
    createdAt: r.created_at,
  };
}

/**
 * Which comments a review reads: a conversation's, a task's without a
 * conversation (team review), or a conversation's together with its task's
 * comments from before that task had a conversation.
 */
export interface ReviewCommentScope {
  threadId?: string;
  taskId?: string;
}

export interface ReviewCommentInsert {
  threadId: string | null;
  taskId: string | null;
  snapshotId: string | null;
  path: string;
  startLine: number | null;
  startSide: "old" | "new" | null;
  line: number | null;
  side: "old" | "new" | null;
  lineText: string | null;
  body: string;
}

export const comments = {
  get(db: Db, id: string): ReviewComment | null {
    const row = db.stmt(`${COMMENT_ROWS} WHERE c.id = ?`).get(id) as unknown as CommentRow | undefined;
    return row ? commentFromRow(row) : null;
  },
  list(db: Db, scope: ReviewCommentScope): ReviewComment[] {
    const order = "ORDER BY c.created_at, c.rowid";
    let rows: CommentRow[];
    if (scope.threadId && scope.taskId) {
      rows = db.stmt(`${COMMENT_ROWS} WHERE c.thread_id = ? OR (c.thread_id IS NULL AND c.task_id = ?) ${order}`).all(scope.threadId, scope.taskId) as unknown as CommentRow[];
    } else if (scope.threadId) {
      rows = db.stmt(`${COMMENT_ROWS} WHERE c.thread_id = ? ${order}`).all(scope.threadId) as unknown as CommentRow[];
    } else if (scope.taskId) {
      rows = db.stmt(`${COMMENT_ROWS} WHERE c.task_id = ? AND c.thread_id IS NULL ${order}`).all(scope.taskId) as unknown as CommentRow[];
    } else {
      throw new Error("Review comments need a conversation or a task.");
    }
    return rows.map(commentFromRow);
  },
  /** A task's comments without a conversation, as team review claims and marks them. */
  listForTask(db: Db, taskId: string): ReviewComment[] {
    return comments.list(db, { taskId });
  },
  insert(db: Db, c: ReviewCommentInsert): ReviewComment {
    if (c.threadId === null && c.taskId === null) throw new Error("Review comments need a conversation or a task.");
    const id = randomUUID();
    const t = now();
    db.stmt("INSERT INTO review_comments (id, thread_id, task_id, snapshot_id, path, start_line, start_side, line, side, line_text, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      c.threadId,
      c.taskId,
      c.snapshotId,
      c.path,
      c.startLine,
      c.startSide,
      c.line,
      c.side,
      c.lineText,
      c.body,
      t,
    );
    return {
      id,
      threadId: c.threadId,
      taskId: c.taskId,
      snapshotId: c.snapshotId,
      path: c.path,
      startLine: c.startLine,
      startSide: c.startSide,
      line: c.line,
      side: c.side,
      lineText: c.lineText,
      body: c.body,
      sentInRunId: null,
      sentMessageId: null,
      createdAt: t,
    };
  },
  remove(db: Db, id: string): void {
    db.stmt("DELETE FROM review_comments WHERE id = ?").run(id);
  },
  /** Team review: the run that received a retained batch. */
  markSent(db: Db, ids: string[], runId: string): void {
    for (const id of ids) db.stmt("UPDATE review_comments SET sent_in_run_id = ? WHERE id = ?").run(runId, id);
  },
  /**
   * The conversation message that accepted these comments. Only unsent rows
   * change, including rows whose message was removed from the queue, so a
   * retried send cannot move a comment to a second message; a task's earlier
   * comments join the conversation they were sent to.
   */
  markQueued(db: Db, ids: string[], input: { threadId: string; messageId: string }): void {
    for (const id of ids)
      db.stmt(
        "UPDATE review_comments SET sent_message_id = ?, thread_id = COALESCE(thread_id, ?) WHERE id = ? AND sent_in_run_id IS NULL AND (sent_message_id IS NULL OR sent_message_id IN (SELECT id FROM thread_queue WHERE state = 'cancelled'))",
      ).run(input.messageId, input.threadId, id);
  },
};
