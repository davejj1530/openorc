import { useMemo, useRef, useState } from "react";
import { commentMentionOptions, commentRecipientKey, harnessName, type CommentAttempt, type CommentRecipient, type TaskComment } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../lib/query";
import { modelEffortLabel } from "../lib/model-effort-label";
import { mentionQueryAt, insertMention } from "../lib/composer-mentions";
import { Button, TextButton } from "./ui";
import { TaskCommentDiscussion } from "./TaskCommentDiscussion";
import { useTaskCommentDraft } from "./useTaskCommentDraft";

function modelSearchMessage(pending: boolean, failed: boolean): string {
  if (pending) return "Loading models…";
  if (failed) return "Couldn’t load models.";
  return "No matching model and effort.";
}

export function TaskComments({ taskId, description, beforeSend }: { taskId: string; description: string; beforeSend: () => Promise<boolean> }) {
  const discussion = useRpc("tasks.comments.list", { taskId }, { refetchInterval: 5000 });
  const models = useRpc("agents.models", {}, { staleTime: 300000 });
  const retry = useRpcMutation("tasks.comments.retry");
  const cancel = useRpcMutation("tasks.comments.cancel");
  const execute = useRpcMutation("tasks.comments.execute");
  const submission = useTaskCommentDraft({ taskId, beforeSend, onPosted: () => void discussion.refetch() });
  const { draft, stored, sending } = submission;
  const [actionError, setActionError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const options = useMemo(() => commentMentionOptions((models.data ?? []).filter((m) => !m.unavailable)), [models.data]);
  const names = useMemo(() => new Map(options.map((o) => [commentRecipientKey(o.recipient), o.name])), [options]);
  const recipientName = (r: CommentRecipient) => names.get(commentRecipientKey(r)) ?? modelEffortLabel(r, models.data);
  const query = dismissed ? null : mentionQueryAt(draft.body, caret);
  const matches = useMemo(() => (query ? options.filter((o) => `${o.name} ${o.token}`.toLowerCase().includes(query.query.toLowerCase())).slice(0, 8) : []), [options, query?.query]);
  const comments = discussion.data?.comments ?? [];
  const attempts = discussion.data?.attempts ?? [];
  const edit = (change: Parameters<typeof submission.edit>[0]) => {
    submission.edit(change);
    setActionError(null);
  };
  const reply = (item: TaskComment | CommentAttempt) => {
    edit({ kind: "reply", item });
    editor.current?.focus();
  };
  const choose = (index: number) => {
    const match = matches[index];
    if (!match || !query) return;
    const result = insertMention(draft.body, query.start, caret, match.name);
    edit({ kind: "mention", body: result.text });
    setCaret(result.caret);
    setSelected(0);
    setDismissed(true);
    requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.setSelectionRange(result.caret, result.caret);
    });
  };
  const send = (source: "comment" | "description") => {
    setActionError(null);
    return submission.send(source);
  };
  const act = async (action: () => Promise<unknown>) => {
    setActionError(null);
    submission.clearError();
    try {
      await action();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };
  const replyTarget = [...comments, ...attempts].find((c) => c.id === draft.replyTo);
  return (
    <section className="task-comments" aria-labelledby={`comments-${taskId}`}>
      <div className="task-comments-heading">
        <h2 id={`comments-${taskId}`}>Comments</h2>
        {/(?:^|\s)@\S/.test(description) ? (
          <TextButton disabled={sending} onClick={() => void send("description")}>
            Ask tagged agents
          </TextButton>
        ) : null}
      </div>
      <p className="text-sm text-ink-3 mb-5">Mention a model to discuss this task. Clear work requests continue in a linked thread.</p>
      {discussion.isPending ? (
        <p role="status" className="text-sm text-ink-3">
          Loading comments…
        </p>
      ) : null}
      {discussion.error ? (
        <p role="alert">
          Couldn’t load comments.{" "}
          <TextButton underline onClick={() => void discussion.refetch()}>
            Retry
          </TextButton>
        </p>
      ) : null}
      {!discussion.isPending && !discussion.error && !comments.length ? <p className="text-base text-ink-3 mb-5">No comments yet. Leave a note or ask an agent.</p> : null}
      {discussion.data ? (
        <TaskCommentDiscussion
          discussion={discussion.data}
          models={models.data}
          recipientName={recipientName}
          onReply={reply}
          actions={{
            cancel: (attemptId) => void act(() => cancel.mutateAsync({ taskId, attemptId })),
            retry: (attemptId) => void act(() => retry.mutateAsync({ taskId, attemptId })),
            execute: (attemptId) => void act(() => execute.mutateAsync({ taskId, attemptId })),
            cancelPending: cancel.isPending,
            retryPending: retry.isPending,
            executePending: execute.isPending,
          }}
        />
      ) : null}
      <form
        className="task-comment-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send("comment");
        }}
      >
        {replyTarget ? (
          <div className="task-comment-recipients">
            <span>Replying to {"recipient" in replyTarget ? recipientName(replyTarget.recipient) : "your comment"}</span>
            <TextButton onClick={() => edit({ kind: "cancel-reply" })}>Cancel reply</TextButton>
          </div>
        ) : null}
        {draft.recipients.length ? (
          <div className="task-comment-recipients" aria-label="Reply recipients">
            {draft.recipients.map((r) => (
              <TextButton key={commentRecipientKey(r)} title="Remove recipient" onClick={() => edit({ kind: "remove-recipient", recipient: r })}>
                @{recipientName(r)} · Remove
              </TextButton>
            ))}
          </div>
        ) : null}
        <textarea
          ref={editor}
          value={draft.body}
          disabled={sending}
          rows={3}
          aria-label="Task comment"
          placeholder="Leave a note, or type @ to ask a model…"
          aria-autocomplete="list"
          aria-controls={matches.length ? `comment-models-${taskId}` : undefined}
          aria-activedescendant={matches.length ? `comment-model-${taskId}-${Math.min(selected, matches.length - 1)}` : undefined}
          onChange={(e) => {
            edit({ kind: "body", body: e.target.value });
            setCaret(e.target.selectionStart);
            setSelected(0);
            setDismissed(false);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (matches.length && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key) && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              if (e.key === "Escape") setDismissed(true);
              else if (e.key === "ArrowDown") setSelected((selected + 1) % matches.length);
              else if (e.key === "ArrowUp") setSelected((selected + matches.length - 1) % matches.length);
              else choose(Math.min(selected, matches.length - 1));
              return;
            }
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              void send("comment");
            }
          }}
        />
        {query ? (
          <div className="task-comment-mentions" role="listbox" id={`comment-models-${taskId}`} aria-label="Mention a model">
            {matches.map((o, i) => (
              <button type="button" role="option" aria-selected={selected === i} id={`comment-model-${taskId}-${i}`} key={o.token} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(i)}>
                <span>@{o.name}</span>
                <span>{harnessName(o.recipient.agent)}</span>
              </button>
            ))}
            {!matches.length ? (
              <p>
                {modelSearchMessage(models.isPending, Boolean(models.error))} <TextButton onClick={() => void models.refetch()}>Refresh models</TextButton>
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="task-comment-compose-footer">
          <span className="text-sm text-ink-3">{draft.recipients.length ? "Reply to selected agents" : "Type @ to choose a model and effort"}</span>
          <Button type="submit" disabled={sending || !draft.body.trim()} size="sm">
            {sending ? "Sending…" : "Comment"}
          </Button>
        </div>
      </form>
      {!stored ? (
        <p role="alert" className="text-sm text-bad mt-2">
          Draft couldn’t be saved locally. Keep this task open until your comment is sent.
        </p>
      ) : null}
      {actionError || submission.error ? (
        <p role="alert" className="text-sm text-bad mt-2">
          {actionError ?? submission.error}
        </p>
      ) : null}
    </section>
  );
}
