import type { ReviewCommentScope } from "@openorc/db";
import { ReviewService } from "../services/review.js";
import type { Handlers } from "./types.js";
/** A review reads a conversation, a team task, or a conversation together with its task's earlier comments. */
function reviewCommentScope(threadId: string | undefined, taskId: string | undefined): ReviewCommentScope {
  return { ...(threadId ? { threadId } : {}), ...(taskId ? { taskId } : {}) };
}

/** The renderer tags a conversation's comments and a task's comments separately. */
function reviewCommentKeys(threadId: string | undefined, taskId: string | undefined): string[] {
  return [...(threadId ? [`comments:thread:${threadId}`] : []), ...(taskId ? [`comments:${taskId}`] : [])];
}

type Dependencies = {
  review: Pick<ReviewService, "comments" | "addComment" | "removeComment" | "sendComments">;
  invalidate: (keys: string[]) => void;
};

export function createReviewCommentsHandlers({ review, invalidate }: Dependencies): Pick<Handlers, "review.comments.list" | "review.comments.add" | "review.comments.remove" | "review.comments.send"> {
  return {
    "review.comments.list": ({ threadId, taskId }) => review.comments(reviewCommentScope(threadId, taskId)),
    "review.comments.add": ({ threadId, taskId, path: p, startLine, startSide, line, side, lineText, body }) => {
      const comment = review.addComment({ ...reviewCommentScope(threadId, taskId), path: p, startLine, startSide, line, side, lineText, body });
      invalidate(reviewCommentKeys(threadId, taskId));
      return comment;
    },
    "review.comments.remove": ({ threadId, taskId, id }) => {
      review.removeComment(reviewCommentScope(threadId, taskId), id);
      invalidate(reviewCommentKeys(threadId, taskId));
      return null;
    },
    "review.comments.send": ({ threadId, taskId, commentIds }) => {
      const { messageId, sent, reopened } = review.sendComments({ threadId, ...(taskId ? { taskId } : {}), commentIds });
      invalidate([...reviewCommentKeys(threadId, taskId), "threads", `thread:${threadId}`, ...(reopened.length > 0 ? ["tasks", ...reopened.map((id) => `task:${id}`)] : [])]);
      return { messageId, sent };
    },
  };
}
