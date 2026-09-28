import { useRef, useState } from "react";
import { commentRecipientKey, type CommentAttempt, type CommentRecipient, type TaskComment } from "@openorc/protocol";
import { readDraft, writeDraft } from "../lib/drafts";
import { useRpcMutation } from "../lib/query";

type CommentDraft = { body: string; recipients: CommentRecipient[]; replyTo?: string; requestKey: string };
type DraftEdit =
  { kind: "body" | "mention"; body: string } | { kind: "reply"; item: TaskComment | CommentAttempt } | { kind: "cancel-reply" } | { kind: "remove-recipient"; recipient: CommentRecipient };

const freshDraft = (): CommentDraft => ({ body: "", recipients: [], requestKey: crypto.randomUUID() });

/** The persisted draft and request keys belong to the submission, including failed retries. */
export function useTaskCommentDraft(input: { taskId: string; beforeSend: () => Promise<boolean>; onPosted: () => void }) {
  const post = useRpcMutation("tasks.comments.post");
  const storageKey = `task-comments.${input.taskId}`;
  const [draft, setDraft] = useState(() => readDraft<CommentDraft>(storageKey, freshDraft()));
  const [stored, setStored] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const submitting = useRef(false);
  const descriptionKey = useRef(crypto.randomUUID());

  const save = (next: CommentDraft) => {
    setDraft(next);
    setStored(writeDraft(storageKey, next));
    setError(null);
  };

  const edit = (change: DraftEdit) => {
    if (change.kind === "body" || change.kind === "mention") {
      save({ ...draft, body: change.body, requestKey: crypto.randomUUID() });
    } else if (change.kind === "reply") {
      const recipients = "recipient" in change.item ? [change.item.recipient] : change.item.recipients;
      save({ ...draft, replyTo: change.item.id, recipients, requestKey: crypto.randomUUID() });
    } else if (change.kind === "cancel-reply") {
      save({ ...draft, replyTo: undefined, recipients: [], requestKey: crypto.randomUUID() });
    } else if (change.kind === "remove-recipient") {
      const removed = commentRecipientKey(change.recipient);
      save({ ...draft, recipients: draft.recipients.filter((recipient) => commentRecipientKey(recipient) !== removed) });
    }
  };

  const send = async (source: "comment" | "description") => {
    if (submitting.current) return;
    submitting.current = true;
    setSending(true);
    setError(null);
    const snapshot = draft;
    try {
      if (!(await input.beforeSend())) throw new Error("Save the task above before sending this request. Your comment is kept here.");
      await post.mutateAsync({
        taskId: input.taskId,
        source,
        body: source === "description" ? "" : snapshot.body,
        recipients: source === "description" ? [] : snapshot.recipients,
        replyTo: source === "description" ? undefined : snapshot.replyTo,
        requestKey: source === "description" ? descriptionKey.current : snapshot.requestKey,
      });
      if (source === "comment") save(freshDraft());
      else descriptionKey.current = crypto.randomUUID();
      input.onPosted();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      submitting.current = false;
      setSending(false);
    }
  };

  return { draft, stored, error, sending, edit, send, clearError: () => setError(null) };
}
