import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projects, pullReviews, threads } from "@openorc/db";
import * as gitTools from "@openorc/git";
import { commitAll, git } from "@openorc/git";
import type { CorePush, Project, RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";

let folder: string;
let root: string;
let core: OpenOrc;
let project: Project;
let pushed: CorePush[];
let rpcId = 0;

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-push-state-"));
  root = path.join(folder, "repo");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "Original\n");
  await commitAll(root, "Initial commit");
  pushed = [];
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  project = projects.insert(core.db, { name: "Site", rootPath: root, defaultBranch: "main", gitRemote: null, settings: {} });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await core?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});

async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const id = ++rpcId;
  await core.handle({ type: "rpc", id, method, params });
  const response = pushed.find((message) => (message.type === "rpc.result" || message.type === "rpc.error") && message.id === id);
  if (!response || (response.type !== "rpc.result" && response.type !== "rpc.error")) throw new Error("Missing RPC response");
  if (response.type === "rpc.error") throw new Error(response.message);
  return response.result as RpcResults[M];
}

async function addOrigin(): Promise<void> {
  await git(folder, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  await git(root, ["remote", "add", "origin", path.join(folder, "remote.git")]);
  await git(root, ["push", "-q", "-u", "origin", "main"]);
}

it("reports what Push would publish from a shared checkout, and clears once it's pushed", async () => {
  const thread = threads.insert(core.db, { projectId: project.id, title: "Checkout", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  await git(root, ["switch", "-q", "-c", "site"]);
  await writeFile(path.join(root, "README.md"), "Faster\n");
  const sha = await commitAll(root, "perf: site overall improvements");
  expect(await call("git.threadPushState", { threadId: thread.id })).toEqual({
    branch: "site",
    blocked: "This repository has no origin remote to push to.",
    published: false,
    unpushedCount: 0,
    unpushed: [],
  });

  await addOrigin();
  expect(await call("git.threadPushState", { threadId: thread.id })).toEqual({ branch: "site", blocked: null, published: false, unpushedCount: 1, unpushed: [sha] });
  await call("review.pushThread", { threadId: thread.id });
  expect(await call("git.threadPushState", { threadId: thread.id })).toEqual({ branch: "site", blocked: null, published: true, unpushedCount: 0, unpushed: [] });

  await git(root, ["switch", "-q", "--detach"]);
  expect(await call("git.threadPushState", { threadId: thread.id })).toMatchObject({ branch: null, blocked: "The checkout isn't on a branch.", unpushed: [] });
});

it("counts a worktree thread's own branch, not the checkout's", async () => {
  await addOrigin();
  const thread = threads.insert(core.db, { projectId: project.id, title: "Worktree", agent: "codex", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
  const baseSha = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const worktreePath = path.join(folder, "worktree");
  await git(root, ["worktree", "add", "-q", "-b", "feature/site", worktreePath]);
  threads.update(core.db, thread.id, { baseSha, worktreePath, branch: "feature/site" });
  await writeFile(path.join(worktreePath, "README.md"), "Branch work\n");
  const sha = await commitAll(worktreePath, "Branch work");
  await writeFile(path.join(root, "README.md"), "Checkout work\n");
  await commitAll(root, "Checkout work");

  expect(await call("git.threadPushState", { threadId: thread.id })).toEqual({ branch: "feature/site", blocked: null, published: false, unpushedCount: 1, unpushed: [sha] });
});

it("refuses a pull request until the checkout's branch is on origin with every commit", async () => {
  vi.spyOn(gitTools, "hasGh").mockResolvedValue(true);
  const createPr = vi.spyOn(gitTools, "createPr").mockResolvedValue("https://example.invalid/pull/1");
  const thread = threads.insert(core.db, { projectId: project.id, title: "Checkout", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  await git(root, ["switch", "-q", "-c", "fix/counter"]);
  await expect(call("review.createThreadPr", { threadId: thread.id, title: "Fix", body: "", base: "main" })).rejects.toThrow("This repository has no origin remote to open a pull request from.");

  await addOrigin();
  await expect(call("review.createThreadPr", { threadId: thread.id, title: "Fix", body: "", base: "main" })).rejects.toThrow("Push fix/counter to origin before opening its pull request.");
  await call("review.pushThread", { threadId: thread.id });
  await writeFile(path.join(root, "README.md"), "Fixed\n");
  await commitAll(root, "fix: counter");
  await expect(call("review.createThreadPr", { threadId: thread.id, title: "Fix", body: "", base: "main" })).rejects.toThrow("Push the commit on fix/counter before opening its pull request.");
  expect(createPr).not.toHaveBeenCalled();

  await call("review.pushThread", { threadId: thread.id });
  expect(await call("review.createThreadPr", { threadId: thread.id, title: "Fix", body: "", base: "main" })).toEqual({ url: "https://example.invalid/pull/1" });
  expect(createPr).toHaveBeenCalledWith(await realpath(root), { title: "Fix", body: "", base: "main", head: "fix/counter" });
});

it("opens the pull request into the target the user chose, and says so when GitHub no longer has it", async () => {
  vi.spyOn(gitTools, "hasGh").mockResolvedValue(true);
  const createPr = vi.spyOn(gitTools, "createPr").mockResolvedValue("https://example.invalid/pull/2");
  const hasBranch = vi.spyOn(gitTools.GitHubPulls.prototype, "hasBranch").mockResolvedValue(false);
  const thread = threads.insert(core.db, { projectId: project.id, title: "Checkout", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  await addOrigin();
  await git(root, ["switch", "-q", "-c", "fix/counter"]);
  await call("review.pushThread", { threadId: thread.id });

  expect(await call("review.createThreadPr", { threadId: thread.id, title: "Fix", body: "", base: "dev" })).toEqual({ url: "https://example.invalid/pull/2" });
  expect(createPr).toHaveBeenCalledWith(await realpath(root), { title: "Fix", body: "", base: "dev", head: "fix/counter" });
  expect(hasBranch).not.toHaveBeenCalled();

  createPr.mockRejectedValue(new Error("gh pr create failed: GraphQL: Base ref must be a branch (createPullRequest)"));
  await expect(call("review.createThreadPr", { threadId: thread.id, title: "Fix", body: "", base: "release/9" })).rejects.toThrow("release/9 isn't a branch on GitHub. Choose another target branch.");
  hasBranch.mockResolvedValue(true);
  await expect(call("review.createThreadPr", { threadId: thread.id, title: "Fix", body: "", base: "dev" })).rejects.toThrow("gh pr create failed");
  await expect(call("review.createThreadPr", { threadId: thread.id, title: "Fix", body: "", base: "no good" })).rejects.toThrow("Not a branch name.");
});

it("pushes the checkout's branch outside any conversation, after committing it from a new thread's Changes", async () => {
  await addOrigin();
  await git(root, ["switch", "-q", "-c", "feat/bots"]);
  await call("review.pushProject", { projectId: project.id });
  await writeFile(path.join(root, "README.md"), "Mentions skip the check\n");
  const { sha } = await call("review.commitProject", { projectId: project.id, message: "fix: mentions skip the check" });

  expect((await call("git.projectLog", { projectId: project.id }))[0]).toMatchObject({ sha, subject: "fix: mentions skip the check" });
  expect(await call("git.projectPushState", { projectId: project.id })).toEqual({ branch: "feat/bots", blocked: null, published: true, unpushedCount: 1, unpushed: [sha] });
  expect(await call("review.pushProject", { projectId: project.id })).toEqual({ remote: "origin", branch: "feat/bots" });
  expect(await call("git.projectPushState", { projectId: project.id })).toEqual({ branch: "feat/bots", blocked: null, published: true, unpushedCount: 0, unpushed: [] });
  expect((await git(root, ["ls-remote", "origin", "refs/heads/feat/bots"])).stdout.split(/\s/)[0]).toBe(sha);

  await git(root, ["switch", "-q", "--detach"]);
  expect(await call("git.projectPushState", { projectId: project.id })).toMatchObject({ branch: null, blocked: "The checkout isn't on a branch." });
  await expect(call("review.pushProject", { projectId: project.id })).rejects.toThrow("The checkout isn't on a branch.");
});

it("publishes nothing from a pull request's copy under review, and throws the copy away with its conversation", async () => {
  await addOrigin();
  await git(root, ["switch", "-q", "-c", "feat/mine"]);
  await writeFile(path.join(root, "README.md"), "Mine, not pushed\n");
  await commitAll(root, "mine");
  const copy = path.join(folder, "review-copy");
  await git(root, ["worktree", "add", "-q", "--detach", copy, "HEAD"]);
  const thread = threads.insert(core.db, { projectId: project.id, title: "Review #7", agent: "codex", model: null, mode: "plan", permissionMode: "review", workspaceMode: "worktree" });
  threads.update(core.db, thread.id, { worktreePath: copy, baseSha: (await git(copy, ["rev-parse", "HEAD"])).stdout.trim() });
  pullReviews.open(core.db, { projectId: project.id, number: 7 }, "c".repeat(40));
  pullReviews.update(core.db, { projectId: project.id, number: 7 }, { threadId: thread.id });
  await writeFile(path.join(copy, "README.md"), "Edited in the review\n");

  // The checkout's own branch, with a commit origin lacks, is none of this conversation's business.
  const refusal = "This conversation's copy is on no branch, so nothing in it is committed or pushed.";
  expect(await call("git.threadPushState", { threadId: thread.id })).toMatchObject({ branch: null, blocked: refusal, unpushedCount: 0 });
  await expect(call("review.commitThread", { threadId: thread.id, message: "Should not commit" })).rejects.toThrow(refusal);
  await expect(call("review.pushThread", { threadId: thread.id })).rejects.toThrow(refusal);

  await core.threads.delete(thread.id);
  expect(
    await access(copy).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});
