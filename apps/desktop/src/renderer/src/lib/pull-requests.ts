import {
  harnessName,
  isHarnessId,
  type ModelExecutionSettings,
  type ModelOption,
  type Orcling,
  type PullRequestDraftComment,
  type PullRequestFilter,
  type PullRequestReviewAuthor,
  type PullRequestReviewDecision,
  type PullRequestSummary,
  type ReviewComment,
} from "@openorc/protocol";
import { orclingById } from "./orclings";
import type { ModelChoice } from "@openorc/client";

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
/** The state's dot beside its word: open is the ok tone, merged full ink, closed the bad tone, a draft faint. */
export const pullRequestDot: Record<PullRequestTone, "ok" | "muted" | "live" | "bad"> = { open: "ok", draft: "muted", merged: "live", closed: "bad" };

export const reviewDecisionLabel: Record<PullRequestReviewDecision, { label: string; tone: "ok" | "warn" | "muted" }> = {
  approved: { label: "Approved", tone: "ok" },
  changes_requested: { label: "Changes requested", tone: "warn" },
  review_required: { label: "Review required", tone: "muted" },
};

/** What a pull request's row says of it, as a dot and a word. Amber only when the next move is the person's. */
export type PullStatus =
  | { kind: "word"; word: string; tone: "attention" | "ok" | "bad" | "live" | "muted" }
  /** A model or an Orcling is drafting a review of it now, by the name its reviewer goes by. */
  | { kind: "reviewing"; who: string };

/** The next move on a pull request, when it is the person's and the app can make it. */
export type PullMove = { kind: "review" } | { kind: "finish" } | { kind: "open-thread"; threadId: string };

/** What the page knows about a pull request beyond GitHub's summary. */
export interface PullContext {
  /** GitHub asks the person to review it. */
  askedOfYou: boolean;
  /** The person opened it. */
  yours: boolean;
  /** Draft comments waiting on this Mac to be posted. */
  draftComments: number;
  /** Who is drafting its review now, while a model or an Orcling does. */
  reviewing: string | null;
  /** The thread that opened it, when it is at rest; a thread still working is not a place to act yet. */
  restingThread: string | null;
}

export interface PullRow {
  status: PullStatus;
  move: PullMove | null;
  /** The next move is the person's: such rows lead their group and are counted on its label. */
  yourMove: boolean;
}

/** One pull request's status and move, from what GitHub and this Mac say. A move the app cannot make is never offered. */
export function pullRow(pull: Pick<PullRequestSummary, "state" | "isDraft" | "reviewDecision">, context: PullContext): PullRow {
  const at = (word: string, tone: Extract<PullStatus, { kind: "word" }>["tone"], move: PullMove | null = null, yourMove = false): PullRow => ({ status: { kind: "word", word, tone }, move, yourMove });
  if (pull.state === "merged") return at("Merged", "live");
  if (pull.state === "closed") return at("Closed", "bad");
  if (context.reviewing) return { status: { kind: "reviewing", who: context.reviewing }, move: null, yourMove: false };
  if (!context.yours && context.draftComments > 0) return at(`${context.draftComments} draft ${context.draftComments === 1 ? "comment" : "comments"}`, "attention", { kind: "finish" }, true);
  if (context.askedOfYou) return at("Review required", "attention", { kind: "review" }, true);
  if (context.yours && pull.reviewDecision === "changes_requested")
    return at("Changes requested", "attention", context.restingThread ? { kind: "open-thread", threadId: context.restingThread } : null, true);
  if (pull.isDraft) return at("Draft", "muted");
  if (pull.reviewDecision === "approved") return at("Approved", "ok");
  if (pull.reviewDecision === "changes_requested") return at("Changes requested", "muted");
  if (pull.reviewDecision === "review_required") return at("Review required", "muted");
  return at("Open", "muted");
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

/** What a review run needs from a picker choice; null for a model no harness can run. */
export function reviewSettings(choice: ModelChoice | null): ModelExecutionSettings | null {
  if (!choice || !isHarnessId(choice.agent)) return null;
  return { agent: choice.agent, model: choice.model, effort: choice.effort, fastMode: Boolean(choice.fastMode) };
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

/** The reviewing model's summary, while the summary being written doesn't include it yet. */
export function offeredSummary(summary: string, modelSummary: string | null | undefined): string | null {
  const offered = modelSummary?.trim();
  return offered && !summary.includes(offered) ? offered : null;
}

/** The summary with the model's added below it. */
export function withModelSummary(summary: string, modelSummary: string): string {
  return summary.trim() ? `${summary.trimEnd()}\n\n${modelSummary}` : modelSummary;
}
