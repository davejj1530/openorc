import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "./exec.js";
import { GhError, GitHubPulls, fetchPullRequest, pullRequestSource, pullRequestSummary, remoteRepository, reviewPayload, type GhRunner } from "./github.js";
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
  labels: [{ name: "bug" }],
};

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
      labels: ["bug"],
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
  it("asks gh for each list with its own filter", async () => {
    const { gh, calls } = fakeGh({ "pr list": JSON.stringify([raw]) });
    const pulls = new GitHubPulls(gh);
    expect(await pulls.list("/repo", "review_requested")).toHaveLength(1);
    await pulls.list("/repo", "closed");
    expect(calls[0]!.args.slice(0, 6)).toEqual(["pr", "list", "--state", "open", "--search", "review-requested:@me"]);
    expect(calls[1]!.args.slice(0, 4)).toEqual(["pr", "list", "--state", "closed"]);
  });

  it("reads a pull request with its commits and the posting account", async () => {
    const { gh } = fakeGh({ "pr view": JSON.stringify({ ...raw, body: null, headRefOid: "h".repeat(40), baseRefOid: "b".repeat(40) }), "api user": "ada\n" });
    expect(await new GitHubPulls(gh).get("/repo", 7)).toMatchObject({ number: 7, body: "", headSha: "h".repeat(40), baseSha: "b".repeat(40), viewer: "ada" });
  });

  it("posts a review to the pull request's own repository", async () => {
    const { gh, calls } = fakeGh({ "api --method": JSON.stringify({ html_url: "https://github.com/acme/app/pull/7#pullrequestreview-1" }) });
    const posted = await new GitHubPulls(gh).submitReview("/repo", raw.url, { commitId: "c".repeat(40), event: "comment", body: "Looks close.", comments: [] });
    expect(posted.url).toBe("https://github.com/acme/app/pull/7#pullrequestreview-1");
    expect(calls[0]!.args).toEqual(["api", "--method", "POST", "repos/acme/app/pulls/7/reviews", "--input", "-"]);
    expect(JSON.parse(calls[0]!.input!)).toEqual({ commit_id: "c".repeat(40), event: "COMMENT", body: "Looks close.", comments: [] });
  });

  it("says what to do instead of repeating gh's output", async () => {
    const signedOut = fakeGh({ "pr list": new GhError("To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable.") });
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
