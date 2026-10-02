import {
  harnessName,
  isHarnessId,
  type ModelOption,
  type Orcling,
  type PullRequestBranches,
  type PullRequestDraftComment,
  type PullRequestFilter,
  type PullRequestReviewAuthor,
  type PullRequestReviewDecision,
  type PullRequestSummary,
  type ReviewComment,
} from "@openorc/protocol";
import { orclingById } from "./orclings";
import type { ModelChoice } from "./model-picker-selection";

export const pullRequestFilters: readonly { value: PullRequestFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "review_requested", label: "To review" },
  { value: "authored", label: "Yours" },
  { value: "closed", label: "Closed" },
];

/** Whether a project's remote is on github.com, where every project in the list can be asked about. */
export function onGitHub(remote: string | null): boolean {
  return remote !== null && /github\.com[:/]/i.test(remote);
}

export type PullRequestTone = "open" | "draft" | "merged" | "closed";

export function pullRequestTone(pull: Pick<PullRequestSummary, "state" | "isDraft">): PullRequestTone {
  if (pull.state === "open") return pull.isDraft ? "draft" : "open";
  return pull.state;
}

export const pullRequestToneLabel: Record<PullRequestTone, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };
export const pullRequestToneClass: Record<PullRequestTone, string> = { open: "text-ok", draft: "text-ink-3", merged: "text-accent-ink", closed: "text-bad" };

export const reviewDecisionLabel: Record<PullRequestReviewDecision, { label: string; tone: "ok" | "warn" | "muted" }> = {
  approved: { label: "Approved", tone: "ok" },
  changes_requested: { label: "Changes requested", tone: "warn" },
  review_required: { label: "Review required", tone: "muted" },
};

/** The number in a pull request's URL, or null for anything else. */
export function pullRequestNumber(url: string | null): number | null {
  const match = url ? /\/pull\/(\d+)(?:[/?#]|$)/.exec(url) : null;
  return match ? Number(match[1]) : null;
}

/** Every word must match the title, number, author or either branch. */
export function matchesPullRequest(pull: PullRequestSummary, query: string): boolean {
  const haystack = `${pull.title} #${pull.number} ${pull.author} ${pull.headRefName} ${pull.baseRefName}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** A draft comment in the shape the diff viewer draws. It belongs to no conversation, so nothing marks it sent. */
export function diffComment(comment: PullRequestDraftComment): ReviewComment {
  return { ...comment, threadId: null, taskId: null, snapshotId: null, sentInRunId: null, sentMessageId: null };
}

/** Who wrote a draft comment: you, or the model that reviewed by the name the model picker shows, after the Orcling that ran it. */
export function draftAuthor(author: PullRequestDraftComment["author"], models: ModelOption[] | undefined, orclings: readonly Orcling[] = []): string {
  if (!author) return "You";
  const listed = models?.find((option) => option.agent === author.agent && option.id === author.model)?.label;
  const model = listed ?? author.model ?? (isHarnessId(author.agent) ? harnessName(author.agent) : author.agent);
  const orcling = orclingById(orclings, author.orclingId);
  return orcling ? `${orcling.name} - ${model}` : model;
}

/** Who drafts the review: you alone, or a model or Orcling you pick. */
export interface PullReviewer {
  kind: "you" | "model";
  choice: ModelChoice | null;
  /** An Orcling that reviews with its own model; the choice then shows that model. */
  orclingId?: string | null;
}

const REVIEWER_KEY = "openorc.pull-reviewer";

export function readPullReviewer(): PullReviewer {
  try {
    const saved = JSON.parse(localStorage.getItem(REVIEWER_KEY) ?? "null") as PullReviewer | null;
    if (saved && (saved.kind === "you" || saved.kind === "model")) return { kind: saved.kind, choice: saved.choice ?? null, orclingId: typeof saved.orclingId === "string" ? saved.orclingId : null };
  } catch {
    // An unreadable choice starts over.
  }
  return { kind: "you", choice: null };
}

export function writePullReviewer(reviewer: PullReviewer): void {
  try {
    localStorage.setItem(REVIEWER_KEY, JSON.stringify(reviewer));
  } catch {
    // The choice then lasts for this session only.
  }
}

const AUTHOR_KEY = "openorc.pull-review-author";

/** Who the last review posted as, so the next one starts there. */
export function readReviewAuthor(): PullRequestReviewAuthor | null {
  try {
    const saved = localStorage.getItem(AUTHOR_KEY);
    return saved === "you" || saved === "app" ? saved : null;
  } catch {
    return null;
  }
}

export function writeReviewAuthor(author: PullRequestReviewAuthor): void {
  try {
    localStorage.setItem(AUTHOR_KEY, author);
  } catch {
    // The choice then lasts for this session only.
  }
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

/** The reviewing model's summary, while the summary being written doesn't include it yet. */
export function offeredSummary(summary: string, modelSummary: string | null | undefined): string | null {
  const offered = modelSummary?.trim();
  return offered && !summary.includes(offered) ? offered : null;
}

/** The summary with the model's added below it. */
export function withModelSummary(summary: string, modelSummary: string): string {
  return summary.trim() ? `${summary.trimEnd()}\n\n${modelSummary}` : modelSummary;
}
