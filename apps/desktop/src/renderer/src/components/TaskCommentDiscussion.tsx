import { effortLabel, harnessName, type CommentAttempt, type CommentRecipient, type ModelOption, type TaskComment, type TaskDiscussion } from "@openorc/protocol";
import { modelLabel } from "../lib/model-effort-label";
import { openThread } from "../lib/router";
import { relativeTime } from "../lib/time";
import { Button, TextButton } from "./ui";
import { ThreadRichText } from "./ThreadImages";
import { QuestionCard } from "./QuestionCard";

const stateLabel: Record<CommentAttempt["state"], string> = {
  queued: "Queued",
  running: "Replying…",
  success: "",
  error: "Couldn’t finish",
  cancelled: "Cancelled",
  choose_executor: "Choose who should implement",
  starting_work: "Starting work…",
  working: "Working in thread",
  completed: "",
};

function attemptStatus(item: CommentAttempt, discussion: TaskDiscussion): string {
  if (discussion.questions?.some((question) => question.runId === item.runId)) return "Waiting for your answer";
  if (discussion.executionActivity?.[item.id] === "waiting") return "Waiting for input in thread";
  return stateLabel[item.state];
}

type AttemptActions = {
  cancel: (attemptId: string) => void;
  retry: (attemptId: string) => void;
  execute: (attemptId: string) => void;
  cancelPending: boolean;
  retryPending: boolean;
  executePending: boolean;
};

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
                  <article key={item.id} id={`comment-${item.id}`} className="task-comment-response" aria-label={`${recipientName(item.recipient)} response`}>
                    <div className="task-comment-meta">
                      <strong>{modelLabel(item.recipient, models)}</strong>
                      <span>
                        {item.recipient.effort ? effortLabel(item.recipient.effort) : "Default"} · {harnessName(item.recipient.agent)}
                      </span>
                      <time title={new Date(item.createdAt).toLocaleString()}>{relativeTime(item.createdAt)}</time>
                    </div>
                    {item.body ? (
                      <div className="task-comment-body">
                        <ThreadRichText>{item.body}</ThreadRichText>
                      </div>
                    ) : null}
                    {stateLabel[item.state] ? (
                      <p className="text-sm text-ink-3 mt-2" role="status">
                        {attemptStatus(item, discussion)}
                      </p>
                    ) : null}
                    {item.error ? (
                      <p role="alert" className="text-sm text-bad mt-2">
                        {item.error}
                      </p>
                    ) : null}
                    {discussion.questions
                      ?.filter((question) => question.runId === item.runId)
                      .map((question) => (
                        <QuestionCard key={question.approvalId} runId={question.runId} approvalId={question.approvalId} input={question.input} decided={undefined} />
                      ))}
                    <div className="task-comment-actions">
                      <TextButton onClick={() => onReply(item)}>Reply</TextButton>
                      {item.state === "queued" || item.state === "running" ? (
                        <TextButton disabled={actions.cancelPending} onClick={() => actions.cancel(item.id)}>
                          Cancel response
                        </TextButton>
                      ) : null}
                      {(item.state === "error" || item.state === "cancelled") && !item.executionRunId ? (
                        <TextButton disabled={actions.retryPending} onClick={() => actions.retry(item.id)}>
                          Retry response
                        </TextButton>
                      ) : null}
                      {item.threadId ? <TextButton onClick={() => openThread(item.threadId!)}>Open thread</TextButton> : null}
                    </div>
                  </article>
                ))}
              </div>
            ) : null}
            {chooseExecutor ? (
              <div className="task-comment-executor">
                <p className="text-base font-medium">Who should implement?</p>
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
