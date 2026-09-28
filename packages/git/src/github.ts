import type {
  PullRequestBranches,
  PullRequestDetail,
  PullRequestFilter,
  PullRequestReviewDecision,
  PullRequestReviewEvent,
  PullRequestSide,
  PullRequestState,
  PullRequestSummary,
} from "@openorc/protocol";
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
/** Reads of a diff before giving up on a pull request that keeps receiving pushes. */
const DIFF_READS = 3;
/** Pages of 100 branches a target picker reads before it stops. */
const BRANCH_PAGES = 10;

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

const filterArgs: Record<PullRequestFilter, string[]> = {
  open: ["--state", "open"],
  review_requested: ["--state", "open", "--search", "review-requested:@me"],
  authored: ["--state", "open", "--author", "@me"],
  closed: ["--state", "closed"],
};

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
  labels: { name: string }[] | null;
}

interface RawPullRequestDetail extends RawPullRequest {
  body: string | null;
  headRefOid: string;
  baseRefOid: string;
}

const decisions: Record<string, PullRequestReviewDecision> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "review_required" };

/** A pull request as gh's JSON describes it, in the app's own terms. A deleted account reads as GitHub's "ghost". */
export function pullRequestSummary(raw: RawPullRequest): PullRequestSummary {
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
    labels: (raw.labels ?? []).map((label) => label.name),
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
  constructor(private readonly gh: GhRunner = runGh) {}

  async list(cwd: string, filter: PullRequestFilter): Promise<PullRequestSummary[]> {
    const out = await this.gh(cwd, ["pr", "list", ...filterArgs[filter], "--limit", LIST_LIMIT, "--json", SUMMARY_FIELDS]).catch((error: unknown) => {
      throw ghFailure(error, "Pull requests");
    });
    return (JSON.parse(out) as RawPullRequest[]).map(pullRequestSummary);
  }

  async get(cwd: string, number: number): Promise<PullRequestDetail> {
    const [out, viewer] = await Promise.all([
      this.gh(cwd, ["pr", "view", String(number), "--json", `${SUMMARY_FIELDS},body,headRefOid,baseRefOid`]).catch((error: unknown) => {
        throw ghFailure(error, `Pull request #${number}`);
      }),
      this.viewer(cwd),
    ]);
    const raw = JSON.parse(out) as RawPullRequestDetail;
    return { ...pullRequestSummary(raw), body: raw.body ?? "", headSha: raw.headRefOid, baseSha: raw.baseRefOid, viewer };
  }

  /**
   * The changes as GitHub shows them, the head against where it left its base branch, and the head they are for.
   * gh can't name that head with the diff, so it is read before and after; a push in between reads the diff again.
   */
  async diff(cwd: string, number: number): Promise<{ patch: string; headSha: string }> {
    const ask = (args: string[]) =>
      this.gh(cwd, ["pr", ...args]).catch((error: unknown) => {
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
  async branches(cwd: string, prefer?: string): Promise<PullRequestBranches> {
    const names: string[] = [];
    let defaultBranch: string | null = null;
    let preferred: string | null = null;
    let after: string | null = null;
    for (let page = 0; page < BRANCH_PAGES; page += 1) {
      const args = [
        "api",
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
      const out: string = await this.gh(cwd, after === null ? args : [...args, "-f", `after=${after}`]).catch((error: unknown) => {
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
  async hasBranch(cwd: string, branch: string): Promise<boolean> {
    try {
      await this.gh(cwd, ["api", `repos/{owner}/{repo}/branches/${encodeURIComponent(branch)}`, "--silent"]);
      return true;
    } catch (error) {
      if (error instanceof GhError && /HTTP 404/.test(error.stderr)) return false;
      throw ghFailure(error, `The branch ${branch}`);
    }
  }

  /** The signed-in account's login, or null when gh cannot say. */
  async viewer(cwd: string): Promise<string | null> {
    try {
      return (await this.gh(cwd, ["api", "user", "--jq", ".login"])).trim() || null;
    } catch {
      return null;
    }
  }

  /** Posts one review with its line comments. Returns the review's page on GitHub when GitHub names one. */
  async submitReview(cwd: string, url: string, review: ReviewSubmission): Promise<{ url: string | null }> {
    const { host, owner, repo } = pullRequestRepository(url);
    const number = /\/pull\/(\d+)/.exec(url)![1];
    const args = ["api", "--method", "POST", `repos/${owner}/${repo}/pulls/${number}/reviews`, "--input", "-", ...(host === "github.com" ? [] : ["--hostname", host])];
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
