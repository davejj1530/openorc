import { lazy, Suspense, useState } from "react";
import { reviewCommentSent } from "@openorc/protocol";
import type { CommentDraft } from "../components/DiffView";
import { Send } from "../components/icons";
import { Button } from "../components/ui";
import { PanelNotice } from "../components/PanelBar";
import { useRpc, useRpcMutation } from "../lib/client";
import { ReviewCommentList } from "./ReviewCommentList";

const DiffView = lazy(() => import("../components/DiffView").then((m) => ({ default: m.DiffView })));

const REVIEW_TEXT = {
  send: (count: number) => `Send ${count} to the conversation`,
  sending: "Sending…",
  queued: (count: number) => `Queued ${count} comment${count === 1 ? "" : "s"} for this conversation.`,
} as const;

/**
 * A conversation's diff with its review comments. Comments are written on
 * lines and sent to the conversation as one queued message, delivered with
 * the conversation's own agent and settings. A task label keeps that task's
 * earlier comments in view and reopens the task when they are sent.
 */
export function ConversationReview({ patch, threadId, taskId }: { patch: string; threadId: string; taskId?: string }) {
  const scope = taskId ? { threadId, taskId } : { threadId };
  const comments = useRpc("review.comments.list", scope);
  const addComment = useRpcMutation("review.comments.add");
  const removeComment = useRpcMutation("review.comments.remove");
  const sendComments = useRpcMutation("review.comments.send");
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const all = comments.data ?? [];
  const unsent = all.filter((comment) => !reviewCommentSent(comment));
  const error = comments.error ?? addComment.error ?? removeComment.error ?? sendComments.error;

  const submitDraft = (body: string) => {
    if (!draft) return;
    addComment.mutate(
      { ...scope, path: draft.path, startLine: draft.startLine, startSide: draft.startSide, line: draft.line, side: draft.side, lineText: draft.lineText, body },
      { onSuccess: () => setDraft(null) },
    );
  };
  const remove = (id: string) => removeComment.mutate({ ...scope, id });
  const sendUnsent = () => {
    setNotice(null);
    sendComments.mutate({ ...scope, commentIds: unsent.map((comment) => comment.id) }, { onSuccess: (accepted) => setNotice(REVIEW_TEXT.queued(accepted.sent)) });
  };

  return (
    <>
      <div className="flex-1 min-h-0">
        <Suspense fallback={null}>
          <DiffView patch={patch} comments={all} commentRanges draft={draft} onRequestComment={setDraft} onSubmitDraft={submitDraft} onCancelDraft={() => setDraft(null)} onRemoveComment={remove} />
        </Suspense>
      </div>
      {all.length > 0 ? (
        <div className="shrink-0">
          <div className="max-h-48 overflow-y-auto">
            <ReviewCommentList comments={all} onRemove={remove} />
          </div>
          {unsent.length > 0 ? (
            <div className="flex justify-end px-2.5 pb-2.5">
              <Button disabled={sendComments.isPending} onClick={sendUnsent}>
                <Send size={14} /> {sendComments.isPending ? REVIEW_TEXT.sending : REVIEW_TEXT.send(unsent.length)}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {notice ? <PanelNotice className="pt-2">{notice}</PanelNotice> : null}
      {error ? (
        <PanelNotice role="alert" tone="bad" className="pt-2">
          {error.message}
        </PanelNotice>
      ) : null}
    </>
  );
}
