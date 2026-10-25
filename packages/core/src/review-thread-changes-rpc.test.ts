import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projects, teamDeletedThreads, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { WORKSPACE_ID, type FolderPath, type Project } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { rpcClient } from "./rpc-test-client.js";

let folder: string;
let root: string;
let core: OpenOrc;
let project: Project;

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-thread-changes-"));
  root = path.join(folder, "repo");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "Original\n");
  await commitAll(root, "Initial commit");
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push: () => {} } });
  project = projects.insert(core.db, { name: "Changes", rootPath: root, defaultBranch: "main", gitRemote: null, settings: {} });
});

afterEach(async () => {
  await core?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});

const call = rpcClient(() => core);
/** A path as a phone sends it, before the schema checks it. */
const at = (file: string) => file as FolderPath;

async function worktreeThread() {
  const thread = threads.insert(core.db, { projectId: project.id, title: "Worktree", agent: "codex", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
  const baseSha = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const worktreePath = path.join(folder, "worktree");
  await git(root, ["worktree", "add", "-q", "-b", "feature/changes", worktreePath]);
  threads.update(core.db, thread.id, { baseSha, worktreePath, branch: "feature/changes" });
  return { thread, baseSha, worktreePath };
}

it("lists a worktree thread's changes against its base or HEAD, with true totals and no patch", async () => {
  const { thread, baseSha, worktreePath } = await worktreeThread();
  await writeFile(path.join(worktreePath, "committed.ts"), "export const a = 1;\nexport const b = 2;\n");
  await commitAll(worktreePath, "Branch work");
  await writeFile(path.join(worktreePath, "README.md"), "Changed\n");
  await writeFile(path.join(root, "root-only.txt"), "Another workspace\n");

  const branch = await call("review.threadChanges", { threadId: thread.id });
  expect(branch).toEqual({
    comparison: "base",
    baseSha,
    totals: { files: 2, insertions: 3, deletions: 1 },
    files: [
      { path: "README.md", status: "modified", oldPath: null, body: { kind: "text", insertions: 1, deletions: 1 } },
      { path: "committed.ts", status: "added", oldPath: null, body: { kind: "text", insertions: 2, deletions: 0 } },
    ],
    unlisted: 0,
  });
  const uncommitted = await call("review.threadChanges", { threadId: thread.id, comparison: "head" });
  expect(uncommitted).toMatchObject({ comparison: "head", baseSha: null, totals: { files: 1, insertions: 1, deletions: 1 } });
  expect(JSON.stringify(uncommitted)).not.toContain("@@");
});

it("reads one changed file's diff, and refuses a path with no changes", async () => {
  const { thread } = await worktreeThread();
  const checkout = threads.insert(core.db, { projectId: project.id, title: "Checkout", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  await writeFile(path.join(root, "README.md"), "Original\nMore\n");
  expect(await call("review.threadFileDiff", { threadId: checkout.id, path: at("README.md") })).toEqual({
    path: "README.md",
    oldPath: null,
    status: "modified",
    body: { kind: "text", insertions: 1, deletions: 0 },
    patch: "@@ -1 +1,2 @@\n Original\n+More\n",
    cut: null,
  });
  await expect(call("review.threadFileDiff", { threadId: thread.id, path: at("README.md") })).rejects.toThrow("This file has no changes.");
  await expect(call("review.threadFileDiff", { threadId: checkout.id, path: at("missing.ts") })).rejects.toThrow("This file has no changes.");
  await expect(call("review.threadFileDiff", { threadId: checkout.id, path: at("../outside.txt") })).rejects.toThrow(/invalid params for review.threadFileDiff/);
  await expect(call("review.threadFileDiff", { threadId: checkout.id, path: at("/etc/hosts") })).rejects.toThrow(/invalid params for review.threadFileDiff/);
});

it("keeps Workspace conversations and deleted team conversations out of both reads", async () => {
  const workspace = threads.insert(core.db, { projectId: WORKSPACE_ID, title: "Folder", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  await expect(call("review.threadChanges", { threadId: workspace.id })).rejects.toThrow("Git review is available in project conversations. Workspace uses ordinary folders.");
  const deleted = threads.insert(core.db, { projectId: project.id, title: "Deleted", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  const hidden = vi.spyOn(teamDeletedThreads, "has").mockImplementation((_db, id) => id === deleted.id);
  for (const read of [() => call("review.threadChanges", { threadId: deleted.id }), () => call("review.threadFileDiff", { threadId: deleted.id, path: at("README.md") })]) {
    await expect(read()).rejects.toThrow("This conversation was deleted. Its saved tasks keep their team activity and controls.");
  }
  hidden.mockRestore();
});

it("says whether gh is installed without the Mac's paths", async () => {
  const gh = await call("system.gh", {});
  expect(Object.keys(gh)).toEqual(["installed"]);
  expect(typeof gh.installed).toBe("boolean");
  await expect(call("system.gh", { refresh: true } as never)).rejects.toThrow(/invalid params for system.gh/);
});
