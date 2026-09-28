import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { audit, projects, pullReviews, runs, threads, type Db, type PullReviewKey } from "@openorc/db";
import { GitHubPulls, fetchPullRequest, git, pullRequestSource, worktree } from "@openorc/git";
import type { PullReviewComment, PullReviewTools } from "@openorc/mcp";
import {
  WORKSPACE_ID,
  commentAnchor,
  harnessName,
  isHarnessId,
  patchFiles,
  reviewCommentPlace,
  type CommentAnchor,
  type ModelExecutionSettings,
  type Project,
  type PullRequestDetail,
  type PullRequestDraftComment,
  type PullRequestFilter,
  type PullRequestReview,
  type PullRequestReviewAuthor,
  type PullRequestReviewEvent,
  type PullRequestSummary,
  type RpcParams,
  type Run,
  type Thread,
} from "@openorc/protocol";
import type { ReviewerAppService } from "./reviewer-app.js";
import type { RunService } from "./runs.js";
import type { SystemService } from "./system.js";
import type { ThreadService } from "./threads.js";
import { slugify } from "./workspace.js";

export interface PullRequestServiceOptions {
  /** Where review checkouts live, beside the app's other worktrees. */
  dataDir: string;
  github?: GitHubPulls;
  /** Whether gh is installed, from the probe the rest of the app reads. */
  system: Pick<SystemService, "info">;
  threads: Pick<ThreadService, "start">;
  runs: Pick<RunService, "threadActivity" | "models">;
  /** Posts reviews as the user's GitHub App instead of their gh account. */
  reviewerApp: Pick<ReviewerAppService, "submitReview">;
  invalidate(keys: string[]): void;
}

/** Who wrote a draft, by agent and model. */
type DraftAuthor = NonNullable<PullRequestDraftComment["author"]>;

/** How much of a diff one tool result carries before the agent is asked to read it a file at a time. */
const AGENT_DIFF_LIMIT = 150_000;
/** Review diffs kept for agents between tool calls. */
const CACHED_DIFFS = 16;
const PROMPT_BODY_LIMIT = 20_000;

/** The first message of a review conversation: what the author asked for, as the reviewer would read it on GitHub. */
function reviewPrompt(detail: PullRequestDetail): string {
  const body = detail.body.trim() ? detail.body.trim().slice(0, PROMPT_BODY_LIMIT) : "No description.";
  return `Review pull request #${detail.number}: ${detail.title}\n${detail.url}\n\nBy @${detail.author}, merging ${detail.headRefName} into ${detail.baseRefName}.\n\n${body}`;
}

/** The files a diff changes with their line counts, for a pull request too large to read in one piece. */
function changedFileList(patch: string): string {
  return patchFiles(patch)
    .map((file) => {
      const lines = file.chunk.split("\n");
      const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
      const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
      return `${file.path} (+${added} -${removed})`;
    })
    .join("\n");
}

function limited(text: string): string {
  return text.length <= AGENT_DIFF_LIMIT ? text : `${text.slice(0, AGENT_DIFF_LIMIT)}\n[Truncated. Read the rest of this file in your checkout.]`;
}

/** The diff an agent asked for: all of it, one file, or the file list when all of it is too long. */
function agentDiff(patch: string, filePath: string | undefined): string {
  if (!patch.trim()) return "This pull request changes nothing.";
  if (filePath === undefined) {
    if (patch.length <= AGENT_DIFF_LIMIT) return patch;
    return `This pull request is too large to read at once. Ask for one path at a time. Changed files:\n${changedFileList(patch)}`;
  }
  const file = patchFiles(patch).find((entry) => entry.path === filePath);
  return file ? limited(file.chunk) : `${filePath} is not changed in this pull request. Changed files:\n${changedFileList(patch)}`;
}

/**
 * Where an agent's comment attaches, checked the way GitHub will check it:
 * every line must be in the diff, and a range must stay inside one hunk.
 */
function agentAnchor(chunk: string, comment: PullReviewComment): CommentAnchor {
  const end = { line: comment.line, side: comment.side };
  const start = comment.startLine === undefined ? end : { line: comment.startLine, side: comment.startSide ?? comment.side };
  const where = `${comment.path} line ${comment.line} (${comment.side} side)`;
  if (!commentAnchor(chunk, end, end)) throw new Error(`${where} is not in this pull request's diff. Comment on a line pull_request_diff shows.`);
  if (!commentAnchor(chunk, start, start)) throw new Error(`${comment.path} line ${start.line} (${start.side} side) is not in this pull request's diff.`);
  const anchor = commentAnchor(chunk, start, end)!;
  const single = start.line === end.line && start.side === end.side;
  const exact = anchor.line === end.line && anchor.side === end.side && (single ? anchor.startLine === null : anchor.startLine === start.line && anchor.startSide === start.side);
  if (!exact) throw new Error(`The range ending at ${where} must start above it, in the same hunk.`);
  return anchor;
}

/**
 * GitHub pull requests for a project, and the reviews drafted for them. Lists,
 * diffs and posting go through the user's own gh; drafts stay in the ledger
 * until the user posts or discards them. A model reviews in a conversation of
 * its own, in Plan mode, on a detached checkout of the pull request: no branch
 * is created and the user's checkout is never touched.
 */
export class PullRequestService {
  private readonly github: GitHubPulls;
  private readonly diffs = new Map<string, Promise<string>>();

  constructor(
    private readonly db: Db,
    private readonly options: PullRequestServiceOptions,
  ) {
    this.github = options.github ?? new GitHubPulls();
  }

  async list(projectId: string, filter: PullRequestFilter): Promise<PullRequestSummary[]> {
    return this.github.list(await this.repository(projectId), filter);
  }

  async get(key: PullReviewKey): Promise<PullRequestDetail> {
    return this.github.get(await this.repository(key.projectId), key.number);
  }

  async diff(key: PullReviewKey): Promise<{ patch: string }> {
    return { patch: await this.github.diff(await this.repository(key.projectId), key.number) };
  }

  review(key: PullReviewKey): PullRequestReview | null {
    this.project(key.projectId);
    return pullReviews.get(this.db, key);
  }

  comment(input: RpcParams<"pulls.review.comment">): PullRequestDraftComment {
    const { commitId, projectId, number, ...comment } = input;
    const key = { projectId, number };
    this.project(projectId);
    const added = this.db.transaction(() => {
      this.draftAt(key, commitId);
      return pullReviews.addComment(this.db, key, { ...comment, author: null });
    });
    this.changed();
    return added;
  }

  editComment(key: PullReviewKey, id: string, body: string): PullRequestDraftComment {
    const comment = pullReviews.editComment(this.db, key, id, body);
    if (!comment) throw new Error("That comment is no longer in the draft.");
    this.changed();
    return comment;
  }

  removeComment(key: PullReviewKey, id: string): void {
    pullReviews.removeComment(this.db, key, id);
    this.changed();
  }

  setSummary(key: PullReviewKey, commitId: string, summary: string): void {
    this.project(key.projectId);
    this.db.transaction(() => {
      if (!pullReviews.get(this.db, key)) {
        if (!summary.trim()) return;
        pullReviews.open(this.db, key, commitId);
      }
      pullReviews.update(this.db, key, { summary });
    });
    this.changed();
  }

  discard(key: PullReviewKey): void {
    const review = pullReviews.get(this.db, key);
    if (review?.threadId && this.options.runs.threadActivity(review.threadId) !== "idle") throw new Error("A model is still reviewing. Stop it in its conversation first.");
    pullReviews.remove(this.db, key);
    this.changed();
  }

  /** Starts a model reviewing the pull request's current head in a new Plan-mode conversation. */
  async start(key: PullReviewKey, reviewer: ModelExecutionSettings): Promise<{ threadId: string }> {
    const project = this.project(key.projectId);
    await this.assertGh();
    const detail = await this.github.get(project.rootPath, key.number);
    const current = pullReviews.get(this.db, key);
    if (current?.threadId && current.commitId === detail.headSha && this.options.runs.threadActivity(current.threadId) !== "idle")
      throw new Error("A model is already reviewing this pull request. Open its conversation to follow along.");
    const stale = this.staleReason(current, detail.headSha);
    if (stale) throw new Error(stale);
    const { path: checkoutPath, mergeBase } = await this.checkout(project, detail);
    let admitted = false;
    try {
      const { thread } = await this.options.threads.start(
        {
          projectId: project.id,
          agent: reviewer.agent,
          model: reviewer.model,
          effort: reviewer.effort ?? undefined,
          fastMode: reviewer.fastMode,
          mode: "plan",
          permissionMode: "review",
          // The conversation's own changes count from the head it checked out; the pull request's start from the merge base.
          checkout: { path: checkoutPath, baseSha: detail.headSha },
          prompt: reviewPrompt(detail),
          attachments: undefined,
          title: `Review #${detail.number}: ${detail.title}`,
        },
        {
          assertCanAdmit: () => undefined,
          // Linked before the agent starts, so its first request already sees the review tools.
          onAdmitted: (thread) => {
            this.draftAt(key, detail.headSha);
            pullReviews.update(this.db, key, { threadId: thread.id, baseCommit: mergeBase });
            admitted = true;
          },
        },
      );
      return { threadId: thread.id };
    } catch (error) {
      // An admitted conversation owns its checkout and removes it with itself.
      if (!admitted) await worktree.remove(project.rootPath, checkoutPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      this.changed();
    }
  }

  /** Posts the draft as one review, as the user through gh or as their reviewer app, then clears it. */
  async submit(key: PullReviewKey, input: { event: PullRequestReviewEvent; summary: string; as: PullRequestReviewAuthor }): Promise<{ url: string | null }> {
    const { event, summary } = input;
    const project = this.project(key.projectId);
    await this.assertGh();
    const review = pullReviews.get(this.db, key);
    if (review?.threadId && this.options.runs.threadActivity(review.threadId) !== "idle") throw new Error("A model is still reviewing. Wait for it to finish, or stop it, before posting.");
    const comments = review?.comments ?? [];
    if (event !== "approve" && !summary.trim() && comments.length === 0) throw new Error("Write a summary or add a comment before posting.");
    const detail = await this.github.get(project.rootPath, key.number);
    const submission = { commitId: review?.commitId ?? detail.headSha, event, body: summary, comments };
    const posted =
      input.as === "app"
        ? await this.options.reviewerApp.submitReview(detail.url, { ...submission, body: await this.signed(review, summary) })
        : await this.github.submitReview(project.rootPath, detail.url, submission);
    this.db.transaction(() => {
      pullReviews.remove(this.db, key);
      audit.record(this.db, {
        actor: "user",
        action: "pull_request.review",
        resourceType: "project",
        resourceId: key.projectId,
        metadata: { number: key.number, event, as: input.as, comments: comments.length },
      });
    });
    this.changed();
    return posted;
  }

  /**
   * The body a review posted by the app carries: which models drafted it, then
   * the summary. The app is one name on GitHub, so the models are named here.
   */
  private async signed(review: PullRequestReview | null, summary: string): Promise<string> {
    const authors = new Map<string, DraftAuthor>();
    const conversation = review?.threadId ? threads.get(this.db, review.threadId) : null;
    if (conversation) authors.set(`${conversation.agent}:${conversation.model}`, { agent: conversation.agent, model: conversation.model });
    for (const comment of review?.comments ?? []) if (comment.author) authors.set(`${comment.author.agent}:${comment.author.model}`, comment.author);
    if (authors.size === 0) return summary;
    const names = new Set(await Promise.all([...authors.values()].map((author) => this.modelName(author))));
    const line = `Review by ${new Intl.ListFormat("en", { type: "conjunction" }).format([...names])}.`;
    return summary.trim() ? `${line}\n\n${summary}` : line;
  }

  /** A model by the name the model picker shows, falling back to its ID or harness. */
  private async modelName(author: DraftAuthor): Promise<string> {
    const models = await this.options.runs.models(author.agent).catch(() => []);
    const listed = models.find((model) => model.id === author.model)?.label;
    return listed ?? author.model ?? (isHarnessId(author.agent) ? harnessName(author.agent) : author.agent);
  }

  /** What a conversation reviewing a pull request is told on every turn; null for any other conversation. */
  brief(thread: Thread): string | null {
    const review = pullReviews.forThread(this.db, thread.id);
    if (!review) return null;
    return [
      `This conversation reviews GitHub pull request #${review.number} for the user. Its code is checked out in your working folder at commit ${review.commitId.slice(0, 12)}, on no branch. Its changes start from commit ${(review.baseCommit ?? "").slice(0, 12)}.`,
      "Read the changes with pull_request_diff, and the surrounding code in the checkout as needed. Look for bugs, security problems, data loss, races, missing error handling and missing tests, and for code that will be hard to change. Skip style points a formatter or linter would catch.",
      "Record each finding with pull_request_comment on the changed line it is about: one finding per comment, saying what is wrong, why it matters and a concrete fix. Finish with pull_request_summary, a short overall assessment.",
      "Reviewing is the whole task: do not propose an implementation plan. Your comments and summary are drafts. The user edits them and decides what to post to GitHub; you cannot post, push or change files. Keep your reply short: the findings live in the draft.",
    ].join("\n");
  }

  /** The review tools, offered only to runs of a conversation that reviews a pull request. */
  agentTools(): PullReviewTools {
    return {
      available: (runId) => this.reviewForRun(runId) !== null,
      diff: async (runId, filePath) => {
        const { review } = this.requireReview(runId);
        return agentDiff(await this.reviewDiff(review), filePath);
      },
      comment: async (runId, comment) => {
        const { review, run } = this.requireReview(runId);
        const file = patchFiles(await this.reviewDiff(review)).find((entry) => entry.path === comment.path);
        if (!file) throw new Error(`${comment.path} is not changed in this pull request. Comment on a file pull_request_diff shows.`);
        const anchor = agentAnchor(file.chunk, comment);
        const added = pullReviews.addComment(this.db, review, { path: comment.path, ...anchor, body: comment.body, author: { agent: run.agent, model: run.model } });
        this.changed();
        return `Draft comment saved on ${reviewCommentPlace(added)}.`;
      },
      summary: async (runId, body) => {
        const { review } = this.requireReview(runId);
        pullReviews.update(this.db, review, { summary: body });
        this.changed();
        return "Summary saved. The user reviews the draft and decides what to post.";
      },
    };
  }

  private reviewForRun(runId: string): { review: PullRequestReview; run: Run } | null {
    const run = runs.get(this.db, runId);
    const review = run?.threadId ? pullReviews.forThread(this.db, run.threadId) : null;
    return run && review ? { review, run } : null;
  }

  private requireReview(runId: string): { review: PullRequestReview; run: Run } {
    const found = this.reviewForRun(runId);
    if (!found) throw new Error("This conversation no longer reviews a pull request.");
    return found;
  }

  /** The changes at the reviewed commit, as the agent's checkout has them. GitHub diffs from the same merge base. */
  private reviewDiff(review: PullRequestReview): Promise<string> {
    const project = this.project(review.projectId);
    const base = review.baseCommit;
    if (!base) return Promise.reject(new Error("This review has no starting commit. Start a new review from the pull request."));
    const key = `${project.id}:${base}:${review.commitId}`;
    let diff = this.diffs.get(key);
    if (!diff) {
      diff = git(project.rootPath, ["diff", "--no-color", "--no-ext-diff", "-M", base, review.commitId]).then((result) => result.stdout);
      diff.catch(() => this.diffs.delete(key));
      this.diffs.set(key, diff);
      if (this.diffs.size > CACHED_DIFFS) this.diffs.delete(this.diffs.keys().next().value!);
    }
    return diff;
  }

  /** The pull request's head in a worktree of its own, detached, with the commit its changes start from. */
  private async checkout(project: Project, detail: PullRequestDetail): Promise<{ path: string; mergeBase: string }> {
    const source = await pullRequestSource(project.rootPath, detail.url);
    await fetchPullRequest(project.rootPath, { source, number: detail.number, baseRefName: detail.baseRefName, commits: [detail.headSha, detail.baseSha] });
    const mergeBase = (await git(project.rootPath, ["merge-base", detail.baseSha, detail.headSha])).stdout.trim();
    const target = path.join(this.options.dataDir, "worktrees", `${slugify(project.name)}-${project.id.slice(0, 6)}`, `pr-${detail.number}-${randomUUID().slice(0, 6)}`);
    await mkdir(path.dirname(target), { recursive: true });
    await worktree.addDetached(project.rootPath, { path: target, commit: detail.headSha });
    return { path: target, mergeBase };
  }

  /** Why the draft cannot move to `commitId`; null when it can. Comments stay on the commit they were written against. */
  private staleReason(review: PullRequestReview | null, commitId: string): string | null {
    if (!review || review.commitId === commitId) return null;
    if (review.comments.length > 0) return `Your draft is for an earlier version of this pull request (${review.commitId.slice(0, 7)}). Post or discard it first.`;
    if (review.threadId && this.options.runs.threadActivity(review.threadId) !== "idle") return "A model is still reviewing the earlier version of this pull request.";
    return null;
  }

  /**
   * The draft for `commitId`, opened if needed. An empty draft follows the pull
   * request to a new commit and lets go of the conversation that reviewed the
   * old one, whose agent would otherwise comment on lines that moved.
   */
  private draftAt(key: PullReviewKey, commitId: string): void {
    const review = pullReviews.get(this.db, key);
    const stale = this.staleReason(review, commitId);
    if (stale) throw new Error(stale);
    if (!review) pullReviews.open(this.db, key, commitId);
    else if (review.commitId !== commitId) pullReviews.update(this.db, key, { commitId, threadId: null, baseCommit: null });
  }

  private project(projectId: string): Project {
    if (projectId === WORKSPACE_ID) throw new Error("Workspace has no pull requests. Choose a project.");
    const project = projects.get(this.db, projectId);
    if (!project) throw new Error(`project ${projectId} not found`);
    return project;
  }

  private async repository(projectId: string): Promise<string> {
    const project = this.project(projectId);
    await this.assertGh();
    return project.rootPath;
  }

  private async assertGh(): Promise<void> {
    if (!(await this.options.system.info()).gh.installed) throw new Error("The GitHub CLI (gh) isn't installed. Install it, then sign in with gh auth login.");
  }

  private changed(): void {
    this.options.invalidate(["pull-reviews"]);
  }
}
