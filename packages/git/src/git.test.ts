import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "./exec.js";
import { changedFiles, log, patchAgainst, repoInfo } from "./repo.js";
import { diffStat, treeHash } from "./snapshot.js";
import { commitAll, push, unpushedCommits } from "./publish.js";
import * as worktree from "./worktree.js";

let root: string;
let baseSha: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-git-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await writeFile(path.join(root, ".gitignore"), ".env\n");
  await writeFile(path.join(root, ".env"), "SECRET=1\n");
  baseSha = await commitAll(root, "init");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("repo", () => {
  it("reads repo info", async () => {
    const info = await repoInfo(root);
    expect(info.root).toBe(await realpath(root));
    expect(info.branch).toBe("main");
    expect(info.defaultBranch).toBe("main");
    expect(info.headSha).toBe(baseSha);
    expect(info.remoteUrl).toBeNull();
  });

  it("lists changed and untracked files and builds a patch", async () => {
    await writeFile(path.join(root, "README.md"), "# demo\nmore\n");
    await writeFile(path.join(root, "new.ts"), "export const x = 1;\n");
    const files = await changedFiles(root, baseSha);
    expect(files).toEqual([
      { path: "README.md", status: "modified", oldPath: null },
      { path: "new.ts", status: "untracked", oldPath: null },
    ]);
    const patch = await patchAgainst(root, baseSha);
    expect(patch).toContain("diff --git a/README.md b/README.md");
    expect(patch).toContain("+more");
    expect(patch).toContain("diff --git a/new.ts b/new.ts");
    expect(patch).toContain("+export const x = 1;");
    expect(patch).not.toContain(".env");
    const stat = await diffStat(root, baseSha);
    expect(stat).toEqual({ files: 1, insertions: 1, deletions: 0, untracked: 1 });
  });

  it("hashes the working tree including untracked files without touching the index", async () => {
    const a = await treeHash(root);
    await writeFile(path.join(root, "new.ts"), "export const x = 2;\n");
    const b = await treeHash(root);
    expect(a).not.toBe(b);
    const status = (await git(root, ["status", "--porcelain"])).stdout;
    expect(status).toContain("?? new.ts");
  });
});

describe("worktree", () => {
  it("adds on a new branch, lists, locks, removes", async () => {
    const wt = path.join(root, "..", path.basename(root) + "-wt");
    await worktree.add(root, { path: wt, branch: "openorc/demo-abc1", startPoint: baseSha });
    let entries = await worktree.list(root);
    expect(entries.map((e) => e.branch)).toContain("openorc/demo-abc1");
    await worktree.lock(root, wt, "run-1");
    entries = await worktree.list(root);
    expect(entries.find((e) => e.branch === "openorc/demo-abc1")?.locked).toBe(true);
    await worktree.unlock(root, wt);
    await writeFile(path.join(wt, "feature.ts"), "export const f = 1;\n");
    const sha = await commitAll(wt, "feature");
    expect((await log(wt, `${baseSha}..HEAD`)).map((c) => c.subject)).toEqual(["feature"]);
    expect(sha).not.toBe(baseSha);
    await worktree.remove(root, wt, { force: true });
    await worktree.deleteBranch(root, "openorc/demo-abc1", { force: true });
    entries = await worktree.list(root);
    expect(entries.map((e) => e.branch)).not.toContain("openorc/demo-abc1");
  });

  it("saves uncommitted work onto the branch, skipping hooks and ignored files, before a removal", async () => {
    const wt = path.join(root, "..", path.basename(root) + "-save");
    await worktree.add(root, { path: wt, branch: "openorc/save-abc1", startPoint: baseSha });
    expect(await worktree.saveChanges(wt, "save")).toBeNull();
    await writeFile(path.join(wt, "README.md"), "# demo\nedited\n");
    await writeFile(path.join(wt, "new.ts"), "export const n = 1;\n");
    await writeFile(path.join(wt, ".env"), "SECRET=2\n");
    // A hook that would refuse the commit: saving work must not depend on the repository's checks.
    const hooks = path.join(root, "..", path.basename(root) + "-hooks");
    await mkdir(hooks);
    await writeFile(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await git(wt, ["config", "core.hooksPath", hooks]);
    const saved = await worktree.saveChanges(wt, "Save uncommitted work before removing the worktree");
    await git(wt, ["config", "--unset", "core.hooksPath"]);
    expect(saved).toMatchObject({ paths: 2 });
    await worktree.remove(root, wt, { force: true });
    const files = (await git(root, ["ls-tree", "-r", "--name-only", "openorc/save-abc1"])).stdout.split("\n");
    expect(files).toEqual(expect.arrayContaining(["README.md", "new.ts"]));
    expect(files).not.toContain(".env");
    expect((await git(root, ["show", "openorc/save-abc1:README.md"])).stdout).toContain("edited");
    await worktree.deleteBranch(root, "openorc/save-abc1", { force: true });
    await rm(hooks, { recursive: true, force: true });
  });

  it("refuses to save a worktree that is not on a branch", async () => {
    const wt = path.join(root, "..", path.basename(root) + "-detached");
    await git(root, ["worktree", "add", "--detach", wt, baseSha]);
    await writeFile(path.join(wt, "loose.ts"), "export const l = 1;\n");
    await expect(worktree.saveChanges(wt, "save")).rejects.toThrow(/not on a branch/);
    await worktree.remove(root, wt, { force: true });
  });
});

describe("push", () => {
  let folder: string;
  let local: string;

  beforeAll(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), "openorc-push-"));
    local = path.join(folder, "local");
    await git(folder, ["init", "-q", "-b", "main", local]);
    await git(local, ["config", "user.email", "test@example.com"]);
    await git(local, ["config", "user.name", "Test"]);
    await writeFile(path.join(local, "README.md"), "# demo\n");
    await commitAll(local, "init");
  });

  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  const main = { rev: "refs/heads/main", branch: "main" };

  it("counts what origin lacks from local refs alone, and names the fix for a rejected push", async () => {
    expect(await unpushedCommits(local, main)).toBeNull();

    await git(folder, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
    await git(local, ["remote", "add", "origin", path.join(folder, "remote.git")]);
    const init = (await git(local, ["rev-parse", "HEAD"])).stdout.trim();
    expect(await unpushedCommits(local, main)).toEqual({ published: false, count: 1, shas: [init] });

    await push(local, "main");
    expect(await unpushedCommits(local, main)).toEqual({ published: true, count: 0, shas: [] });

    // A new branch owes origin only its own commits; the ones it shares with main are there already.
    await git(local, ["switch", "-q", "-c", "feature"]);
    const feature = { rev: "refs/heads/feature", branch: "feature" };
    expect(await unpushedCommits(local, feature)).toEqual({ published: false, count: 0, shas: [] });
    await writeFile(path.join(local, "feature.ts"), "export const f = 1;\n");
    const first = await commitAll(local, "first");
    await writeFile(path.join(local, "feature.ts"), "export const f = 2;\n");
    const second = await commitAll(local, "second");
    expect(await unpushedCommits(local, feature)).toEqual({ published: false, count: 2, shas: [second, first] });
    expect(await unpushedCommits(local, { ...feature, limit: 1 })).toEqual({ published: false, count: 2, shas: [second] });

    const other = path.join(folder, "other");
    await git(folder, ["clone", "-q", "-b", "main", "remote.git", other]);
    await git(other, ["config", "user.email", "other@example.com"]);
    await git(other, ["config", "user.name", "Other"]);
    await writeFile(path.join(other, "theirs.md"), "Theirs\n");
    await commitAll(other, "theirs");
    await git(other, ["push", "-q", "origin", "main"]);
    await git(local, ["switch", "-q", "main"]);
    await writeFile(path.join(local, "mine.md"), "Mine\n");
    await commitAll(local, "mine");
    await expect(push(local, "main")).rejects.toThrow("origin has newer commits on main. Pull them in first, then push again.");
  });
});

async function realpath(p: string): Promise<string> {
  return (await git(p, ["rev-parse", "--show-toplevel"])).stdout.trim();
}
