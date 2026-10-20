import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { isDetachedCopy, type Project, type Task, type ThreadSummary } from "@openorc/protocol";
import { RefreshCw } from "../components/icons";
import { CommitSheet } from "../components/CommitSheet";
import { DiffStat, PanelBar, PanelBarMeta, PanelNotice } from "../components/PanelBar";
import { Button, Empty, IconButton, Segmented, TextButton, Tooltip } from "../components/ui";
import { cn } from "../lib/cn";
import { ConversationReview } from "./ConversationReview";
import { FileRows } from "./FileRows";
import { PullRequestLink } from "./ThreadPullRequest";
import { useRpc, useRpcMutation } from "../lib/query";
import { teamGitActions } from "../lib/team-git-actions";
import { useThreadMutationPending } from "../lib/thread-mutations";
import { useLayout, type WorkspaceChangesTarget } from "../lib/layout";

const DiffView = lazy(() => import("../components/DiffView").then((m) => ({ default: m.DiffView })));

/**
 * What the thread's agent changed in its workspace: read it, comment on it,
 * commit it. Push and the pull request wait on the Commits tab, since only
 * committed work can leave. A task label marks comments made from that task's
 * screen. Team conversations take feedback through team review.
 */
export function ChangesPanel({ thread, project, task }: { thread?: ThreadSummary; project: Project; task?: Task }) {
  const target: WorkspaceChangesTarget = { kind: thread ? "thread" : "project", id: thread?.id ?? project.id };
  const request = useLayout((s) => s.workspaceChanges);
  const consumeCommit = useLayout((s) => s.consumeWorkspaceCommit);
  const scoped = request?.kind === target.kind && request.id === target.id ? request : null;
  const comparison = thread?.worktreePath ? (scoped?.comparison ?? "base") : "head";
  const threadDiff = useRpc("review.threadDiff", { threadId: thread?.id ?? "", comparison }, { enabled: Boolean(thread) });
  const projectDiff = useRpc("review.projectDiff", { projectId: project.id }, { enabled: !thread });
  const headDiff = useRpc("review.threadDiff", { threadId: thread?.id ?? "", comparison: "head" }, { enabled: Boolean(thread) });
  const diff = thread ? threadDiff : projectDiff;
  const uncommitted = thread ? headDiff : projectDiff;
  const team = Boolean(thread?.teamInstanceId);
  const runtime = useRpc("orchestration.runtime", { threadId: thread?.id ?? "" }, { enabled: team, refetchInterval: 8000 });
  const threadCommit = useRpcMutation("review.commitThread");
  const projectCommit = useRpcMutation("review.commitProject");
  const commit = thread ? threadCommit : projectCommit;
  const [commitOpen, setCommitOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const files = diff.data?.files ?? [];
  const patch = diff.data?.patch ?? "";
  const stat = countStat(patch);
  const where = thread?.workspaceMode === "worktree" ? "this thread's worktree" : project.name;
  const actions = teamGitActions(team, runtime);
  const threadMutationPending = useThreadMutationPending(thread?.id ?? "");
  const busy = commit.isPending || (team && threadMutationPending);
  const canCommit = actions.commit.allowed && !uncommitted.isError && (uncommitted.data?.files.length ?? 0) > 0 && !busy;
  const commitReason = actions.commit.allowed ? null : actions.commit.reason;
  // A pull request's copy under review is someone else's code: it is read, never committed.
  const commits = !thread || Boolean(thread.teamInstanceId) || !isDetachedCopy(thread);
  const refresh = () => {
    void diff.refetch();
    if (thread && comparison !== "head") void headDiff.refetch();
    if (team) void runtime.refetch();
  };
  useEffect(() => {
    if (scoped?.commit) {
      setCommitOpen(true);
      consumeCommit(scoped.requestId);
    }
  }, [scoped, consumeCommit]);
  const commitChanges = async () => {
    if (!canCommit || !message.trim()) return;
    try {
      const result = thread ? await threadCommit.mutateAsync({ threadId: thread.id, message: message.trim() }) : await projectCommit.mutateAsync({ projectId: project.id, message: message.trim() });
      setCommitOpen(false);
      setMessage("");
      setNotice(`Committed ${result.sha.slice(0, 7)}`);
    } catch {
      // The mutation keeps its error and the message in the open dialog for retry.
    } finally {
      refresh();
    }
  };
  let workspaceContent: ReactNode = null;
  if (diff.error) workspaceContent = <Empty title="Could not read the workspace">{diff.error.message}</Empty>;
  else if (!diff.isLoading && files.length === 0) {
    workspaceContent = (
      <Empty title="Clean workspace">
        Edits the agent makes in {where} show up here{!actions.commit.allowed ? "." : ", ready to commit."}
      </Empty>
    );
  } else if (!diff.isLoading) {
    workspaceContent = (
      <>
        {files.length > 1 || !/^@@ /m.test(patch) ? <FileRows files={files} /> : null}
        {thread && !team ? (
          <ConversationReview patch={patch} threadId={thread.id} taskId={task?.id} />
        ) : (
          <div className="flex-1 min-h-0">
            <Suspense fallback={null}>
              <DiffView patch={patch} />
            </Suspense>
          </div>
        )}
      </>
    );
  }
  const refreshTeam = (
    <TextButton type="button" disabled={busy || runtime.isFetching} underline onClick={refresh}>
      Refresh team status
    </TextButton>
  );

  return (
    <div className="h-full flex flex-col min-h-0">
      <PanelBar
        title={
          thread?.worktreePath ? (
            <Segmented size="sm" label="Compare" value={comparison} options={comparisons} onChange={(next) => useLayout.getState().openWorkspaceChanges(target, "review", next)} />
          ) : (
            "Uncommitted"
          )
        }
        meta={
          <>
            <PanelBarMeta>{fileCount(files.length)}</PanelBarMeta>
            <DiffStat add={stat.add} del={stat.del} />
          </>
        }
      >
        {thread ? <PullRequestLink thread={thread} /> : null}
        <Tooltip label="Refresh">
          <IconButton onClick={refresh} aria-label="Refresh" className="text-ink-4">
            <RefreshCw size={15} className={cn(diff.isFetching && "animate-spin")} />
          </IconButton>
        </Tooltip>
        {commits ? (
          <CommitSheet
            open={commitOpen}
            onOpenChange={(open) => {
              if (!busy) setCommitOpen(open);
            }}
            trigger={
              <Button variant="primary" disabled={!canCommit} title={actions.commit.reason ?? undefined}>
                Commit
              </Button>
            }
            title="Commit changes"
            summary={<CommitSummary files={uncommitted.data?.files.length ?? 0} stat={countStat(uncommitted.data?.patch ?? "")} />}
            message={message}
            onMessageChange={setMessage}
            busy={busy}
            commitDisabled={!canCommit || !message.trim()}
            committing={commit.isPending}
            onCommit={() => void commitChanges()}
            placeholder="What changed and why"
          >
            {actions.commit.reason ? (
              <p role="status" className="text-sm text-ink-3 mb-3">
                {actions.commit.reason} {refreshTeam}
              </p>
            ) : null}
            {uncommitted.isError ? (
              <p role="alert" className="text-sm text-bad mb-3">
                Could not refresh uncommitted changes.{" "}
                <TextButton underline onClick={refresh}>
                  Retry
                </TextButton>
              </p>
            ) : null}
            {commit.error ? (
              <div role="alert" className="text-sm text-bad mb-3 break-words">
                {commit.error.message}
              </div>
            ) : null}
          </CommitSheet>
        ) : null}
      </PanelBar>
      {commitReason ? (
        <PanelNotice>
          {commitReason} {refreshTeam}
        </PanelNotice>
      ) : null}
      {notice ? <PanelNotice>{notice}</PanelNotice> : null}
      <div className="flex-1 min-h-0 flex flex-col">{workspaceContent}</div>
    </div>
  );
}

const comparisons = [
  { value: "head", label: "Uncommitted" },
  { value: "base", label: "Branch" },
] as const;

const fileCount = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;

/** What a commit takes: its files and line counts, under the sheet's title. */
export function CommitSummary({ files, stat }: { files: number; stat: { add: number; del: number } }) {
  return (
    <span className="inline-flex items-center gap-2">
      {fileCount(files)}
      <DiffStat add={stat.add} del={stat.del} />
    </span>
  );
}

/** Added and removed line counts straight from the patch, so the header never disagrees with the diff. */
export function countStat(patch: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add += 1;
    else if (line.startsWith("-")) del += 1;
  }
  return { add, del };
}
