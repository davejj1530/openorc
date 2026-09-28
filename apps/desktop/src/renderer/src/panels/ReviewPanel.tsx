import { lazy, Suspense, useState, type ReactNode } from "react";
import type { Project, Task } from "@openorc/protocol";
import { Send } from "../components/icons";
import { Button, Empty, TextButton } from "../components/ui";
import { countStat } from "./ChangesPanel";
import { FileRows } from "./FileRows";
import { ReviewCommentList } from "./ReviewCommentList";
import { cn } from "../lib/cn";
import { useRpc, useRpcMutation } from "../lib/query";
import { relativeTime } from "../lib/time";
import { taskPublicationBlockedReason } from "../lib/task-review-availability";
import { ReviewPublication } from "./ReviewPublication";
import { useTaskReviewComments } from "./useTaskReviewComments";
import { TeamTaskAdmissions, TeamTaskIdentity } from "../components/TeamTaskStart";
import { openTask, openThread } from "../lib/router";
import { useLayout } from "../lib/layout";

const DiffView = lazy(() => import("../components/DiffView").then((m) => ({ default: m.DiffView })));

function blockedReviewAction(input: { team?: { ownerDeletedAt?: number | null; threadId: string } | null; taskId: string; ownershipError: boolean; retry: () => void }): ReactNode {
  const { team, taskId, ownershipError, retry } = input;
  if (team) {
    return (
      <>
        {" "}
        <TextButton
          type="button"
          underline
          onClick={() => {
            if (team.ownerDeletedAt) {
              openTask(taskId, "chat");
              return;
            }
            openThread(team.threadId);
            useLayout.getState().setPanel(true, "changes");
          }}
        >
          {team.ownerDeletedAt ? "Conversation deleted · open team activity" : "Open team changes"}
        </TextButton>
      </>
    );
  }
  if (ownershipError)
    return (
      <>
        {" "}
        <TextButton type="button" underline onClick={retry}>
          Retry
        </TextButton>
      </>
    );
  return null;
}

export { taskBaseLabel } from "../lib/task-review-availability";

/** A task's branch against its base: files, the diff with inline comments, and the way out (commit, push, PR). */
export function ReviewPanel({ task, project }: { task: Task; project: Project }) {
  return <TaskReview key={task.id} task={task} project={project} />;
}

function TaskReview({ task, project }: { task: Task; project: Project }) {
  const ownership = useRpc("orchestration.taskState", { taskId: task.id }, { enabled: Boolean(task.threadId) });
  const exportInfo = ownership.data?.export;
  const blockedReason = taskPublicationBlockedReason({ hasOwner: Boolean(task.threadId), team: ownership.data, isError: ownership.isError, isPending: ownership.isPending });
  const exportNote = exportInfo?.allowed
    ? `Commit publishes this assignment’s files on its own branch, ${exportInfo.branch}, separate from the integrated team branch. Inherited uncommitted input is part of it, as shown below.`
    : null;
  const [sinceReviewed, setSinceReviewed] = useState(false);
  const diff = useRpc("review.diff", { taskId: task.id, sinceReviewed });
  const markReviewed = useRpcMutation("review.markReviewed");
  const [notice, setNotice] = useState<string | null>(null);
  const team = ownership.data;
  const {
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
    error: commentError,
  } = useTaskReviewComments({
    taskId: task.id,
    team,
    ownershipUnavailable: Boolean(task.threadId && (ownership.isPending || ownership.isError)),
    blockedReason,
  });
  const files = diff.data?.files ?? [];
  const patch = diff.data?.patch ?? "";
  const stat = countStat(patch);
  const blockedAction = blockedReviewAction({ team, taskId: task.id, ownershipError: ownership.isError, retry: () => void ownership.refetch() });
  let diffContent: ReactNode = null;
  if (diff.error) diffContent = <Empty title="Could not read the diff">{diff.error.message}</Empty>;
  else if (!diff.isLoading && patch.trim().length === 0) {
    diffContent = (
      <Empty title={sinceReviewed ? "Nothing new since your last review" : "No changes yet"}>
        {sinceReviewed ? "Every change here has been marked reviewed." : "The diff against the base appears here after the agent edits files. Click a line number to comment."}
      </Empty>
    );
  } else if (!diff.isLoading) {
    diffContent = (
      <>
        {files.length > 1 || !/^@@ /m.test(patch) ? <FileRows files={files} commented={commented} /> : null}
        <div className="flex-1 min-h-0 border-t border-line">
          <Suspense fallback={null}>
            <DiffView
              patch={patch}
              comments={allComments}
              draft={draft}
              onRequestComment={team ? setDraft : undefined}
              onSubmitDraft={submitDraft}
              onCancelDraft={() => setDraft(null)}
              onRemoveComment={remove}
              commentState={team || (task.threadId && (ownership.isPending || ownership.isError)) ? commentState : undefined}
            />
          </Suspense>
        </div>
      </>
    );
  }
  let submitLabel = `Send ${selection.length} selected comment${selection.length === 1 ? "" : "s"}`;
  if (teamReview.working) submitLabel = "Submitting…";
  else if (teamReview.pending) submitLabel = "Retry review request";

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-line text-base">
        <span className="font-medium">Changes</span>
        <span className="text-ink-3 tabular">{files.length}</span>
        {stat.add + stat.del > 0 ? (
          <span className="font-mono text-sm tabular">
            <span className="text-ok">+{stat.add}</span> <span className="text-bad">-{stat.del}</span>
          </span>
        ) : null}
        <span className="flex-1" />
        <ReviewPublication task={task} project={project} hasChanges={files.length > 0} blockedReason={blockedReason} exportBranch={exportInfo?.branch} onNotice={setNotice} />
      </div>
      {!blockedReason && exportNote ? (
        <p role="status" className="px-3 py-2 text-sm text-ink-3 border-b border-line break-words">
          {exportNote}
        </p>
      ) : null}
      {blockedReason ? (
        <p role="status" className="px-3 py-2 text-sm text-ink-3 border-b border-line">
          {blockedReason}
          {blockedAction}
        </p>
      ) : null}
      <div className="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-line text-sm text-ink-3">
        <button
          onClick={() => setSinceReviewed((v) => !v)}
          disabled={!task.reviewedSnapshotId}
          className={cn("h-6 px-2 rounded-md hover:text-ink disabled:text-ink-4 disabled:pointer-events-none", sinceReviewed && "bg-surface-2 text-ink")}
          title={task.reviewedSnapshotId ? "Only what changed since you last marked this reviewed" : "Mark reviewed first"}
        >
          Since last review
        </button>
        {diff.data?.since ? <span className="text-ink-4">from {relativeTime(diff.data.since.createdAt)}</span> : null}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => markReviewed.mutate({ taskId: task.id }, { onSuccess: () => setNotice("Marked as reviewed") })}
          disabled={markReviewed.isPending || files.length === 0}
        >
          Mark reviewed
        </Button>
      </div>
      {notice ? <div className="px-3 py-1.5 text-sm text-ink-3 border-b border-line break-words">{notice}</div> : null}
      <div className="flex-1 min-h-0 flex flex-col">{diffContent}</div>
      {allComments.length > 0 || Boolean(team && teamReview.pending) ? (
        <div className="shrink-0 border-t border-line">
          <div className="max-h-48 overflow-y-auto">
            <ReviewCommentList
              comments={allComments}
              onRemove={remove}
              commentState={team ? commentState : undefined}
              selectedIds={team ? selection : undefined}
              onSelect={changeSelection}
              selectionLocked={Boolean(teamReview.pending) || teamReview.working}
            />
          </div>
          {team ? (
            <div className="px-3 pb-3 space-y-2">
              <TeamTaskIdentity task={team} />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={teamReview.working || (!teamReview.pending && (!team.review.allowed || ownership.isError || selection.length === 0))}
                  title={teamReview.pending ? undefined : (team.review.reason ?? undefined)}
                  onClick={() => void teamReview.submit(selection)}
                >
                  <Send size={12} />
                  {submitLabel}
                </Button>
              </div>
              {!team.review.allowed && !teamReview.pending && team.review.reason ? <p className="text-sm text-ink-3">{team.review.reason}</p> : null}
              {teamReview.pending ? <p className="text-xs text-ink-3">The saved request keeps these {pendingIds?.length ?? 0} comments. New comments are separate.</p> : null}
              {teamReview.error ? (
                <p role="alert" className="text-sm text-bad break-words">
                  {teamReview.error}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {team?.admissions.some((item) => item.kind === "review") ? (
        <div className="shrink-0 max-h-40 overflow-y-auto border-t border-line px-3 py-2">
          <TeamTaskAdmissions task={team} kind="review" />
        </div>
      ) : null}
      {commentError ? (
        <p role="alert" className="px-3 py-2 text-sm text-bad break-words">
          {commentError.message}
        </p>
      ) : null}
    </div>
  );
}
