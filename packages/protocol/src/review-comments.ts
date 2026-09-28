import type { ReviewComment } from "./domain.js";

type CommentLines = Pick<ReviewComment, "startLine" | "startSide" | "line" | "side">;

/**
 * A review comment's lines as a diff reads them: "12" or "10-12" in the
 * current version. A removed line carries a "-" ("-12"), and a range that
 * involves one marks both ends ("-10 to +12"). Null for a whole-file comment.
 */
export function reviewCommentLines(comment: CommentLines): string | null {
  if (comment.line === null) return null;
  if (comment.startLine === null) return comment.side === "old" ? `-${comment.line}` : `${comment.line}`;
  if (comment.startSide !== "old" && comment.side !== "old") return `${comment.startLine}-${comment.line}`;
  const mark = (side: ReviewComment["side"]) => (side === "old" ? "-" : "+");
  return `${mark(comment.startSide)}${comment.startLine} to ${mark(comment.side)}${comment.line}`;
}

/** Sent to a conversation as a queued message, or to a team run through team review. */
export function reviewCommentSent(comment: Pick<ReviewComment, "sentInRunId" | "sentMessageId">): boolean {
  return comment.sentInRunId !== null || comment.sentMessageId !== null;
}

/** Where a comment points, as the review list and the agent read it: "src/app.ts:10-12". */
export function reviewCommentPlace(comment: CommentLines & Pick<ReviewComment, "path">): string {
  const lines = reviewCommentLines(comment);
  return lines === null ? comment.path : `${comment.path}:${lines}`;
}
