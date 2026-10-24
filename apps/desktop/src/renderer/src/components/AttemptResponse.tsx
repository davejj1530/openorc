import { effortLabel, harnessName, type CommentAttempt, type CommentRecipient, type ModelOption, type TaskComment, type TaskDiscussion } from "@openorc/protocol";
import { modelLabel } from "../lib/model-effort-label";
import { orclingById, useOrclings } from "../lib/orclings";
import { openThread } from "../lib/router";
import { relativeTime } from "@openorc/client";
import { OrclingAvatar } from "./OrclingAvatar";
import { QuestionCard } from "./QuestionCard";
import { ThreadRichText } from "./ThreadImages";
import { TextButton } from "./ui";

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

export type AttemptActions = {
  cancel: (attemptId: string) => void;
  retry: (attemptId: string) => void;
  execute: (attemptId: string) => void;
  cancelPending: boolean;
  retryPending: boolean;
  executePending: boolean;
};

/** One agent's response under a comment: who replied, its text, its state and its actions. */
export function AttemptResponse({
  item,
  discussion,
  models,
  recipientName,
  onReply,
  actions,
}: {
  item: CommentAttempt;
  discussion: TaskDiscussion;
  models: ModelOption[] | undefined;
  recipientName: (recipient: CommentRecipient) => string;
  onReply: (item: TaskComment | CommentAttempt) => void;
  actions: AttemptActions;
}) {
  return (
    <article id={`comment-${item.id}`} className="task-comment-response" aria-label={`${recipientName(item.recipient)} response`}>
      <div className="task-comment-meta">
        <ReplyAuthor recipient={item.recipient} models={models} />
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
  );
}

/** Who replied: an Orcling by name, with the model it used, or the model with its effort and harness. */
function ReplyAuthor({ recipient, models }: { recipient: CommentRecipient; models: readonly ModelOption[] | undefined }) {
  const orcling = orclingById(useOrclings(), recipient.orclingId);
  if (orcling) {
    return (
      <>
        <strong className="inline-flex items-center gap-1.5">
          <OrclingAvatar orcling={orcling} size={16} />
          {orcling.name}
        </strong>
        <span>{modelLabel(recipient, models)}</span>
      </>
    );
  }
  return (
    <>
      <strong>{modelLabel(recipient, models)}</strong>
      <span>
        {recipient.effort ? effortLabel(recipient.effort) : "Default"} · {harnessName(recipient.agent)}
      </span>
    </>
  );
}
