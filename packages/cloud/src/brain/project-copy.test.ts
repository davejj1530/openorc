import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branchHead, bundleBranch, copyHeads, takeBranch } from "./project-copy.js";

const IDENTITY = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
const ORIGIN = "https://github.com/example/app.git";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: "utf8" }).trimEnd();
}

function commit(root: string, name: string, content: string): string {
  writeFileSync(path.join(root, name), content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", `${name}: ${content.trim()}`);
  return git(root, "rev-parse", "HEAD");
}

let base: string;
let mac: string;
let copy: string;
let first: string;

/** The Mac's branch bundled from `since`, as the brain's inbox has it. */
async function send(since: string | null, branch = "main"): Promise<{ file: string; incremental: boolean }> {
  const { bytes, incremental } = await bundleBranch(mac, branch, since);
  const file = path.join(base, `inbox-${Math.random().toString(36).slice(2)}.bundle`);
  await writeFile(file, bytes);
  return { file, incremental };
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "openorc-project-copy-"));
  mac = path.join(base, "mac");
  mkdirSync(mac);
  git(mac, "init", "-q", "-b", "main");
  git(mac, "remote", "add", "origin", ORIGIN);
  first = commit(mac, "a.txt", "a1\n");
  git(mac, "switch", "-q", "-c", "feature");
  commit(mac, "feature.txt", "not on main\n");
  copy = path.join(base, "brain", "projects", "p1", "My App");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("a Mac project's copy on the brain", () => {
  it("clones the default branch with its history and the Mac's origin the first time, whatever branch the Mac is on", async () => {
    const second = (git(mac, "switch", "-q", "main"), commit(mac, "a.txt", "a2\n"));
    git(mac, "switch", "-q", "feature");
    const { file, incremental } = await send(null);
    expect(incremental).toBe(false);
    expect(await takeBranch(copy, file, "main", ORIGIN)).toEqual({ macHead: second, head: second });
    expect(git(copy, "log", "--format=%H", "main").split("\n")).toEqual([second, first]);
    expect(git(copy, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(readFileSync(path.join(copy, "a.txt"), "utf8")).toBe("a2\n");
    expect(existsSync(path.join(copy, "feature.txt"))).toBe(false);
    expect(git(copy, "remote", "get-url", "origin")).toBe(ORIGIN);
  });

  it("sends only what came after the last commit sent, and the copy's checked-out branch fast-forwards to it", async () => {
    await takeBranch(copy, (await send(null)).file, "main", ORIGIN);
    git(mac, "switch", "-q", "main");
    const second = commit(mac, "b.txt", "b1\n");
    const next = await send(first);
    expect(next.incremental).toBe(true);
    expect(git(base, "bundle", "list-heads", next.file)).toBe(`${second} refs/heads/main`);
    expect(
      readFileSync(next.file, "latin1")
        .split("\n\n")[0]!
        .split("\n")
        .filter((line) => line.startsWith("-")),
    ).toEqual([`-${first} a.txt: a1`]);
    expect(await takeBranch(copy, next.file, "main", ORIGIN)).toEqual({ macHead: second, head: second });
    expect(readFileSync(path.join(copy, "b.txt"), "utf8")).toBe("b1\n");
    expect(git(copy, "status", "--porcelain")).toBe("");

    expect(await takeBranch(copy, next.file, "main", ORIGIN)).toEqual({ macHead: second, head: second });
    expect(git(copy, "rev-parse", "main")).toBe(second);
  });

  it("moves a branch the copy has not checked out without touching its files", async () => {
    await takeBranch(copy, (await send(null)).file, "main", ORIGIN);
    git(copy, "switch", "-q", "-c", "elsewhere");
    git(mac, "switch", "-q", "main");
    const second = commit(mac, "b.txt", "b1\n");
    expect(await takeBranch(copy, (await send(first)).file, "main", ORIGIN)).toEqual({ macHead: second, head: second });
    expect(git(copy, "rev-parse", "main")).toBe(second);
    expect(existsSync(path.join(copy, "b.txt"))).toBe(false);
  });

  it("moves the branch of a copy on a detached HEAD without touching its files", async () => {
    await takeBranch(copy, (await send(null)).file, "main", ORIGIN);
    git(copy, "switch", "-q", "--detach");
    git(mac, "switch", "-q", "main");
    const second = commit(mac, "b.txt", "b1\n");
    expect(await takeBranch(copy, (await send(first)).file, "main", ORIGIN)).toEqual({ macHead: second, head: second });
    expect([git(copy, "rev-parse", "HEAD"), existsSync(path.join(copy, "b.txt"))]).toEqual([first, false]);
  });

  it("keeps commits made on the copy's branch, and still takes the Mac's so the next bundle builds on it", async () => {
    await takeBranch(copy, (await send(null)).file, "main", ORIGIN);
    const own = commit(copy, "brain.txt", "made on the brain\n");
    git(mac, "switch", "-q", "main");
    const second = commit(mac, "b.txt", "b1\n");
    expect(await takeBranch(copy, (await send(first)).file, "main", ORIGIN)).toEqual({ macHead: second, head: own });
    expect(git(copy, "rev-parse", "main")).toBe(own);
    const third = commit(mac, "c.txt", "c1\n");
    const next = await send(second);
    expect(next.incremental).toBe(true);
    expect(await takeBranch(copy, next.file, "main", ORIGIN)).toEqual({ macHead: third, head: own });
  });

  it("keeps a copy that is ahead of the Mac's branch, as after the Mac moved its branch back", async () => {
    git(mac, "switch", "-q", "main");
    const second = commit(mac, "b.txt", "b1\n");
    await takeBranch(copy, (await send(null)).file, "main", ORIGIN);
    git(mac, "reset", "-q", "--hard", first);
    const back = await send(second);
    expect(back.incremental).toBe(false);
    expect(await takeBranch(copy, back.file, "main", ORIGIN)).toEqual({ macHead: first, head: second });
  });

  it("takes nothing of a bundle built on a commit the copy lacks, leaving no copy behind when there was none", async () => {
    git(mac, "switch", "-q", "main");
    const second = commit(mac, "b.txt", "b1\n");
    const incremental = (await send(first)).file;
    expect(await takeBranch(copy, incremental, "main", ORIGIN)).toEqual({ lacksBase: true });
    expect(existsSync(copy)).toBe(false);

    await takeBranch(copy, (await send(null)).file, "main", ORIGIN);
    git(copy, "update-ref", "-d", "refs/openorc/mac/main");
    git(copy, "reset", "-q", "--hard", first);
    git(copy, "reflog", "expire", "--expire=now", "--all");
    git(copy, "gc", "-q", "--prune=now");
    commit(mac, "c.txt", "c1\n");
    expect(await takeBranch(copy, (await send(second)).file, "main", ORIGIN)).toEqual({ lacksBase: true });
    expect(git(copy, "rev-parse", "main")).toBe(first);
  });

  it("takes again in full what a blocked fast-forward left, once the copy's checkout lets it", async () => {
    await takeBranch(copy, (await send(null)).file, "main", ORIGIN);
    writeFileSync(path.join(copy, "a.txt"), "edited on the brain\n");
    git(mac, "switch", "-q", "main");
    const second = commit(mac, "a.txt", "a2\n");
    const next = (await send(first)).file;
    await expect(takeBranch(copy, next, "main", ORIGIN)).rejects.toThrow("The cloud copy has uncommitted changes in the way.");
    expect(await copyHeads(copy)).toEqual({ macHead: first, head: first });

    git(copy, "checkout", "--", "a.txt");
    expect(await takeBranch(copy, next, "main", ORIGIN)).toEqual({ macHead: second, head: second });
    expect(readFileSync(path.join(copy, "a.txt"), "utf8")).toBe("a2\n");
  });

  it("makes the copy again where a folder lost its git", async () => {
    mkdirSync(copy, { recursive: true });
    writeFileSync(path.join(copy, "stray.txt"), "left behind\n");
    expect(await takeBranch(copy, (await send(null)).file, "main", ORIGIN)).toEqual({ macHead: first, head: first });
    expect(existsSync(path.join(copy, "stray.txt"))).toBe(false);
    expect(git(copy, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(copy, "status", "--porcelain")).toBe("");
  });

  it("follows the Mac's origin, dropping it when the Mac has none", async () => {
    await takeBranch(copy, (await send(null)).file, "main", null);
    expect(git(copy, "remote")).toBe("");
    await takeBranch(copy, (await send(null)).file, "main", "git@github.com:example/renamed.git");
    expect(git(copy, "remote", "get-url", "origin")).toBe("git@github.com:example/renamed.git");
  });

  it("says what a copy last took from the Mac and where its own branch is, or that a folder holds none", async () => {
    await takeBranch(copy, (await send(null)).file, "main", ORIGIN);
    expect(await copyHeads(copy)).toEqual({ macHead: first, head: first });
    const own = commit(copy, "brain.txt", "made on the brain\n");
    expect(await copyHeads(copy)).toEqual({ macHead: first, head: own });
    expect(await copyHeads(mac)).toBeNull();
    expect(await copyHeads(path.join(base, "nowhere"))).toBeNull();
  });

  it("names a branch's commit, or none for a branch without one", async () => {
    expect(await branchHead(mac, "main")).toBe(first);
    expect(await branchHead(mac, "trunk")).toBeNull();
    const empty = path.join(base, "empty");
    mkdirSync(empty);
    git(empty, "init", "-q", "-b", "main");
    expect(await branchHead(empty, "main")).toBeNull();
  });
});
