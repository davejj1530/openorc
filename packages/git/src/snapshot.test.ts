import { chmod, lstat, mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "./exec.js";
import { commitAll } from "./publish.js";
import { switchFiles, treeHash } from "./snapshot.js";

let root: string;

/** The tree a snapshot must produce: HEAD plus every change in the working tree, built from a fresh index. */
async function referenceTree(cwd: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-reference-"));
  const env = { GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    await git(cwd, ["read-tree", "HEAD"], { env });
    await git(cwd, ["add", "-A"], { env });
    return (await git(cwd, ["write-tree"], { env })).stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-snapshot-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, ".gitignore"), "dist/\n");
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) await writeFile(path.join(root, name), `${name}\n`);
  await commitAll(root, "init");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("treeHash", () => {
  it.each(["--skip-worktree"])("sees changes the real index hides with %s", async (flag) => {
    await git(root, ["update-index", flag, "a.txt"]);
    await writeFile(path.join(root, "a.txt"), "hidden change\n");
    expect(await treeHash(root)).toBe(await referenceTree(root));
  });

  // Reading an unchanged file is exactly the cost this avoids: an unreadable but unchanged file proves it is not re-read.
  it.skipIf(process.platform === "win32")("does not re-read files the real index already knows are unchanged", async () => {
    await git(root, ["config", "core.trustctime", "false"]);
    const old = new Date(Date.now() - 60_000);
    await utimes(path.join(root, "d.txt"), old, old);
    await git(root, ["update-index", "--really-refresh"]);
    await writeFile(path.join(root, "a.txt"), "changed\n");
    const expected = await referenceTree(root);
    await chmod(path.join(root, "d.txt"), 0o000);
    try {
      expect(await treeHash(root)).toBe(expected);
    } finally {
      await chmod(path.join(root, "d.txt"), 0o644);
    }
  });
});

describe("switchFiles", () => {
  const read = (name: string) => readFile(path.join(root, name), "utf8");
  const head = async () => (await git(root, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
  const realIndex = async () => (await git(root, ["ls-files", "-s", "-v"])).stdout;

  it("moves the working tree between two trees without touching the real index", async () => {
    await writeFile(path.join(root, "a.txt"), "changed\n");
    await writeFile(path.join(root, "new.txt"), "new\n");
    await unlink(path.join(root, "b.txt"));
    await git(root, ["add", "a.txt"]);
    const index = await realIndex();
    const current = await treeHash(root);
    await switchFiles(root, current, await head());
    expect([await read("a.txt"), await read("b.txt")]).toEqual(["a.txt\n", "b.txt\n"]);
    await expect(lstat(path.join(root, "new.txt"))).rejects.toThrow();
    expect(await realIndex()).toBe(index);
    await switchFiles(root, await head(), current);
    expect([await read("a.txt"), await read("new.txt")]).toEqual(["changed\n", "new\n"]);
    await expect(lstat(path.join(root, "b.txt"))).rejects.toThrow();
  });

  it("refuses, changing nothing, when a file changed after the tree was read", async () => {
    await writeFile(path.join(root, "a.txt"), "changed\n");
    await writeFile(path.join(root, "new.txt"), "new\n");
    const current = await treeHash(root);
    await writeFile(path.join(root, "new.txt"), "edited meanwhile\n");
    await expect(switchFiles(root, current, await head())).rejects.toThrow();
    expect([await read("a.txt"), await read("new.txt")]).toEqual(["changed\n", "edited meanwhile\n"]);
  });

  it("leaves ignored files alone", async () => {
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "dist", "bundle.js"), "built\n");
    await writeFile(path.join(root, "a.txt"), "changed\n");
    await switchFiles(root, await treeHash(root), await head());
    expect(await read("dist/bundle.js")).toBe("built\n");
  });
});
