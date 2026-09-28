import { useMemo, useState } from "react";
import { reviewCommentSent, type TeamTaskView } from "@openorc/protocol";
import type { CommentDraft, ReviewCommentState } from "../components/DiffView";
import { useTeamTaskRequest } from "../components/TeamTaskStart";
import { useRpc, useRpcMutation } from "../lib/query";
import { retainedTeamComments, teamReviewCommentState } from "../lib/team-task-actions";

/** A pending review owns its exact selection; later comments remain separate. */
export function useTaskReviewComments({
  taskId,
  team,
  ownershipUnavailable,
  blockedReason,
}: {
  taskId: string;
  team: TeamTaskView | null | undefined;
  ownershipUnavailable: boolean;
  blockedReason: string | null;
}) {
  const comments = useRpc("review.comments.list", { taskId });
  const addComment = useRpcMutation("review.comments.add");
  const removeComment = useRpcMutation("review.comments.remove");
  const teamReview = useTeamTaskRequest({ taskId, kind: "review" });
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const allComments = useMemo(() => retainedTeamComments(comments.data ?? [], team), [comments.data, team]);
  const unsent = useMemo(() => allComments.filter((comment) => !reviewCommentSent(comment) && !team?.claimedCommentIds.includes(comment.id)), [allComments, team]);
  const commented = useMemo(() => new Set(allComments.map((comment) => comment.path)), [allComments]);
  const pendingIds = teamReview.pending?.kind === "review" ? teamReview.pending.commentIds : null;
  const selection = pendingIds ?? selectedIds.filter((id) => unsent.some((comment) => comment.id === id));
  const commentState = (id: string): ReviewCommentState => {
    if (team) return teamReviewCommentState(id, team, teamReview.pending);
    return {
      label: allComments.some((comment) => comment.id === id && reviewCommentSent(comment)) ? "Sent" : "Not sent yet",
      removeDisabled: ownershipUnavailable,
      reason: blockedReason ?? undefined,
    };
  };
  const remove = (id: string) => {
    if (!commentState(id).removeDisabled) removeComment.mutate({ taskId, id });
  };
  const changeSelection = (id: string, checked: boolean) => setSelectedIds((previous) => (checked ? [...new Set([...previous, id])] : previous.filter((item) => item !== id)));
  const submitDraft = (body: string) => {
    if (!draft) return;
    addComment.mutate(
      { taskId, path: draft.path, startLine: draft.startLine, startSide: draft.startSide, line: draft.line, side: draft.side, lineText: draft.lineText, body },
      { onSuccess: () => setDraft(null) },
    );
  };
  return {
    allComments,
    commented,
    draft,
    setDraft,
    submitDraft,
    remove,
    commentState,
    selection,
    changeSelection,
    teamReview,
    pendingIds,
    error: comments.error ?? removeComment.error ?? addComment.error,
  };
}
