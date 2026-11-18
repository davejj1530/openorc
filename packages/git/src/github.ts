import type {
  PullRequestBranches,
  PullRequestCounts,
  PullRequestDetail,
  PullRequestChoice,
  PullRequestChoiceKind,
  PullRequestLabel,
  PullRequestNarrowing,
  PullRequestReviewDecision,
  PullRequestReviewFilter,
  PullRequestSort,
  PullRequestReviewEvent,
  PullRequestSide,
  PullRequestState,
  PullRequestStateFilter,
  PullRequestSummary,
} from "@openorc/protocol";
import { PullRequestProjectRef, SearchName } from "@openorc/protocol";
import os from "node:os";
import { git, run, GitError } from "./exec.js";

/** Runs the user's own gh in a repository and returns what it printed. A failure rejects with a GhError. */
export type GhRunner = (cwd: string, args: string[], input?: string) => Promise<string>;

/** gh exited with an error. `gh api` prints GitHub's error body, which names the actual problem, on stdout. */
export class GhError extends Error {
  constructor(
    readonly stderr: string,
    readonly stdout = "",
  ) {
    super(stderr.trim() || "gh failed");
    this.name = "GhError";
  }
}

const runGh: GhRunner = async (cwd, args, input) => {
  const result = await run("gh", cwd, args, { timeoutMs: 60_000, okCodes: [0, 1], ...(input === undefined ? {} : { input }) });
  if (result.code !== 0) throw new GhError(result.stderr, result.stdout);
  return result.stdout;
};

const SUMMARY_FIELDS = "number,title,url,author,state,isDraft,headRefName,baseRefName,createdAt,updatedAt,additions,deletions,changedFiles,reviewDecision,labels";
const LIST_LIMIT = "50";
/** Labels a filter offers, by name. GitHub's own picker pages; few repositories come near this. */
const LABEL_LIMIT = "500";
/** Reads of a diff before giving up on a pull request that keeps receiving pushes. */
const DIFF_READS = 3;
/** Pages of 100 branches a target picker reads before it stops. */
const BRANCH_PAGES = 10;
/**
 * gh processes the list page's reads run at once in one GitHubPulls. A page of many projects asks for lists, counts and
 * filter choices for each at the same moment; the rest wait their turn rather than all reaching GitHub, and its limits,
 * together.
 */
const GH_PROCESSES = 8;

/** `gh`, with at most `most` of its processes running at once and the rest started in the order they were asked for. */
function limitedGh(gh: GhRunner, most: number): GhRunner {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (cwd, args, input) => {
    if (running >= most) await new Promise<void>((resolve) => waiting.push(resolve));
    else running += 1;
    try {
      return await gh(cwd, args, input);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

/** gh's api asks github.com unless told otherwise whenever more than one host is signed in, so another host is named. */
const hostname = (host: string): string[] => (host === "github.com" ? [] : ["--hostname", host]);

/**
 * Where gh finds a repository's pull requests: a clone's folder on this Mac, or, for a project with no folder here, its
 * `owner/name` on GitHub, which gh is told with `--repo`.
 */
export type PullsAt = string | { repo: string };
const cwdOf = (at: PullsAt): string => (typeof at === "string" ? at : os.homedir());
const repoFlag = (at: PullsAt): string[] => (typeof at === "string" ? [] : ["--repo", at.repo]);

/** A checkout's repository as gh resolves it: `owner/name`, and the host it is on. */
interface Repository {
  name: string;
  host: string;
}

/** The repository in the URL `gh repo view` prints, such as https://github.example.com/acme/app. */
function repositoryAt(url: string): Repository {
  const match = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+?)\/?$/.exec(url.trim());
  if (!match) throw new Error(`gh named no repository here: ${url.trim()}`);
  return { host: match[1]!.toLowerCase(), name: match[2]! };
}

/**
 * The repository's branches by name, a page at a time, with its default branch and, when asked, whether `prefer`
 * exists. GitHub can't sort branches by activity. `{owner}` and `{repo}` are the repository gh opens pull requests in.
 */
const BRANCHES_QUERY = `query($owner: String!, $repo: String!, $after: String, $prefer: String!, $checkPrefer: Boolean!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name }
    preferred: ref(qualifiedName: $prefer) @include(if: $checkPrefer) { name }
    refs(refPrefix: "refs/heads/", first: 100, after: $after, orderBy: { field: ALPHABETICAL, direction: ASC }) {
      nodes { name }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

interface RawBranchPage {
  data: {
    repository: {
      defaultBranchRef: { name: string } | null;
      preferred?: { name: string } | null;
      refs: { nodes: { name: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    };
  };
}

/** The states the repository's own list shows unfiltered, as GitHub names them. It has no drafts alone, so those are a search. */
const plainStates: Partial<Record<PullRequestStateFilter, string>> = { open: "[OPEN]", merged: "[MERGED]", closed: "[CLOSED]", any: "[OPEN, CLOSED, MERGED]" };

/** Each state as search terms: drafts are open, and closed means closed without merging. */
const stateTerms: Record<PullRequestStateFilter, string[]> = {
  open: ["is:open"],
  draft: ["is:open", "draft:true"],
  merged: ["is:merged"],
  closed: ["is:closed", "is:unmerged"],
  any: [],
};

const STATES = Object.keys(stateTerms) as PullRequestStateFilter[];

const reviewTerms: Record<PullRequestReviewFilter, string> = {
  none: "review:none",
  required: "review:required",
  approved: "review:approved",
  changes_requested: "review:changes_requested",
  reviewed_by_you: "reviewed-by:@me",
  not_reviewed_by_you: "-reviewed-by:@me",
  awaiting_you: "user-review-requested:@me",
  awaiting_you_or_team: "review-requested:@me",
};

const sortTerms: Record<PullRequestSort, string> = {
  newest: "sort:created-desc",
  oldest: "sort:created-asc",
  most_commented: "sort:comments-desc",
  least_commented: "sort:comments-asc",
  recently_updated: "sort:updated-desc",
  least_recently_updated: "sort:updated-asc",
  best_match: "sort:relevance-desc",
  reactions_thumbs_up: "sort:reactions-+1-desc",
  reactions_thumbs_down: "sort:reactions--1-desc",
  reactions_laugh: "sort:reactions-smile-desc",
  reactions_hooray: "sort:reactions-tada-desc",
  reactions_confused: "sort:reactions-thinking_face-desc",
  reactions_heart: "sort:reactions-heart-desc",
  reactions_rocket: "sort:reactions-rocket-desc",
  reactions_eyes: "sort:reactions-eyes-desc",
};

/** Whether a list asks for more than its tab: any filter, or an order other than newest first. */
export function isNarrowed(narrowing: PullRequestNarrowing): boolean {
  return Object.entries(narrowing).some(([key, value]) => value !== undefined && !(key === "sort" && value === "newest"));
}

/** Each author once, compared as GitHub compares logins: without regard to case. */
function distinctAuthors(authors: readonly string[]): string[] {
  const seen = new Set<string>();
  return authors.filter((author) => {
    const key = author.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A filtered list of one repository (`owner/name`) as one GitHub search, the way GitHub's filter bar writes it: the
 * authors as alternatives, every label, one of each other filter, what must be missing, then the order. Names are
 * quoted; the schema keeps quotes out of them.
 */
export function searchQuery(repository: string, state: PullRequestStateFilter, narrowing: PullRequestNarrowing): string {
  const authors = distinctAuthors(narrowing.authors ?? []);
  const terms = [
    `repo:${repository}`,
    "is:pr",
    ...stateTerms[state],
    authors.length > 0 ? `(${authors.map((author) => `author:${author}`).join(" OR ")})` : null,
    ...(narrowing.labels ?? []).map((name) => `label:"${name}"`),
    narrowing.assignee ? `assignee:${narrowing.assignee}` : null,
    narrowing.milestone ? `milestone:"${narrowing.milestone}"` : null,
    narrowing.project ? `project:${narrowing.project}` : null,
    narrowing.review ? reviewTerms[narrowing.review] : null,
    ...(narrowing.missing ?? []).map((missing) => `no:${missing}`),
    sortTerms[narrowing.sort ?? "newest"],
  ];
  return terms.filter(Boolean).join(" ");
}

/** The fields a list shows. gh's own list can't count comments: it reads every one, and only the conversation's. */
const LIST_FIELDS = `number title url author { __typename login } state isDraft headRefName baseRefName createdAt updatedAt
        additions deletions changedFiles reviewDecision totalCommentsCount labels(first: 20) { nodes { name color description } }`;

/**
 * The repository's own pull requests in some states. `states` is written into the query as it is, so it is only ever
 * one of `plainStates`, never anything a user typed.
 */
const repositoryQuery = (states: string) => `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: ${states}, first: ${LIST_LIMIT}, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { ${LIST_FIELDS} }
    }
  }
}`;

/**
 * GitHub's advanced search, which takes OR and parentheses, for the fields a list shows. gh's own list can't ask for
 * one author or another: two `author:` terms there mean both.
 */
const SEARCH_QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE_ADVANCED, first: ${LIST_LIMIT}) {
    nodes {
      ... on PullRequest {
        ${LIST_FIELDS}
      }
    }
  }
}`;

/** How many pull requests each state holds, every count its own search in one request. */
const COUNTS_QUERY = `query(${STATES.map((state) => `$${state}: String!`).join(", ")}) {
  ${STATES.map((state) => `${state}: search(query: $${state}, type: ISSUE_ADVANCED, first: 0) { issueCount }`).join("\n  ")}
}`;

/** A pull request as a GraphQL list gives it: its author with their kind, its labels one page of a connection. */
type RawListNode = Omit<RawPullRequest, "author" | "labels"> & {
  author: { __typename: string; login: string } | null;
  labels?: { nodes: RawLabel[] } | null;
  /** GitHub's schema lets this be null; a list shows none then. */
  totalCommentsCount: number | null;
};

/** The author as gh names them: anyone but a user, such as an app, is `app/<login>`, as a search asks for them. */
const listedAuthor = (author: RawListNode["author"]) => (author && author.__typename !== "User" ? { login: `app/${author.login}` } : author);

/** Anything the search finds that isn't a pull request comes back without its fields. */
interface RawSearch {
  data: { search: { nodes: Partial<RawListNode>[] } };
}

interface RawRepositoryPulls {
  data: { repository: { pullRequests: { nodes: RawListNode[] } } };
}

const listedPullRequest = (node: RawListNode): PullRequestSummary => ({
  ...pullRequestSummary({ ...node, author: listedAuthor(node.author), labels: node.labels?.nodes ?? [] }),
  comments: node.totalCommentsCount ?? 0,
});

/** The projects linked to the repository, which GitHub's Projects filter offers. Reading them needs gh's read:project scope. */
const PROJECTS_QUERY = `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    projectsV2(first: 50, orderBy: { field: TITLE, direction: ASC }) {
      nodes { number title owner { ... on Organization { login } ... on User { login } } }
    }
  }
}`;

interface RawProjects {
  data: { repository: { projectsV2: { nodes: { number: number; title: string; owner: { login?: string } }[] } } };
}

const byName = (a: PullRequestChoice, b: PullRequestChoice) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

interface RawPullRequest {
  number: number;
  title: string;
  url: string;
  author: { login: string } | null;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  labels: RawLabel[] | null;
}

interface RawLabel {
  name: string;
  color?: string | null;
  description?: string | null;
}

const label = (raw: RawLabel): PullRequestLabel => ({ name: raw.name, color: raw.color ?? "", description: raw.description ?? "" });

interface RawPullRequestDetail extends RawPullRequest {
  body: string | null;
  headRefOid: string;
  baseRefOid: string;
}

const decisions: Record<string, PullRequestReviewDecision> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "review_required" };

/** A pull request as gh's JSON describes it, in the app's own terms. A deleted account reads as GitHub's "ghost". */
export function pullRequestSummary(raw: RawPullRequest): Omit<PullRequestSummary, "comments"> {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? "ghost",
    state: raw.state.toLowerCase() as PullRequestState,
    isDraft: raw.isDraft,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    createdAt: Date.parse(raw.createdAt),
    updatedAt: Date.parse(raw.updatedAt),
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    reviewDecision: decisions[raw.reviewDecision ?? ""] ?? null,
    labels: (raw.labels ?? []).map(label),
  };
}

/** Where a pull request lives, read from its URL: `https://<host>/<owner>/<repo>/pull/<number>`. */
export function pullRequestRepository(url: string): { host: string; owner: string; repo: string } {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url);
  if (!match) throw new Error(`Not a pull request URL: ${url}`);
  return { host: match[1]!.toLowerCase(), owner: match[2]!, repo: match[3]! };
}

/** A remote URL reduced to host and owner/repo, whichever of the https, ssh or scp forms it uses. Null for a local path. */
export function remoteRepository(url: string): { host: string; path: string } | null {
  const trimmed = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
  const standard = /^[a-z+]+:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  const match = standard ?? scp;
  if (!match) return null;
  return { host: match[1]!.toLowerCase(), path: match[2]!.toLowerCase() };
}

/** The specific reasons in a GitHub API error body, such as "Can not approve your own pull request". */
export function githubErrorReason(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { message?: string; errors?: (string | { message?: string })[] };
    const reasons = (parsed.errors ?? []).map((item) => (typeof item === "string" ? item : item.message)).filter((reason): reason is string => Boolean(reason));
    return reasons.length > 0 ? reasons.join(" ") : (parsed.message ?? null);
  } catch {
    return null;
  }
}

/**
 * Turns gh's failures into what the user can do about them. gh prints several
 * paragraphs for a missing login; the remedy is one sentence.
 */
function ghFailure(error: unknown, subject: string): Error {
  if (!(error instanceof GhError || error instanceof GitError)) return error instanceof Error ? error : new Error(String(error));
  const text = error.stderr.trim();
  if (/gh auth login/.test(text)) return new Error("Sign in to GitHub first: run gh auth login in a terminal.");
  if (/none of the git remotes|no git remotes found|not a git repository/i.test(text)) return new Error("This project has no GitHub remote.");
  if (/could not resolve to a pullrequest/i.test(text)) return new Error(`${subject} was not found on GitHub.`);
  if (/HTTP 406|diff exceeded|too large/i.test(text)) return new Error(`${subject} is too large for GitHub to send as one diff. Review it on GitHub.`);
  const reason = error instanceof GhError ? githubErrorReason(error.stdout) : null;
  if (reason) return new Error(`GitHub: ${reason}`);
  if (!text) return new Error(`gh could not read ${subject.toLowerCase()}. Check that the GitHub CLI is installed and signed in.`);
  return new Error(text.split("\n").find((line) => line.trim().length > 0)!);
}

export interface ReviewSubmission {
  commitId: string;
  event: PullRequestReviewEvent;
  body: string;
  comments: { path: string; startLine: number | null; startSide: PullRequestSide | null; line: number; side: PullRequestSide; body: string }[];
}

const reviewEvents: Record<PullRequestReviewEvent, string> = { comment: "COMMENT", approve: "APPROVE", request_changes: "REQUEST_CHANGES" };
const githubSide = (side: PullRequestSide) => (side === "old" ? "LEFT" : "RIGHT");

/** The review GitHub's API takes: one request carries the verdict, the summary and every line comment. */
export function reviewPayload(review: ReviewSubmission): Record<string, unknown> {
  return {
    commit_id: review.commitId,
    event: reviewEvents[review.event],
    ...(review.body.trim() ? { body: review.body } : {}),
    comments: review.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: githubSide(comment.side),
      ...(comment.startLine !== null && comment.startSide !== null ? { start_line: comment.startLine, start_side: githubSide(comment.startSide) } : {}),
      body: comment.body,
    })),
  };
}

/** The user's own gh, asked about one repository's pull requests. Nothing here reads credentials. */
export class GitHubPulls {
  /** Each checkout's repository, by path. */
  private readonly repositories = new Map<string, Promise<Repository>>();
  /** gh for what someone is waiting on: a pull request, its diff, a review, the branches to open one against. */
  private readonly gh: GhRunner;
  /**
   * gh for the list page's reads, many projects at a time: lists, counts and filter choices. Only `GH_PROCESSES` run at
   * once, and the rest queue among themselves, never in front of `gh`.
   */
  private readonly listing: GhRunner;

  constructor(gh: GhRunner = runGh) {
    this.gh = gh;
    this.listing = limitedGh(gh, GH_PROCESSES);
  }

  /**
   * One list. Open, merged, closed or every pull request with nothing else asked is the repository's own list, which
   * shows a pull request the moment it changes. Drafts, any filter or another order make it one GitHub search, which can
   * take a few seconds to see a new one.
   */
  async list(at: PullsAt, state: PullRequestStateFilter, narrowing: PullRequestNarrowing = {}): Promise<PullRequestSummary[]> {
    const plain = plainStates[state];
    if (plain && !isNarrowed(narrowing)) {
      const out = await this.graphql(at, (repository) => {
        const [owner, repo] = repository.split("/");
        return ["-f", `owner=${owner}`, "-f", `repo=${repo}`, "-f", `query=${repositoryQuery(plain)}`];
      }).catch((error: unknown) => {
        throw ghFailure(error, "Pull requests");
      });
      return (JSON.parse(out) as RawRepositoryPulls).data.repository.pullRequests.nodes.map(listedPullRequest);
    }
    const out = await this.graphql(at, (repository) => ["-f", `q=${searchQuery(repository, state, narrowing)}`, "-f", `query=${SEARCH_QUERY}`]).catch((error: unknown) => {
      throw ghFailure(error, "Pull requests");
    });
    return (JSON.parse(out) as RawSearch).data.search.nodes.filter((node): node is RawListNode => typeof node.number === "number").map(listedPullRequest);
  }

  /** How many pull requests each state holds under the same filters. The order searched for changes no count. */
  async counts(at: PullsAt, narrowing: PullRequestNarrowing = {}): Promise<PullRequestCounts> {
    const { sort: _sort, ...filters } = narrowing;
    const queries = (repository: string) => STATES.flatMap((state) => ["-f", `${state}=${searchQuery(repository, state, filters)}`]);
    const out = await this.graphql(at, (repository) => [...queries(repository), "-f", `query=${COUNTS_QUERY}`]).catch((error: unknown) => {
      throw ghFailure(error, "Pull request counts");
    });
    const data = (JSON.parse(out) as { data: Record<PullRequestStateFilter, { issueCount: number }> }).data;
    return Object.fromEntries(STATES.map((state) => [state, data[state].issueCount])) as PullRequestCounts;
  }

  /**
   * One GraphQL request on the checkout's repository, in raw fields: gh fills its `{owner}` and `:owner` placeholders
   * into typed fields wherever they appear, label and milestone names included, and reads a name of digits as a number.
   */
  private async graphql(at: PullsAt, fields: (repository: string) => string[]): Promise<string> {
    const { name, host } = await this.repository(at, this.listing);
    return this.listing(cwdOf(at), ["api", "graphql", ...fields(name), ...hostname(host)]);
  }

  /**
   * `gh api` about the repository, asked of the host it is on, through `gh` unless told otherwise. gh fills `{owner}` and
   * `{repo}` only inside a clone, so for a repository named by `owner/name` they are filled here.
   */
  private async api(at: PullsAt, args: string[], gh: GhRunner = this.gh): Promise<string> {
    const { name, host } = await this.repository(at, gh);
    const [owner = "", repo = ""] = name.split("/");
    const filled = typeof at === "string" ? args : args.map((arg) => arg.replaceAll("{owner}", owner).replaceAll("{repo}", repo));
    return gh(cwdOf(at), ["api", ...filled, ...hostname(host)]);
  }

  /**
   * The repository gh works with in a checkout, read once through whichever gh asks first. A failed read is tried
   * again the next time.
   */
  private repository(at: PullsAt, gh: GhRunner = this.gh): Promise<Repository> {
    // A repository named on its own is on github.com, where a project with no folder here comes from.
    if (typeof at !== "string") return Promise.resolve({ name: at.repo, host: "github.com" });
    const cwd = at;
    const known = this.repositories.get(cwd);
    if (known) return known;
    const read = gh(cwd, ["repo", "view", "--json", "url", "--jq", ".url"]).then(repositoryAt);
    this.repositories.set(cwd, read);
    read.catch(() => this.repositories.delete(cwd));
    return read;
  }

  /** What one of GitHub's filters offers for the repository. */
  async choices(at: PullsAt, kind: PullRequestChoiceKind): Promise<PullRequestChoice[]> {
    if (kind === "labels") return this.labels(at);
    if (kind === "assignees") return this.assignees(at);
    if (kind === "milestones") return this.milestones(at);
    return this.projects(at);
  }

  private async labels(at: PullsAt): Promise<PullRequestChoice[]> {
    const out = await this.listing(cwdOf(at), ["label", "list", ...repoFlag(at), "--sort", "name", "--order", "asc", "--limit", LABEL_LIMIT, "--json", "name,color,description"]).catch((error: unknown) => {
      throw ghFailure(error, "The repository's labels");
    });
    return (JSON.parse(out) as RawLabel[])
      .filter((raw) => SearchName.safeParse(raw.name).success)
      .map(label)
      .map(({ name, color, description }) => ({ value: name, name, color, ...(description ? { detail: description } : {}) }));
  }

  /** The people GitHub can assign in the repository, as its Assignee filter lists them: the first hundred, by login. */
  private async assignees(at: PullsAt): Promise<PullRequestChoice[]> {
    const out = await this.api(at, ["repos/{owner}/{repo}/assignees?per_page=100"], this.listing).catch((error: unknown) => {
      throw ghFailure(error, "The people GitHub can assign");
    });
    return (JSON.parse(out) as { login: string }[]).map(({ login }) => ({ value: login, name: login })).sort(byName);
  }

  /** Open milestones by due date, then closed ones. A title a search can't quote isn't offered. */
  private async milestones(at: PullsAt): Promise<PullRequestChoice[]> {
    const out = await this.api(at, ["repos/{owner}/{repo}/milestones?state=all&sort=due_on&per_page=100"], this.listing).catch((error: unknown) => {
      throw ghFailure(error, "The repository's milestones");
    });
    const milestones = (JSON.parse(out) as { title: string; state: string }[]).filter((milestone) => SearchName.safeParse(milestone.title).success);
    const open = milestones.filter((milestone) => milestone.state === "open").map(({ title }) => ({ value: title, name: title }));
    const closed = milestones.filter((milestone) => milestone.state !== "open").map(({ title }) => ({ value: title, name: title, detail: "Closed" }));
    return [...open, ...closed];
  }

  private async projects(at: PullsAt): Promise<PullRequestChoice[]> {
    const out = await this.api(at, ["graphql", "-F", "owner={owner}", "-F", "repo={repo}", "-f", `query=${PROJECTS_QUERY}`], this.listing).catch((error: unknown) => {
      if (error instanceof GhError && /read:project/.test(error.stdout + error.stderr)) {
        throw new Error("Projects need gh's read:project scope. Run gh auth refresh -s read:project, then try again.");
      }
      throw ghFailure(error, "The repository's projects");
    });
    // Only a project the list can be asked for: one a filter couldn't send would fail the list it was picked for.
    return (JSON.parse(out) as RawProjects).data.repository.projectsV2.nodes
      .filter((project) => project.owner.login && PullRequestProjectRef.safeParse(`${project.owner.login}/${project.number}`).success)
      .map((project) => ({ value: `${project.owner.login}/${project.number}`, name: project.title, detail: project.owner.login! }));
  }

  async get(at: PullsAt, number: number): Promise<PullRequestDetail> {
    const [out, viewer] = await Promise.all([
      this.gh(cwdOf(at), ["pr", "view", String(number), ...repoFlag(at), "--json", `${SUMMARY_FIELDS},body,headRefOid,baseRefOid`]).catch((error: unknown) => {
        throw ghFailure(error, `Pull request #${number}`);
      }),
      this.viewer(at),
    ]);
    const raw = JSON.parse(out) as RawPullRequestDetail;
    return { ...pullRequestSummary(raw), body: raw.body ?? "", headSha: raw.headRefOid, baseSha: raw.baseRefOid, viewer };
  }

  /**
   * The changes as GitHub shows them, the head against where it left its base branch, and the head they are for.
   * gh can't name that head with the diff, so it is read before and after; a push in between reads the diff again.
   */
  async diff(at: PullsAt, number: number): Promise<{ patch: string; headSha: string }> {
    const ask = (args: string[]) =>
      this.gh(cwdOf(at), ["pr", ...args, ...repoFlag(at)]).catch((error: unknown) => {
        throw ghFailure(error, `Pull request #${number}`);
      });
    const head = async () => (JSON.parse(await ask(["view", String(number), "--json", "headRefOid"])) as { headRefOid: string }).headRefOid;
    for (let read = 0; read < DIFF_READS; read += 1) {
      const before = await head();
      const patch = await ask(["diff", String(number), "--color", "never"]);
      if ((await head()) === before) return { patch, headSha: before };
    }
    throw new Error(`Pull request #${number} kept changing while it loaded. Try again.`);
  }

  /**
   * The branches a new pull request can target in the repository gh opens pull requests in: the default branch first,
   * `prefer` next when it exists, then the rest by name.
   */
  async branches(at: PullsAt, prefer?: string): Promise<PullRequestBranches> {
    const names: string[] = [];
    let defaultBranch: string | null = null;
    let preferred: string | null = null;
    let after: string | null = null;
    for (let page = 0; page < BRANCH_PAGES; page += 1) {
      const args = [
        "graphql",
        "-F",
        "owner={owner}",
        "-F",
        "repo={repo}",
        "-f",
        `query=${BRANCHES_QUERY}`,
        "-f",
        `prefer=refs/heads/${prefer ?? ""}`,
        "-F",
        `checkPrefer=${page === 0 && prefer !== undefined}`,
      ];
      const out: string = await this.api(at, after === null ? args : [...args, "-f", `after=${after}`]).catch((error: unknown) => {
        throw ghFailure(error, "The repository's branches");
      });
      const { repository }: RawBranchPage["data"] = (JSON.parse(out) as RawBranchPage).data;
      if (page === 0) {
        defaultBranch = repository.defaultBranchRef?.name ?? null;
        preferred = repository.preferred?.name ?? null;
      }
      names.push(...repository.refs.nodes.map((node) => node.name));
      if (!repository.refs.pageInfo.hasNextPage) break;
      after = repository.refs.pageInfo.endCursor;
    }
    const first = [defaultBranch, preferred].filter((name): name is string => name !== null);
    return { branches: [...new Set([...first, ...names])], defaultBranch };
  }

  /** Whether `branch` is a branch of the repository gh opens pull requests in. */
  async hasBranch(at: PullsAt, branch: string): Promise<boolean> {
    try {
      await this.api(at, [`repos/{owner}/{repo}/branches/${encodeURIComponent(branch)}`, "--silent"]);
      return true;
    } catch (error) {
      if (error instanceof GhError && /HTTP 404/.test(error.stderr)) return false;
      throw ghFailure(error, `The branch ${branch}`);
    }
  }

  /** The signed-in account's login on the checkout's host, or null when gh cannot say. Outside a checkout, gh's own host. */
  async viewer(at: PullsAt): Promise<string | null> {
    const host = await this.repository(at).then(
      (repository) => repository.host,
      () => "github.com",
    );
    try {
      return (await this.gh(cwdOf(at), ["api", "user", "--jq", ".login", ...hostname(host)])).trim() || null;
    } catch {
      return null;
    }
  }

  /** Posts one review with its line comments. Returns the review's page on GitHub when GitHub names one. */
  async submitReview(cwd: string, url: string, review: ReviewSubmission): Promise<{ url: string | null }> {
    const { host, owner, repo } = pullRequestRepository(url);
    const number = /\/pull\/(\d+)/.exec(url)![1];
    const args = ["api", "--method", "POST", `repos/${owner}/${repo}/pulls/${number}/reviews`, "--input", "-", ...hostname(host)];
    const out = await this.gh(cwd, args, JSON.stringify(reviewPayload(review))).catch((error: unknown) => {
      throw ghFailure(error, `Pull request #${number}`);
    });
    const posted = JSON.parse(out) as { html_url?: string };
    return { url: posted.html_url ?? null };
  }
}

/**
 * Where to fetch a pull request from: the local remote that points at its
 * repository, so the user's own transport and credentials apply, or else the
 * repository's URL. An ssh host alias matches on owner/repo alone.
 */
export async function pullRequestSource(cwd: string, url: string): Promise<string> {
  const target = pullRequestRepository(url);
  const path = `${target.owner}/${target.repo}`.toLowerCase();
  // The URLs as configured: `git remote -v` would show them after any insteadOf rewrite.
  const configured = await git(cwd, ["config", "--get-regexp", "^remote\\..*\\.url$"], { okCodes: [0, 1] });
  const remotes = configured.stdout.split("\n").flatMap((line) => {
    const [key, remoteUrl] = line.split(/\s+/);
    const parsed = key && remoteUrl ? remoteRepository(remoteUrl) : null;
    return parsed && parsed.path === path ? [{ name: key!.slice("remote.".length, -".url".length), host: parsed.host }] : [];
  });
  const remote = remotes.find((candidate) => candidate.host === target.host) ?? remotes[0];
  return remote?.name ?? `https://${target.host}/${target.owner}/${target.repo}.git`;
}

/**
 * Brings a pull request's head and its base branch into the repository. No
 * branch, checkout or FETCH_HEAD changes; a named remote may refresh its own
 * tracking ref for the base branch, as any fetch does.
 */
export async function fetchPullRequest(cwd: string, options: { source: string; number: number; baseRefName: string; commits: string[] }): Promise<void> {
  await git(cwd, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", options.source, `refs/pull/${options.number}/head`, `refs/heads/${options.baseRefName}`], { timeoutMs: 180_000 });
  for (const commit of options.commits) {
    const found = await git(cwd, ["cat-file", "-e", `${commit}^{commit}`], { okCodes: [0, 1, 128] });
    if (found.code !== 0) throw new Error("The pull request changed while it was loading. Try again.");
  }
}
