import { randomUUID } from "node:crypto";
import { audit, claudeAccounts, orclings, projects, pullReviews, runs, threads, type Db, type PullReviewKey } from "@openorc/db";
import { GitHubPulls, git, remoteRepository, worktree, type PullsAt } from "@openorc/git";
import type { Hosted } from "@openorc/hosted";
import type { PullReviewTools } from "@openorc/mcp";
import {
  PULL_REVIEW_NEEDS_FOLDER,
  WORKSPACE_ID,
  harnessName,
  isHarnessId,
  patchFiles,
  reviewCommentPlace,
  reviewDrafted,
  type ModelExecutionSettings,
  type Orcling,
  type Project,
  type PullRequestBranches,
  type PullRequestDetail,
  type PullRequestDraftComment,
  type PullRequestCounts,
  type PullRequestStateFilter,
  type PullRequestChoice,
  type PullRequestChoiceKind,
  type PullRequestNarrowing,
  type PullRequestReview,
  type PullRequestReviewAuthor,
  type PullRequestReviewEvent,
  type PullRequestSummary,
  type RpcParams,
  type Run,
  type Thread,
} from "@openorc/protocol";
import { ACCOUNTS_KEPT_SEPARATE, accountsSeparate, threadAccount } from "./claude-account-separation.js";
import { projectAccountPolicy, startingAccount } from "./project-claude-accounts.js";
import { addReviewCheckout, fetchPullRequestHead, moveReviewCheckout } from "./pull-request-checkout.js";
import { REVIEW_DIFF, agentAnchor, agentDiff, agentDraft, changedSince } from "./pull-request-diff.js";
import type { ReviewerAppService } from "./reviewer-app.js";
import type { RunService } from "./runs.js";
import type { SystemService } from "./system.js";
import type { StartThreadInput } from "./thread-inputs.js";
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
  /** A project only OpenOrc Cloud has, with no folder on this Mac: its pull requests are read on GitHub by name. */
  cloudProject?(projectId: string): Project | null;
  /** OpenOrc Cloud's reviews, which keep the draft of a project only it has; null while signed out. */
  cloudReviews?(): Hosted["pullReviews"] | null;
  invalidate(keys: string[]): void;
}

/** Who wrote a draft, by agent and model. */
type DraftAuthor = NonNullable<PullRequestDraftComment["author"]>;
/** Who reviews: a model, or an Orcling with the model it uses. */
type Reviewer = ModelExecutionSettings & { orclingId: string | null };
/** The model a review was asked of, with the Claude account it was given. */
type ReviewModel = Pick<ModelExecutionSettings, "agent"> & { claudeAccountId?: string | undefined };

/** Review diffs kept for agents between tool calls. */
const CACHED_DIFFS = 16;
const PROMPT_BODY_LIMIT = 20_000;
const NO_DRAFT_COMMENT = "No comment of the draft has that id. Read the draft with pull_request_draft.";

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

/** An archived conversation, or one whose copy was removed, was put away: the next round starts fresh. */
function reviewGoesOn(conversation: Thread | null): conversation is Thread {
  return conversation !== null && conversation.archivedAt === null && Boolean(conversation.worktreePath);
}

function askedAccount(db: Db, orcling: Pick<Orcling, "claudeAccountId"> | null, model: ReviewModel): string | undefined {
  if (orcling) return accountsSeparate(db) ? orcling.claudeAccountId : undefined;
  return model.agent === "claude" ? model.claudeAccountId : undefined;
}

/**
 * Where a round of review runs: the conversation it goes on in, unless that is on another account than the round asks
 * for, else a fresh one; and its Claude account, none for a fresh one on the project's default.
 */
export function reviewRound(db: Db, conversation: Thread | null, orcling: Pick<Orcling, "claudeAccountId"> | null, model: ReviewModel): { goesOn: Thread | null; claudeAccountId: string | undefined } {
  const asked = askedAccount(db, orcling, model);
  if (reviewGoesOn(conversation) && (!asked || threadAccount(conversation) === asked)) return { goesOn: conversation, claudeAccountId: threadAccount(conversation) };
  return { goesOn: null, claudeAccountId: asked };
}

/**
 * What a fresh review conversation starts on: an Orcling's own account, which the project's accounts leave alone, or
 * the one a model was given, refused as a new thread's is when the project doesn't use it; else the project's default.
 */
function freshAccount(db: Db, projectId: string, reviewer: Reviewer, account: string | undefined): Pick<StartThreadInput, "claudeAccountId" | "claudeAccountFrom"> {
  if (!account) return {};
  if (reviewer.orclingId) return { claudeAccountId: account, claudeAccountFrom: "own" };
  return { claudeAccountId: startingAccount(db, projectId, account, "chosen"), claudeAccountFrom: "chosen" };
}

/**
 * While accounts are kept separate, a round on another account than the conversation that wrote the draft would take
 * the draft's comments and summary with it, so the draft is posted or discarded first. An empty draft moves freely.
 */
function assertDraftStays(db: Db, review: PullRequestReview | null, conversation: Thread | null, round: { claudeAccountId: string | undefined }, reviewer: string): void {
  if (!review || !conversation || !accountsSeparate(db)) return;
  if (!reviewDrafted(review)) return;
  const written = threadAccount(conversation);
  const reviewsOn = round.claudeAccountId ?? projectAccountPolicy(db, review.projectId).defaultId;
  if (reviewsOn === written) return;
  const name = (id: string) => claudeAccounts.list(db).find((account) => account.id === id)?.name ?? "another Claude account";
  throw new Error(`This pull request's review draft was written on ${name(written)}, and ${ACCOUNTS_KEPT_SEPARATE}, so post or discard it before ${reviewer} reviews it on ${name(reviewsOn)}.`);
}

/** The `owner/name` of a cloud project's repository on GitHub. */
function cloudRepository(project: Project): string {
  const repository = project.gitRemote ? remoteRepository(project.gitRemote) : null;
  if (repository?.host !== "github.com") throw new Error("This project's repository isn't on GitHub.");
  return repository.path;
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

  async list(projectId: string, state: PullRequestStateFilter, narrowing: PullRequestNarrowing = {}): Promise<PullRequestSummary[]> {
    return this.github.list(await this.repository(projectId), state, narrowing);
  }

  /** How many pull requests each state holds under these filters. */
  async counts(projectId: string, narrowing: PullRequestNarrowing = {}): Promise<PullRequestCounts> {
    return this.github.counts(await this.repository(projectId), narrowing);
  }

  /** What one of GitHub's filters offers for the project's repository. */
  async choices(projectId: string, kind: PullRequestChoiceKind): Promise<PullRequestChoice[]> {
    return this.github.choices(await this.repository(projectId), kind);
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

  /** Who keeps the draft of a project only OpenOrc Cloud has: OpenOrc Cloud. Null for a project with a folder here. */
  drafts(projectId: string): Hosted["pullReviews"] | null {
    return this.cloud(projectId) ? (this.options.cloudReviews?.() ?? null) : null;
  }

  review(key: PullReviewKey): PullRequestReview | null {
    // A project only OpenOrc Cloud has keeps no draft review on this Mac.
    if (this.cloud(key.projectId)) return null;
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
  async start(key: PullReviewKey, chosen: ModelExecutionSettings, orclingId?: string, claudeAccountId?: string): Promise<{ threadId: string }> {
    const cloud = this.drafts(key.projectId);
    if (cloud) return this.startInCloud(cloud, key, chosen, orclingId);
    const project = this.project(key.projectId);
    const orcling = orclingId ? orclings.get(this.db, orclingId) : null;
    if (orclingId && !orcling) throw new Error("That Orcling no longer exists. Choose another reviewer.");
    // An Orcling reviews with its own model; its identity follows the conversation.
    const reviewer = { ...(orcling?.settings ?? chosen), orclingId: orcling?.id ?? null };
    await this.assertGh();
    const detail = await this.github.get(project.rootPath, key.number);
    const current = pullReviews.get(this.db, key);
    const conversation = current?.threadId ? threads.get(this.db, current.threadId) : null;
    if (conversation && this.options.runs.threadActivity(conversation.id) !== "idle") throw new Error("A model is already reviewing this pull request. Open its conversation to follow along.");
    const stale = this.staleReason(current, detail.headSha);
    if (stale) throw new Error(stale);
    const round = reviewRound(this.db, conversation, orcling, { agent: chosen.agent, claudeAccountId });
    assertDraftStays(this.db, current, conversation, round, orcling?.name ?? "a model");
    try {
      if (round.goesOn) return await this.reviewAgain(key, project, detail, round.goesOn, reviewer);
      return await this.reviewAnew(key, project, detail, reviewer, round.claudeAccountId);
    } finally {
      this.changed();
    }
  }

  /** A model reviews a cloud-only project's pull request in a cloud thread of its own, on the head GitHub shows now. */
  private async startInCloud(cloud: Hosted["pullReviews"], key: PullReviewKey, chosen: ModelExecutionSettings, orclingId?: string): Promise<{ threadId: string }> {
    if (orclingId) throw new Error("Orclings review pull requests of projects on this Mac.");
    const detail = await this.github.get(await this.repository(key.projectId), key.number);
    try {
      return await cloud.start(key, detail.headSha, { agent: chosen.agent, model: chosen.model, effort: chosen.effort });
    } finally {
      this.changed();
    }
  }

  private async reviewAnew(key: PullReviewKey, project: Project, detail: PullRequestDetail, reviewer: Reviewer, account: string | undefined): Promise<{ threadId: string }> {
    const startsOn = freshAccount(this.db, project.id, reviewer, account);
    const mergeBase = await fetchPullRequestHead(project, detail);
    const checkoutPath = await addReviewCheckout(this.options.dataDir, project, detail);
    let admitted = false;
    try {
      const { thread } = await this.options.threads.start(
        {
          ...startsOn,
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
            threads.update(this.db, thread.id, { prUrl: detail.url, prState: detail.state, orclingId: reviewer.orclingId });
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
  private async reviewAgain(key: PullReviewKey, project: Project, detail: PullRequestDetail, conversation: Thread, reviewer: Reviewer): Promise<{ threadId: string }> {
    const previous = conversation.baseSha;
    const mergeBase = await fetchPullRequestHead(project, detail);
    await moveReviewCheckout({ db: this.db, writers: this.options.writers }, project, conversation, detail);
    this.db.transaction(() => {
      this.draftAt(key, detail.headSha);
      pullReviews.update(this.db, key, { baseCommit: mergeBase });
    });
    const same = conversation.agent === reviewer.agent && conversation.model === reviewer.model && conversation.effort === reviewer.effort && conversation.fastMode === reviewer.fastMode;
    if (!same) this.options.threads.update(conversation.id, { agent: reviewer.agent, model: reviewer.model, effort: reviewer.effort, fastMode: reviewer.fastMode });
    if ((conversation.orclingId ?? null) !== reviewer.orclingId) threads.update(this.db, conversation.id, { orclingId: reviewer.orclingId });
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
    const at = await this.repository(key.projectId);
    const cloud = this.drafts(key.projectId);
    const review = cloud ? await cloud.get(key) : pullReviews.get(this.db, key);
    if (review?.threadId && this.options.runs.threadActivity(review.threadId) !== "idle") throw new Error("A model is still reviewing. Wait for it to finish, or stop it, before posting.");
    const comments = review?.comments ?? [];
    if (event !== "approve" && !summary.trim() && comments.length === 0) throw new Error("Write a summary or add a comment before posting.");
    const detail = await this.github.get(at, key.number);
    // Comments post against the commit they were written on; a review without any is about the head as it is now.
    const commitId = review && comments.length > 0 ? review.commitId : detail.headSha;
    const submission = { commitId, event, body: summary, comments };
    const posted =
      input.as === "app"
        ? await this.options.reviewerApp.submitReview(detail.url, { ...submission, body: await this.signed(review, summary) })
        : await this.github.submitReview(typeof at === "string" ? at : this.options.dataDir, detail.url, submission);
    // What was posted leaves the draft, wherever it is kept; an edit made while it posted stays.
    if (cloud && review) await cloud.posted(key, review);
    this.db.transaction(() => {
      if (review && !cloud) pullReviews.clearPosted(this.db, key, review);
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
   * The body a review posted by the app carries: which models and Orclings drafted it, then
   * the summary. The app is one name on GitHub, so the reviewers are named here.
   */
  private async signed(review: PullRequestReview | null, summary: string): Promise<string> {
    const authors = new Map<string, DraftAuthor>();
    const conversation = review?.threadId ? threads.get(this.db, review.threadId) : null;
    const add = (author: DraftAuthor) => authors.set(`${author.agent}:${author.model}:${author.orclingId ?? ""}`, author);
    if (conversation) add({ agent: conversation.agent, model: conversation.model, orclingId: conversation.orclingId ?? null });
    for (const comment of review?.comments ?? []) if (comment.author) add(comment.author);
    if (authors.size === 0) return summary;
    const names = new Set(await Promise.all([...authors.values()].map((author) => this.reviewerName(author))));
    const line = `Review by ${new Intl.ListFormat("en", { type: "conjunction" }).format([...names])}.`;
    return summary.trim() ? `${line}\n\n${summary}` : line;
  }

  /** A model by the name the model picker shows, falling back to its ID or harness, after the Orcling that ran it. */
  private async reviewerName(author: DraftAuthor): Promise<string> {
    const models = await this.options.runs.models(author.agent).catch(() => []);
    const listed = models.find((model) => model.id === author.model)?.label;
    const model = listed ?? author.model ?? (isHarnessId(author.agent) ? harnessName(author.agent) : author.agent);
    const orcling = author.orclingId ? orclings.get(this.db, author.orclingId) : null;
    return orcling ? `${orcling.name} (${model})` : model;
  }

  /** What a conversation reviewing a pull request is told on every turn; null for any other conversation. */
  brief(thread: Thread): string | null {
    const review = pullReviews.forThread(this.db, thread.id);
    if (!review) return null;
    return [
      `This conversation reviews GitHub pull request #${review.number} for the user. Its code is checked out in your working folder at commit ${(thread.baseSha ?? "").slice(0, 12)}, on no branch. Its changes start from commit ${(review.baseCommit ?? "").slice(0, 12)}.`,
      "Read the changes with pull_request_diff, and the surrounding code in the checkout as needed. Look for bugs, security problems, data loss, races, missing error handling and missing tests, and for code that will be hard to change. Skip style points a formatter or linter would catch.",
      "Record each finding with pull_request_comment on the changed line it is about: one finding per comment, saying what is wrong, why it matters and a concrete fix. Finish with pull_request_summary, a short overall assessment.",
      "Read the draft as it stands with pull_request_draft, the user's own comments included. When the user asks, or a finding no longer holds, change what a comment says with pull_request_edit_comment and remove one with pull_request_delete_comment.",
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
      draft: async (runId) => agentDraft(this.requireReview(runId).review),
      comment: async (runId, comment) => {
        const { review, run, head } = this.requireCurrent(runId);
        const file = patchFiles(await this.reviewDiff(review.projectId, review.baseCommit, head)).find((entry) => entry.path === comment.path);
        if (!file) throw new Error(`${comment.path} is not changed in this pull request. Comment on a file pull_request_diff shows.`);
        const anchor = agentAnchor(file.chunk, comment);
        const added = pullReviews.addComment(this.db, review, {
          path: comment.path,
          ...anchor,
          body: comment.body,
          author: { agent: run.agent, model: run.model, ...(run.orclingId ? { orclingId: run.orclingId } : {}) },
        });
        this.changed();
        return `Draft comment saved on ${reviewCommentPlace(added)}.`;
      },
      editComment: async (runId, id, body) => {
        const edited = pullReviews.editComment(this.db, this.requireReview(runId).review, id, body);
        if (!edited) throw new Error(NO_DRAFT_COMMENT);
        this.changed();
        return `Draft comment on ${reviewCommentPlace(edited)} changed.`;
      },
      deleteComment: async (runId, id) => {
        if (!pullReviews.removeComment(this.db, this.requireReview(runId).review, id)) throw new Error(NO_DRAFT_COMMENT);
        this.changed();
        return "Draft comment removed.";
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

  /** The project's folder on this Mac, which a review drafts on. */
  private project(projectId: string): Project {
    if (projectId === WORKSPACE_ID) throw new Error("Workspace has no pull requests. Choose a project.");
    const project = projects.get(this.db, projectId);
    if (project) return project;
    throw new Error(this.cloud(projectId) ? PULL_REVIEW_NEEDS_FOLDER : `project ${projectId} not found`);
  }

  /** A project OpenOrc Cloud has and this Mac does not; null for any other. */
  private cloud(projectId: string): Project | null {
    if (projectId === WORKSPACE_ID || projects.get(this.db, projectId)) return null;
    return this.options.cloudProject?.(projectId) ?? null;
  }

  /** Where gh reads a project's pull requests: its folder on this Mac, or, for a project only OpenOrc Cloud has, its name on GitHub. */
  private async repository(projectId: string): Promise<PullsAt> {
    const cloud = this.cloud(projectId);
    const at = cloud ? { repo: cloudRepository(cloud) } : this.project(projectId).rootPath;
    await this.assertGh();
    return at;
  }

  private async assertGh(): Promise<void> {
    if (!(await this.options.system.info()).gh.installed) throw new Error("The GitHub CLI (gh) isn't installed. Install it, then sign in with gh auth login.");
  }

  private changed(): void {
    this.options.invalidate(["pull-reviews"]);
  }
}
