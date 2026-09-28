import { useState } from "react";
import type { Project, PushState, Task, ThreadSummary } from "@openorc/protocol";
import { Upload } from "../components/icons";
import { Badge, Button, Empty } from "../components/ui";
import { cn } from "../lib/cn";
import { useRpc, useRpcMutation } from "../lib/query";
import { teamGitActions } from "../lib/team-git-actions";
import { useThreadMutationPending } from "../lib/thread-mutations";
import { relativeTime, shortSha } from "../lib/time";
import { ThreadPullRequest } from "./ThreadPullRequest";

export type CommitSource = { kind: "task"; task: Task } | { kind: "thread"; thread: ThreadSummary; project: Project };

/** The commits on a task's branch since its base, or on a thread's workspace, marking the ones origin doesn't have yet. */
export function CommitsPanel({ source }: { source: CommitSource }) {
  const thread = source.kind === "thread" ? source.thread : null;
  const taskLog = useRpc("git.log", { taskId: source.kind === "task" ? source.task.id : "" }, { enabled: source.kind === "task" });
  // Polled, so commits and pushes made in a terminal show up too.
  const threadLog = useRpc("git.threadLog", { threadId: thread?.id ?? "" }, { enabled: thread !== null, refetchInterval: 8000 });
  const log = thread ? threadLog : taskLog;
  const commits = log.data ?? [];
  const pushState = useRpc("git.threadPushState", { threadId: thread?.id ?? "" }, { enabled: thread !== null && commits.length > 0, refetchInterval: 8000 });
  const unpushed = new Set(pushState.data?.unpushed);
  if (!log.isLoading && commits.length === 0) {
    return <Empty title={thread ? "No commits from this thread yet" : "No commits on this task yet"}>Commit from Changes once the diff looks right.</Empty>;
  }
  return (
    <div className="h-full flex flex-col min-h-0">
      {source.kind === "thread" ? <PushBar thread={source.thread} project={source.project} state={pushState.data} error={pushState.error} /> : null}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {commits.map((c) => (
          <div key={c.sha} className="grid gap-0.5 px-3 py-2 border-b border-line text-base">
            <div className="flex items-center gap-2">
              <span className="truncate">{c.subject}</span>
              {unpushed.has(c.sha) ? <Badge className="ml-auto">Not pushed</Badge> : null}
            </div>
            <div className="flex items-center gap-2 text-sm text-ink-3">
              <span className="font-mono text-xs">{shortSha(c.sha)}</span>
              <span>{c.author}</span>
              <span className="ml-auto tabular text-ink-4">{relativeTime(c.at)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Push and the pull request, each shown only once it can run: after a commit origin lacks, and after the branch is on origin. */
function PushBar({ thread, project, state, error }: { thread: ThreadSummary; project: Project; state: PushState | undefined; error: Error | null }) {
  const team = Boolean(thread.teamInstanceId);
  const runtime = useRpc("orchestration.runtime", { threadId: thread.id }, { enabled: team, refetchInterval: 8000 });
  const push = useRpcMutation("review.pushThread");
  const pr = useRpcMutation("review.createThreadPr");
  const threadMutationPending = useThreadMutationPending(thread.id);
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const actions = teamGitActions(team, runtime);
  const action = actions.push;
  const reason = error?.message ?? state?.blocked ?? action.reason;
  const busy = push.isPending || pr.isPending || (team && threadMutationPending);
  const pending = hasUnpushed(state);
  const pushable = pending && !state?.blocked;
  const canPush = action.allowed && !reason && !busy;
  // A success holds until new commits arrive; a failure until nothing is left to push.
  const shown = notice && (notice.error ? pending : !pending) ? notice : null;
  const pushNow = () => {
    setNotice(null);
    push.mutate({ threadId: thread.id }, { onSuccess: (r) => setNotice({ message: `Pushed ${r.branch} to ${r.remote}` }), onError: (e) => setNotice({ message: e.message, error: true }) });
  };
  return (
    <>
      <div className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-line text-base">
        <span className="font-medium">Commits</span>
        <span className="flex-1" />
        {pushable ? (
          <Button size="sm" disabled={!canPush} title={state?.branch ? `Push ${state.branch} to origin` : undefined} onClick={pushNow}>
            <Upload size={12} /> {pushLabel(state, push.isPending)}
          </Button>
        ) : null}
        <ThreadPullRequest
          thread={thread}
          project={project}
          pr={pr}
          action={actions.createPr}
          busy={busy}
          ready={pullRequestReady(state, project)}
          onOpened={(url) => setNotice({ message: `Opened ${url}` })}
        />
      </div>
      {reason ? (
        <p role="status" className="px-3 py-2 text-sm text-ink-3 border-b border-line">
          {reason}
        </p>
      ) : null}
      {shown ? (
        <div role={shown.error ? "alert" : "status"} className={cn("px-3 py-1.5 text-sm border-b border-line break-words", shown.error ? "text-bad" : "text-ink-3")}>
          {shown.message}
        </div>
      ) : null}
    </>
  );
}

/** GitHub opens a pull request only from a branch of its own that origin has with every commit. */
function pullRequestReady(state: PushState | undefined, project: Project): boolean {
  return Boolean(state?.branch && !state.blocked && !hasUnpushed(state) && state.branch !== (project.defaultBranch ?? "main"));
}

/** Whether origin lacks the branch or some of its commits. */
function hasUnpushed(state: PushState | undefined): boolean {
  return Boolean(state && (state.unpushedCount > 0 || !state.published));
}

/** "Push 2 commits" while origin lacks some, "Publish branch" until origin has the branch at all. */
function pushLabel(state: PushState | undefined, pushing: boolean): string {
  if (state && !state.published && !state.blocked) return pushing ? "Publishing…" : "Publish branch";
  if (pushing) return "Pushing…";
  const count = state?.unpushedCount ?? 0;
  return count > 0 ? `Push ${count} ${count === 1 ? "commit" : "commits"}` : "Push";
}
