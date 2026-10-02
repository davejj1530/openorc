import { useState } from "react";
import { reviewCommentPlace, type PullRequestDetail, type PullRequestDraftComment, type PullRequestReview, type PullRequestReviewAuthor, type PullRequestReviewEvent } from "@openorc/protocol";
import { ChevronDown, ChevronRight, ExternalLink, Pencil, X } from "./icons";
import { Button, Dialog, Field, IconButton, Segmented, Textarea, TextButton, Tooltip } from "./ui";
import { draftAuthor, offeredSummary, readReviewAuthor, withModelSummary, writeReviewAuthor } from "../lib/pull-requests";
import { useRpc, useRpcMutation } from "../lib/query";
import { useModelCatalog } from "../lib/use-model-catalog";
import { useOrclings } from "../lib/orclings";

type Key = { projectId: string; number: number };

function DraftCommentRow({ comment, reviewKey, author }: { comment: PullRequestDraftComment; reviewKey: Key; author: string }) {
  const edit = useRpcMutation("pulls.review.editComment");
  const remove = useRpcMutation("pulls.review.removeComment");
  const [body, setBody] = useState<string | null>(null);
  const error = edit.error ?? remove.error;
  const save = () => {
    if (body === null || !body.trim()) return;
    edit.mutate({ ...reviewKey, id: comment.id, body }, { onSuccess: () => setBody(null) });
  };
  return (
    <li className="group px-6 py-1.5 text-sm">
      <div className="flex items-center gap-2 text-xs text-ink-4">
        <span className="truncate font-mono">{reviewCommentPlace(comment)}</span>
        <span className="shrink-0">{author}</span>
        <span className="flex-1" />
        {body === null ? (
          <Tooltip label="Edit comment">
            <IconButton aria-label="Edit comment" size="sm" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => setBody(comment.body)}>
              <Pencil size={11} />
            </IconButton>
          </Tooltip>
        ) : null}
        <Tooltip label="Remove comment">
          <IconButton
            aria-label="Remove comment"
            size="sm"
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ ...reviewKey, id: comment.id })}
          >
            <X size={11} />
          </IconButton>
        </Tooltip>
      </div>
      {body === null ? (
        <p className="whitespace-pre-wrap text-ink-2">{comment.body}</p>
      ) : (
        <div className="mt-1">
          <Textarea
            autoFocus
            rows={3}
            value={body}
            aria-label="Comment"
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
              if (e.key === "Escape") setBody(null);
            }}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setBody(null)}>
              Cancel
            </Button>
            <Button size="sm" disabled={!body.trim() || edit.isPending} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      )}
      {error ? <p className="mt-1 text-xs text-bad">{error.message}</p> : null}
    </li>
  );
}

/** Why GitHub, or the user's own setting, rules out approving as this author; null when it is allowed. */
function approveBlocked(author: PullRequestReviewAuthor, own: boolean, allowApprove: boolean): string | null {
  if (author === "you" && own) return "You can’t approve your own pull request.";
  if (author === "app" && !allowApprove) return "Turn on approvals for the reviewer app in Settings.";
  return null;
}

/** One choice in a segmented control; a ruled-out one says why. */
type Choice<T extends string> = { value: T; label: string; disabled?: boolean; reason?: string };

/** The verdicts this author can give. */
function verdicts(author: PullRequestReviewAuthor, own: boolean, allowApprove: boolean): Choice<PullRequestReviewEvent>[] {
  const approve = approveBlocked(author, own, allowApprove);
  const changes = author === "you" && own ? "You can’t request changes on your own pull request." : null;
  return [
    { value: "comment", label: "Comment" },
    { value: "approve", label: "Approve", ...(approve ? { disabled: true, reason: approve } : {}) },
    { value: "request_changes", label: "Request changes", ...(changes ? { disabled: true, reason: changes } : {}) },
  ];
}

/** Who the review posts as: the last choice, while a reviewer app is set up to post as. */
function useReviewAuthor() {
  const status = useRpc("reviewerApp.get", {});
  const app = status.data?.app ?? null;
  const [chosen, setChosen] = useState<PullRequestReviewAuthor | null>(readReviewAuthor);
  const choose = (next: PullRequestReviewAuthor) => {
    setChosen(next);
    writeReviewAuthor(next);
  };
  return { app, author: app ? (chosen ?? "app") : ("you" as PullRequestReviewAuthor), choose };
}

/** How GitHub will sign the review. */
function postingAs(author: PullRequestReviewAuthor, app: { login: string } | null, viewer: string | null): string {
  if (author === "app" && app) return app.login;
  return viewer ? `@${viewer}` : "your GitHub account";
}

function authorOptions(appReady: boolean): Choice<PullRequestReviewAuthor>[] {
  return [
    { value: "you", label: "You" },
    { value: "app", label: "Reviewer app", ...(appReady ? {} : { disabled: true, reason: "Set up a reviewer app in Settings." }) },
  ];
}

/**
 * The last step: a summary, who posts, and a verdict, sent with every draft
 * comment as one GitHub review. A summary typed here is kept with the draft
 * if the dialog closes without posting.
 */
function SubmitReviewDialog({
  open,
  onClose,
  reviewKey,
  pull,
  review,
  onPosted,
}: {
  open: boolean;
  onClose: () => void;
  reviewKey: Key;
  pull: PullRequestDetail;
  review: PullRequestReview | null;
  onPosted: (url: string | null) => void;
}) {
  const submit = useRpcMutation("pulls.review.submit");
  const saveSummary = useRpcMutation("pulls.review.summary");
  const { app, author, choose } = useReviewAuthor();
  const [edited, setEdited] = useState<string | null>(null);
  const [chosenEvent, setEvent] = useState<PullRequestReviewEvent>("comment");
  const saved = review?.summary ?? "";
  const summary = edited ?? saved;
  const offered = offeredSummary(summary, review?.modelSummary);
  const count = review?.comments.length ?? 0;
  const options = verdicts(author, pull.viewer !== null && pull.viewer === pull.author, app?.allowApprove ?? false);
  // A verdict the chosen author can't give falls back to a comment.
  const event = options.find((option) => option.value === chosenEvent)?.disabled ? "comment" : chosenEvent;
  const ready = event === "approve" || summary.trim().length > 0 || count > 0;
  const close = () => {
    if (submit.isPending) return;
    if (edited !== null && edited !== saved) saveSummary.mutate({ ...reviewKey, commitId: pull.headSha, summary: edited });
    setEdited(null);
    submit.reset();
    onClose();
  };
  const post = () =>
    submit.mutate(
      { ...reviewKey, event, summary, as: author },
      {
        onSuccess: (result) => {
          setEdited(null);
          onPosted(result.url);
          onClose();
        },
      },
    );
  const account = postingAs(author, app, pull.viewer);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="Submit review"
      width={560}
    >
      <Field label="Summary">
        <Textarea rows={6} value={summary} onChange={(e) => setEdited(e.target.value)} placeholder="Overall feedback" autoFocus disabled={submit.isPending} />
      </Field>
      {offered ? <ModelSummary text={offered} disabled={submit.isPending} onAdd={() => setEdited(withModelSummary(summary, offered))} /> : null}
      <div className="mb-2 flex items-center gap-3">
        <span className="w-20 shrink-0 text-sm text-ink-3">Post as</span>
        <Segmented label="Post as" value={author} onChange={choose} options={authorOptions(app !== null)} />
      </div>
      <div className="mb-3 flex items-center gap-3">
        <span className="w-20 shrink-0 text-sm text-ink-3">Verdict</span>
        <Segmented label="Verdict" value={event} onChange={setEvent} options={options} />
      </div>
      <p className="mb-3 text-sm text-ink-3">{count > 0 ? `Posts ${count} comment${count === 1 ? "" : "s"} as ${account}.` : `Posts as ${account}.`}</p>
      {submit.error ? (
        <p role="alert" className="mb-3 text-sm text-bad break-words">
          {submit.error.message}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button disabled={submit.isPending} onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!ready || submit.isPending} onClick={post}>
          {submit.isPending ? "Posting…" : "Post review"}
        </Button>
      </div>
    </Dialog>
  );
}

/** The model's summary, kept beside one the user wrote rather than replacing it. */
function ModelSummary({ text, disabled, onAdd }: { text: string; disabled: boolean; onAdd: () => void }) {
  return (
    <div className="mb-3 rounded-md border border-line px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="text-sm text-ink-3">Model's summary</span>
        <TextButton disabled={disabled} onClick={onAdd}>
          Add to summary
        </TextButton>
      </div>
      <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-sm text-ink-2">{text}</p>
    </div>
  );
}

function DiscardDialog({ open, onClose, reviewKey, count }: { open: boolean; onClose: () => void; reviewKey: Key; count: number }) {
  const discard = useRpcMutation("pulls.review.discard");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !discard.isPending) onClose();
      }}
      title="Discard draft review"
    >
      <p className="mb-3 text-base text-ink-2">{count > 0 ? `Its ${count} comment${count === 1 ? "" : "s"} and summary will be deleted.` : "Its summary will be deleted."}</p>
      {discard.error ? (
        <p role="alert" className="mb-3 text-sm text-bad break-words">
          {discard.error.message}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button disabled={discard.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" disabled={discard.isPending} onClick={() => discard.mutate(reviewKey, { onSuccess: onClose })}>
          Discard
        </Button>
      </div>
    </Dialog>
  );
}

/** The draft review under the diff: its comments, and the way to post it or throw it away. */
export function PullRequestReviewBar({ projectId, pull, review }: { projectId: string; pull: PullRequestDetail; review: PullRequestReview | null }) {
  const models = useModelCatalog();
  const orclings = useOrclings();
  const reviewKey = { projectId, number: pull.number };
  const [listOpen, setListOpen] = useState(false);
  const [dialog, setDialog] = useState<"submit" | "discard" | null>(null);
  const [posted, setPosted] = useState<{ url: string | null } | null>(null);
  const comments = review?.comments ?? [];
  // A review outlives its drafts, so a posted one is still here with nothing in it.
  const drafted = comments.length > 0 || Boolean(review?.summary.trim());
  const earlier = review !== null && comments.length > 0 && review.commitId !== pull.headSha;
  return (
    <div className="shrink-0 border-t border-line">
      {listOpen && comments.length > 0 ? (
        <ul className="max-h-60 overflow-y-auto border-b border-line py-1" aria-label="Draft comments">
          {comments.map((comment) => (
            <DraftCommentRow key={comment.id} comment={comment} reviewKey={reviewKey} author={draftAuthor(comment.author, models.data, orclings)} />
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-6 py-2">
        {comments.length > 0 ? (
          <TextButton className="inline-flex items-center gap-1 text-sm text-ink-2" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>
            {listOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {comments.length} draft comment{comments.length === 1 ? "" : "s"}
          </TextButton>
        ) : (
          <span className="text-sm text-ink-3">No draft comments</span>
        )}
        {earlier ? <span className="text-sm text-warn">Written on an earlier version ({review.commitId.slice(0, 7)}). They post there.</span> : null}
        {posted ? (
          <span role="status" className="inline-flex items-center gap-1 text-sm text-ink-3">
            Review posted.
            {posted.url ? (
              <TextButton underline className="inline-flex items-center gap-1" onClick={() => window.openorc.openExternal(posted.url!)}>
                View on GitHub <ExternalLink size={11} />
              </TextButton>
            ) : null}
          </span>
        ) : null}
        <span className="flex-1" />
        {drafted ? (
          <Button size="sm" variant="ghost" onClick={() => setDialog("discard")}>
            Discard draft
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setPosted(null);
            setDialog("submit");
          }}
        >
          Submit review
        </Button>
      </div>
      <SubmitReviewDialog open={dialog === "submit"} onClose={() => setDialog(null)} reviewKey={reviewKey} pull={pull} review={review} onPosted={(url) => setPosted({ url })} />
      <DiscardDialog open={dialog === "discard"} onClose={() => setDialog(null)} reviewKey={reviewKey} count={comments.length} />
    </div>
  );
}
