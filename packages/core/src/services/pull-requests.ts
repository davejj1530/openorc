import { randomUUID } from "node:crypto";
import { audit, projects, pullReviews, runs, threads, type Db, type PullReviewKey } from "@openorc/db";
import { GitHubPulls, git, worktree } from "@openorc/git";
import type { PullReviewTools } from "@openorc/mcp";
import {
  WORKSPACE_ID,
  harnessName,
  isHarnessId,
  patchFiles,
  reviewCommentPlace,
  type ModelExecutionSettings,
  type Project,
  type PullRequestBranches,
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
import { addReviewCheckout, fetchPullRequestHead, moveReviewCheckout } from "./pull-request-checkout.js";
import { REVIEW_DIFF, agentAnchor, agentDiff, changedSince } from "./pull-request-diff.js";
import type { ReviewerAppService } from "./reviewer-app.js";
import type { RunService } from "./runs.js";
import type { SystemService } from "./system.js";
import type { ThreadService } from "./threads.js";
import type { WorkspaceWriters } from "./workspace-writers.js";

export interface PullRequestServiceOptions {
  /** Where review checkouts live, beside the app's other worktrees. */
  dataDir: string;
  github?: GitHubPulls;
  /** Whether gh is installed, from the probe the rest of the app reads. */
  system: Pick<SystemService, "info">;
  threads: Pick<ThreadService, "start" | "update" | "queueFollowUp">;
  runs: Pick<RunService, "threadActivity" | "models">;
  /** Serializes changes to a review conversation's copy with its own turns. */
  writers: Pick<WorkspaceWriters, "withLease">;
  /** Posts reviews as the user's GitHub App instead of their gh account. */
  reviewerApp: Pick<ReviewerAppService, "submitReview">;
  invalidate(keys: string[]): void;
}

/** Who wrote a draft, by agent and model. */
type DraftAuthor = NonNullable<PullRequestDraftComment["author"]>;

/** Review diffs kept for agents between tool calls. */
const CACHED_DIFFS = 16;
const PROMPT_BODY_LIMIT = 20_000;

/** The first message of a review conversation: what the author asked for, as the reviewer would read it on GitHub. */
function reviewPrompt(detail: PullRequestDetail): string {
  const body = detail.body.trim() ? detail.body.trim().slice(0, PROMPT_BODY_LIMIT) : "No description.";
  return `Review pull request #${detail.number}: ${detail.title}\n${detail.url}\n\nBy @${detail.author}, merging ${detail.headRefName} into ${detail.baseRefName}.\n\n${body}`;
}

/** The message that starts another round in the same conversation, which remembers the last one. */
function againPrompt(detail: PullRequestDetail, previous: string | null): string {
  const lines = [`Review pull request #${detail.number} again: ${detail.title}`];
  if (previous && previous !== detail.headSha) {
    lines.push(
      `New commits since your last review: ${previous.slice(0, 7)}..${detail.headSha.slice(0, 7)}. Your copy now has the latest code, and pull_request_diff with since "${previous}" shows only what changed.`,
    );
    lines.push("", "Check whether your earlier findings were addressed. Comment only on what still needs work or is new.");
  } else {
    lines.push("No commits were added since your last review. Look again, and add only findings you haven't made.");
  }
  return lines.join("\n");
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

  /** The branches a new pull request can target, with `prefer` among them when GitHub has it. */
  async branches(projectId: string, prefer?: string): Promise<PullRequestBranches> {
    return this.github.branches(await this.repository(projectId), prefer);
  }

  async get(key: PullReviewKey): Promise<PullRequestDetail> {
    return this.github.get(await this.repository(key.projectId), key.number);
  }

  async diff(key: PullReviewKey): Promise<{ patch: string; headSha: string }> {
    return this.github.diff(await this.repository(key.projectId), key.number);
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

  /** Saves the draft's summary. A draft without comments moves to `commitId`, the head the summary was written about. */
  setSummary(key: PullReviewKey, commitId: string, summary: string): void {
    this.project(key.projectId);
    this.db.transaction(() => {
      const review = pullReviews.get(this.db, key);
      if (!review && !summary.trim()) return;
      if (!this.staleReason(review, commitId)) this.draftAt(key, commitId);
      pullReviews.update(this.db, key, { summary });
    });
    this.changed();
  }

  discard(key: PullReviewKey): void {
    const review = pullReviews.get(this.db, key);
    if (review?.threadId && this.options.runs.threadActivity(review.threadId) !== "idle") throw new Error("A model is still reviewing. Stop it in its conversation first.");
    this.db.transaction(() => pullReviews.clearDraft(this.db, key));
    this.changed();
  }

  /**
   * Starts a model reviewing the pull request's current head. The first round
   * opens a Plan-mode conversation of its own; later rounds continue it, so the
   * model can check its earlier findings against the new commits.
   */
  async start(key: PullReviewKey, reviewer: ModelExecutionSettings): Promise<{ threadId: string }> {
    const project = this.project(key.projectId);
    await this.assertGh();
    const detail = await this.github.get(project.rootPath, key.number);
    const current = pullReviews.get(this.db, key);
    const conversation = current?.threadId ? threads.get(this.db, current.threadId) : null;
    if (conversation && this.options.runs.threadActivity(conversation.id) !== "idle") throw new Error("A model is already reviewing this pull request. Open its conversation to follow along.");
    const stale = this.staleReason(current, detail.headSha);
    if (stale) throw new Error(stale);
    try {
      // An archived conversation, or one whose copy was removed, was put away: the next round starts fresh.
      if (conversation && conversation.archivedAt === null && conversation.worktreePath) return await this.reviewAgain(key, project, detail, conversation, reviewer);
      return await this.reviewAnew(key, project, detail, reviewer);
    } finally {
      this.changed();
    }
  }

  private async reviewAnew(key: PullReviewKey, project: Project, detail: PullRequestDetail, reviewer: ModelExecutionSettings): Promise<{ threadId: string }> {
    const mergeBase = await fetchPullRequestHead(project, detail);
    const checkoutPath = await addReviewCheckout(this.options.dataDir, project, detail);
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
            // The conversation names the pull request it reviews, as one that opened a pull request does.
            threads.update(this.db, thread.id, { prUrl: detail.url, prState: detail.state });
            admitted = true;
          },
        },
      );
      return { threadId: thread.id };
    } catch (error) {
      // An admitted conversation owns its checkout and removes it with itself.
      if (!admitted) await worktree.remove(project.rootPath, checkoutPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Another round in the same conversation: its copy moves to the new head, and the reviewer the user chose now asks. */
  private async reviewAgain(key: PullReviewKey, project: Project, detail: PullRequestDetail, conversation: Thread, reviewer: ModelExecutionSettings): Promise<{ threadId: string }> {
    const previous = conversation.baseSha;
    const mergeBase = await fetchPullRequestHead(project, detail);
    await moveReviewCheckout({ db: this.db, writers: this.options.writers }, project, conversation, detail);
    this.db.transaction(() => {
      this.draftAt(key, detail.headSha);
      pullReviews.update(this.db, key, { baseCommit: mergeBase });
    });
    const same = conversation.agent === reviewer.agent && conversation.model === reviewer.model && conversation.effort === reviewer.effort && conversation.fastMode === reviewer.fastMode;
    if (!same) this.options.threads.update(conversation.id, { agent: reviewer.agent, model: reviewer.model, effort: reviewer.effort, fastMode: reviewer.fastMode });
    this.options.threads.queueFollowUp({ threadId: conversation.id, text: againPrompt(detail, previous), requestKey: randomUUID() });
    this.options.invalidate(["threads", `thread:${conversation.id}`, `checkpoints:${conversation.id}`, `threaddiff:${conversation.id}`, "workspace-diff"]);
    return { threadId: conversation.id };
  }

  /**
   * Posts the draft as one review, as the user through gh or as their reviewer app, then removes what it carried.
   * Edits made while it posted stay in the draft. The conversation stays for the next round.
   */
  async submit(key: PullReviewKey, input: { event: PullRequestReviewEvent; summary: string; as: PullRequestReviewAuthor }): Promise<{ url: string | null }> {
    const { event, summary } = input;
    const project = this.project(key.projectId);
    await this.assertGh();
    const review = pullReviews.get(this.db, key);
    if (review?.threadId && this.options.runs.threadActivity(review.threadId) !== "idle") throw new Error("A model is still reviewing. Wait for it to finish, or stop it, before posting.");
    const comments = review?.comments ?? [];
    if (event !== "approve" && !summary.trim() && comments.length === 0) throw new Error("Write a summary or add a comment before posting.");
    const detail = await this.github.get(project.rootPath, key.number);
    // Comments post against the commit they were written on; a review without any is about the head as it is now.
    const commitId = review && comments.length > 0 ? review.commitId : detail.headSha;
    const submission = { commitId, event, body: summary, comments };
    const posted =
      input.as === "app"
        ? await this.options.reviewerApp.submitReview(detail.url, { ...submission, body: await this.signed(review, summary) })
        : await this.github.submitReview(project.rootPath, detail.url, submission);
    this.db.transaction(() => {
      if (review) pullReviews.clearPosted(this.db, key, review);
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

  /** Whether the conversation reviews a pull request, so its checkout holds code the user hasn't vetted. */
  reviewsPullRequest(thread: Thread): boolean {
    return pullReviews.forThread(this.db, thread.id) !== null;
  }

  /** What a conversation reviewing a pull request is told on every turn; null for any other conversation. */
  brief(thread: Thread): string | null {
    const review = pullReviews.forThread(this.db, thread.id);
    if (!review) return null;
    return [
      `This conversation reviews GitHub pull request #${review.number} for the user. Its code is checked out in your working folder at commit ${(thread.baseSha ?? "").slice(0, 12)}, on no branch. Its changes start from commit ${(review.baseCommit ?? "").slice(0, 12)}.`,
      "Read the changes with pull_request_diff, and the surrounding code in the checkout as needed. Look for bugs, security problems, data loss, races, missing error handling and missing tests, and for code that will be hard to change. Skip style points a formatter or linter would catch.",
      "Record each finding with pull_request_comment on the changed line it is about: one finding per comment, saying what is wrong, why it matters and a concrete fix. Finish with pull_request_summary, a short overall assessment.",
      "Reviewing is the whole task: do not propose an implementation plan. Your comments and summary are drafts. The user edits them and decides what to post to GitHub; you cannot post, push or change files. Keep your reply short: the findings live in the draft.",
    ].join("\n");
  }

  /** The review tools, offered only to runs of a conversation that reviews a pull request. */
  agentTools(): PullReviewTools {
    return {
      available: (runId) => this.reviewForRun(runId) !== null,
      diff: async (runId, { path: filePath, since }) => {
        const { review, head } = this.requireReview(runId);
        const full = await this.reviewDiff(review.projectId, review.baseCommit, head);
        if (since === undefined) return agentDiff(full, filePath);
        return agentDiff(changedSince(full, await this.reviewDiff(review.projectId, since, head, true)), filePath, `this pull request since ${since}`);
      },
      comment: async (runId, comment) => {
        const { review, run, head } = this.requireCurrent(runId);
        const file = patchFiles(await this.reviewDiff(review.projectId, review.baseCommit, head)).find((entry) => entry.path === comment.path);
        if (!file) throw new Error(`${comment.path} is not changed in this pull request. Comment on a file pull_request_diff shows.`);
        const anchor = agentAnchor(file.chunk, comment);
        const added = pullReviews.addComment(this.db, review, { path: comment.path, ...anchor, body: comment.body, author: { agent: run.agent, model: run.model } });
        this.changed();
        return `Draft comment saved on ${reviewCommentPlace(added)}.`;
      },
      summary: async (runId, body) => {
        const { review } = this.requireCurrent(runId);
        // A summary the user wrote stays; the model's waits beside it for the user to add.
        const theirs = review.summary.trim() !== "" && review.summary !== review.modelSummary;
        pullReviews.update(this.db, review, { modelSummary: body, ...(theirs ? {} : { summary: body }) });
        this.changed();
        return theirs ? "Summary saved beside the one the user wrote, which stays. The user decides what to post." : "Summary saved. The user reviews the draft and decides what to post.";
      },
    };
  }

  /** The review a run's conversation belongs to, with the commit its copy has checked out. */
  private reviewForRun(runId: string): { review: PullRequestReview; run: Run; head: string } | null {
    const run = runs.get(this.db, runId);
    const review = run?.threadId ? pullReviews.forThread(this.db, run.threadId) : null;
    const head = run?.threadId ? threads.get(this.db, run.threadId)?.baseSha : null;
    return run && review && head ? { review, run, head } : null;
  }

  private requireReview(runId: string): { review: PullRequestReview; run: Run; head: string } {
    const found = this.reviewForRun(runId);
    if (!found) throw new Error("This conversation no longer reviews a pull request.");
    return found;
  }

  /** Drafting needs the draft and the conversation's copy on the same commit, or the comments would point at lines that moved. */
  private requireCurrent(runId: string): { review: PullRequestReview; run: Run; head: string } {
    const found = this.requireReview(runId);
    if (found.review.commitId !== found.head) throw new Error("The pull request has newer commits than your copy. Ask the user to review it again from the Pull requests tab.");
    return found;
  }

  /**
   * Changes between two commits as the agent's copy has them: by default from
   * the merge base to the reviewed head, as GitHub diffs a pull request.
   */
  private async reviewDiff(projectId: string, base: string | null, head: string, requested = false): Promise<string> {
    const project = this.project(projectId);
    if (!base) throw new Error("This review has no starting commit. Start a new review from the pull request.");
    if (requested && (await git(project.rootPath, ["cat-file", "-e", `${base}^{commit}`], { okCodes: [0, 1, 128] })).code !== 0)
      throw new Error(`Commit ${base} isn't in this repository. Use a commit from an earlier review.`);
    const key = `${project.id}:${base}:${head}`;
    let diff = this.diffs.get(key);
    if (!diff) {
      diff = git(project.rootPath, [...REVIEW_DIFF, base, head]).then((result) => result.stdout);
      diff.catch(() => this.diffs.delete(key));
      this.diffs.set(key, diff);
      if (this.diffs.size > CACHED_DIFFS) this.diffs.delete(this.diffs.keys().next().value!);
    }
    return diff;
  }

  /** Why the draft cannot move to `commitId`; null when it can. Comments stay on the commit they were written against. */
  private staleReason(review: PullRequestReview | null, commitId: string): string | null {
    if (!review || review.commitId === commitId) return null;
    if (review.comments.length > 0) return `Your draft is for a different version of this pull request (${review.commitId.slice(0, 7)}). Post or discard it first.`;
    if (review.threadId && this.options.runs.threadActivity(review.threadId) !== "idle") return "A model is still reviewing a different version of this pull request.";
    return null;
  }

  /**
   * The draft for `commitId`, opened if needed. An empty draft follows the pull
   * request to a new commit. Its conversation stays linked; until its copy is
   * moved too, the agent's drafting tools refuse lines that may have moved.
   */
  private draftAt(key: PullReviewKey, commitId: string): void {
    const review = pullReviews.get(this.db, key);
    const stale = this.staleReason(review, commitId);
    if (stale) throw new Error(stale);
    if (!review) pullReviews.open(this.db, key, commitId);
    else if (review.commitId !== commitId) pullReviews.update(this.db, key, { commitId });
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
