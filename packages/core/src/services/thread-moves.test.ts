import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { commitAll, git, pinObject, treeHash } from "@openorc/git";
import { checkpoints, tasks, threads } from "@openorc/db";
import type { CorePush, Project, RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { checkpointRefs } from "./checkpoint-refs.js";

let root: string;
let dataDir: string;
let core: OpenOrc;
let project: Project;
const pushed: CorePush[] = [];
let rpcId = 0;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-moves-repo-")));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-moves-data-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await writeFile(path.join(root, "tracked.txt"), "original\n");
  await writeFile(path.join(root, "gone.txt"), "deleted by the conversation\n");
  await commitAll(root, "init");
  core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push: (message) => pushed.push(message) } });
  project = await core.projects.import(root);
});

afterAll(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await git(root, ["reset", "-q", "--hard", "HEAD"]);
  await git(root, ["clean", "-qfd"]);
});

async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const id = ++rpcId;
  await core.handle({ type: "rpc", id, method, params });
  const response = pushed.find((message) => (message.type === "rpc.result" || message.type === "rpc.error") && message.id === id);
  if (!response || (response.type !== "rpc.result" && response.type !== "rpc.error")) throw new Error("Missing RPC response");
  if (response.type === "rpc.error") throw new Error(response.message);
  return response.result as RpcResults[M];
}

const insert = (title: string) => threads.insert(core.db, { projectId: project.id, title, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
const text = (dir: string, file: string) => readFile(path.join(dir, file), "utf8");
const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  );

/** What a text patch used to lose or mangle: a large file, binary bytes, a non-ASCII path, a symlink, a mode, a deletion, and a staged edit. */
async function makeWork(dir: string) {
  const big = randomBytes(5 * 1024 * 1024);
  const binary = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13, 0]);
  await writeFile(path.join(dir, "big.bin"), big);
  await writeFile(path.join(dir, "image.bin"), binary);
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "docs", "café résumé.md"), "Accents travel.\n");
  await symlink("README.md", path.join(dir, "link"));
  await writeFile(path.join(dir, "run.sh"), "#!/bin/sh\necho hi\n");
  await chmod(path.join(dir, "run.sh"), 0o755);
  await rm(path.join(dir, "gone.txt"));
  await writeFile(path.join(dir, "tracked.txt"), "staged edit\n");
  await git(dir, ["add", "tracked.txt"]);
  return { big, binary };
}

async function expectWork(dir: string, work: Awaited<ReturnType<typeof makeWork>>) {
  expect(await readFile(path.join(dir, "big.bin"))).toEqual(work.big);
  expect(await readFile(path.join(dir, "image.bin"))).toEqual(work.binary);
  expect(await text(dir, "docs/café résumé.md")).toBe("Accents travel.\n");
  expect(await readlink(path.join(dir, "link"))).toBe("README.md");
  expect((await lstat(path.join(dir, "run.sh"))).mode & 0o111).not.toBe(0);
  expect(await exists(path.join(dir, "gone.txt"))).toBe(false);
  expect(await text(dir, "tracked.txt")).toBe("staged edit\n");
}

describe("moving a conversation", () => {
  it("carries every change into a worktree byte for byte and back, leaving each source as it was", async () => {
    const thread = insert("Carry everything");
    const work = await makeWork(root);
    const preview = await call("threads.movePreview", { id: thread.id, to: "worktree" });
    expect(preview.blocked).toBeNull();
    expect(preview.files.map((file) => `${file.status} ${file.path}`).sort()).toEqual([
      "added big.bin",
      "added docs/café résumé.md",
      "added image.bin",
      "added link",
      "added run.sh",
      "deleted gone.txt",
      "modified tracked.txt",
    ]);

    const moved = await core.threads.moveWorkspace(thread.id, "worktree");
    expect(moved.workspaceMode).toBe("worktree");
    await expectWork(moved.worktreePath!, work);
    // The checkout is back at HEAD, its index included: the staged edit left with the rest.
    expect((await git(root, ["status", "--porcelain"])).stdout).toBe("");

    const back = await core.threads.moveWorkspace(thread.id, "current");
    expect(back.workspaceMode).toBe("current");
    await expectWork(root, work);
    expect(await exists(moved.worktreePath!)).toBe(false);
    expect((await git(root, ["branch", "--list", moved.branch!])).stdout).toContain(moved.branch!);
  });

  it("refuses to move a file whose staged version differs from the file on disk, and changes nothing", async () => {
    const thread = insert("Partly staged");
    await writeFile(path.join(root, "tracked.txt"), "staged version\n");
    await git(root, ["add", "tracked.txt"]);
    await writeFile(path.join(root, "tracked.txt"), "newer version on disk\n");
    const preview = await call("threads.movePreview", { id: thread.id, to: "worktree" });
    expect(preview.blocked).toMatch(/tracked\.txt has staged changes/);
    await expect(core.threads.moveWorkspace(thread.id, "worktree")).rejects.toThrow(/tracked\.txt has staged changes/);
    expect((await git(root, ["show", ":tracked.txt"])).stdout).toBe("staged version\n");
    expect(await text(root, "tracked.txt")).toBe("newer version on disk\n");
    expect(threads.get(core.db, thread.id)).toMatchObject({ workspaceMode: "current", worktreePath: null });
  });

  it("refuses to move when both sides changed the same lines, and changes neither", async () => {
    const thread = insert("Clash");
    const moved = await core.threads.moveWorkspace(thread.id, "worktree");
    await writeFile(path.join(moved.worktreePath!, "README.md"), "# from the worktree\n");
    await writeFile(path.join(root, "README.md"), "# from the checkout\n");
    await expect(core.threads.moveWorkspace(thread.id, "current")).rejects.toThrow(/README\.md.*Nothing was moved/);
    expect(await text(moved.worktreePath!, "README.md")).toBe("# from the worktree\n");
    expect(await text(root, "README.md")).toBe("# from the checkout\n");
    expect(threads.get(core.db, thread.id)).toMatchObject({ workspaceMode: "worktree", worktreePath: moved.worktreePath });
  });

  it("merges changes that do not overlap", async () => {
    const thread = insert("Merge both");
    const moved = await core.threads.moveWorkspace(thread.id, "worktree");
    await writeFile(path.join(moved.worktreePath!, "tracked.txt"), "original\nfrom the worktree\n");
    await writeFile(path.join(root, "README.md"), "# from the checkout\n");
    await core.threads.moveWorkspace(thread.id, "current");
    expect(await text(root, "tracked.txt")).toBe("original\nfrom the worktree\n");
    expect(await text(root, "README.md")).toBe("# from the checkout\n");
  });

  it("takes nothing from the checkout when the move fails, and removes only what it created", async () => {
    const thread = insert("Fails midway");
    const work = await makeWork(root);
    const prepare = core.workspaces.prepareThread.bind(core.workspaces);
    const failing = vi.spyOn(core.workspaces, "prepareThread").mockImplementation(async (...args) => {
      await prepare(...args);
      throw new Error("setup failed");
    });
    try {
      await expect(core.threads.moveWorkspace(thread.id, "worktree")).rejects.toThrow("setup failed");
    } finally {
      failing.mockRestore();
    }
    await expectWork(root, work);
    expect((await git(root, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("tracked.txt");
    expect(threads.get(core.db, thread.id)).toMatchObject({ workspaceMode: "current", worktreePath: null });
    expect((await git(root, ["worktree", "list"])).stdout).not.toContain("fails-midway");
    expect((await git(root, ["branch", "--list", "*fails-midway*"])).stdout.trim()).toBe("");
  });

  it("never adopts an existing branch that has the conversation's name", async () => {
    const thread = insert("Taken name");
    const name = core.workspaces.threadBranch({ ...thread, branch: null }, project);
    await git(root, ["checkout", "-q", "-b", name]);
    await writeFile(path.join(root, "old.txt"), "older work\n");
    await commitAll(root, "older work");
    const older = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    await git(root, ["checkout", "-q", "main"]);
    const moved = await core.threads.moveWorkspace(thread.id, "worktree");
    expect(moved.branch).toBe(`${name}-2`);
    expect((await git(root, ["rev-parse", name])).stdout.trim()).toBe(older);
    expect(await exists(path.join(moved.worktreePath!, "old.txt"))).toBe(false);
  });
});

describe("checkpoints", () => {
  async function checkpoint(threadId: string, turn: number, pinned = true) {
    const tree = await treeHash(root);
    if (pinned) await pinObject(root, `${checkpointRefs(threadId)}${tree}`, tree);
    return checkpoints.insert(core.db, { threadId, runId: null, turn, treeSha: tree, diffStat: { files: 0, insertions: 0, deletions: 0, untracked: 0 }, root });
  }

  it("survive git gc, restore exactly, and can be undone", async () => {
    const thread = insert("Checkpoint me");
    await writeFile(path.join(root, "notes.txt"), "turn one\n");
    const first = await checkpoint(thread.id, 1);
    await writeFile(path.join(root, "notes.txt"), "turn two\n");
    await writeFile(path.join(root, "later.txt"), "made after the checkpoint\n");
    await git(root, ["add", "later.txt"]);
    await git(root, ["gc", "-q", "--prune=now"]);

    const preview = await call("threads.restorePreview", { id: thread.id, checkpointId: first.id });
    expect(preview.files.map((file) => `${file.status} ${file.path}`).sort()).toEqual(["deleted later.txt", "modified notes.txt"]);
    await core.threads.restore(thread.id, first.id);
    expect(await text(root, "notes.txt")).toBe("turn one\n");
    expect(await exists(path.join(root, "later.txt"))).toBe(false);
    // Staged changes stay staged.
    expect((await git(root, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("later.txt");

    const list = checkpoints.listForThread(core.db, thread.id);
    expect(list.map((item) => item.note)).toEqual([null, "Before restoring turn 1", "Restored turn 1"]);
    await core.threads.restore(thread.id, list[1]!.id);
    expect(await text(root, "notes.txt")).toBe("turn two\n");
    expect(await text(root, "later.txt")).toBe("made after the checkpoint\n");
  });

  it("go away with their conversation", async () => {
    const thread = insert("Forget me");
    await writeFile(path.join(root, "gone-soon.txt"), "pinned\n");
    await checkpoint(thread.id, 1);
    expect((await git(root, ["for-each-ref", checkpointRefs(thread.id)])).stdout).not.toBe("");
    await core.threads.delete(thread.id);
    expect((await git(root, ["for-each-ref", checkpointRefs(thread.id)])).stdout).toBe("");
  });

  it("refuse to restore into another folder, or once Git has removed their files", async () => {
    const thread = insert("Elsewhere");
    await writeFile(path.join(root, "unique.txt"), `only here ${Date.now()}\n`);
    const unpinned = await checkpoint(thread.id, 1, false);
    const moved = checkpoints.insert(core.db, { ...unpinned, root: dataDir });
    await rm(path.join(root, "unique.txt"));
    await git(root, ["gc", "-q", "--prune=now"]);
    await expect(core.threads.restore(thread.id, moved.id)).rejects.toThrow(/saved in a worktree at .*now works in the project checkout/);
    expect((await call("threads.restorePreview", { id: thread.id, checkpointId: unpinned.id })).blocked).toMatch(/Git no longer has this checkpoint's files/);
  });
});

describe("removing a task's worktree", () => {
  async function taskWithWork(title: string) {
    const task = tasks.insert(core.db, { projectId: project.id, title, spec: null, priority: "none", labels: [], workspaceMode: "worktree", baseRef: null, parentTaskId: null });
    const prepared = await core.workspaces.prepare(task, project);
    // Unique content: identical commits made within the same second would share a hash across branches.
    await writeFile(path.join(prepared.worktreePath!, "feature.txt"), `${title}: committed only on this branch\n`);
    await commitAll(prepared.worktreePath!, "feature");
    await writeFile(path.join(prepared.worktreePath!, "draft.txt"), "not committed\n");
    return prepared;
  }

  it("keeps the branch by default, with the uncommitted work committed to it", async () => {
    const task = await taskWithWork("Keep my branch");
    await call("tasks.delete", { id: task.id });
    expect(await exists(task.worktreePath!)).toBe(false);
    expect((await git(root, ["show", `${task.branch}:draft.txt`])).stdout).toBe("not committed\n");
  });

  it("deletes a branch holding the only copy of work only once that loss is accepted", async () => {
    const task = await taskWithWork("Delete my branch");
    const impact = await call("workspace.removalImpact", { taskId: task.id });
    expect(impact).toEqual({ branch: task.branch, uncommitted: 1, commits: 1 });
    await expect(call("tasks.delete", { id: task.id, deleteBranch: true })).rejects.toThrow(/1 uncommitted file in its worktree and 1 commit that no other branch/);
    expect(await exists(task.worktreePath!)).toBe(true);
    expect(tasks.get(core.db, task.id)).not.toBeNull();
    await call("tasks.delete", { id: task.id, deleteBranch: true, acceptLoss: { uncommitted: 1, commits: 1 } });
    expect((await git(root, ["branch", "--list", task.branch!])).stdout.trim()).toBe("");
  });
});
