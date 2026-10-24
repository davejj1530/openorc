import type { CommentAttempt, CommentRecipient, ModelOption, TaskComment, TaskDiscussion } from "@openorc/protocol";
import { relativeTime } from "@openorc/client";
import { AttemptResponse, type AttemptActions } from "./AttemptResponse";
import { Button, TextButton } from "./ui";
import { ThreadRichText } from "./ThreadImages";

/** Discussion order follows the server's comment and attempt arrays; no local sorting is introduced. */
export function TaskCommentDiscussion({
  discussion,
  models,
  recipientName,
  onReply,
  actions,
}: {
  discussion: TaskDiscussion;
  models: ModelOption[] | undefined;
  recipientName: (recipient: CommentRecipient) => string;
  onReply: (item: TaskComment | CommentAttempt) => void;
  actions: AttemptActions;
}) {
  const grouped = new Map<string, CommentAttempt[]>();
  for (const attempt of discussion.attempts) grouped.set(attempt.commentId, [...(grouped.get(attempt.commentId) ?? []), attempt]);

  return (
    <ol className="task-comments-feed">
      {discussion.comments.map((comment) => {
        const attempts = grouped.get(comment.id) ?? [];
        const chooseExecutor =
          attempts.some((attempt) => attempt.state === "choose_executor") && !attempts.some((attempt) => attempt.executionRunId || (attempt.threadId && attempt.state === "success"));
        return (
          <li key={comment.id} className="task-comment" id={`comment-${comment.id}`}>
            <div className="task-comment-meta">
              <strong>You</strong>
              <time title={new Date(comment.createdAt).toLocaleString()}>{relativeTime(comment.createdAt)}</time>
              {comment.replyTo ? (
                <a href={`#comment-${comment.replyTo}`} className="text-ink-3">
                  In reply
                </a>
              ) : null}
            </div>
            <div className="task-comment-body">
              <ThreadRichText>{comment.body}</ThreadRichText>
            </div>
            {comment.source === "description" ? (
              <details className="text-sm text-ink-3 mt-2">
                <summary>Saved task context</summary>
                <pre className="task-comment-context">{comment.context}</pre>
              </details>
            ) : null}
            <TextButton className="text-sm text-ink-3 mt-2" onClick={() => onReply(comment)}>
              Reply
            </TextButton>
            {attempts.length > 0 ? (
              <div className="task-comment-replies">
                {attempts.map((item) => (
                  <AttemptResponse key={item.id} item={item} discussion={discussion} models={models} recipientName={recipientName} onReply={onReply} actions={actions} />
                ))}
              </div>
            ) : null}
            {chooseExecutor ? (
              <div className="task-comment-executor">
                <p className="text-base">Who should implement?</p>
                <div className="task-comment-actions">
                  {attempts.map((attempt) => (
                    <Button
                      key={attempt.id}
                      variant="secondary"
                      size="sm"
                      disabled={actions.executePending || attempt.state === "running" || attempt.state === "queued"}
                      onClick={() => actions.execute(attempt.id)}
                    >
                      {recipientName(attempt.recipient)}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
