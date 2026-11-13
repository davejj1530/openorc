import { patchStat, relativeTime } from "@openorc/client";
import type { Project, Task } from "@openorc/protocol";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { DiffStat, PanelBar, PanelBarMeta, PanelNotice } from "../components/PanelBar";
import { Button, Empty } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { cn } from "../lib/cn";
import { FileRows } from "./FileRows";
import { ReviewCommentList } from "./ReviewCommentList";
import { ReviewPublication } from "./ReviewPublication";

const DiffView = lazy(() => import("../components/DiffView").then((m) => ({ default: m.DiffView })));

export { taskBaseLabel } from "../lib/task-review-availability";

/** A task's branch against its base: files, the diff with inline comments, and the way out (commit, push, PR). */
export function ReviewPanel({ task, project }: { task: Task; project: Project }) {
  return <TaskReview key={task.id} task={task} project={project} />;
}

function TaskReview({ task, project }: { task: Task; project: Project }) {
  const blockedReason = task.retiredTeam ? "This item is no longer available." : null;
  const [sinceReviewed, setSinceReviewed] = useState(false);
  const diff = useRpc("review.diff", { taskId: task.id, sinceReviewed });
  const markReviewed = useRpcMutation("review.markReviewed");
  const [notice, setNotice] = useState<string | null>(null);
  const comments = useRpc("review.comments.list", { taskId: task.id });
  const allComments = comments.data ?? [];
  const commented = new Set(allComments.map((comment) => comment.path));
  const commentError = comments.error;
  const files = diff.data?.files ?? [];
  const patch = diff.data?.patch ?? "";
  const stat = patchStat(patch);
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
        <div className="flex-1 min-h-0">
          <Suspense fallback={null}>
            <DiffView patch={patch} comments={allComments} />
          </Suspense>
        </div>
      </>
    );
  }
  return (
    <div className="h-full flex flex-col min-h-0">
      <PanelBar
        title="Changes"
        meta={
          <>
            <PanelBarMeta>
              {files.length} {files.length === 1 ? "file" : "files"}
            </PanelBarMeta>
            <DiffStat add={stat.insertions} del={stat.deletions} />
          </>
        }
      >
        <ReviewPublication task={task} project={project} hasChanges={files.length > 0} blockedReason={blockedReason} onNotice={setNotice} />
      </PanelBar>

      {blockedReason ? <PanelNotice>{blockedReason}</PanelNotice> : null}
      <div className="h-9 shrink-0 flex items-center gap-2 pl-3.5 pr-2.5 pb-1 text-sm text-ink-4">
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={sinceReviewed}
          onClick={() => setSinceReviewed((v) => !v)}
          disabled={!task.reviewedSnapshotId}
          className={cn(sinceReviewed && "bg-control-fill text-navigation-ink hover:bg-control-fill")}
          data-tip={task.reviewedSnapshotId ? "Only what changed since you last marked this reviewed" : "Mark reviewed first"}
        >
          Since last review
        </Button>
        {diff.data?.since ? <span>from {relativeTime(diff.data.since.createdAt)}</span> : null}
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
      {notice ? <PanelNotice>{notice}</PanelNotice> : null}
      <div className="flex-1 min-h-0 flex flex-col">{diffContent}</div>
      {allComments.length > 0 ? (
        <div className="shrink-0">
          <div className="max-h-48 overflow-y-auto">
            <ReviewCommentList comments={allComments} />
          </div>
        </div>
      ) : null}

      {commentError ? (
        <PanelNotice role="alert" tone="bad">
          {commentError.message}
        </PanelNotice>
      ) : null}
    </div>
  );
}
