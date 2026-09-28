import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { projects, threads } from "@openorc/db";
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
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-uncommitted-"));
  root = path.join(folder, "repo");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "Original\n");
  await commitAll(root, "Initial commit");
  pushed = [];
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  project = projects.insert(core.db, { name: "Composer", rootPath: root, defaultBranch: "main", gitRemote: null, settings: {} });
});

afterEach(async () => {
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

it("separates uncommitted worktree edits from the existing branch comparison through RPC", async () => {
  const thread = threads.insert(core.db, { projectId: project.id, title: "Worktree", agent: "codex", model: null, mode: "plan", permissionMode: "trusted", workspaceMode: "worktree" });
  const baseSha = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const worktreePath = path.join(folder, "worktree");
  await git(root, ["worktree", "add", "-q", "-b", "feature/composer", worktreePath]);
  threads.update(core.db, thread.id, { baseSha, worktreePath, branch: "feature/composer" });
  await writeFile(path.join(worktreePath, "README.md"), "Committed branch work\n");
  await commitAll(worktreePath, "Branch work");
  expect((await call("review.threadDiff", { threadId: thread.id })).patch).toContain("+Committed branch work");
  expect((await call("review.threadDiff", { threadId: thread.id, comparison: "head" })).files).toEqual([]);

  await writeFile(path.join(root, "root-only.txt"), "Other workspace\n");
  await writeFile(path.join(worktreePath, "README.md"), "Uncommitted work\n");
  await git(worktreePath, ["add", "README.md"]);
  await writeFile(path.join(worktreePath, "binary.dat"), Buffer.from([0, 1, 0, 2]));
  const dirty = await call("review.threadDiff", { threadId: thread.id, comparison: "head" });
  expect(dirty.files.map((file) => file.path).sort()).toEqual(["README.md", "binary.dat"]);
  expect(dirty.patch).toContain("-Committed branch work");
  await call("review.commitThread", { threadId: thread.id, message: "Commit only this worktree" });
  expect((await call("review.threadDiff", { threadId: thread.id, comparison: "head" })).files).toEqual([]);
  expect((await call("review.threadDiff", { threadId: thread.id })).files.length).toBeGreaterThan(0);
  expect((await call("review.projectDiff", { projectId: project.id })).files.map((file) => file.path)).toEqual(["root-only.txt"]);
});

it("reports and commits binary-only project changes before a thread exists", async () => {
  await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 0, 2]));
  const diff = await call("review.projectDiff", { projectId: project.id });
  expect(diff.files.map((file) => file.path)).toEqual(["binary.dat"]);
  expect(diff.patch).not.toMatch(/^\+[^+]/m);
  await call("review.commitProject", { projectId: project.id, message: "Add binary" });
  expect((await call("review.projectDiff", { projectId: project.id })).files).toEqual([]);
  expect(threads.list(core.db, { projectId: project.id })).toEqual([]);
});
