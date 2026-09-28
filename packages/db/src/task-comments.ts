import { randomUUID } from "node:crypto";
import { CommentIntent, CommentRecipient, commentRecipientKey, type TaskComment, type CommentAttempt, type TaskDiscussion } from "@openorc/protocol";
import { z } from "zod";
import type { Db } from "./database.js";
type Row = Record<string, unknown>;
const commentSource = z.enum(["comment", "description"]);
const commentAttemptState = z.enum(["queued", "running", "success", "error", "cancelled", "choose_executor", "starting_work", "working", "completed"]);
const comment = (r: Row): TaskComment => ({
  id: String(r.id),
  taskId: String(r.task_id),
  requestKey: String(r.request_key),
  body: String(r.body),
  recipients: z.array(CommentRecipient).parse(JSON.parse(String(r.recipients))),
  replyTo: r.reply_to as string | null,
  source: commentSource.parse(r.source),
  context: String(r.context),
  createdAt: Number(r.created_at),
});
const attempt = (r: Row): CommentAttempt => ({
  id: String(r.id),
  taskId: String(r.task_id),
  commentId: String(r.comment_id),
  recipient: CommentRecipient.parse(JSON.parse(String(r.recipient))),
  state: commentAttemptState.parse(r.state),
  body: String(r.body),
  error: r.error as string | null,
  runId: r.run_id as string | null,
  threadId: r.thread_id as string | null,
  executionRunId: r.execution_run_id as string | null,
  intent: r.intent ? CommentIntent.parse(JSON.parse(String(r.intent))) : null,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});
export const taskComments = {
  list(db: Db, taskId: string): TaskDiscussion {
    return {
      comments: db
        .stmt("SELECT * FROM task_comments WHERE task_id=? ORDER BY created_at,rowid")
        .all(taskId)
        .map((r) => comment(r)),
      attempts: db
        .stmt("SELECT * FROM task_comment_attempts WHERE task_id=? ORDER BY created_at,rowid")
        .all(taskId)
        .map((r) => attempt(r)),
    };
  },
  get(db: Db, id: string): TaskComment | null {
    const r = db.stmt("SELECT * FROM task_comments WHERE id=?").get(id);
    return r ? comment(r) : null;
  },
  request(db: Db, taskId: string, key: string): TaskComment | null {
    const r = db.stmt("SELECT * FROM task_comments WHERE task_id=? AND request_key=?").get(taskId, key);
    return r ? comment(r) : null;
  },
  attempt(db: Db, id: string): CommentAttempt | null {
    const r = db.stmt("SELECT * FROM task_comment_attempts WHERE id=?").get(id);
    return r ? attempt(r) : null;
  },
  forRun(db: Db, runId: string): CommentAttempt | null {
    const r = db.stmt("SELECT * FROM task_comment_attempts WHERE run_id=? OR execution_run_id=?").get(runId, runId);
    return r ? attempt(r) : null;
  },
  insert(db: Db, input: Omit<TaskComment, "id" | "createdAt">): TaskComment {
    const id = randomUUID();
    db.stmt("INSERT INTO task_comments VALUES (?,?,?,?,?,?,?,?,?)").run(
      id,
      input.taskId,
      input.requestKey,
      input.body,
      JSON.stringify(input.recipients),
      input.replyTo,
      input.source,
      input.context,
      Date.now(),
    );
    return this.get(db, id)!;
  },
  addAttempt(db: Db, c: TaskComment, recipient: CommentRecipient): CommentAttempt {
    const id = randomUUID(),
      now = Date.now();
    db.stmt("INSERT INTO task_comment_attempts (id,task_id,comment_id,recipient_key,recipient,state,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?)").run(
      id,
      c.taskId,
      c.id,
      commentRecipientKey(recipient),
      JSON.stringify(recipient),
      now,
      now,
    );
    return this.attempt(db, id)!;
  },
  update(db: Db, id: string, patch: Partial<Pick<CommentAttempt, "state" | "body" | "error" | "runId" | "threadId" | "executionRunId" | "intent">>): CommentAttempt | null {
    const columns = { state: "state", body: "body", error: "error", runId: "run_id", threadId: "thread_id", executionRunId: "execution_run_id", intent: "intent" };
    const sets: string[] = [],
      values: (string | number | null)[] = [];
    for (const key of Object.keys(columns) as (keyof typeof columns)[])
      if (patch[key] !== undefined) {
        sets.push(`${columns[key]}=?`);
        if (key === "intent") values.push(patch.intent ? JSON.stringify(patch.intent) : null);
        else values.push(patch[key] as string | null);
      }
    db.stmt(`UPDATE task_comment_attempts SET ${[...sets, "updated_at=?"].join(",")} WHERE id=?`).run(...values, Date.now(), id);
    return this.attempt(db, id);
  },
  unfinished(db: Db): CommentAttempt[] {
    return db
      .stmt("SELECT * FROM task_comment_attempts WHERE state IN ('queued','running','starting_work','working')")
      .all()
      .map((r) => attempt(r));
  },
};
