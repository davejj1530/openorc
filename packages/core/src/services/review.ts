import { WORKSPACE_ID, reviewCommentPlace, teamReviewComment } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { audit, comments, orchestration, projects, snapshots, tasks, teamDeletedThreads, teamRuntime, teamTasks, threads, type Db, type ReviewCommentScope } from "@openorc/db";
import { changedFiles, commitAll, createPr, git, hasGh, log, patchAgainst, patchSinceTree, pullRequestTemplate, push, teamTransfer, unpushedCommits } from "@openorc/git";
import type { Commit, Project, PushState, ReviewComment, ReviewDiff, Snapshot, Task, TeamActionAvailability, TeamReviewComment, Thread } from "@openorc/protocol";
import { workspaceWriters, type WorkspaceWriters } from "./workspace-writers.js";
import { teamPublicationBranch, teamWorkspaceLocation } from "./team-workspace-location.js";
import type { TeamTaskExport } from "./team-task-export.js";
import { slugify } from "./workspace.js";

export interface ReviewTeamMutations {
  /** Reserve before any await; new team work stays blocked until release. */
  reserve(threadId: string): { assertCurrent(): void; release(): void };
  /** Read-only availability; native Git state is checked when the action runs. */
  reason?(threadId: string): string | null;
}
interface ThreadMutation {
  thread: Thread;
  project: Project;
  cwd: string;
  team: boolean;
  assertCurrent(): void;
}
interface PublicationRef {
  branch: string;
  ref: string;
  head: string;
  previous: string | null;
}
interface TaskMutation {
  task: Task;
  project: Project;
  cwd: string;
  team: TeamTaskExport | null;
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
  /** Team-owned task publication availability; null for ordinary tasks. */
  taskExport?(taskId: string): TeamTaskExport | null;
  conversations?: ReviewConversations;
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
  deletedConversation: "This conversation was deleted. Its saved tasks keep their team activity and controls.",
  workspaceConversation: "Git review is available in project conversations. Workspace uses ordinary folders.",
  teamConversation: "Team conversations take feedback through their tasks' team review.",
  taskNotFound: "Task not found.",
  unassignedTask: "This task hasn't started in a conversation yet. Review it once it has.",
  otherConversation: "This task works in another conversation. Review it there.",
  teamTaskOnly: "Review comments without a conversation belong to team review.",
  notInReview: "Comment not found in this review.",
  teamFeedback: "This comment belongs to retained team feedback. Add another comment to clarify it.",
  selectOnce: "Select each review comment once.",
  alreadySent: "Some of these comments were already sent. Refresh and send the rest.",
  queueUnavailable: "Sending review comments needs the conversation queue.",
  archivedTask: "Unarchive this task before sending it review comments.",
  teamSingleLine: "Team review comments cover one line.",
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
const isSha = (value: string | null | undefined) => Boolean(value && /^[0-9a-f]{40,64}$/.test(value));

/** Everything the Files and Commits tabs need, plus the three integrate actions. */
export class ReviewService {
  constructor(
    private readonly db: Db,
    private readonly writers: WorkspaceWriters = workspaceWriters,
    private readonly teamMutations?: ReviewTeamMutations,
    private readonly options: ReviewOptions = {},
  ) {}

  teamActionAvailability(threadId: string): TeamActionAvailability {
    try {
      const thread = threads.get(this.db, threadId);
      if (!thread || !orchestration.getInstance(this.db, threadId)) throw new Error("This conversation has no saved team.");
      if (!this.teamMutations?.reason) throw new Error("Team Git actions require the team's execution guard.");
      const reason = this.teamMutations.reason(threadId);
      if (reason) throw new Error(reason);
      this.assertTeamWorkspace(thread);
      return { allowed: true, reason: null };
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** What the thread agent changed in the checkout itself, against HEAD. */
  async projectDiff(project: Project): Promise<ReviewDiff> {
    const [patch, files] = await Promise.all([patchAgainst(project.rootPath, null), changedFiles(project.rootPath, null)]);
    return { baseSha: null, patch, files, since: null };
  }

  async commitProject(project: Project, message: string): Promise<{ sha: string }> {
    return this.writers.withLease(project.rootPath, `committing project ${project.id}`, async () => {
      const sha = await commitAll(project.rootPath, message);
      audit.record(this.db, { actor: "user", action: "project.commit", resourceType: "project", resourceId: project.id, metadata: { sha } });
      return { sha };
    });
  }

  /* Threads: the checkout against HEAD, or the thread's worktree against where it branched. */

  private threadCwd(thread: Thread, project: Project): string {
    if (project.id === WORKSPACE_ID) throw new Error("Git review is available in project conversations. Workspace uses ordinary folders.");
    return thread.worktreePath ?? project.rootPath;
  }

  async threadDiff(thread: Thread, project: Project, comparison: "base" | "head" = "base"): Promise<ReviewDiff> {
    const cwd = this.threadCwd(thread, project);
    const base = comparison === "base" && thread.worktreePath ? thread.baseSha : null;
    const [patch, files] = await Promise.all([patchAgainst(cwd, base), changedFiles(cwd, base)]);
    return { baseSha: base, patch, files, since: null };
  }

  async commitThread(thread: Thread, project: Project, message: string): Promise<{ sha: string }> {
    return this.withThreadMutation(thread, project, "committing", async (context) => {
      const publication = context.team && context.thread.workspaceMode === "worktree" ? await this.publicationRef(context) : null;
      context.assertCurrent();
      const sha = await commitAll(context.cwd, message);
      audit.record(this.db, { actor: "user", action: "thread.commit", resourceType: "thread", resourceId: thread.id, metadata: { sha } });
      if (publication) {
        try {
          await this.updatePublicationRef(context, { ...publication, head: sha });
        } catch (error) {
          throw new Error(`Commit ${sha} was created in the team workspace, but its publication branch could not advance: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { sha };
    });
  }

  /** The branch a thread publishes: its own for a worktree, whatever the checkout is on otherwise. */
  private async threadBranch(thread: Thread, project: Project): Promise<string> {
    if (thread.branch && thread.worktreePath) return thread.branch;
    const head = await git(project.rootPath, ["symbolic-ref", "--short", "-q", "HEAD"], { okCodes: [0, 1] });
    if (head.code !== 0) throw new Error("The checkout isn't on a branch.");
    return head.stdout.trim();
  }

  /** What Push would publish from the thread's workspace, judged by what origin was last seen to have. */
  async threadPushState(thread: Thread, project: Project): Promise<PushState> {
    const cwd = this.threadCwd(thread, project);
    // A team worktree stays detached, and Push first advances its publication branch to HEAD.
    const team = thread.workspaceMode === "worktree" && Boolean(orchestration.getInstance(this.db, thread.id));
    let branch: string;
    try {
      branch = team ? this.teamBranch(thread.id) : await this.threadBranch(thread, project);
    } catch (error) {
      return { branch: null, blocked: error instanceof Error ? error.message : String(error), published: false, unpushedCount: 0, unpushed: [] };
    }
    const state = await unpushedCommits(cwd, { rev: team ? "HEAD" : `refs/heads/${branch}`, branch });
    if (!state) return { branch, blocked: "This repository has no origin remote to push to.", published: false, unpushedCount: 0, unpushed: [] };
    return { branch, blocked: null, published: state.published, unpushedCount: state.count, unpushed: state.shas };
  }

  async pushThread(thread: Thread, project: Project): Promise<{ remote: string; branch: string }> {
    return this.withThreadMutation(thread, project, "pushing", async (context) => {
      const publication = context.team && context.thread.workspaceMode === "worktree" ? await this.publicationRef(context) : null;
      const branch = publication ? await this.updatePublicationRef(context, publication) : await this.threadBranch(context.thread, context.project);
      context.assertCurrent();
      await push(context.cwd, branch);
      audit.record(this.db, { actor: "user", action: "thread.push", resourceType: "thread", resourceId: thread.id, metadata: { branch } });
      return { remote: "origin", branch };
    });
  }

  /** The pull request template gh would use, read from the thread's workspace. */
  async threadPrTemplate(thread: Thread, project: Project): Promise<{ body: string | null }> {
    return { body: await pullRequestTemplate(this.threadCwd(thread, project)) };
  }

  async createThreadPr(thread: Thread, project: Project, title: string, body: string): Promise<{ url: string }> {
    return this.withThreadMutation(thread, project, "publishing", async (context) => {
      if (!(await hasGh())) throw new Error("the GitHub CLI (gh) is not installed");
      context.assertCurrent();
      const publication = context.team && context.thread.workspaceMode === "worktree" ? await this.publicationRef(context) : null;
      const branch = publication ? await this.updatePublicationRef(context, publication) : await this.threadBranch(context.thread, context.project);
      const base = context.project.defaultBranch ?? "main";
      if (branch === base) throw new Error(`the thread is on ${base}; a pull request needs a branch of its own`);
      if (publication) {
        const remote = await git(context.cwd, ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], { okCodes: [0, 2] });
        if (remote.code !== 0 || remote.stdout.split(/\s/)[0] !== publication.head) throw new Error("Push the team's committed changes before creating its pull request.");
      } else {
        await this.assertPushed(context.cwd, branch);
      }
      context.assertCurrent();
      const url = await createPr(context.cwd, { title, body, base, head: branch });
      threads.update(this.db, thread.id, { prUrl: url, prState: "open" });
      audit.record(this.db, { actor: "user", action: "thread.pr", resourceType: "thread", resourceId: thread.id, metadata: { url } });
      return { url };
    });
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
    const instance = orchestration.getInstance(this.db, thread.id);
    if (instance && !this.teamMutations) throw new Error("Team Git actions require the team's execution guard.");
    const reservation = instance ? this.teamMutations!.reserve(thread.id) : null;
    try {
      const cwd = this.threadCwd(thread, ownedProject);
      const assertCurrent = () => {
        reservation?.assertCurrent();
        const current = threads.get(this.db, thread.id);
        const currentProject = projects.get(this.db, ownedProject.id);
        if (
          !current ||
          !currentProject ||
          current.projectId !== ownedProject.id ||
          currentProject.rootPath !== ownedProject.rootPath ||
          current.worktreePath !== thread.worktreePath ||
          current.baseSha !== thread.baseSha ||
          current.workspaceMode !== thread.workspaceMode ||
          orchestration.getInstance(this.db, thread.id)?.id !== instance?.id
        )
          throw new Error("The conversation's workspace changed. Reload before publishing its changes.");
        if (instance) this.assertTeamWorkspace(current);
      };
      assertCurrent();
      return await this.writers.withLease(cwd, `${action} thread ${thread.id}`, async (lease) => {
        assertCurrent();
        if (instance) {
          const isProject = (await realpath(ownedProject.rootPath)) === lease.paths[0];
          if (isProject !== (thread.workspaceMode === "current")) throw new Error("Team Git actions must use their retained local or isolated lead workspace.");
        }
        assertCurrent();
        return operation({ thread, project: ownedProject, cwd: lease.paths[0]!, team: Boolean(instance), assertCurrent });
      });
    } finally {
      reservation?.release();
    }
  }

  private teamBranch(threadId: string): string {
    return teamPublicationBranch(this.db, threadId);
  }

  private assertTeamWorkspace(thread: Thread): void {
    teamWorkspaceLocation(this.db, thread.id);
    teamPublicationBranch(this.db, thread.id);
  }

  /** Lead workspaces stay detached; only explicit Git actions advance this thread's ref. */
  private publicationRef(context: ThreadMutation): Promise<PublicationRef> {
    return this.dedicatedRef(context.cwd, this.teamBranch(context.thread.id), context.assertCurrent);
  }

  /** Team workspaces stay detached; a dedicated branch advances only by explicit action, never divergently. */
  private async dedicatedRef(cwd: string, branch: string, assertCurrent: () => void): Promise<PublicationRef> {
    const ref = `refs/heads/${branch}`;
    const [symbolic, head, existing, worktrees] = await Promise.all([
      git(cwd, ["symbolic-ref", "-q", "HEAD"], { okCodes: [0, 1] }),
      git(cwd, ["rev-parse", "HEAD"]),
      git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { okCodes: [0, 1] }),
      git(cwd, ["worktree", "list", "--porcelain", "-z"]),
    ]);
    assertCurrent();
    if (symbolic.code === 0) throw new Error("The team workspace is attached to a branch outside its publication flow. Detach it before publishing team changes.");
    if (worktrees.stdout.split("\0").includes(`branch ${ref}`)) throw new Error("The team's publication branch is checked out in another workspace. Detach that checkout before advancing it.");
    const previous = existing.code === 0 ? existing.stdout.trim() : null;
    const currentHead = head.stdout.trim();
    if (previous) {
      const ancestry = await git(cwd, ["merge-base", "--is-ancestor", previous, currentHead], { okCodes: [0, 1] });
      if (ancestry.code !== 0) throw new Error("The team's publication branch has divergent commits. Reconcile them before publishing; it will not be overwritten.");
    }
    assertCurrent();
    return { branch, ref, head: currentHead, previous };
  }

  private async advanceRef(cwd: string, publication: PublicationRef, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    await git(cwd, ["update-ref", publication.ref, publication.head, publication.previous ?? "0".repeat(publication.head.length)]);
    const verified = (await git(cwd, ["rev-parse", "--verify", publication.ref])).stdout.trim();
    if (verified !== publication.head) throw new Error("The team publication ref changed during the operation. Reload its Git state before retrying.");
  }

  private async updatePublicationRef(context: ThreadMutation, publication: PublicationRef): Promise<string> {
    await this.advanceRef(context.cwd, publication, context.assertCurrent);
    threads.update(this.db, context.thread.id, { branch: publication.branch });
    return publication.branch;
  }

  /** Ordinary tasks publish their own branch; team assignments publish a dedicated detached-worktree ref under the team fences. */
  private async withTaskMutation<T>(input: Task, project: Project, action: string, operation: (context: TaskMutation) => Promise<T>): Promise<T> {
    const task = tasks.get(this.db, input.id);
    if (!task || task.projectId !== project.id) throw new Error("The task no longer belongs to this project.");
    const team = this.options.taskExport?.(task.id) ?? null;
    if (team && !team.allowed) throw new Error(team.reason!);
    // A team-owned task never takes the ordinary path without an export authority; the integrated team branch stays the fallback.
    if (!team && ((task.threadId && orchestration.getInstance(this.db, task.threadId)) || teamRuntime.assignmentsForTask(this.db, task.id).length))
      throw new Error("Publish integrated team changes from the main team conversation. This assignment has no publication authority in this app instance.");
    const cwd = task.worktreePath ?? project.rootPath;
    const assertCurrent = () => {
      const current = tasks.get(this.db, task.id);
      if (!current || current.worktreePath !== task.worktreePath || current.baseSha !== task.baseSha || current.threadId !== task.threadId)
        throw new Error("The task's workspace changed. Reload before publishing its changes.");
      if (team) {
        const latest = this.options.taskExport?.(task.id);
        if (!latest?.allowed) throw new Error(latest?.reason ?? "This assignment can no longer be published.");
      }
    };
    assertCurrent();
    return this.writers.withLease(cwd, `${action} task ${task.id}`, async (lease) => {
      assertCurrent();
      return operation({ task, project, cwd: lease.paths[0]!, team, assertCurrent });
    });
  }

  private taskBase(task: Task, project: Project): string | null {
    return isSha(task.baseRef) ? project.defaultBranch : (task.baseRef ?? project.defaultBranch);
  }

  threadLog(thread: Thread, project: Project, limit = 50): Promise<Commit[]> {
    const range = thread.worktreePath && thread.baseSha ? `${thread.baseSha}..HEAD` : null;
    return log(this.threadCwd(thread, project), range, limit);
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
    if (scope.threadId) this.reviewableConversation(scope.threadId);
    return comments.list(this.db, scope);
  }

  /**
   * A conversation comment may carry the task it was written from, but only
   * for the conversation that task works in. Without a conversation, a
   * comment belongs to team review and keeps the task's latest snapshot.
   */
  addComment(input: NewReviewComment): ReviewComment {
    const scope = this.writableScope(input);
    // A retained team batch keeps a frozen single-line copy of each comment.
    if (!scope.threadId && input.startLine !== null) throw new Error(REVIEW_COMMENT_ERRORS.teamSingleLine);
    const teamSnapshot = scope.threadId ? null : snapshots.latestForTask(this.db, scope.taskId!);
    return comments.insert(this.db, {
      threadId: scope.threadId ?? null,
      taskId: scope.taskId ?? null,
      snapshotId: teamSnapshot?.id ?? null,
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
    if (teamTasks.claim(this.db, id)) throw new Error(REVIEW_COMMENT_ERRORS.teamFeedback);
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
        if (teamTasks.claim(this.db, id)) throw new Error(REVIEW_COMMENT_ERRORS.teamFeedback);
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

  /** Validate and snapshot an explicit team selection; the caller owns durable claims and delivery. */
  composeSelectedComments(taskId: string, commentIds: string[]): { prompt: string; comments: TeamReviewComment[] } {
    if (commentIds.length === 0) throw new Error("Select at least one review comment");
    if (new Set(commentIds).size !== commentIds.length) throw new Error("Selected review comment IDs must be distinct");
    return this.db.transaction(() => {
      if (!tasks.get(this.db, taskId)) throw new Error(`task ${taskId} not found`);
      const available = new Map(comments.listForTask(this.db, taskId).map((comment) => [comment.id, comment]));
      const selected = commentIds.map((id) => {
        const comment = available.get(id);
        if (!comment) throw new Error(`Review comment ${id} was not found on this task`);
        if (comment.sentInRunId !== null || comment.sentMessageId !== null) throw new Error(`Review comment ${id} was already sent`);
        if (comment.snapshotId !== null) {
          const source = snapshots.get(this.db, comment.snapshotId);
          if (!source || source.taskId !== taskId) throw new Error(`Review comment ${id} references a snapshot that does not belong to this task`);
        }
        return comment;
      });
      return { prompt: this.formatComments(selected), comments: selected.map(teamReviewComment) };
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

  /** Git review of a conversation's own workspace. Team conversations take feedback through team review. */
  private reviewableConversation(threadId: string): Thread {
    const thread = threads.get(this.db, threadId);
    if (!thread) throw new Error(REVIEW_COMMENT_ERRORS.conversationNotFound);
    if (teamDeletedThreads.has(this.db, thread.id)) throw new Error(REVIEW_COMMENT_ERRORS.deletedConversation);
    if (thread.projectId === WORKSPACE_ID) throw new Error(REVIEW_COMMENT_ERRORS.workspaceConversation);
    if (orchestration.getInstance(this.db, thread.id)) throw new Error(REVIEW_COMMENT_ERRORS.teamConversation);
    return thread;
  }

  private writableScope(input: ReviewCommentScope): ReviewCommentScope {
    if (input.threadId) {
      const thread = this.reviewableConversation(input.threadId);
      if (!input.taskId) return { threadId: thread.id };
      const assigned = this.options.conversations?.executionThreadFor(input.taskId) ?? null;
      if (!assigned) throw new Error(REVIEW_COMMENT_ERRORS.unassignedTask);
      if (assigned.id !== thread.id) throw new Error(REVIEW_COMMENT_ERRORS.otherConversation);
      return { threadId: thread.id, taskId: input.taskId };
    }
    if (!input.taskId) throw new Error(REVIEW_COMMENT_ERRORS.scopeRequired);
    const task = tasks.get(this.db, input.taskId);
    if (!task) throw new Error(REVIEW_COMMENT_ERRORS.taskNotFound);
    if (!this.isTeamTask(task)) throw new Error(REVIEW_COMMENT_ERRORS.teamTaskOnly);
    return { taskId: task.id };
  }

  private isTeamTask(task: Task): boolean {
    if (teamRuntime.assignmentForTask(this.db, task.id) || teamTasks.intent(this.db, task.id)) return true;
    return [task.threadId, task.executionThreadId].some((threadId) => Boolean(threadId && orchestration.getInstance(this.db, threadId)));
  }

  async log(task: Task, project: Project, limit = 50): Promise<Commit[]> {
    const cwd = await this.taskWorkspace(task, project);
    if (!cwd) return [];
    return log(cwd, task.baseSha ? `${task.baseSha}..HEAD` : null, limit);
  }

  /** Reading never prepares a workspace: a worktree task without one yet has nothing to show. */
  private async taskWorkspace(task: Task, project: Project): Promise<string | null> {
    const cwd = task.worktreePath ?? (task.workspaceMode === "worktree" ? null : project.rootPath);
    if (!cwd) return null;
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
      const publication = context.team ? await this.dedicatedRef(context.cwd, context.team.branch, context.assertCurrent) : null;
      const sha = await commitAll(context.cwd, message);
      audit.record(this.db, { actor: "user", action: "review.commit", resourceType: "task", resourceId: task.id, metadata: { sha, message, ...(publication ? { branch: publication.branch } : {}) } });
      if (publication) {
        try {
          await this.advanceRef(context.cwd, { ...publication, head: sha }, context.assertCurrent);
          tasks.update(this.db, task.id, { branch: publication.branch });
        } catch (error) {
          throw new Error(`Commit ${sha} was created in the assignment workspace, but its branch could not advance: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { sha };
    });
  }

  async push(task: Task, project: Project): Promise<{ remote: string; branch: string }> {
    return this.withTaskMutation(task, project, "pushing", async (context) => {
      let branch = context.task.branch;
      if (context.team) {
        const publication = await this.dedicatedRef(context.cwd, context.team.branch, context.assertCurrent);
        await this.advanceRef(context.cwd, publication, context.assertCurrent);
        tasks.update(this.db, task.id, { branch: publication.branch });
        branch = publication.branch;
      }
      if (!branch) throw new Error("task has no branch to push");
      context.assertCurrent();
      await push(context.cwd, branch);
      audit.record(this.db, { actor: "user", action: "review.push", resourceType: "task", resourceId: task.id, metadata: { branch } });
      return { remote: "origin", branch };
    });
  }

  async createPr(task: Task, project: Project, title: string, body: string): Promise<{ url: string }> {
    return this.withTaskMutation(task, project, "publishing", async (context) => {
      if (!(await hasGh())) throw new Error("GitHub CLI (gh) is not installed. Install it and run gh auth login, or push and open the PR in the browser.");
      context.assertCurrent();
      const base = this.taskBase(context.task, project);
      const publication = context.team ? await this.dedicatedRef(context.cwd, context.team.branch, context.assertCurrent) : null;
      const head = publication?.branch ?? context.task.branch;
      if (!base || !head) throw new Error("task needs a base branch and its own branch to open a PR");
      if (publication) {
        const remote = await git(context.cwd, ["ls-remote", "--exit-code", "origin", `refs/heads/${head}`], { okCodes: [0, 2] });
        if (remote.code !== 0 || remote.stdout.split(/\s/)[0] !== publication.head) throw new Error("Push the assignment's committed changes before creating its pull request.");
      }
      context.assertCurrent();
      const url = await createPr(context.cwd, { title, body, base, head });
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
      const snapshot = await teamTransfer.capture(context.cwd, { refPrefix: `refs/openorc/exports/${id}` });
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
