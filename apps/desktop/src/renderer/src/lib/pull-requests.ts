import {
  GitHubLogin,
  PullRequestNarrowing as PullRequestNarrowingSchema,
  PullRequestStateFilter as PullRequestStateFilterSchema,
  harnessName,
  isHarnessId,
  type ModelOption,
  type Orcling,
  type PullRequestDraftComment,
  type PullRequestChoice,
  type PullRequestMissing,
  type PullRequestNarrowing,
  type PullRequestReviewAuthor,
  type PullRequestReviewFilter,
  type PullRequestSort,
  type PullRequestStateFilter,
  type PullRequestReviewDecision,
  type PullRequestSummary,
  type ReviewComment,
} from "@openorc/protocol";
import { orclingById } from "./orclings";
import type { ModelChoice } from "@openorc/client";

/** The state tabs: open pull requests (drafts among them), drafts alone, merged, closed without merging, and all. */
export const stateTabs: readonly { value: PullRequestStateFilter; label: string; empty: string }[] = [
  { value: "open", label: "Open", empty: "No open pull requests" },
  { value: "draft", label: "Drafts", empty: "No drafts" },
  { value: "merged", label: "Merged", empty: "Nothing merged" },
  { value: "closed", label: "Closed", empty: "Nothing closed without merging" },
  { value: "any", label: "All", empty: "No pull requests" },
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

export const reviewDecisionLabel: Record<PullRequestReviewDecision, { label: string; tone: "ok" | "warn" | "muted" }> = {
  approved: { label: "Approved", tone: "ok" },
  changes_requested: { label: "Changes requested", tone: "warn" },
  review_required: { label: "Review required", tone: "muted" },
};

/** Every word must match the title, number, author or either branch. */
export function matchesPullRequest(pull: PullRequestSummary, query: string): boolean {
  const haystack = `${pull.title} #${pull.number} ${pull.author} ${pull.headRefName} ${pull.baseRefName}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/**
 * What the filter bar is set to, as GitHub's: any of these authors, all of these labels, one assignee, milestone,
 * project and review state, what must be missing, and the order.
 */
export interface PullRequestFilters {
  authors: string[];
  labels: string[];
  /** A login, or `@me`. */
  assignee: string | null;
  milestone: string | null;
  /** `owner/number`. */
  project: string | null;
  review: PullRequestReviewFilter | null;
  missing: PullRequestMissing[];
  sort: PullRequestSort;
}

export const noPullRequestFilters: PullRequestFilters = { authors: [], labels: [], assignee: null, milestone: null, project: null, review: null, missing: [], sort: "newest" };

/** GitHub's Reviews menu, in its order. */
export const reviewFilterOptions: readonly { value: PullRequestReviewFilter; label: string }[] = [
  { value: "none", label: "No reviews" },
  { value: "required", label: "Review required" },
  { value: "approved", label: "Approved review" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "reviewed_by_you", label: "Reviewed by you" },
  { value: "not_reviewed_by_you", label: "Not reviewed by you" },
  { value: "awaiting_you", label: "Awaiting review from you" },
  { value: "awaiting_you_or_team", label: "Awaiting review from you or your team" },
];

/** GitHub's Sort menu: the orders by name, then the reactions, which it draws as a row of emoji. */
export const sortOptions: readonly { value: PullRequestSort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "most_commented", label: "Most commented" },
  { value: "least_commented", label: "Least commented" },
  { value: "recently_updated", label: "Recently updated" },
  { value: "least_recently_updated", label: "Least recently updated" },
  { value: "best_match", label: "Best match" },
];

export const reactionSortOptions: readonly { value: PullRequestSort; emoji: string; label: string }[] = [
  { value: "reactions_thumbs_up", emoji: "👍", label: "Most thumbs up" },
  { value: "reactions_thumbs_down", emoji: "👎", label: "Most thumbs down" },
  { value: "reactions_laugh", emoji: "😄", label: "Most laughs" },
  { value: "reactions_hooray", emoji: "🎉", label: "Most hoorays" },
  { value: "reactions_confused", emoji: "😕", label: "Most confused" },
  { value: "reactions_heart", emoji: "❤️", label: "Most hearts" },
  { value: "reactions_rocket", emoji: "🚀", label: "Most rockets" },
  { value: "reactions_eyes", emoji: "👀", label: "Most eyes" },
];

/** The order's name, or null while newest first, the order every list starts in. */
export function sortLabel(sort: PullRequestSort): string | null {
  if (sort === "newest") return null;
  return sortOptions.find((option) => option.value === sort)?.label ?? reactionSortOptions.find((option) => option.value === sort)!.label;
}

/** What a list asks gh to narrow by, and what storage keeps of its filters: only what is set. */
export function pullRequestNarrowing(filters: PullRequestFilters): PullRequestNarrowing {
  return {
    ...(filters.authors.length > 0 ? { authors: filters.authors } : {}),
    ...(filters.labels.length > 0 ? { labels: filters.labels } : {}),
    ...(filters.assignee ? { assignee: filters.assignee } : {}),
    ...(filters.milestone ? { milestone: filters.milestone } : {}),
    ...(filters.project ? { project: filters.project } : {}),
    ...(filters.review ? { review: filters.review } : {}),
    ...(filters.missing.length > 0 ? { missing: filters.missing } : {}),
    ...(filters.sort !== "newest" ? { sort: filters.sort } : {}),
  };
}

function filtersOf(narrowing: PullRequestNarrowing): PullRequestFilters {
  return {
    authors: narrowing.authors ?? [],
    labels: narrowing.labels ?? [],
    assignee: narrowing.assignee ?? null,
    milestone: narrowing.milestone ?? null,
    project: narrowing.project ?? null,
    review: narrowing.review ?? null,
    missing: narrowing.missing ?? [],
    sort: narrowing.sort ?? "newest",
  };
}

/** Filters read from storage, or none when they no longer make sense. */
function readFilters(value: unknown): PullRequestFilters | null {
  const parsed = PullRequestNarrowingSchema.safeParse(value);
  return parsed.success ? filtersOf(parsed.data) : null;
}

export function hasPullRequestFilters(filters: PullRequestFilters): boolean {
  return Object.keys(pullRequestNarrowing(filters)).length > 0;
}

/** Whether a missing-thing filter is on. */
export const isMissing = (filters: PullRequestFilters, what: PullRequestMissing) => filters.missing.includes(what);

/** The filters with something required to be missing, or no longer; asking for none clears what would contradict it. */
export function withMissing(filters: PullRequestFilters, what: PullRequestMissing, on: boolean): PullRequestFilters {
  const missing = filters.missing.filter((entry) => entry !== what);
  if (!on) return { ...filters, missing };
  const cleared = { label: { labels: [] }, assignee: { assignee: null }, milestone: { milestone: null } }[what];
  return { ...filters, ...cleared, missing: [...missing, what] };
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/** The names in every list, once each regardless of case, by name. The first spelling met is kept. */
function distinctNames(...lists: (readonly string[])[]): string[] {
  const names = new Map<string, string>();
  for (const name of lists.flat()) if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  return [...names.values()].sort(byName);
}

/** Who the author filter offers: the people chosen, and everyone with a pull request in the lists. */
export function authorChoices(picked: readonly string[], pulls: readonly PullRequestSummary[]): string[] {
  return distinctNames(
    picked,
    pulls.map((pull) => pull.author),
  );
}

/** The labels the label filter offers: the chosen ones, every label the repositories have, and any a pull request carries. */
export function labelChoices(picked: readonly string[], repositories: readonly PullRequestChoice[], pulls: readonly PullRequestSummary[]): string[] {
  return distinctNames(
    picked,
    repositories.map((label) => label.value),
    pulls.flatMap((pull) => pull.labels.map((label) => label.name)),
  );
}

/** One filter's choices from every repository in view: each value once, in the order the first repository gave it. */
export function mergedChoices(lists: readonly (readonly PullRequestChoice[])[]): PullRequestChoice[] {
  const byValue = new Map<string, PullRequestChoice>();
  for (const choice of lists.flat()) if (!byValue.has(choice.value.toLowerCase())) byValue.set(choice.value.toLowerCase(), choice);
  return [...byValue.values()];
}

/** A login typed into the author filter, without its @, when GitHub could have such an account. */
export function typedLogin(input: string): string | null {
  const login = input.trim().replace(/^@/, "");
  return login && GitHubLogin.safeParse(login).success ? login : null;
}

const FILTERS_KEY = "openorc.pull-filters";

/** The filters last set, so the people and labels you follow are there the next time the page opens. */
export function readPullRequestFilters(): PullRequestFilters {
  try {
    return readFilters(JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "{}")) ?? noPullRequestFilters;
  } catch {
    return noPullRequestFilters;
  }
}

export function writePullRequestFilters(filters: PullRequestFilters): void {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(pullRequestNarrowing(filters)));
  } catch {
    // The filters then last for this session only.
  }
}

/** Everything a list shows: its state, its filters and order, the words searched for, and the view it started from. */
export interface PullRequestListState {
  state: PullRequestStateFilter;
  filters: PullRequestFilters;
  query: string;
  /** The view the list was opened as. Changing its filters edits it until they are saved or reverted. */
  base: string;
}

/**
 * A list saved under a name, which one click brings back. Its state is where it opens; moving between the state tabs
 * doesn't edit it. The built-in views can't be renamed, saved over or deleted.
 */
export interface PullRequestView extends Omit<PullRequestListState, "base"> {
  id: string;
  name: string;
  builtIn?: boolean;
}

const view = (id: string, name: string, filters: Partial<PullRequestFilters>): PullRequestView => ({
  id,
  name,
  state: "open",
  filters: { ...noPullRequestFilters, ...filters },
  query: "",
  builtIn: true,
});

/** Every open pull request, the ones waiting on you or a team you're in, and your own: what the old tabs showed. */
export const builtInViews: readonly PullRequestView[] = [
  view("builtin-all", "All pull requests", {}),
  view("builtin-review", "Needs my review", { review: "awaiting_you_or_team" }),
  view("builtin-mine", "Mine", { authors: ["@me"] }),
];

const VIEWS_KEY = "openorc.pull-views";
export const VIEW_NAME_LIMIT = 60;

/** A list's state read from storage, or null when it no longer makes sense. */
function readState(value: unknown): Omit<PullRequestListState, "base"> | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const filters = readFilters(entry.filters);
  if (!filters) return null;
  const query = typeof entry.query === "string" ? entry.query : "";
  const state = PullRequestStateFilterSchema.safeParse(entry.state);
  return state.success ? { state: state.data, filters, query } : null;
}

/** A list's state as storage keeps it: only the filters that are set. */
const storedState = (state: Omit<PullRequestListState, "base">) => ({ state: state.state, filters: pullRequestNarrowing(state.filters), query: state.query });

/** A view read from storage, or null when it no longer makes sense. */
function readView(value: unknown): PullRequestView | null {
  const state = readState(value);
  const entry = value as Record<string, unknown> | null;
  const name = typeof entry?.name === "string" ? entry.name.trim().slice(0, VIEW_NAME_LIMIT) : "";
  if (!state || typeof entry?.id !== "string" || !name) return null;
  return { ...state, id: entry.id, name };
}

/** The views you saved, after the built-in ones. */
export function readPullRequestViews(): PullRequestView[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "[]");
    if (!Array.isArray(saved)) return [];
    return saved.map(readView).filter((entry): entry is PullRequestView => entry !== null && !builtInViews.some((builtIn) => builtIn.id === entry.id));
  } catch {
    return [];
  }
}

export function writePullRequestViews(views: readonly PullRequestView[]): void {
  try {
    const saved = views.filter((entry) => !entry.builtIn).map((entry) => ({ id: entry.id, name: entry.name, ...storedState(entry) }));
    localStorage.setItem(VIEWS_KEY, JSON.stringify(saved));
  } catch {
    // The views then last for this session only.
  }
}

const DEFAULT_VIEW_KEY = "openorc.pull-default-view";

/** Calls `changed` when another window saves, deletes or defaults a view. Returns the way to stop. */
export function watchPullRequestViews(changed: () => void): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key === null || event.key === VIEWS_KEY || event.key === DEFAULT_VIEW_KEY) changed();
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

/** The view the page opens with when the app starts, if one was chosen. A built-in view can be the default too. */
export function readDefaultViewId(): string | null {
  try {
    return localStorage.getItem(DEFAULT_VIEW_KEY);
  } catch {
    return null;
  }
}

export function writeDefaultViewId(id: string | null): void {
  try {
    if (id) localStorage.setItem(DEFAULT_VIEW_KEY, id);
    else localStorage.removeItem(DEFAULT_VIEW_KEY);
  } catch {
    // The default then lasts for this session only.
  }
}

/** Where the list was left in this window, which lasts until the app closes. */
const LEFT_AT_KEY = "openorc.pull-list";

export function rememberListState(state: PullRequestListState): void {
  try {
    sessionStorage.setItem(LEFT_AT_KEY, JSON.stringify({ ...storedState(state), base: state.base }));
  } catch {
    // Coming back then starts over.
  }
}

function leftAt(): PullRequestListState | null {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(LEFT_AT_KEY) ?? "null");
    const state = readState(saved);
    const base = (saved as { base?: unknown } | null)?.base;
    return state ? { ...state, base: typeof base === "string" ? base : builtInViews[0]!.id } : null;
  } catch {
    return null;
  }
}

/** The view a list starts as. */
export function listOf(entry: PullRequestView): PullRequestListState {
  return { state: entry.state, filters: entry.filters, query: entry.query, base: entry.id };
}

/**
 * Where the list starts: as it was left when coming back to it, so opening a pull request loses nothing. When the app
 * has just started, the default view if one was chosen, otherwise every open pull request with the filters last set.
 */
export function startingListState(): PullRequestListState {
  const left = leftAt();
  if (left) return left;
  const id = readDefaultViewId();
  const chosen = id ? [...builtInViews, ...readPullRequestViews()].find((entry) => entry.id === id) : undefined;
  if (chosen) return listOf(chosen);
  return { state: "open", filters: readPullRequestFilters(), query: "", base: builtInViews[0]!.id };
}

/** A list's filters, order and search written so two that ask the same compare equal, whatever order things were picked in. */
function filtersKey(state: Pick<PullRequestListState, "filters" | "query">): string {
  const narrowing = Object.entries(pullRequestNarrowing(state.filters))
    .map(([key, value]) => [key, Array.isArray(value) ? value.map((entry) => entry.toLowerCase()).sort() : value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ query: state.query.trim().toLowerCase(), narrowing });
}

/**
 * The view the list shows right now: the one it started as while its filters still match, else any whose filters do.
 * The state tab is left out, so moving between Open and Merged doesn't edit a view.
 */
export function activeView(views: readonly PullRequestView[], state: PullRequestListState): PullRequestView | null {
  const key = filtersKey(state);
  const matching = views.filter((entry) => filtersKey(entry) === key);
  return matching.find((entry) => entry.id === state.base) ?? matching[0] ?? null;
}

/** A name to start from when saving: who and what the list is narrowed to, its order, or its state. */
export function suggestedViewName(state: Omit<PullRequestListState, "base">): string {
  const { filters } = state;
  const people = filters.authors.map((author) => (author === "@me" ? "mine" : author));
  const assignee = filters.assignee === "@me" ? "Assigned to you" : filters.assignee;
  const parts = [
    people.join(", "),
    filters.labels.join(", "),
    filters.milestone,
    reviewFilterOptions.find((option) => option.value === filters.review)?.label,
    assignee,
    sortLabel(filters.sort),
    state.query.trim(),
  ].filter(Boolean);
  const tab = stateTabs.find((option) => option.value === state.state)!.label;
  return (parts.length > 0 ? parts.join(" · ") : tab).slice(0, VIEW_NAME_LIMIT);
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

/** The reviewing model's summary, while the summary being written doesn't include it yet. */
export function offeredSummary(summary: string, modelSummary: string | null | undefined): string | null {
  const offered = modelSummary?.trim();
  return offered && !summary.includes(offered) ? offered : null;
}

/** The summary with the model's added below it. */
export function withModelSummary(summary: string, modelSummary: string): string {
  return summary.trim() ? `${summary.trimEnd()}\n\n${modelSummary}` : modelSummary;
}
