import { randomUUID } from "node:crypto";
import type { AgentKind, PullRequestDraftComment, PullRequestReview, PullRequestSide } from "@openorc/protocol";
import type { Db } from "./database.js";

/** The pull request a draft review belongs to. */
export interface PullReviewKey {
  projectId: string;
  number: number;
}

export type DraftCommentInsert = Omit<PullRequestDraftComment, "id" | "createdAt">;

export interface PullReviewPatch {
  commitId?: string;
  summary?: string;
  threadId?: string | null;
  baseCommit?: string | null;
}

interface ReviewRow {
  project_id: string;
  number: number;
  commit_id: string;
  summary: string;
  thread_id: string | null;
  base_commit: string | null;
  updated_at: number;
}

interface CommentRow {
  id: string;
  path: string;
  start_line: number | null;
  start_side: PullRequestSide | null;
  line: number;
  side: PullRequestSide;
  line_text: string | null;
  body: string;
  author_agent: AgentKind | null;
  author_model: string | null;
  created_at: number;
}

const reviewColumns: Record<keyof PullReviewPatch, string> = { commitId: "commit_id", summary: "summary", threadId: "thread_id", baseCommit: "base_commit" };

function commentFromRow(row: CommentRow): PullRequestDraftComment {
  return {
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    startSide: row.start_side,
    line: row.line,
    side: row.side,
    lineText: row.line_text,
    body: row.body,
    author: row.author_agent ? { agent: row.author_agent, model: row.author_model } : null,
    createdAt: row.created_at,
  };
}

function reviewFromRow(db: Db, row: ReviewRow): PullRequestReview {
  const comments = db.stmt("SELECT * FROM pull_request_review_comments WHERE project_id = ? AND number = ? ORDER BY created_at, rowid").all(row.project_id, row.number) as unknown as CommentRow[];
  return {
    projectId: row.project_id,
    number: row.number,
    commitId: row.commit_id,
    summary: row.summary,
    threadId: row.thread_id,
    baseCommit: row.base_commit,
    comments: comments.map(commentFromRow),
    updatedAt: row.updated_at,
  };
}

function touch(db: Db, key: PullReviewKey, at: number): void {
  db.stmt("UPDATE pull_request_reviews SET updated_at = ? WHERE project_id = ? AND number = ?").run(at, key.projectId, key.number);
}

export const pullReviews = {
  get(db: Db, key: PullReviewKey): PullRequestReview | null {
    const row = db.stmt("SELECT * FROM pull_request_reviews WHERE project_id = ? AND number = ?").get(key.projectId, key.number) as unknown as ReviewRow | undefined;
    return row ? reviewFromRow(db, row) : null;
  },
  /** The review a conversation was started for; its agent writes into this one. */
  forThread(db: Db, threadId: string): PullRequestReview | null {
    const row = db.stmt("SELECT * FROM pull_request_reviews WHERE thread_id = ?").get(threadId) as unknown as ReviewRow | undefined;
    return row ? reviewFromRow(db, row) : null;
  },
  /** Starts a review against `commitId`, or returns the one already open. */
  open(db: Db, key: PullReviewKey, commitId: string): PullRequestReview {
    const at = Date.now();
    db.stmt("INSERT INTO pull_request_reviews (project_id, number, commit_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, number) DO NOTHING").run(
      key.projectId,
      key.number,
      commitId,
      at,
      at,
    );
    return pullReviews.get(db, key)!;
  },
  update(db: Db, key: PullReviewKey, patch: PullReviewPatch): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as [keyof PullReviewPatch, string | null][];
    if (entries.length === 0) return;
    const assignments = entries.map(([name]) => `${reviewColumns[name]} = ?`).join(", ");
    db.stmt(`UPDATE pull_request_reviews SET ${assignments}, updated_at = ? WHERE project_id = ? AND number = ?`).run(...entries.map(([, value]) => value), Date.now(), key.projectId, key.number);
  },
  addComment(db: Db, key: PullReviewKey, comment: DraftCommentInsert): PullRequestDraftComment {
    const id = randomUUID();
    const at = Date.now();
    db.stmt(
      "INSERT INTO pull_request_review_comments (id, project_id, number, path, start_line, start_side, line, side, line_text, body, author_agent, author_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      key.projectId,
      key.number,
      comment.path,
      comment.startLine,
      comment.startSide,
      comment.line,
      comment.side,
      comment.lineText,
      comment.body,
      comment.author?.agent ?? null,
      comment.author?.model ?? null,
      at,
    );
    touch(db, key, at);
    return { ...comment, id, createdAt: at };
  },
  /** Null when the comment is not in this review. */
  editComment(db: Db, key: PullReviewKey, id: string, body: string): PullRequestDraftComment | null {
    const changed = db.stmt("UPDATE pull_request_review_comments SET body = ? WHERE id = ? AND project_id = ? AND number = ?").run(body, id, key.projectId, key.number);
    if (changed.changes === 0) return null;
    touch(db, key, Date.now());
    const row = db.stmt("SELECT * FROM pull_request_review_comments WHERE id = ?").get(id) as unknown as CommentRow;
    return commentFromRow(row);
  },
  removeComment(db: Db, key: PullReviewKey, id: string): void {
    db.stmt("DELETE FROM pull_request_review_comments WHERE id = ? AND project_id = ? AND number = ?").run(id, key.projectId, key.number);
    touch(db, key, Date.now());
  },
  /**
   * Removes what a posted review carried, as the draft stood when it was sent. A comment edited or added while it
   * was posting, and a summary changed since, stay in the draft.
   */
  clearPosted(db: Db, key: PullReviewKey, sent: Pick<PullRequestReview, "summary" | "comments">): void {
    const remove = db.stmt("DELETE FROM pull_request_review_comments WHERE id = ? AND project_id = ? AND number = ? AND body = ?");
    for (const comment of sent.comments) remove.run(comment.id, key.projectId, key.number, comment.body);
    db.stmt("UPDATE pull_request_reviews SET summary = '' WHERE project_id = ? AND number = ? AND summary = ?").run(key.projectId, key.number, sent.summary);
    touch(db, key, Date.now());
  },
  /** Empties the draft once it is discarded. The review keeps its conversation for the next round. */
  clearDraft(db: Db, key: PullReviewKey): void {
    db.stmt("DELETE FROM pull_request_review_comments WHERE project_id = ? AND number = ?").run(key.projectId, key.number);
    db.stmt("UPDATE pull_request_reviews SET summary = '', updated_at = ? WHERE project_id = ? AND number = ?").run(Date.now(), key.projectId, key.number);
  },
};
