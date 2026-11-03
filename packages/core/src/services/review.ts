import { audit, comments, projects, retiredTeams, snapshots, tasks, threads, type Db, type ReviewCommentScope } from "@openorc/db";
import {
  changedFiles,
  changeStats,
  commitAll,
  createPr,
  filePatch,
  git,
  GitHubPulls,
  hasGh,
  headCommit,
  log,
  patchAgainst,
  patchSinceTree,
  pullRequestTemplate,
  push,
  unpushedCommits,
  workspaceTransfer,
} from "@openorc/git";
import type { ChangeComparison, Commit, FileDiff, Project, PushState, ReviewComment, ReviewDiff, Snapshot, Task, Thread, WorkspaceChanges } from "@openorc/protocol";
import { isDetachedCopy, reviewCommentPlace, WORKSPACE_ID } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { phoneOrigin } from "../request-origin.js";
import { executionFolder } from "./conversation-folder.js";
import { assertRepository, projectGit } from "./project-git.js";
import { assertMutableThread } from "./thread-mutations.js";
import { workspaceWriters, type WorkspaceWriters } from "./workspace-writers.js";
import { slugify } from "./workspace.js";
interface ThreadMutation {
  thread: Thread;
  project: Project;
  cwd: string;
  assertCurrent(): void;
}
interface TaskMutation {
  task: Task;
  project: Project;
  cwd: string;
  assertCurrent(): void;
}
/** Where a task's work happens, and how a conversation receives a follow-up message. */
export interface ReviewConversations {
  executionThreadFor(taskId: string): { id: string } | null;
  queueFollowUp(input: { threadId: string; text: string; requestKey: string }): { messageId: string };
}
export interface ReviewOptions {
  /** Where exported patches are written. */
  dataDir?: string;
  conversations?: ReviewConversations;
  github?: GitHubPulls;
}

export interface NewReviewComment extends ReviewCommentScope {
  path: string;
  /** The first line of a range; null for one line. */
  startLine: number | null;
  startSide: "old" | "new" | null;
  line: number | null;
  side: "old" | "new" | null;
  lineText: string | null;
  body: string;
}

const REVIEW_COMMENT_ERRORS = {
  scopeRequired: "Review comments need a conversation or a task.",
  conversationNotFound: "This conversation no longer exists.",
  deletedConversation: "This conversation is no longer available.",
  workspaceConversation: "Git review is available in project conversations. Workspace uses ordinary folders.",
  taskNotFound: "Task not found.",
  unassignedTask: "This task hasn't started in a conversation yet. Review it once it has.",
  otherConversation: "This task works in another conversation. Review it there.",
  notInReview: "Comment not found in this review.",
  selectOnce: "Select each review comment once.",
  alreadySent: "Some of these comments were already sent. Refresh and send the rest.",
  queueUnavailable: "Sending review comments needs the conversation queue.",
  archivedTask: "Unarchive this task before sending it review comments.",
} as const;

/** A long range quotes its first lines only; the agent reads the rest in the file. */
const QUOTED_LINES = 20;

function quotedLines(lineText: string | null): string {
  if (lineText === null) return "";
  const lines = lineText.split("\n");
  const quoted = lines
    .slice(0, QUOTED_LINES)
    .map((text) => `\n   > ${text}`)
    .join("");
  return lines.length > QUOTED_LINES ? `${quoted}\n   > … ${lines.length - QUOTED_LINES} more lines` : quoted;
}

/** The message that already accepted this whole selection, if one did. */
function acceptedMessage(selected: ReviewComment[]): string | null {
  const messages = new Set(selected.map((comment) => comment.sentMessageId));
  if (messages.size !== 1) return null;
  const [messageId] = messages;
  return messageId ?? null;
}

const DETACHED_COPY = "This conversation's copy is on no branch, so nothing in it is committed or pushed.";

/** What a thread's changes are measured against: its worktree's base for "base", else HEAD (null). */
const threadBase = (thread: Thread, comparison: ChangeComparison): string | null => (comparison === "base" && thread.worktreePath ? thread.baseSha : null);

/**
 * What Push would publish from `cwd`, judged by what origin was last seen to have: `head`, the branch itself unless
 * given, against the branch `branchOf` names. When no branch can be named, that is why nothing can be pushed.
 */
async function pushState(cwd: string, branchOf: () => string | Promise<string>, head?: string): Promise<Omit<PushState, "busy">> {
  let branch: string;
  try {
    branch = await branchOf();
  } catch (error) {
    return { branch: null, blocked: error instanceof Error ? error.message : String(error), published: false, unpushedCount: 0, unpushed: [] };
  }
  const state = await unpushedCommits(cwd, { rev: head ?? `refs/heads/${branch}`, branch });
  if (!state) return { branch, blocked: "This repository has no origin remote to push to.", published: false, unpushedCount: 0, unpushed: [] };
  return { branch, blocked: null, published: state.published, unpushedCount: state.count, unpushed: state.shas };
}

/** Everything the Files and Commits tabs need, plus the three integrate actions. */
export class ReviewService {
  constructor(
    private readonly db: Db,
    private readonly writers: WorkspaceWriters = workspaceWriters,
    private readonly options: ReviewOptions = {},
  ) {}

  /** What the thread agent changed in the checkout itself, against HEAD. */
  async projectDiff(project: Project): Promise<ReviewDiff> {
    await assertRepository(project);
    const [patch, files] = await Promise.all([patchAgainst(project.rootPath, null), changedFiles(project.rootPath, null)]);
    return { baseSha: null, patch, files, since: null };
  }

  async commitProject(project: Project, message: string): Promise<{ sha: string }> {
    await assertRepository(project);
    return this.writers.withLease(project.rootPath, `committing project ${project.id}`, async () => {
      const sha = await commitAll(project.rootPath, message);
      audit.record(this.db, { actor: "user", action: "project.commit", resourceType: "project", resourceId: project.id, metadata: { sha } });
      return { sha };
    });
  }

  async projectLog(project: Project, limit = 50): Promise<Commit[]> {
    await assertRepository(project);
    return log(project.rootPath, null, limit);
  }

  /** What Push would publish from the checkout's branch, whoever made its commits. */
  async projectPushState(project: Project): Promise<PushState> {
    await assertRepository(project);
    return this.withBusy(project.rootPath, () => pushState(project.rootPath, () => this.checkoutBranch(project)));
  }

  async pushProject(project: Project): Promise<{ remote: string; branch: string }> {
    await assertRepository(project);
    return this.writers.withLease(project.rootPath, `pushing project ${project.id}`, async () => {
      const branch = await this.checkoutBranch(project);
      await push(project.rootPath, branch);
      audit.record(this.db, { actor: "user", action: "project.push", resourceType: "project", resourceId: project.id, metadata: { branch } });
      return { remote: "origin", branch };
    });
  }

  /* Threads: the checkout against HEAD, or the thread's worktree against where it branched. */

  private async threadCwd(thread: Thread, project: Project): Promise<string> {
    if (retiredTeams.isHidden(this.db, thread.id)) throw new Error(REVIEW_COMMENT_ERRORS.deletedConversation);
    if (project.id === WORKSPACE_ID) throw new Error("Git review is available in project conversations. Workspace uses ordinary folders.");
    if (!thread.worktreePath) await assertRepository(project);
    return executionFolder({ thread, task: null }, project);
  }

  async threadDiff(thread: Thread, project: Project, comparison: ChangeComparison = "base"): Promise<ReviewDiff> {
    const cwd = await this.threadCwd(thread, project);
    const base = threadBase(thread, comparison);
    const [patch, files] = await Promise.all([patchAgainst(cwd, base), changedFiles(cwd, base)]);
    return { baseSha: base, patch, files, since: null };
  }

  /** The same changes as threadDiff, as a capped list with line counts and true totals. */
  async threadChanges(thread: Thread, project: Project, comparison: ChangeComparison = "base"): Promise<WorkspaceChanges> {
    const cwd = await this.threadCwd(thread, project);
    const base = threadBase(thread, comparison);
    return { comparison: base ? "base" : "head", baseSha: base, ...(await changeStats(cwd, base)) };
  }

  /** One file of those changes. A path with no changes is refused, so nothing is read that the list would not name. */
  async threadFileDiff(thread: Thread, project: Project, file: string, comparison: ChangeComparison = "base"): Promise<FileDiff> {
    const diff = await filePatch(await this.threadCwd(thread, project), threadBase(thread, comparison), file);
    if (!diff) throw new Error("This file has no changes.");
    return diff;
  }

  async commitThread(thread: Thread, project: Project, message: string): Promise<{ sha: string }> {
    return this.withThreadMutation(thread, project, "committing", async (context) => {
      // Committing runs the user's hooks, which in a pull request's copy would be its author's.
      if (isDetachedCopy(context.thread)) throw new Error(DETACHED_COPY);
      context.assertCurrent();
      const sha = await commitAll(context.cwd, message);
      audit.record(this.db, { actor: "user", action: "thread.commit", resourceType: "thread", resourceId: thread.id, metadata: { sha, ...phoneOrigin() } });
      return { sha };
    });
  }

  /** The branch a thread publishes: its own for a worktree, whatever the checkout is on otherwise. */
  private async threadBranch(thread: Thread, project: Project): Promise<string> {
    if (!thread.worktreePath) return this.checkoutBranch(project);
    if (isDetachedCopy(thread)) throw new Error(DETACHED_COPY);
    return thread.branch!;
  }

  /** The branch the project's checkout is on, once it has a commit to push. */
  private async checkoutBranch(project: Project): Promise<string> {
    const head = await git(project.rootPath, ["symbolic-ref", "--short", "-q", "HEAD"], { okCodes: [0, 1] });
    if (head.code !== 0) throw new Error("The checkout isn't on a branch.");
    if (!(await headCommit(project.rootPath))) throw new Error("Make a first commit before pushing.");
    return head.stdout.trim();
  }

  /**
   * A push state with whether a Git write holds `cwd` now, so a phone that lost a write's answer waits for it to land.
   * The rest is read after: once it says no write holds the workspace, it shows what the last one did.
   */
  private async withBusy(cwd: string, state: () => Promise<Omit<PushState, "busy">>): Promise<PushState> {
    const busy = await this.writers.writing(cwd);
    return { ...(await state()), busy };
  }

  /** What Push would publish from the thread's workspace, judged by what origin was last seen to have. */
  async threadPushState(thread: Thread, project: Project): Promise<PushState> {
    const cwd = await this.threadCwd(thread, project);
    return this.withBusy(cwd, () => pushState(cwd, () => this.threadBranch(thread, project)));
  }

  async pushThread(thread: Thread, project: Project): Promise<{ remote: string; branch: string }> {
    return this.withThreadMutation(thread, project, "pushing", async (context) => {
      const branch = await this.threadBranch(context.thread, context.project);
      context.assertCurrent();
      await push(context.cwd, branch);
      audit.record(this.db, { actor: "user", action: "thread.push", resourceType: "thread", resourceId: thread.id, metadata: { branch, ...phoneOrigin() } });
      return { remote: "origin", branch };
    });
  }

  /** The pull request template gh would use, read from the thread's workspace. */
  async threadPrTemplate(thread: Thread, project: Project): Promise<{ body: string | null }> {
    return { body: await pullRequestTemplate(await this.threadCwd(thread, project)) };
  }

  /** Opens a pull request from the thread's branch into `base`, the target the user chose. */
  async createThreadPr(thread: Thread, project: Project, title: string, body: string, base: string): Promise<{ url: string }> {
    return this.withThreadMutation(thread, project, "publishing", async (context) => {
      if (!(await hasGh())) throw new Error("the GitHub CLI (gh) is not installed");
      context.assertCurrent();
      const branch = await this.threadBranch(context.thread, context.project);
      if (branch === base) throw new Error(`the thread is on ${base}; a pull request needs a branch of its own`);
      await this.assertPushed(context.cwd, branch);
      context.assertCurrent();
      const url = await this.openPullRequest(context.cwd, { title, body, base, head: branch });
      threads.update(this.db, thread.id, { prUrl: url, prState: "open" });
      audit.record(this.db, { actor: "user", action: "thread.pr", resourceType: "thread", resourceId: thread.id, metadata: { url, ...phoneOrigin() } });
      return { url };
    });
  }

  /** Opens the pull request, saying plainly when gh refused because its target branch isn't on GitHub. */
  private async openPullRequest(cwd: string, options: { title: string; body: string; base: string; head: string }): Promise<string> {
    try {
      return await createPr(cwd, options);
    } catch (error) {
      const github = this.options.github ?? new GitHubPulls();
      if (!(await github.hasBranch(cwd, options.base).catch(() => true))) throw new Error(`${options.base} isn't a branch on GitHub. Choose another target branch.`);
      throw error;
    }
  }

  /**
   * GitHub answers a pull request for a head it has never seen with a page of GraphQL validation
   * errors, so the branch must be on origin, with every commit, before gh is asked.
   */
  private async assertPushed(cwd: string, branch: string): Promise<void> {
    const state = await unpushedCommits(cwd, { rev: `refs/heads/${branch}`, branch });
    if (!state) throw new Error("This repository has no origin remote to open a pull request from.");
    if (!state.published) throw new Error(`Push ${branch} to origin before opening its pull request.`);
    if (state.count > 0) throw new Error(`Push the ${state.count === 1 ? "commit" : `${state.count} commits`} on ${branch} before opening its pull request.`);
  }

  private async withThreadMutation<T>(input: Thread, project: Project, action: string, operation: (context: ThreadMutation) => Promise<T>): Promise<T> {
    const thread = threads.get(this.db, input.id);
    const ownedProject = projects.get(this.db, project.id);
    if (!thread || !ownedProject || thread.projectId !== ownedProject.id) throw new Error("The conversation no longer belongs to this project.");
    assertMutableThread(thread);
    if (retiredTeams.isHidden(this.db, thread.id)) throw new Error("This item is no longer available.");
    const cwd = await this.threadCwd(thread, ownedProject);
    const assertCurrent = () => {
      const current = threads.get(this.db, thread.id);
      const currentProject = projects.get(this.db, ownedProject.id);
      if (
        !current ||
        !currentProject ||
        current.projectId !== ownedProject.id ||
        currentProject.rootPath !== ownedProject.rootPath ||
        current.worktreePath !== thread.worktreePath ||
        current.baseSha !== thread.baseSha ||
        current.workspaceMode !== thread.workspaceMode
      )
        throw new Error("The conversation's workspace changed. Reload before publishing its changes.");
    };
    assertCurrent();
    return await this.writers.withLease(cwd, `${action} thread ${thread.id}`, async (lease) => {
      assertCurrent();
      assertCurrent();
      return operation({ thread, project: ownedProject, cwd: lease.paths[0]!, assertCurrent });
    });
  }

  /** Publish a task's branch after checking its workspace. */
  private async withTaskMutation<T>(input: Task, project: Project, action: string, operation: (context: TaskMutation) => Promise<T>): Promise<T> {
    const task = tasks.get(this.db, input.id);
    if (!task || task.projectId !== project.id) throw new Error("The task no longer belongs to this project.");
    if (this.isRetiredTask(task)) throw new Error("This item is no longer available.");
    if (!task.worktreePath) await assertRepository(project);
    const cwd = task.worktreePath ?? project.rootPath;
    const assertCurrent = () => {
      const current = tasks.get(this.db, task.id);
      if (!current || current.worktreePath !== task.worktreePath || current.baseSha !== task.baseSha || current.threadId !== task.threadId)
        throw new Error("The task's workspace changed. Reload before publishing its changes.");
    };
    assertCurrent();
    return this.writers.withLease(cwd, `${action} task ${task.id}`, async (lease) => {
      assertCurrent();
      return operation({ task, project, cwd: lease.paths[0]!, assertCurrent });
    });
  }

  async threadLog(thread: Thread, project: Project, limit = 50): Promise<Commit[]> {
    const range = thread.worktreePath && thread.baseSha ? `${thread.baseSha}..HEAD` : null;
    return log(await this.threadCwd(thread, project), range, limit);
  }

  async diff(task: Task, project: Project, options: { sinceReviewed?: boolean } = {}): Promise<ReviewDiff> {
    const cwd = await this.taskWorkspace(task, project);
    if (!cwd) return { baseSha: task.baseSha, patch: "", files: [], since: null };
    const reviewed = options.sinceReviewed && task.reviewedSnapshotId ? snapshots.get(this.db, task.reviewedSnapshotId) : null;
    if (reviewed) {
      const [patch, files] = await Promise.all([patchSinceTree(cwd, reviewed.treeSha), changedFiles(cwd, task.baseSha)]);
      return { baseSha: task.baseSha, patch, files, since: { snapshotId: reviewed.id, createdAt: reviewed.createdAt } };
    }
    const [patch, files] = await Promise.all([patchAgainst(cwd, task.baseSha), changedFiles(cwd, task.baseSha)]);
    return { baseSha: task.baseSha, patch, files, since: null };
  }

  snapshots(taskId: string): Snapshot[] {
    return snapshots.listForTask(this.db, taskId);
  }

  /** Remember what the user has seen, so the next look can be an interdiff. */
  markReviewed(task: Task): Task {
    const latest = snapshots.latestForTask(this.db, task.id);
    return tasks.update(this.db, task.id, { reviewedSnapshotId: latest?.id ?? null });
  }

  comments(scope: ReviewCommentScope): ReviewComment[] {
    if ((scope.threadId && retiredTeams.isHidden(this.db, scope.threadId)) || (scope.taskId && retiredTeams.hasTask(this.db, scope.taskId))) return [];
    if (scope.threadId) this.reviewableConversation(scope.threadId);
    return comments.list(this.db, scope);
  }

  /** A conversation comment can also name the task that works in that conversation. */
  addComment(input: NewReviewComment): ReviewComment {
    const scope = this.writableScope(input);
    return comments.insert(this.db, {
      threadId: scope.threadId ?? null,
      taskId: scope.taskId ?? null,
      snapshotId: null,
      path: input.path,
      startLine: input.startLine,
      startSide: input.startSide,
      line: input.line,
      side: input.side,
      lineText: input.lineText,
      body: input.body,
    });
  }

  removeComment(scope: ReviewCommentScope, id: string): void {
    if (!comments.list(this.db, this.writableScope(scope)).some((comment) => comment.id === id)) throw new Error(REVIEW_COMMENT_ERRORS.notInReview);
    comments.remove(this.db, id);
  }

  /**
   * Accepts the selected comments as one queued message in the conversation,
   * which delivers it with its own agent and settings. Queueing and linking
   * commit together; repeating an accepted selection returns its message.
   * Returns the tasks the feedback reopened.
   */
  sendComments(input: { threadId: string; taskId?: string; commentIds: string[] }): { messageId: string; sent: number; reopened: string[] } {
    const conversations = this.options.conversations;
    if (!conversations) throw new Error(REVIEW_COMMENT_ERRORS.queueUnavailable);
    if (new Set(input.commentIds).size !== input.commentIds.length) throw new Error(REVIEW_COMMENT_ERRORS.selectOnce);
    return this.db.transaction(() => {
      const scope = this.writableScope(input);
      const available = new Map(comments.list(this.db, scope).map((comment) => [comment.id, comment]));
      const selected = input.commentIds.map((id) => {
        const comment = available.get(id);
        if (!comment) throw new Error(REVIEW_COMMENT_ERRORS.notInReview);
        return comment;
      });
      const accepted = acceptedMessage(selected);
      if (accepted) return { messageId: accepted, sent: selected.length, reopened: [] };
      if (selected.some((comment) => comment.sentMessageId !== null || comment.sentInRunId !== null)) throw new Error(REVIEW_COMMENT_ERRORS.alreadySent);
      const labeled = this.labeledTasks(scope.taskId, selected);
      if (labeled.some((task) => task.status === "archived")) throw new Error(REVIEW_COMMENT_ERRORS.archivedTask);
      // A repeat is answered by the links above, so every send gets a new key: a message removed from the queue must not answer the next send.
      const { messageId } = conversations.queueFollowUp({ threadId: input.threadId, text: this.formatComments(selected), requestKey: `review:${randomUUID()}` });
      comments.markQueued(this.db, input.commentIds, { threadId: input.threadId, messageId });
      // Feedback on a task's work reopens that task, as starting it would.
      const reopened = labeled.filter((task) => task.status !== "in_progress");
      for (const task of reopened) tasks.update(this.db, task.id, { status: "in_progress", completedAt: null }, { explicitStatus: true });
      return { messageId, sent: selected.length, reopened: reopened.map((task) => task.id) };
    });
  }

  /** The tasks a send gives feedback on: the task screen it came from and every task its comments were written from. */
  private labeledTasks(taskId: string | undefined, selected: ReviewComment[]): Task[] {
    const ids = new Set([...(taskId ? [taskId] : []), ...selected.flatMap((comment) => (comment.taskId ? [comment.taskId] : []))]);
    return [...ids].flatMap((id) => {
      const task = tasks.get(this.db, id);
      return task ? [task] : [];
    });
  }

  private formatComments(selected: ReviewComment[]): string {
    const lines = selected.map((c, i) => `${i + 1}. ${reviewCommentPlace(c)}${quotedLines(c.lineText)}\n   ${c.body.replace(/\n/g, "\n   ")}`);
    const removedLines = selected.some((c) => c.side === "old" || c.startSide === "old");
    return [
      "Review comments on the current changes:",
      ...(removedLines ? ["A line number marked - is a removed line, counted in the previous version; the others count lines in the current files."] : []),
      "",
      ...lines,
      "",
      "Address each comment. When a comment is wrong, say why instead of changing the code. Finish with a short list of what changed.",
    ].join("\n");
  }

  /** Git review of a conversation's own workspace. */
  private reviewableConversation(threadId: string): Thread {
    const thread = threads.get(this.db, threadId);
    if (!thread) throw new Error(REVIEW_COMMENT_ERRORS.conversationNotFound);
    if (retiredTeams.isHidden(this.db, thread.id)) throw new Error(REVIEW_COMMENT_ERRORS.deletedConversation);
    if (thread.projectId === WORKSPACE_ID) throw new Error(REVIEW_COMMENT_ERRORS.workspaceConversation);
    return thread;
  }

  private writableScope(input: ReviewCommentScope): ReviewCommentScope {
    if (input.threadId) {
      const thread = this.reviewableConversation(input.threadId);
      if (retiredTeams.isHidden(this.db, thread.id)) throw new Error("This item is no longer available.");
      if (!input.taskId) return { threadId: thread.id };
      const assigned = this.options.conversations?.executionThreadFor(input.taskId) ?? null;
      if (!assigned) throw new Error(REVIEW_COMMENT_ERRORS.unassignedTask);
      if (assigned.id !== thread.id) throw new Error(REVIEW_COMMENT_ERRORS.otherConversation);
      return { threadId: thread.id, taskId: input.taskId };
    }
    if (!input.taskId) throw new Error(REVIEW_COMMENT_ERRORS.scopeRequired);
    const task = tasks.get(this.db, input.taskId);
    if (!task) throw new Error(REVIEW_COMMENT_ERRORS.taskNotFound);
    throw new Error(this.isRetiredTask(task) ? "This item is no longer available." : REVIEW_COMMENT_ERRORS.unassignedTask);
  }

  private isRetiredTask(task: Task): boolean {
    return retiredTeams.hasTask(this.db, task.id);
  }

  async log(task: Task, project: Project, limit = 50): Promise<Commit[]> {
    const cwd = await this.taskWorkspace(task, project);
    if (!cwd) return [];
    return log(cwd, task.baseSha ? `${task.baseSha}..HEAD` : null, limit);
  }

  /** Reading never prepares a workspace: a worktree task without one yet, or a folder without git, has nothing to show. */
  private async taskWorkspace(task: Task, project: Project): Promise<string | null> {
    const cwd = task.worktreePath ?? (task.workspaceMode === "worktree" ? null : project.rootPath);
    if (!cwd || (cwd === project.rootPath && (await projectGit(project)) === "none")) return null;
    try {
      await access(cwd);
      return cwd;
    } catch {
      // A removed worktree reads as empty; starting or preparing the task recreates it.
      return null;
    }
  }

  async commit(task: Task, project: Project, message: string): Promise<{ sha: string }> {
    return this.withTaskMutation(task, project, "committing", async (context) => {
      const sha = await commitAll(context.cwd, message);
      audit.record(this.db, { actor: "user", action: "review.commit", resourceType: "task", resourceId: task.id, metadata: { sha, message } });
      return { sha };
    });
  }

  async push(task: Task, project: Project): Promise<{ remote: string; branch: string }> {
    return this.withTaskMutation(task, project, "pushing", async (context) => {
      let branch = context.task.branch;
      if (!branch) throw new Error("task has no branch to push");
      context.assertCurrent();
      await push(context.cwd, branch);
      audit.record(this.db, { actor: "user", action: "review.push", resourceType: "task", resourceId: task.id, metadata: { branch } });
      return { remote: "origin", branch };
    });
  }

  /** Opens a pull request from the task's branch into `base`, the target the user chose. */
  async createPr(task: Task, project: Project, title: string, body: string, base: string): Promise<{ url: string }> {
    return this.withTaskMutation(task, project, "publishing", async (context) => {
      if (!(await hasGh())) throw new Error("GitHub CLI (gh) is not installed. Install it and run gh auth login, or push and open the PR in the browser.");
      context.assertCurrent();
      const head = context.task.branch;
      if (!head || head === base) throw new Error("task needs its own branch to open a PR");
      context.assertCurrent();
      const url = await this.openPullRequest(context.cwd, { title, body, base, head });
      audit.record(this.db, { actor: "user", action: "review.pr", resourceType: "task", resourceId: task.id, metadata: { url } });
      return { url };
    });
  }

  /** Lossless patch of the workspace against its base, including untracked files; retention refs are removed afterwards. */
  async exportPatch(task: Task, project: Project): Promise<{ path: string; files: number; bytes: number }> {
    if (!this.options.dataDir) throw new Error("Patch export needs an app data directory.");
    const dataDir = this.options.dataDir;
    return this.withTaskMutation(task, project, "exporting", async (context) => {
      const id = randomUUID();
      const snapshot = await workspaceTransfer.capture(context.cwd, { refPrefix: `refs/openorc/exports/${id}` });
      try {
        context.assertCurrent();
        const base = context.task.worktreePath ? (context.task.baseSha ?? snapshot.headSha) : snapshot.headSha;
        const patch = (await git(context.cwd, ["diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", "-M", base, snapshot.treeSha], { okCodes: [0, 1] })).stdout;
        const files = (await git(context.cwd, ["diff", "--name-only", "--no-renames", base, snapshot.treeSha], { okCodes: [0, 1] })).stdout.split("\n").filter(Boolean).length;
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
        const file = path.join(dataDir, "exports", `${slugify(task.title)}-${task.id.slice(0, 8)}-${stamp}.patch`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, patch, { flag: "wx" });
        audit.record(this.db, { actor: "user", action: "review.export", resourceType: "task", resourceId: task.id, metadata: { path: file, base, files } });
        return { path: file, files, bytes: Buffer.byteLength(patch) };
      } finally {
        for (const ref of [snapshot.treeRef, snapshot.headRef]) await git(context.cwd, ["update-ref", "-d", ref]).catch(() => undefined);
      }
    });
  }
}
