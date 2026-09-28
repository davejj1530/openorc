import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Db, checkpoints, projects, pullReviews, runs, threads } from "@openorc/db";
import { GhError, GitHubPulls, commitAll, git, type GhRunner, type ReviewSubmission } from "@openorc/git";
import type { SystemInfo, Thread } from "@openorc/protocol";
import { PullRequestService, type PullRequestServiceOptions } from "./pull-requests.js";
import { WorkspaceWriters } from "./workspace-writers.js";

const url = "https://github.com/acme/app/pull/7";

/** A repository whose origin plays GitHub: it publishes pull request 7 under refs/pull/7/head. */
async function repository(root: string) {
  const upstream = path.join(root, "upstream");
  const clone = path.join(root, "clone");
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-q", "-b", "main", upstream]);
  await git(upstream, ["config", "user.email", "test@example.com"]);
  await git(upstream, ["config", "user.name", "Test"]);
  await writeFile(path.join(upstream, "app.ts"), "export function start() {\n  const port = 3000;\n  return port;\n}\n");
  const base = await commitAll(upstream, "init");
  await git(upstream, ["checkout", "-q", "-b", "feat/retries"]);
  await writeFile(path.join(upstream, "app.ts"), "export function start() {\n  const port = 3000;\n  const retries = 3;\n  return port;\n}\n");
  const head = await commitAll(upstream, "retries");
  await git(upstream, ["checkout", "-q", "main"]);
  await git(upstream, ["update-ref", "refs/pull/7/head", head]);
  await git(root, ["clone", "-q", "--single-branch", "--branch", "main", upstream, clone]);
  await git(clone, ["remote", "set-url", "origin", "https://github.com/acme/app.git"]);
  await git(clone, ["config", `url.${upstream}.insteadOf`, "https://github.com/acme/app.git"]);
  return { clone, base, head };
}

function detail(head: string, base: string) {
  return JSON.stringify({
    number: 7,
    title: "Add retries",
    url,
    author: { login: "ada" },
    state: "OPEN",
    isDraft: false,
    headRefName: "feat/retries",
    baseRefName: "main",
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-02T10:00:00Z",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    reviewDecision: "",
    labels: [],
    body: "Retry the listener three times.",
    headRefOid: head,
    baseRefOid: base,
  });
}

let root: string;
let repo: Awaited<ReturnType<typeof repository>>;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-pull-service-"));
  repo = await repository(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Adds a commit to the pull request's branch upstream, as the author pushing a fix, and returns it. */
async function push(source: Awaited<ReturnType<typeof repository>>, content: string): Promise<string> {
  const upstream = path.join(path.dirname(source.clone), "upstream");
  await git(upstream, ["checkout", "-q", "feat/retries"]);
  await writeFile(path.join(upstream, "app.ts"), content);
  const head = await commitAll(upstream, "address review");
  await git(upstream, ["checkout", "-q", "main"]);
  await git(upstream, ["update-ref", "refs/pull/7/head", head]);
  return head;
}

function setup(
  overrides: {
    activity?: "idle" | "running";
    posted?: { args: string[]; input?: string }[];
    /** Holds GitHub's answer to a posted review until it resolves. */
    posting?: Promise<void>;
    startFails?: Error;
    repo?: Awaited<ReturnType<typeof repository>>;
    head?: () => string;
  } = {},
) {
  const source = overrides.repo ?? repo;
  const db = Db.memory();
  const project = projects.insert(db, { name: "App", rootPath: source.clone, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
  const posted = overrides.posted ?? [];
  const gh: GhRunner = async (_cwd, args, input) => {
    if (args[0] === "pr" && args[1] === "view") return detail(overrides.head?.() ?? source.head, source.base);
    if (args[0] === "api" && args[1] === "user") return "ada\n";
    if (args[0] === "api" && args[1] === "--method") {
      posted.push({ args, ...(input === undefined ? {} : { input }) });
      await overrides.posting;
      return JSON.stringify({ html_url: `${url}#pullrequestreview-1` });
    }
    throw new GhError(`unexpected gh ${args.join(" ")}`);
  };
  let started: Thread | null = null;
  const start = vi.fn<PullRequestServiceOptions["threads"]["start"]>(async (input, internal) => {
    if (overrides.startFails) throw overrides.startFails;
    const thread = db.transaction(() => {
      const inserted = threads.insert(db, {
        projectId: input.projectId,
        title: input.title!,
        agent: input.agent,
        model: input.model ?? null,
        mode: input.mode,
        permissionMode: input.permissionMode,
        workspaceMode: "worktree",
      });
      const adopted = threads.update(db, inserted.id, { worktreePath: input.checkout!.path, baseSha: input.checkout!.baseSha });
      internal?.onAdmitted(adopted);
      return adopted;
    });
    started = thread;
    const run = runs.insert(db, { id: `run-${thread.id}`, taskId: null, threadId: thread.id, agent: input.agent, model: input.model ?? null, mode: input.mode, permissionMode: input.permissionMode });
    return { thread, run };
  });
  const invalidate = vi.fn();
  const update = vi.fn((id: string) => threads.get(db, id)!);
  const queueFollowUp = vi.fn(() => ({ messageId: "follow-up" }));
  const appPosts: { url: string; review: ReviewSubmission }[] = [];
  const service = new PullRequestService(db, {
    dataDir: path.join(root, `data-${project.id}`),
    github: new GitHubPulls(gh),
    system: { info: async () => ({ gh: { installed: true, path: "/usr/bin/gh" } }) as SystemInfo },
    threads: { start, update, queueFollowUp },
    runs: {
      threadActivity: () => overrides.activity ?? "idle",
      models: async (agent) => (agent === "claude" ? [{ id: "claude-opus-5-5", label: "Claude Opus 5.5", agent, isDefault: true, efforts: [], defaultEffort: null }] : []),
    },
    reviewerApp: {
      submitReview: async (pullUrl, review) => {
        appPosts.push({ url: pullUrl, review });
        return { url: `${pullUrl}#pullrequestreview-2` };
      },
    },
    writers: new WorkspaceWriters(),
    invalidate,
  });
  return { db, key: { projectId: project.id, number: 7 }, service, start, update, queueFollowUp, invalidate, started: () => started, appPosts };
}

const yours = { path: "app.ts", startLine: null, startSide: null, line: 3, side: "new" as const, lineText: "  const retries = 3;", body: "Make this configurable." };

describe("draft reviews", () => {
  it("keeps a draft's comments on the commit they were written against", () => {
    const { service, key, invalidate } = setup();
    service.comment({ ...key, commitId: "a".repeat(40), ...yours });
    expect(invalidate).toHaveBeenCalledWith(["pull-reviews"]);
    expect(() => service.comment({ ...key, commitId: "b".repeat(40), ...yours })).toThrow("Your draft is for a different version of this pull request (aaaaaaa). Post or discard it first.");
    const [comment] = service.review(key)!.comments;
    service.removeComment(key, comment!.id);
    // An empty draft follows the pull request to its new head.
    service.comment({ ...key, commitId: "b".repeat(40), ...yours });
    expect(service.review(key)).toMatchObject({ commitId: "b".repeat(40), comments: [{ body: "Make this configurable.", author: null }] });
  });

  it("saves a summary written before any comment", () => {
    const { service, key } = setup();
    service.setSummary(key, "a".repeat(40), "");
    expect(service.review(key)).toBeNull();
    service.setSummary(key, "a".repeat(40), "Looks close.");
    expect(service.review(key)).toMatchObject({ commitId: "a".repeat(40), summary: "Looks close." });
  });

  it("posts one review with every draft comment, then empties the draft", async () => {
    const posted: { args: string[]; input?: string }[] = [];
    const { service, key, db } = setup({ posted });
    service.comment({ ...key, commitId: repo.head, ...yours });
    await expect(service.submit(key, { event: "comment", summary: "", as: "you" })).resolves.toEqual({ url: `${url}#pullrequestreview-1` });
    expect(posted[0]!.args.slice(0, 4)).toEqual(["api", "--method", "POST", "repos/acme/app/pulls/7/reviews"]);
    expect(JSON.parse(posted[0]!.input!)).toEqual({ commit_id: repo.head, event: "COMMENT", comments: [{ path: "app.ts", line: 3, side: "RIGHT", body: "Make this configurable." }] });
    expect(pullReviews.get(db, key)).toMatchObject({ summary: "", comments: [] });
  });

  it("posts as the reviewer app, naming the models that drafted the review", async () => {
    const { service, key, db, appPosts } = setup();
    service.comment({ ...key, commitId: repo.head, ...yours });
    pullReviews.addComment(db, key, { ...yours, line: 2, lineText: "  const port = 3000;", body: "Read the port from the environment.", author: { agent: "claude", model: "claude-opus-5-5" } });
    pullReviews.addComment(db, key, { ...yours, body: "Retries need a backoff.", author: { agent: "codex", model: "gpt-6" } });
    await expect(service.submit(key, { event: "request_changes", summary: "Two small fixes.", as: "app" })).resolves.toEqual({ url: `${url}#pullrequestreview-2` });
    expect(appPosts).toHaveLength(1);
    expect(appPosts[0]!.url).toBe(url);
    expect(appPosts[0]!.review).toMatchObject({ commitId: repo.head, event: "request_changes", body: "Review by Claude Opus 5.5 and gpt-6.\n\nTwo small fixes." });
    expect(appPosts[0]!.review.comments).toHaveLength(3);
    expect(pullReviews.get(db, key)).toMatchObject({ summary: "", comments: [] });
  });

  it("leaves a review the user wrote alone when the app posts it", async () => {
    const { service, key, appPosts } = setup();
    service.comment({ ...key, commitId: repo.head, ...yours });
    await service.submit(key, { event: "comment", summary: "", as: "app" });
    expect(appPosts[0]!.review.body).toBe("");
  });

  it("keeps what changed in the draft while the review was posting", async () => {
    const posted: { args: string[]; input?: string }[] = [];
    let answer!: () => void;
    const { service, key } = setup({ posted, posting: new Promise<void>((resolve) => (answer = resolve)) });
    service.setSummary(key, repo.head, "Two small fixes.");
    const edited = service.comment({ ...key, commitId: repo.head, ...yours });
    service.comment({ ...key, commitId: repo.head, ...yours, body: "Posted as written." });
    const submitting = service.submit(key, { event: "comment", summary: "Two small fixes.", as: "you" });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    service.editComment(key, edited.id, "Make this configurable, with a default of 3.");
    service.comment({ ...key, commitId: repo.head, ...yours, body: "Added while posting." });
    answer();
    await submitting;
    expect(JSON.parse(posted[0]!.input!).comments.map((comment: { body: string }) => comment.body)).toEqual(["Make this configurable.", "Posted as written."]);
    expect(service.review(key)).toMatchObject({ summary: "", comments: [{ body: "Make this configurable, with a default of 3." }, { body: "Added while posting." }] });
  });

  it("posts a review without comments on the pull request's newest commit", async () => {
    const posted: { args: string[]; input?: string }[] = [];
    let head = repo.head;
    const { service, key } = setup({ posted, head: () => head });
    service.setSummary(key, head, "Looks close.");
    await service.submit(key, { event: "comment", summary: "Looks close.", as: "you" });
    head = "c".repeat(40);
    await service.submit(key, { event: "approve", summary: "", as: "you" });
    // The emptied draft follows a summary written about the newer commit.
    service.setSummary(key, head, "Still good.");
    expect(service.review(key)).toMatchObject({ commitId: head, summary: "Still good." });
    await service.submit(key, { event: "comment", summary: "Still good.", as: "you" });
    expect(posted.map((post) => JSON.parse(post.input!).commit_id)).toEqual([repo.head, head, head]);
  });

  it("refuses an empty review unless it approves", async () => {
    const posted: { args: string[]; input?: string }[] = [];
    const { service, key } = setup({ posted });
    await expect(service.submit(key, { event: "request_changes", summary: " ", as: "you" })).rejects.toThrow("Write a summary or add a comment before posting.");
    await service.submit(key, { event: "approve", summary: "", as: "you" });
    expect(JSON.parse(posted[0]!.input!)).toEqual({ commit_id: repo.head, event: "APPROVE", comments: [] });
  });
});

describe("model reviews", () => {
  it("reviews in a Plan conversation on a detached checkout of the head", async () => {
    const { service, key, start, db } = setup();
    const { threadId } = await service.start(key, { agent: "claude", model: "claude-opus-5-5", effort: "high", fastMode: false });
    const input = start.mock.calls[0]![0];
    expect(input).toMatchObject({ mode: "plan", permissionMode: "review", model: "claude-opus-5-5", effort: "high", title: "Review #7: Add retries" });
    expect(input.prompt).toContain("Retry the listener three times.");
    // The conversation's own changes count from the head; the review keeps where the pull request's changes start.
    expect(input.checkout!.baseSha).toBe(repo.head);
    expect((await git(input.checkout!.path, ["rev-parse", "HEAD"])).stdout.trim()).toBe(repo.head);
    expect((await git(input.checkout!.path, ["symbolic-ref", "--quiet", "HEAD"], { okCodes: [0, 1] })).code).toBe(1);
    expect(pullReviews.get(db, key)).toMatchObject({ commitId: repo.head, threadId, baseCommit: repo.base });
    expect(threads.get(db, threadId)).toMatchObject({ branch: null, prUrl: url, prState: "open" });
    expect(service.brief(threads.get(db, threadId)!)).toContain("pull request #7");
  });

  it("removes the checkout when the conversation could not start", async () => {
    const { service, key, start } = setup({ startFails: new Error("Claude is not signed in.") });
    await expect(service.start(key, { agent: "claude", model: "claude-opus-5-5", effort: null, fastMode: false })).rejects.toThrow("Claude is not signed in.");
    const checkout = start.mock.calls[0]![0].checkout!.path;
    expect((await git(repo.clone, ["worktree", "list", "--porcelain"])).stdout).not.toContain(checkout);
    await expect(stat(checkout)).rejects.toThrow();
  });

  it("gives the reviewing agent tools that write checked drafts", async () => {
    const { service, key, db, started } = setup();
    await service.start(key, { agent: "codex", model: "gpt-6", effort: null, fastMode: false });
    const runId = `run-${started()!.id}`;
    const tools = service.agentTools();
    expect(tools.available(runId)).toBe(true);
    expect(await tools.diff(runId, { path: "app.ts" })).toContain("+  const retries = 3;");
    await expect(tools.comment(runId, { path: "app.ts", line: 40, side: "new", body: "Off the diff." })).rejects.toThrow("app.ts line 40 (new side) is not in this pull request's diff.");
    await expect(tools.comment(runId, { path: "README.md", line: 1, side: "new", body: "Unchanged." })).rejects.toThrow("README.md is not changed in this pull request.");
    expect(await tools.comment(runId, { path: "app.ts", line: 3, side: "new", startLine: 2, startSide: "new", body: "Name the retry count." })).toBe("Draft comment saved on app.ts:2-3.");
    await tools.summary(runId, "One small change.");
    expect(pullReviews.get(db, key)).toMatchObject({
      summary: "One small change.",
      comments: [{ startLine: 2, line: 3, lineText: "  const port = 3000;\n  const retries = 3;", author: { agent: "codex", model: "gpt-6" } }],
    });
    // Discarding empties the draft; the conversation keeps reviewing this pull request.
    service.discard(key);
    expect(pullReviews.get(db, key)).toMatchObject({ summary: "", comments: [], threadId: started()!.id });
    expect(tools.available(runId)).toBe(true);
  });

  it("keeps a summary the user wrote when the model sums up again, offering the model's beside it", async () => {
    const { service, key, db, started } = setup();
    await service.start(key, { agent: "codex", model: "gpt-6", effort: null, fastMode: false });
    const tools = service.agentTools();
    const runId = `run-${started()!.id}`;
    await tools.summary(runId, "First round: one fix needed.");
    await tools.summary(runId, "Second round: looks good.");
    expect(pullReviews.get(db, key)).toMatchObject({ summary: "Second round: looks good.", modelSummary: "Second round: looks good." });
    service.setSummary(key, repo.head, "Ship it once the tests pass.");
    expect(await tools.summary(runId, "Third round: all fixed.")).toContain("the user wrote, which stays");
    expect(pullReviews.get(db, key)).toMatchObject({ summary: "Ship it once the tests pass.", modelSummary: "Third round: all fixed." });
    service.discard(key);
    expect(pullReviews.get(db, key)).toMatchObject({ summary: "", modelSummary: null });
  });

  it("refuses drafting once the draft has moved past the conversation's copy", async () => {
    const { service, key, started } = setup();
    await service.start(key, { agent: "codex", model: "gpt-6", effort: null, fastMode: false });
    // You comment on a newer push than the conversation has checked out.
    service.comment({ ...key, commitId: "c".repeat(40), ...yours });
    const runId = `run-${started()!.id}`;
    await expect(service.agentTools().comment(runId, { path: "app.ts", line: 3, side: "new", body: "Late." })).rejects.toThrow("The pull request has newer commits than your copy.");
    await expect(service.agentTools().summary(runId, "Late.")).rejects.toThrow("The pull request has newer commits than your copy.");
  });

  it("continues the same conversation for the next round, on the new commits", async () => {
    const again = await repository(path.join(root, "again"));
    let head = again.head;
    const { service, key, db, start, update, queueFollowUp, started } = setup({ repo: again, head: () => head });
    const { threadId } = await service.start(key, { agent: "claude", model: "claude-opus-5-5", effort: null, fastMode: false });
    await service.submit(key, { event: "comment", summary: "Retries need a backoff.", as: "you" });
    const first = head;
    head = await push(again, "export function start() {\n  const port = 3000;\n  const retries = 3;\n  const backoff = 100;\n  return port;\n}\n");

    await expect(service.start(key, { agent: "claude", model: "claude-haiku-4-5", effort: null, fastMode: false })).resolves.toEqual({ threadId });
    expect(start).toHaveBeenCalledTimes(1);
    const thread = threads.get(db, threadId)!;
    expect(thread.baseSha).toBe(head);
    expect((await git(thread.worktreePath!, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect(pullReviews.get(db, key)).toMatchObject({ commitId: head, threadId, baseCommit: again.base });
    // The new code is the next turn's starting point, so the agent isn't credited with the author's commits.
    expect(checkpoints.listForThread(db, threadId).at(-1)).toMatchObject({ runId: null, note: `Pull request #7 at ${head.slice(0, 7)}` });
    expect(update).toHaveBeenCalledWith(threadId, { agent: "claude", model: "claude-haiku-4-5", effort: null, fastMode: false });
    const [request] = queueFollowUp.mock.calls[0] as unknown as [{ threadId: string; text: string }];
    expect(request.threadId).toBe(threadId);
    expect(request.text).toContain(`${first.slice(0, 7)}..${head.slice(0, 7)}`);

    const runId = `run-${started()!.id}`;
    const since = await service.agentTools().diff(runId, { since: first });
    // The hunks that changed after the first round, numbered as the whole pull request's diff numbers them.
    expect(since).toContain("+  const backoff = 100;");
    expect(since).toContain("@@ -1,4 +1,6 @@");
    expect(await service.agentTools().comment(runId, { path: "app.ts", line: 4, side: "new", body: "Make the backoff grow." })).toBe("Draft comment saved on app.ts:4.");
  });

  it("starts a fresh conversation once the last one is archived", async () => {
    const { service, key, db, start } = setup();
    const { threadId } = await service.start(key, { agent: "claude", model: "claude-opus-5-5", effort: null, fastMode: false });
    threads.update(db, threadId, { archivedAt: Date.now() });
    const next = await service.start(key, { agent: "claude", model: "claude-opus-5-5", effort: null, fastMode: false });
    expect(start).toHaveBeenCalledTimes(2);
    expect(next.threadId).not.toBe(threadId);
    expect(pullReviews.get(db, key)?.threadId).toBe(next.threadId);
  });

  it("will not start a second review while one is running", async () => {
    const { service, key, db, started } = setup({ activity: "running" });
    pullReviews.open(db, key, repo.head);
    const thread = threads.insert(db, { projectId: key.projectId, title: "Review #7", agent: "claude", model: null, mode: "plan", permissionMode: "review" });
    pullReviews.update(db, key, { threadId: thread.id });
    await expect(service.start(key, { agent: "claude", model: "claude-opus-5-5", effort: null, fastMode: false })).rejects.toThrow("A model is already reviewing this pull request.");
    expect(started()).toBeNull();
    await expect(service.submit(key, { event: "comment", summary: "Early", as: "you" })).rejects.toThrow("A model is still reviewing.");
  });
});

it("keeps review checkouts beside the app's other worktrees", async () => {
  const { service, key, start } = setup();
  await service.start(key, { agent: "claude", model: "claude-opus-5-5", effort: null, fastMode: false });
  const checkout = start.mock.calls[0]![0].checkout!.path;
  expect(checkout).toContain(`${path.sep}worktrees${path.sep}app-`);
  expect((await stat(checkout)).isDirectory()).toBe(true);
});
