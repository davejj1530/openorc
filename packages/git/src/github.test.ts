import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "./exec.js";
import { GhError, GitHubPulls, fetchPullRequest, pullRequestSource, pullRequestSummary, remoteRepository, reviewPayload, searchQuery, type GhRunner } from "./github.js";
import { commitAll } from "./publish.js";
import * as worktree from "./worktree.js";

const raw = {
  number: 7,
  title: "Add retries",
  url: "https://github.com/acme/app/pull/7",
  author: { login: "ada" },
  state: "OPEN",
  isDraft: false,
  headRefName: "feat/retries",
  baseRefName: "main",
  createdAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-09-02T10:00:00Z",
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  reviewDecision: "CHANGES_REQUESTED",
  labels: [{ name: "bug", color: "d73a4a", description: null }],
};

/** What `gh repo view --json url --jq .url` prints in a checkout of acme/app. */
const REPO_URL = "https://github.com/acme/app\n";

const EMPTY_LIST = JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } });

/** Records each gh call and answers from a table keyed by the first two arguments. */
function fakeGh(answers: Record<string, string | GhError>) {
  const calls: { args: string[]; input?: string }[] = [];
  const gh: GhRunner = async (_cwd, args, input) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    const answer = answers[args.slice(0, 2).join(" ")];
    if (answer instanceof GhError) throw answer;
    if (answer === undefined) throw new GhError(`unexpected gh ${args.join(" ")}`);
    return answer;
  };
  return { gh, calls };
}

describe("pull request records", () => {
  it("reads gh's JSON in the app's terms", () => {
    expect(pullRequestSummary(raw)).toEqual({
      number: 7,
      title: "Add retries",
      url: "https://github.com/acme/app/pull/7",
      author: "ada",
      state: "open",
      isDraft: false,
      headRefName: "feat/retries",
      baseRefName: "main",
      createdAt: Date.parse("2026-09-01T10:00:00Z"),
      updatedAt: Date.parse("2026-09-02T10:00:00Z"),
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      reviewDecision: "changes_requested",
      labels: [{ name: "bug", color: "d73a4a", description: "" }],
    });
    expect(pullRequestSummary({ ...raw, author: null, reviewDecision: "", labels: null, state: "MERGED" })).toMatchObject({ author: "ghost", reviewDecision: null, labels: [], state: "merged" });
  });

  it("reduces every remote URL form to host and owner/repo", () => {
    expect(remoteRepository("https://github.com/Acme/App.git")).toEqual({ host: "github.com", path: "acme/app" });
    expect(remoteRepository("git@github.com:acme/app.git")).toEqual({ host: "github.com", path: "acme/app" });
    expect(remoteRepository("ssh://git@github.example.com:2222/acme/app/")).toEqual({ host: "github.example.com", path: "acme/app" });
    expect(remoteRepository("/tmp/remote.git")).toBeNull();
  });

  it("builds one review request with GitHub's sides and optional ranges", () => {
    const payload = reviewPayload({
      commitId: "a".repeat(40),
      event: "request_changes",
      body: "  ",
      comments: [
        { path: "src/a.ts", startLine: null, startSide: null, line: 4, side: "new", body: "Handle the error." },
        { path: "src/b.ts", startLine: 2, startSide: "old", line: 5, side: "new", body: "Keep the guard." },
      ],
    });
    expect(payload).toEqual({
      commit_id: "a".repeat(40),
      event: "REQUEST_CHANGES",
      comments: [
        { path: "src/a.ts", line: 4, side: "RIGHT", body: "Handle the error." },
        { path: "src/b.ts", line: 5, side: "RIGHT", start_line: 2, start_side: "LEFT", body: "Keep the guard." },
      ],
    });
  });
});

describe("GitHubPulls", () => {
  it("reads open, merged, closed and every pull request from the repository's own list, and drafts from a search", async () => {
    const node = { ...raw, author: { __typename: "User", login: "ada" }, labels: { nodes: [] }, totalCommentsCount: 4 };
    const answer = (args: string[]) => (args.some((arg) => arg.startsWith("q=")) ? { data: { search: { nodes: [] } } } : { data: { repository: { pullRequests: { nodes: [node] } } } });
    const calls: string[][] = [];
    const gh: GhRunner = async (_cwd, args) => {
      calls.push(args);
      return args[0] === "repo" ? REPO_URL : JSON.stringify(answer(args));
    };
    const pulls = new GitHubPulls(gh);
    expect(await pulls.list("/repo", "open")).toEqual([expect.objectContaining({ number: 7, author: "ada", comments: 4 })]);
    await pulls.list("/repo", "merged");
    await pulls.list("/repo", "any");
    await pulls.list("/repo", "draft");
    await pulls.list("/repo", "closed");
    // The repository is read once for the checkout, and named as raw fields so gh leaves a name of digits a string.
    expect(calls.filter((args) => args[0] === "repo")).toHaveLength(1);
    const requests = calls.filter((args) => args[1] === "graphql");
    const query = (args: string[]) => args.find((arg) => arg.startsWith("query="))!;
    expect(requests[0]).toEqual(expect.arrayContaining(["-f", "owner=acme", "-f", "repo=app"]));
    const listed = requests.filter((args) => !args.some((arg) => arg.startsWith("q=")));
    expect(listed.map((args) => /states: (\[[A-Z, ]+\])/.exec(query(args))?.[1])).toEqual(["[OPEN]", "[MERGED]", "[OPEN, CLOSED, MERGED]", "[CLOSED]"]);
    expect(query(requests[0]!)).toContain("orderBy: { field: CREATED_AT, direction: DESC }");
    expect(query(requests[0]!)).toContain("totalCommentsCount");
    // The repository's list has no drafts alone, so drafts are a search.
    expect(requests[3]).toContain("q=repo:acme/app is:pr is:open draft:true sort:created-desc");
  });

  it("counts every state under the same filters in one request", async () => {
    const counts = { open: { issueCount: 6 }, draft: { issueCount: 1 }, merged: { issueCount: 12 }, closed: { issueCount: 3 }, any: { issueCount: 21 } };
    const { gh, calls } = fakeGh({ "repo view": REPO_URL, "api graphql": JSON.stringify({ data: counts }) });
    expect(await new GitHubPulls(gh).counts("/repo", { labels: ["area:repo"], sort: "oldest" })).toEqual({ open: 6, draft: 1, merged: 12, closed: 3, any: 21 });
    const [, request] = calls;
    expect(calls).toHaveLength(2);
    // Raw fields, so gh leaves ":repo" in a label's name alone.
    expect(request!.args).toEqual(expect.arrayContaining(["-f", 'merged=repo:acme/app is:pr is:merged label:"area:repo" sort:created-desc']));
    expect(request!.args).toContain('any=repo:acme/app is:pr label:"area:repo" sort:created-desc');
    expect(request!.args).not.toContain("-F");
  });

  it("keeps a list with nothing but the newest-first order on the repository's own list", async () => {
    const { gh, calls } = fakeGh({ "repo view": REPO_URL, "api graphql": EMPTY_LIST });
    await new GitHubPulls(gh).list("/repo", "open", { sort: "newest" });
    expect(calls[1]!.args.some((arg) => arg.startsWith("q="))).toBe(false);
  });

  it("asks for a filtered list as one advanced search and reads its pull requests", async () => {
    const node = { ...raw, author: { __typename: "User", login: "ada" }, labels: { nodes: [{ name: "bug", color: "d73a4a", description: "Broken" }] }, totalCommentsCount: 2 };
    const { gh, calls } = fakeGh({ "repo view": REPO_URL, "api graphql": JSON.stringify({ data: { search: { nodes: [node, {}] } } }) });
    const pulls = await new GitHubPulls(gh).list("/repo", "open", { authors: ["ada", "linus"], sort: "oldest" });
    expect(pulls).toEqual([expect.objectContaining({ number: 7, author: "ada", comments: 2, labels: [{ name: "bug", color: "d73a4a", description: "Broken" }] })]);
    expect(calls[1]!.args).toContain("q=repo:acme/app is:pr is:open (author:ada OR author:linus) sort:created-asc");
    expect(calls[1]!.args.find((arg) => arg.startsWith("query="))).toContain("type: ISSUE_ADVANCED");
    expect(calls[1]!.args.find((arg) => arg.startsWith("query="))).toContain("totalCommentsCount");
  });

  it("names an app's pull requests as gh's own list does, so its author filter finds them", async () => {
    const node = { ...raw, author: { __typename: "Bot", login: "dependabot" }, labels: { nodes: [] }, totalCommentsCount: 0 };
    const { gh } = fakeGh({ "repo view": REPO_URL, "api graphql": JSON.stringify({ data: { search: { nodes: [node] } } }) });
    expect((await new GitHubPulls(gh).list("/repo", "draft"))[0]!.author).toBe("app/dependabot");
  });

  it("reads a pull request GitHub sends no comment count for as having none", async () => {
    const node = { ...raw, author: { __typename: "User", login: "ada" }, labels: { nodes: [] }, totalCommentsCount: null };
    const { gh } = fakeGh({ "repo view": REPO_URL, "api graphql": JSON.stringify({ data: { repository: { pullRequests: { nodes: [node] } } } }) });
    expect((await new GitHubPulls(gh).list("/repo", "open"))[0]!.comments).toBe(0);
  });

  it("reads the repository again after a failed read", async () => {
    let reads = 0;
    const gh: GhRunner = async (_cwd, args) => {
      if (args[0] === "repo") {
        reads += 1;
        if (reads === 1) throw new GhError("could not resolve");
        return REPO_URL;
      }
      return JSON.stringify({ data: { search: { nodes: [] } } });
    };
    const pulls = new GitHubPulls(gh);
    await expect(pulls.list("/repo", "draft")).rejects.toThrow("could not resolve");
    await pulls.list("/repo", "draft");
    await pulls.list("/repo", "draft");
    expect(reads).toBe(2);
  });
});

describe("searchQuery", () => {
  it("writes every filter as GitHub's filter bar does, each author once and every label quoted", () => {
    expect(
      searchQuery("acme/app", "open", {
        authors: ["ada", "linus", "Ada"],
        labels: ["bug", "good first issue"],
        assignee: "@me",
        milestone: "v2 launch",
        project: "acme/7",
        review: "not_reviewed_by_you",
        missing: ["milestone"],
        sort: "reactions_thumbs_up",
      }),
    ).toBe(
      'repo:acme/app is:pr is:open (author:ada OR author:linus) label:"bug" label:"good first issue" assignee:@me milestone:"v2 launch" project:acme/7 -reviewed-by:@me no:milestone sort:reactions-+1-desc',
    );
  });

  it("names you as @me, asks for what is missing, and leaves the state out when any will do", () => {
    expect(searchQuery("acme/app", "open", { authors: ["@me"], missing: ["label", "assignee"] })).toBe("repo:acme/app is:pr is:open (author:@me) no:label no:assignee sort:created-desc");
    expect(searchQuery("acme/app", "any", { review: "awaiting_you_or_team", sort: "least_recently_updated" })).toBe("repo:acme/app is:pr review-requested:@me sort:updated-asc");
  });
});

describe("GitHubPulls choices", () => {
  it("lists the repository's labels by name, with their colors and descriptions, leaving out names a search can't quote", async () => {
    const { gh, calls } = fakeGh({
      "label list": JSON.stringify([
        { name: "bug", color: "d73a4a", description: "Broken" },
        { name: 'say "hi"', color: "0e8a16", description: null },
        { name: "x\\", color: "0e8a16", description: null },
        { name: "wip", color: "ededed", description: null },
      ]),
    });
    expect(await new GitHubPulls(gh).choices("/repo", "labels")).toEqual([
      { value: "bug", name: "bug", color: "d73a4a", detail: "Broken" },
      { value: "wip", name: "wip", color: "ededed" },
    ]);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--sort", "name", "--json", "name,color,description"]));
  });

  it("lists assignees by login and open milestones before closed ones, leaving out titles a search can't quote", async () => {
    const { gh } = fakeGh({
      "repo view": REPO_URL,
      "api repos/{owner}/{repo}/assignees?per_page=100": JSON.stringify([{ login: "zed" }, { login: "Ada" }]),
      "api repos/{owner}/{repo}/milestones?state=all&sort=due_on&per_page=100": JSON.stringify([
        { title: "v1", state: "closed" },
        { title: 'The "big" one', state: "open" },
        { title: "v2", state: "open" },
      ]),
    });
    const pulls = new GitHubPulls(gh);
    expect(await pulls.choices("/repo", "assignees")).toEqual([
      { value: "Ada", name: "Ada" },
      { value: "zed", name: "zed" },
    ]);
    expect(await pulls.choices("/repo", "milestones")).toEqual([
      { value: "v2", name: "v2" },
      { value: "v1", name: "v1", detail: "Closed" },
    ]);
  });

  it("names projects by owner and number, and says how to grant the scope they need", async () => {
    const nodes = [
      { number: 7, title: "Roadmap", owner: { login: "acme" } },
      { number: 3, title: "Mine", owner: { login: "jdoe_acme" } },
      // An owner the project filter couldn't send isn't offered, so picking it can't fail the list.
      { number: 4, title: "Odd", owner: { login: "acme.io" } },
    ];
    const { gh } = fakeGh({ "repo view": REPO_URL, "api graphql": JSON.stringify({ data: { repository: { projectsV2: { nodes } } } }) });
    expect(await new GitHubPulls(gh).choices("/repo", "projects")).toEqual([
      { value: "acme/7", name: "Roadmap", detail: "acme" },
      { value: "jdoe_acme/3", name: "Mine", detail: "jdoe_acme" },
    ]);
    const scopeless = fakeGh({
      "repo view": REPO_URL,
      "api graphql": new GhError("gh: Your token has not been granted the required scopes", '{"errors":[{"type":"INSUFFICIENT_SCOPES","message":"requires read:project"}]}'),
    });
    await expect(new GitHubPulls(scopeless.gh).choices("/repo", "projects")).rejects.toThrow("gh auth refresh -s read:project");
  });

  it("reads a pull request with its commits and the posting account", async () => {
    const { gh } = fakeGh({ "pr view": JSON.stringify({ ...raw, body: null, headRefOid: "h".repeat(40), baseRefOid: "b".repeat(40) }), "api user": "ada\n" });
    expect(await new GitHubPulls(gh).get("/repo", 7)).toMatchObject({ number: 7, body: "", headSha: "h".repeat(40), baseSha: "b".repeat(40), viewer: "ada" });
  });

  it("reads the diff with the head it belongs to, again when a push lands in between", async () => {
    const heads = ["a", "b", "b", "b"].map((letter) => JSON.stringify({ headRefOid: letter.repeat(40) }));
    const patches = ["diff at a", "diff at b"];
    const calls: string[] = [];
    const gh: GhRunner = async (_cwd, args) => {
      calls.push(args[1]!);
      return args[1] === "view" ? heads.shift()! : patches.shift()!;
    };
    expect(await new GitHubPulls(gh).diff("/repo", 7)).toEqual({ patch: "diff at b", headSha: "b".repeat(40) });
    expect(calls).toEqual(["view", "diff", "view", "view", "diff", "view"]);
    const restless: GhRunner = async (_cwd, args) => (args[1] === "view" ? JSON.stringify({ headRefOid: String(calls.push("view")).padStart(40, "0") }) : "diff");
    await expect(new GitHubPulls(restless).diff("/repo", 7)).rejects.toThrow("Pull request #7 kept changing while it loaded. Try again.");
  });

  it("lists the branches a pull request can target: the default, the preferred one, then the rest by name", async () => {
    const page = (nodes: string[], endCursor: string | null, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        data: { repository: { defaultBranchRef: { name: "main" }, ...extra, refs: { nodes: nodes.map((name) => ({ name })), pageInfo: { hasNextPage: endCursor !== null, endCursor } } } },
      });
    const pages = [page(["alpha", "dev", "main"], "cursor-1", { preferred: { name: "dev" } }), page(["zeta"], null)];
    const calls: string[][] = [];
    const gh: GhRunner = async (_cwd, args) => {
      if (args[0] === "repo") return REPO_URL;
      calls.push(args);
      return pages.shift()!;
    };
    expect(await new GitHubPulls(gh).branches("/repo", "dev")).toEqual({ branches: ["main", "dev", "alpha", "zeta"], defaultBranch: "main" });
    expect(calls[0]).toEqual(expect.arrayContaining(["owner={owner}", "repo={repo}", "prefer=refs/heads/dev", "checkPrefer=true"]));
    expect(calls[0]!.some((arg) => arg.startsWith("after="))).toBe(false);
    expect(calls[1]).toEqual(expect.arrayContaining(["checkPrefer=false", "after=cursor-1"]));
  });

  it("tells a missing branch from a failure to check", async () => {
    const pulls = (answer: string | GhError) => new GitHubPulls(fakeGh({ "repo view": REPO_URL, [`api repos/{owner}/{repo}/branches/${encodeURIComponent("release/2.x")}`]: answer }).gh);
    expect(await pulls("").hasBranch("/repo", "release/2.x")).toBe(true);
    expect(await pulls(new GhError("gh: Branch not found (HTTP 404)")).hasBranch("/repo", "release/2.x")).toBe(false);
    await expect(pulls(new GhError("To get started with GitHub CLI, please run:  gh auth login")).hasBranch("/repo", "release/2.x")).rejects.toThrow("Sign in to GitHub first");
  });

  it("posts a review to the pull request's own repository", async () => {
    const { gh, calls } = fakeGh({ "api --method": JSON.stringify({ html_url: "https://github.com/acme/app/pull/7#pullrequestreview-1" }) });
    const posted = await new GitHubPulls(gh).submitReview("/repo", raw.url, { commitId: "c".repeat(40), event: "comment", body: "Looks close.", comments: [] });
    expect(posted.url).toBe("https://github.com/acme/app/pull/7#pullrequestreview-1");
    expect(calls[0]!.args).toEqual(["api", "--method", "POST", "repos/acme/app/pulls/7/reviews", "--input", "-"]);
    expect(JSON.parse(calls[0]!.input!)).toEqual({ commit_id: "c".repeat(40), event: "COMMENT", body: "Looks close.", comments: [] });
  });

  it("asks a GitHub Enterprise checkout's own host, and github.com's without naming it", async () => {
    const answers = {
      "repo view": "https://github.example.com/acme/app\n",
      "api graphql": JSON.stringify({ data: { search: { nodes: [] } } }),
      "api repos/{owner}/{repo}/assignees?per_page=100": "[]",
      "api user": "ada\n",
    };
    const enterprise = fakeGh(answers);
    const pulls = new GitHubPulls(enterprise.gh);
    await pulls.list("/repo", "draft");
    await pulls.choices("/repo", "assignees");
    expect(await pulls.viewer("/repo")).toBe("ada");
    const api = enterprise.calls.filter((call) => call.args[0] === "api");
    expect(api).toHaveLength(3);
    for (const call of api) expect(call.args.slice(-2)).toEqual(["--hostname", "github.example.com"]);
    expect(api[0]!.args).toContain("q=repo:acme/app is:pr is:open draft:true sort:created-desc");
    const dotcom = fakeGh({ ...answers, "repo view": REPO_URL });
    await new GitHubPulls(dotcom.gh).list("/repo", "draft");
    expect(dotcom.calls.flatMap((call) => call.args)).not.toContain("--hostname");
    // Outside a checkout there is no repository to ask about; the login is gh's own host's.
    const home = fakeGh({ "api user": "ada\n" });
    expect(await new GitHubPulls(home.gh).viewer("/home/ada")).toBe("ada");
    expect(home.calls.at(-1)!.args).toEqual(["api", "user", "--jq", ".login"]);
  });

  it("runs at most eight gh processes at once, starting the rest in turn", async () => {
    let running = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const gh: GhRunner = async (_cwd, args) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
      return args[0] === "repo" ? REPO_URL : EMPTY_LIST;
    };
    const pulls = new GitHubPulls(gh);
    const lists = Array.from({ length: 20 }, () => pulls.list("/repo", "open"));
    while (releases.length > 0 || running > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      releases.splice(0).forEach((release) => release());
    }
    expect(await Promise.all(lists)).toHaveLength(20);
    expect(most).toBe(8);
  });

  it("reads a pull request without waiting behind the list page's reads", async () => {
    const held: (() => void)[] = [];
    const gh: GhRunner = async (_cwd, args) => {
      if (args[1] === "graphql") {
        await new Promise<void>((resolve) => held.push(resolve));
        return EMPTY_LIST;
      }
      if (args[0] === "repo") return REPO_URL;
      if (args[0] === "api") return "ada\n";
      return JSON.stringify({ ...raw, body: null, headRefOid: "h".repeat(40), baseRefOid: "b".repeat(40) });
    };
    const pulls = new GitHubPulls(gh);
    const lists = Array.from({ length: 20 }, () => pulls.list("/repo", "open"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held).toHaveLength(8);
    // Twelve lists still wait their turn, and the pull request comes back all the same.
    expect(await pulls.get("/repo", 7)).toMatchObject({ number: 7, viewer: "ada" });
    while (held.length > 0) {
      held.splice(0).forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(await Promise.all(lists)).toHaveLength(20);
  });

  it("says what to do instead of repeating gh's output", async () => {
    const signedOut = fakeGh({ "repo view": new GhError("To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable.") });
    await expect(new GitHubPulls(signedOut.gh).list("/repo", "open")).rejects.toThrow("Sign in to GitHub first: run gh auth login in a terminal.");
    const own = fakeGh({ "api --method": new GhError("gh: Unprocessable Entity (HTTP 422)", JSON.stringify({ message: "Unprocessable Entity", errors: ["Can not approve your own pull request"] })) });
    await expect(new GitHubPulls(own.gh).submitReview("/repo", raw.url, { commitId: "c".repeat(40), event: "approve", body: "", comments: [] })).rejects.toThrow(
      "GitHub: Can not approve your own pull request",
    );
  });
});

describe("pull request checkout", () => {
  let root: string;
  let upstream: string;
  let head: string;
  let base: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "openorc-pull-"));
    upstream = path.join(root, "upstream");
    const clone = path.join(root, "clone");
    await git(root, ["init", "-q", "-b", "main", upstream]);
    await git(upstream, ["config", "user.email", "test@example.com"]);
    await git(upstream, ["config", "user.name", "Test"]);
    await writeFile(path.join(upstream, "app.ts"), "export const retries = 0;\n");
    base = await commitAll(upstream, "init");
    await git(upstream, ["checkout", "-q", "-b", "feat/retries"]);
    await writeFile(path.join(upstream, "app.ts"), "export const retries = 3;\n");
    head = await commitAll(upstream, "retries");
    await git(upstream, ["checkout", "-q", "main"]);
    // GitHub publishes every pull request's head under refs/pull/<number>/head.
    await git(upstream, ["update-ref", "refs/pull/7/head", head]);
    await git(root, ["clone", "-q", "--single-branch", "--branch", "main", upstream, clone]);
    // The clone knows the upstream by its GitHub address; fetches go to the local copy.
    await git(clone, ["remote", "set-url", "origin", "https://github.com/acme/app.git"]);
    await git(clone, ["config", "url." + upstream + ".insteadOf", "https://github.com/acme/app.git"]);
    await git(clone, ["remote", "add", "fork", "git@github.com:ada/app.git"]);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("fetches from the remote that points at the pull request's repository", async () => {
    const clone = path.join(root, "clone");
    expect(await pullRequestSource(clone, "https://github.com/acme/app/pull/7")).toBe("origin");
    expect(await pullRequestSource(clone, "https://github.com/other/app/pull/1")).toBe("https://github.com/other/app.git");
  });

  it("checks the head out detached, leaving branches and the checkout alone", async () => {
    const clone = path.join(root, "clone");
    const branchesBefore = (await git(clone, ["branch", "--list"])).stdout;
    await fetchPullRequest(clone, { source: "origin", number: 7, baseRefName: "main", commits: [head, base] });
    const copy = path.join(root, "review-7");
    await worktree.addDetached(clone, { path: copy, commit: head });
    expect((await git(copy, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect((await git(copy, ["symbolic-ref", "--quiet", "HEAD"], { okCodes: [0, 1] })).code).toBe(1);
    expect((await git(clone, ["branch", "--list"])).stdout).toBe(branchesBefore);
    expect((await git(clone, ["rev-parse", "HEAD"])).stdout.trim()).toBe(base);
  });

  it("refuses a head that moved after gh described it", async () => {
    const clone = path.join(root, "clone");
    await expect(fetchPullRequest(clone, { source: "origin", number: 7, baseRefName: "main", commits: ["f".repeat(40)] })).rejects.toThrow("The pull request changed while it was loading.");
  });
});
