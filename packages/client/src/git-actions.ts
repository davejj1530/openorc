import {
  harnessName,
  isDetachedCopy,
  type FileChange,
  type PrState,
  type Project,
  type PullRequestBranches,
  type PushState,
  type TeamActionAvailability,
  type TeamConversation,
  type ThreadSummary,
} from "@openorc/protocol";

/*
 * A thread's publish flow as both apps show it: commit, then push, then the pull request, each with its label and,
 * when it cannot run, the one reason why. Layout stays per app.
 */

export type GitActions = Pick<NonNullable<TeamConversation["actions"]>, "commit" | "push" | "createPr">;

/** Old cached projections and failed ownership checks never authorize a workspace write. */
export function teamGitActions(team: boolean, runtime: { isPending: boolean; isError: boolean; data?: Pick<TeamConversation, "actions"> | null }): GitActions {
  let reason: string | null = null;
  if (team) {
    if (runtime.isError) reason = "Could not check team Git actions. Retry before changing its workspace.";
    else if (runtime.isPending) reason = "Checking team Git actions…";
    else if (!runtime.data?.actions) reason = "Team Git actions are unavailable. Refresh team status.";
  }
  const action = (key: keyof GitActions): TeamActionAvailability => {
    if (!team) return { allowed: true, reason: null };
    if (reason) return { allowed: false, reason };
    const value = runtime.data?.actions?.[key];
    return value?.allowed ? value : { allowed: false, reason: value?.reason ?? "This action is currently unavailable for the team." };
  };
  return { commit: action("commit"), push: action("push"), createPr: action("createPr") };
}

/** Whether origin lacks the branch or some of its commits. */
export function hasUnpushed(state: PushState | undefined): boolean {
  return Boolean(state && (state.unpushedCount > 0 || !state.published));
}

/** "Push 2 commits" while origin lacks some, "Publish branch" until origin has the branch at all. */
export function pushLabel(state: PushState | undefined, pushing: boolean): string {
  if (state && !state.published && !state.blocked) return pushing ? "Publishing…" : "Publish branch";
  if (pushing) return "Pushing…";
  const count = state?.unpushedCount ?? 0;
  return count > 0 ? `Push ${count} ${count === 1 ? "commit" : "commits"}` : "Push";
}

/** The branch a pull request would open from now: its own, on origin with every commit. Null until then, or on the default branch. */
export function pullRequestHead(state: PushState | undefined, project: Pick<Project, "defaultBranch">): string | null {
  if (!state?.branch || state.blocked || hasUnpushed(state) || state.branch === (project.defaultBranch ?? "main")) return null;
  return state.branch;
}

/** GitHub's page for comparing a worktree's branch with where it started, for opening a pull request without gh. */
export function compareUrl(project: Pick<Project, "gitRemote" | "defaultBranch">, thread: Pick<ThreadSummary, "branch" | "baseBranch" | "workspaceMode">): string | null {
  const remote = project.gitRemote;
  if (!remote || !thread.branch || thread.workspaceMode !== "worktree") return null;
  const m = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(remote);
  if (!m) return null;
  const base = thread.baseBranch ?? project.defaultBranch ?? "main";
  return `https://github.com/${m[1]}/${m[2]}/compare/${encodeURIComponent(base)}...${encodeURIComponent(thread.branch)}?expand=1`;
}

/**
 * The branch a new pull request targets until you choose another: the one its work started from, else the project's
 * default branch, else GitHub's. Once GitHub's branches are known, only one of those; never the branch it opens from.
 */
export function pullRequestTarget(options: { started: string | null; projectDefault: string | null; head: string | null; branches: PullRequestBranches | undefined }): string | null {
  const { started, projectDefault, head, branches } = options;
  const candidates = [started, projectDefault, branches?.defaultBranch ?? null];
  return candidates.find((branch): branch is string => branch !== null && branch !== head && (!branches || branches.branches.includes(branch))) ?? null;
}

/** A Push or pull request notice: a success holds until new commits arrive, a failure until nothing is left to push. */
export function heldNotice<N extends { message: string; error?: boolean }>(notice: N | null, pending: boolean): N | null {
  return notice && (notice.error ? pending : !pending) ? notice : null;
}

export type FileMarkTone = "ok" | "ink-2" | "bad" | "warn";
/** Each change status's letter and tone in a list of changed files. */
export const fileMarks: Record<FileChange["status"], { letter: string; tone: FileMarkTone }> = {
  added: { letter: "A", tone: "ok" },
  untracked: { letter: "U", tone: "ok" },
  modified: { letter: "M", tone: "ink-2" },
  deleted: { letter: "D", tone: "bad" },
  renamed: { letter: "R", tone: "warn" },
};

export const fileCount = (count: number): string => `${count} ${count === 1 ? "file" : "files"}`;

/** What a worktree thread's changes can be measured against. */
export const comparisons = [
  { value: "head", label: "Uncommitted" },
  { value: "base", label: "Branch" },
] as const;

export interface GitStep {
  label: string;
  /** Why the step cannot run now; null when it can. */
  reason: string | null;
  running: boolean;
}

export type PullRequestStep = { kind: "exists"; url: string; state: PrState } | { kind: "open"; head: string; step: GitStep } | { kind: "compare"; url: string; step: GitStep };

export interface PublishInput {
  thread: Pick<ThreadSummary, "branch" | "baseBranch" | "workspaceMode" | "worktreePath" | "prUrl" | "prState" | "activity" | "agent" | "teamInstanceId">;
  project: Pick<Project, "gitRemote" | "defaultBranch">;
  uncommitted: { files: number } | "loading" | "failed";
  /** What Push would send, and why it could not be read. */
  push: { state: PushState | undefined; error: string | null };
  /** How many commits the thread's log holds of its own; unknown when absent. A fresh branch with none has nothing to publish. */
  commits?: number;
  gh: boolean | undefined;
  /** teamGitActions(); every action allowed outside a team. */
  team: GitActions;
  running: "commit" | "push" | "pr" | null;
  /** Why the app cannot reach the Mac now; null on the desktop. */
  offline: string | null;
}

export interface PublishView {
  /** Null for a detached copy, which is read and never committed. */
  commit: GitStep | null;
  /** Null when origin lacks nothing or push is blocked. */
  push: GitStep | null;
  /** Why nothing can be pushed: the core's reason, or why the push state could not be read. */
  pushBlocked: string | null;
  pullRequest: PullRequestStep | null;
  /** The step the publish bar's ink pill is for. */
  next: "commit" | "push" | "pr" | null;
}

/** Commit, Push and the pull request wait while the agent works, or waits on an approval or a question: its run holds the workspace either way. */
function workingReason(thread: PublishInput["thread"]): string | null {
  return thread.activity === "running" || thread.activity === "waiting" ? `Wait for ${harnessName(thread.agent)} to finish.` : null;
}

/** Why there is nothing to commit, as far as the read of uncommitted changes knows. */
function uncommittedReason(uncommitted: PublishInput["uncommitted"]): string | null {
  if (uncommitted === "failed") return "Refresh changes before committing.";
  if (uncommitted === "loading") return "Checking for changes…";
  return uncommitted.files === 0 ? "Nothing to commit." : null;
}

function commitStep(input: PublishInput, working: string | null): GitStep | null {
  // A pull request's copy under review is someone else's code; a team's detached worktree still commits.
  if (!input.thread.teamInstanceId && isDetachedCopy(input.thread)) return null;
  const running = input.running === "commit";
  return { label: running ? "Committing…" : "Commit", reason: input.offline ?? input.team.commit.reason ?? working ?? uncommittedReason(input.uncommitted), running };
}

function pullRequestStep(input: PublishInput, working: string | null): PullRequestStep | null {
  const { thread, project } = input;
  if (thread.prUrl) return { kind: "exists", url: thread.prUrl, state: thread.prState ?? "open" };
  const head = pullRequestHead(input.push.state, project);
  if (!head) return null;
  const running = input.running === "pr";
  const step = { label: running ? "Opening…" : "PR", reason: input.offline ?? input.team.createPr.reason ?? working, running };
  if (input.gh) return { kind: "open", head, step };
  const url = compareUrl(project, thread);
  return url ? { kind: "compare", url, step } : null;
}

function pushStep(input: PublishInput, working: string | null): GitStep | null {
  const { state, error } = input.push;
  // Like the desktop's Commits tab: a branch with no commits of its own publishes only commits origin lacks from before.
  const nothingOwn = input.commits === 0 && !state?.unpushedCount;
  if (!hasUnpushed(state) || state?.blocked || nothingOwn) return null;
  const running = input.running === "push";
  return { label: pushLabel(state, running), reason: input.offline ?? input.team.push.reason ?? working ?? error, running };
}

/** The publish flow's steps for one thread, in the order a phone's bar offers them. */
export function publishView(input: PublishInput): PublishView {
  const working = workingReason(input.thread);
  const { state, error } = input.push;
  const commit = commitStep(input, working);
  const push = pushStep(input, working);
  const pullRequest = pullRequestStep(input, working);
  const files = typeof input.uncommitted === "object" ? input.uncommitted.files : 0;
  let next: PublishView["next"] = null;
  if (commit && files > 0) next = "commit";
  else if (push) next = "push";
  else if (pullRequest && pullRequest.kind !== "exists") next = "pr";
  return { commit, push, pushBlocked: error ?? state?.blocked ?? null, pullRequest, next };
}
