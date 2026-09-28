import type { ReviewComment, TeamReviewComment, TeamTaskAdmissionView, TeamTaskView } from "@openorc/protocol";

export type TeamTaskRequest = { taskId: string; requestKey: string } & ({ kind: "start" } | { kind: "review"; commentIds: string[] } | { kind: "retry"; admissionId: string });
export type TeamTaskRequestScope = { taskId: string; kind: "start" } | { taskId: string; kind: "review" } | { taskId: string; kind: "retry"; admissionId: string };
const key = (scope: TeamTaskRequestScope) => `openorc.draft.task.${scope.taskId}.team.${scope.kind}${scope.kind === "retry" ? `.${scope.admissionId}` : ""}`;
const changed = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("openorc:team-task-request"));
};

export function readTeamTaskRequest(scope: TeamTaskRequestScope): TeamTaskRequest | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key(scope));
  } catch {
    throw new Error("Could not read the saved task request. Restore local storage before retrying.");
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<TeamTaskRequest>;
    if (value.taskId !== scope.taskId || value.kind !== scope.kind || typeof value.requestKey !== "string" || !value.requestKey.length || value.requestKey.length > 200) throw new Error();
    if (value.kind === "start") return { taskId: scope.taskId, kind: "start", requestKey: value.requestKey };
    if (value.kind === "retry" && scope.kind === "retry" && value.admissionId === scope.admissionId)
      return { taskId: scope.taskId, kind: "retry", admissionId: scope.admissionId, requestKey: value.requestKey };
    if (
      value.kind === "review" &&
      Array.isArray(value.commentIds) &&
      value.commentIds.length > 0 &&
      value.commentIds.length <= 100 &&
      value.commentIds.every((id) => typeof id === "string" && id.length > 0) &&
      new Set(value.commentIds).size === value.commentIds.length
    )
      return { taskId: scope.taskId, kind: "review", requestKey: value.requestKey, commentIds: [...value.commentIds] };
  } catch {
    /* Never replace an uncertain request with a fresh identity. */
  }
  throw new Error("The saved task request could not be restored. Its recovery record has been kept.");
}

/** Persist before submission; a changed document or selection does not replace an uncertain request. */
export function beginTeamTaskRequest(scope: TeamTaskRequestScope, commentIds: string[] = []): TeamTaskRequest {
  const previous = readTeamTaskRequest(scope);
  if (previous) return previous;
  if (scope.kind === "review" && (!commentIds.length || commentIds.length > 100 || new Set(commentIds).size !== commentIds.length || commentIds.some((id) => !id)))
    throw new Error("Select between 1 and 100 distinct review comments.");
  const request: TeamTaskRequest = scope.kind === "review" ? { ...scope, requestKey: crypto.randomUUID(), commentIds: [...commentIds] } : { ...scope, requestKey: crypto.randomUUID() };
  try {
    localStorage.setItem(key(scope), JSON.stringify(request));
  } catch {
    throw new Error("Could not save this task request for recovery. Retry when local storage is available.");
  }
  changed();
  return request;
}

export function finishTeamTaskRequest(request: TeamTaskRequest): void {
  const current = readTeamTaskRequest(request);
  if (current?.requestKey !== request.requestKey) return;
  try {
    localStorage.removeItem(key(request));
  } catch {
    throw new Error("The request was accepted, but its local recovery record could not be cleared. Retry to confirm it safely.");
  }
  changed();
}

export function teamTaskAdmissionLabel(admission: TeamTaskAdmissionView, members: TeamTaskView["members"]): string {
  const name = members.find((member) => member.key === admission.memberKey)?.name ?? (admission.role === "manager" ? "manager" : "agent");
  if (admission.state === "attention") return "Needs attention";
  if (admission.state === "stopped") return "Stopped";
  if (admission.state === "queued") return admission.role === "manager" ? `Queued for ${name} · awaiting assignment` : `Queued for ${name}`;
  if (admission.role === "manager") return `${admission.state === "running" ? `${name} is coordinating` : `Received by ${name}`} · awaiting assignment`;
  if (admission.state === "received") return `Received by ${name}`;
  if (admission.state === "running") return `${name} is working`;
  return "Completed";
}

/** Immutable accepted comments replace mutable source rows and remain visible after deletion. */
export function retainedTeamComments(comments: ReviewComment[], task: TeamTaskView | null | undefined): ReviewComment[] {
  const retained = new Map(comments.map((comment) => [comment.id, comment]));
  for (const admission of task?.admissions ?? []) for (const comment of admission.reviewBatch?.comments ?? []) retained.set(comment.id, retainedComment(comment));
  return [...retained.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** A retained team comment belongs to its task, never to a conversation. */
function retainedComment(comment: TeamReviewComment): ReviewComment {
  return { ...comment, threadId: null, startLine: null, startSide: null, lineText: null, sentMessageId: null };
}

export function teamReviewCommentState(commentId: string, task: TeamTaskView, pending: TeamTaskRequest | null) {
  const admission = task.admissions.findLast((item) => item.reviewBatch?.comments.some((comment) => comment.id === commentId));
  if (admission) return { label: teamTaskAdmissionLabel(admission, task.members), removeDisabled: true, reason: "This comment is retained with an accepted review request." };
  if (task.claimedCommentIds.includes(commentId)) return { label: "Accepted for review", removeDisabled: true, reason: "This comment is retained with an accepted review request." };
  if (pending?.kind === "review" && pending.commentIds.includes(commentId))
    return { label: "Awaiting confirmation", removeDisabled: true, reason: "Confirm the saved review request before changing its comments." };
  return { label: "Not sent yet", removeDisabled: false, reason: undefined };
}
