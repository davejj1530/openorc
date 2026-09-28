import { useState, type ReactNode } from "react";
import type { Project, PushState, Task, TeamActionAvailability, ThreadSummary } from "@openorc/protocol";
import { Upload } from "../components/icons";
import { Badge, Button, Empty } from "../components/ui";
import { cn } from "../lib/cn";
import { useRpc, useRpcMutation } from "../lib/query";
import { teamGitActions } from "../lib/team-git-actions";
import { useThreadMutationPending } from "../lib/thread-mutations";
import { relativeTime, shortSha } from "../lib/time";
import { ThreadPullRequest } from "./ThreadPullRequest";

/** A task's branch, a thread's workspace, or the project's checkout outside any conversation. */
export type CommitSource = { kind: "task"; task: Task } | { kind: "thread"; thread: ThreadSummary; project: Project } | { kind: "checkout"; project: Project };

const emptyTitle: Record<CommitSource["kind"], string> = { task: "No commits on this task yet", thread: "No commits from this thread yet", checkout: "No commits yet" };

/** The source's commits, and what Push would send from them. Polled, so commits and pushes made in a terminal show up too. */
function useCommits(source: CommitSource) {
  const thread = source.kind === "thread" ? source.thread.id : null;
  const checkout = source.kind === "checkout" ? source.project.id : null;
  const logs = {
    task: useRpc("git.log", { taskId: source.kind === "task" ? source.task.id : "" }, { enabled: source.kind === "task" }),
    thread: useRpc("git.threadLog", { threadId: thread ?? "" }, { enabled: thread !== null, refetchInterval: 8000 }),
    checkout: useRpc("git.projectLog", { projectId: checkout ?? "" }, { enabled: checkout !== null, refetchInterval: 8000 }),
  };
  const log = logs[source.kind];
  const listed = Boolean(log.data?.length);
  const threadPush = useRpc("git.threadPushState", { threadId: thread ?? "" }, { enabled: thread !== null && listed, refetchInterval: 8000 });
  const checkoutPush = useRpc("git.projectPushState", { projectId: checkout ?? "" }, { enabled: checkout !== null && listed, refetchInterval: 8000 });
  return { log, push: thread ? threadPush : checkoutPush };
}

/** The commits on a task's branch since its base, a thread's workspace or the checkout, marking the ones origin doesn't have yet. */
export function CommitsPanel({ source }: { source: CommitSource }) {
  const { log, push } = useCommits(source);
  const commits = log.data ?? [];
  const unpushed = new Set(push.data?.unpushed);
  if (!log.isLoading && commits.length === 0) return <Empty title={emptyTitle[source.kind]}>Commit from Changes once the diff looks right.</Empty>;
  return (
    <div className="h-full flex flex-col min-h-0">
      {source.kind === "thread" ? <ThreadPushBar thread={source.thread} project={source.project} state={push.data} error={push.error} /> : null}
      {source.kind === "checkout" ? <CheckoutPushBar project={source.project} state={push.data} error={push.error} /> : null}
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

type PushOutcome = { onSuccess: (r: { remote: string; branch: string }) => void; onError: (e: Error) => void };

/** A thread's Push, and its pull request once the branch is on origin. A team's work waits for the team's go-ahead. */
function ThreadPushBar({ thread, project, state, error }: { thread: ThreadSummary; project: Project; state: PushState | undefined; error: Error | null }) {
  const team = Boolean(thread.teamInstanceId);
  const runtime = useRpc("orchestration.runtime", { threadId: thread.id }, { enabled: team, refetchInterval: 8000 });
  const push = useRpcMutation("review.pushThread");
  const pr = useRpcMutation("review.createThreadPr");
  const threadMutationPending = useThreadMutationPending(thread.id);
  const actions = teamGitActions(team, runtime);
  const busy = push.isPending || pr.isPending || (team && threadMutationPending);
  return (
    <PushBar
      state={state}
      error={error}
      action={actions.push}
      busy={busy}
      pushing={push.isPending}
      onPush={(outcome) => push.mutate({ threadId: thread.id }, outcome)}
      pullRequest={(onOpened) => <ThreadPullRequest thread={thread} project={project} pr={pr} action={actions.createPr} busy={busy} head={pullRequestHead(state, project)} onOpened={onOpened} />}
    />
  );
}

const anyone: TeamActionAvailability = { allowed: true, reason: null };

/** Push for the checkout's branch outside a conversation, such as after committing from a new thread's Changes. */
function CheckoutPushBar({ project, state, error }: { project: Project; state: PushState | undefined; error: Error | null }) {
  const push = useRpcMutation("review.pushProject");
  return <PushBar state={state} error={error} action={anyone} busy={push.isPending} pushing={push.isPending} onPush={(outcome) => push.mutate({ projectId: project.id }, outcome)} />;
}

/** Push, shown once origin lacks a commit, then what it or the pull request did. */
function PushBar({
  state,
  error,
  action,
  busy,
  pushing,
  onPush,
  pullRequest,
}: {
  state: PushState | undefined;
  error: Error | null;
  action: TeamActionAvailability;
  busy: boolean;
  pushing: boolean;
  onPush: (outcome: PushOutcome) => void;
  pullRequest?: (onOpened: (url: string) => void) => ReactNode;
}) {
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const reason = error?.message ?? state?.blocked ?? action.reason;
  const pending = hasUnpushed(state);
  const canPush = action.allowed && !reason && !busy;
  // A success holds until new commits arrive; a failure until nothing is left to push.
  const shown = notice && (notice.error ? pending : !pending) ? notice : null;
  const pushNow = () => {
    setNotice(null);
    onPush({ onSuccess: (r) => setNotice({ message: `Pushed ${r.branch} to ${r.remote}` }), onError: (e) => setNotice({ message: e.message, error: true }) });
  };
  return (
    <>
      <div className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-line text-base">
        <span className="font-medium">Commits</span>
        <span className="flex-1" />
        {pending && !state?.blocked ? (
          <Button size="sm" disabled={!canPush} title={state?.branch ? `Push ${state.branch} to origin` : undefined} onClick={pushNow}>
            <Upload size={12} /> {pushLabel(state, pushing)}
          </Button>
        ) : null}
        {pullRequest?.((url) => setNotice({ message: `Opened ${url}` }))}
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

/** The branch a pull request would open from now: its own, on origin with every commit. Null until then, or on the default branch. */
function pullRequestHead(state: PushState | undefined, project: Project): string | null {
  if (!state?.branch || state.blocked || hasUnpushed(state) || state.branch === (project.defaultBranch ?? "main")) return null;
  return state.branch;
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
