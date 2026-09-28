import { z } from "zod";
import type { AgentKind } from "./events.js";
import { ModelExecutionSettings } from "./orchestration.js";

/** Which pull requests a list shows: open ones, those waiting on your review, your own, or closed and merged ones. */
export const PullRequestFilter = z.enum(["open", "review_requested", "authored", "closed"]);
export type PullRequestFilter = z.infer<typeof PullRequestFilter>;

export type PullRequestState = "open" | "closed" | "merged";
export type PullRequestReviewDecision = "approved" | "changes_requested" | "review_required";

/** A pull request as a list shows it, read from GitHub through the user's own gh. */
export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  /** The author's GitHub login. */
  author: string;
  state: PullRequestState;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  createdAt: number;
  updatedAt: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: PullRequestReviewDecision | null;
  labels: string[];
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string;
  headSha: string;
  baseSha: string;
  /** The gh account that posts reviews; null when gh could not say. */
  viewer: string | null;
}

export type PullRequestSide = "old" | "new";

/** A comment in a draft review, on one line or a range of lines in a single hunk, as GitHub's review comments are. */
export interface PullRequestDraftComment {
  id: string;
  path: string;
  startLine: number | null;
  startSide: PullRequestSide | null;
  line: number;
  side: PullRequestSide;
  /** What the commented lines said when the comment was written, so a later push shows it as outdated. */
  lineText: string | null;
  body: string;
  /** The agent and model that wrote it; null for your own comments. */
  author: { agent: AgentKind; model: string | null } | null;
  createdAt: number;
}

/**
 * A pull request's review in OpenOrc: the draft, which reaches GitHub only when
 * submitted, and the conversation that reviews it round after round.
 */
export interface PullRequestReview {
  projectId: string;
  number: number;
  /** The pull request commit the comments were written against. The review posts against it. */
  commitId: string;
  summary: string;
  /** The reviewing model's latest summary. It fills `summary` until the user writes their own, then waits beside it. */
  modelSummary: string | null;
  /** The conversation where a model reviews this pull request, once one was started. */
  threadId: string | null;
  /** Where that model's checkout says the changes start: the commit the pull request left its base branch at. */
  baseCommit: string | null;
  comments: PullRequestDraftComment[];
  updatedAt: number;
}

export const PullRequestReviewEvent = z.enum(["comment", "approve", "request_changes"]);
export type PullRequestReviewEvent = z.infer<typeof PullRequestReviewEvent>;

/** Who a review posts as on GitHub: your gh account, or your reviewer app. */
export const PullRequestReviewAuthor = z.enum(["you", "app"]);
export type PullRequestReviewAuthor = z.infer<typeof PullRequestReviewAuthor>;

/** The GitHub App reviews can post as, and how setting one up stands. */
export interface ReviewerAppStatus {
  app: {
    name: string;
    slug: string;
    /** The account that owns the app. */
    owner: string;
    /** How the app's reviews are signed on GitHub. */
    login: string;
    /** Where to choose the repositories it can review. */
    installUrl: string;
    /** Whether it may approve pull requests, which can satisfy required reviews. */
    allowApprove: boolean;
  } | null;
  /** The page that continues setup, while OpenOrc waits for GitHub to create the app. */
  setupUrl: string | null;
  /** Why the last setup failed. */
  error: string | null;
}

/** The branches of the repository gh opens pull requests in, as a new pull request's target picker lists them. */
export interface PullRequestBranches {
  /** GitHub's default branch first, then the rest by name. A long list stops after the first thousand. */
  branches: string[];
  defaultBranch: string | null;
}

/** Whether Git accepts `name` as a branch, following `git check-ref-format --branch`. */
function isBranchName(name: string): boolean {
  if (name === "@" || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (/[\s~^:?*[\\\p{Cc}]|\.\.|@\{|\/\//u.test(name)) return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

export const BranchName = z.string().min(1).max(255).refine(isBranchName, "Not a branch name.");

const PullRequestRef = { projectId: z.string().min(1), number: z.number().int().positive() };
const CommitId = z.string().regex(/^[0-9a-f]{40}$/);
const Side = z.enum(["old", "new"]);
const REVIEW_TEXT_LIMIT = 65_536;

export const pullRequestRpcParams = {
  "pulls.list": z.object({ projectId: z.string().min(1), filter: PullRequestFilter }).strict(),
  /** The branches a new pull request can target, with `prefer` among them when GitHub has it. */
  "pulls.branches": z.object({ projectId: z.string().min(1), prefer: BranchName.optional() }).strict(),
  "pulls.get": z.object(PullRequestRef).strict(),
  /** The pull request's changes as one unified diff, as GitHub shows them, and the head commit they are for. */
  "pulls.diff": z.object(PullRequestRef).strict(),
  /** The local draft review, or null when there is none. */
  "pulls.review.get": z.object(PullRequestRef).strict(),
  /** Adds your comment to the draft. `commitId` is the commit whose diff you commented on. */
  "pulls.review.comment": z
    .object({
      ...PullRequestRef,
      commitId: CommitId,
      path: z.string().min(1),
      startLine: z.number().int().positive().nullable(),
      startSide: Side.nullable(),
      line: z.number().int().positive(),
      side: Side,
      lineText: z.string().nullable(),
      body: z.string().trim().min(1).max(REVIEW_TEXT_LIMIT),
    })
    .strict()
    .refine((input) => (input.startLine === null) === (input.startSide === null), "A range needs a start line and its side."),
  "pulls.review.editComment": z.object({ ...PullRequestRef, id: z.string().min(1), body: z.string().trim().min(1).max(REVIEW_TEXT_LIMIT) }).strict(),
  "pulls.review.removeComment": z.object({ ...PullRequestRef, id: z.string().min(1) }).strict(),
  /** Saves the draft's summary; a draft that does not exist yet starts at `commitId`. */
  "pulls.review.summary": z.object({ ...PullRequestRef, commitId: CommitId, summary: z.string().max(REVIEW_TEXT_LIMIT) }).strict(),
  "pulls.review.discard": z.object(PullRequestRef).strict(),
  /** Starts a model reviewing the pull request in a read-only conversation of its own. */
  "pulls.review.start": z.object({ ...PullRequestRef, reviewer: ModelExecutionSettings }).strict(),
  /** Posts the draft as one GitHub review, as you or as your reviewer app, then clears it. */
  "pulls.review.submit": z.object({ ...PullRequestRef, event: PullRequestReviewEvent, summary: z.string().max(REVIEW_TEXT_LIMIT), as: PullRequestReviewAuthor.default("you") }).strict(),
  "reviewerApp.get": z.object({}).strict(),
  /** Starts creating the app on GitHub. Open the returned page in the browser to continue. */
  "reviewerApp.setup": z.object({}).strict(),
  "reviewerApp.cancelSetup": z.object({}).strict(),
  "reviewerApp.configure": z.object({ allowApprove: z.boolean() }).strict(),
  /** Forgets the app and its key on this device. The app stays on GitHub until it is deleted there. */
  "reviewerApp.remove": z.object({}).strict(),
};

export interface PullRequestRpcResults {
  "pulls.list": PullRequestSummary[];
  "pulls.branches": PullRequestBranches;
  "pulls.get": PullRequestDetail;
  "pulls.diff": { patch: string; headSha: string };
  "pulls.review.get": PullRequestReview | null;
  "pulls.review.comment": PullRequestDraftComment;
  "pulls.review.editComment": PullRequestDraftComment;
  "pulls.review.removeComment": null;
  "pulls.review.summary": null;
  "pulls.review.discard": null;
  "pulls.review.start": { threadId: string };
  "pulls.review.submit": { url: string | null };
  "reviewerApp.get": ReviewerAppStatus;
  "reviewerApp.setup": { url: string };
  "reviewerApp.cancelSetup": null;
  "reviewerApp.configure": null;
  "reviewerApp.remove": null;
}
