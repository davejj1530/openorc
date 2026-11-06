import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import { branchHead, bundleBranch, catchUpWithOrigin, copyHeads, copySyncedAt, takeBranch } from "./project-copy.js";

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
  it("follows the Mac's default branch when it moves, as from master to main: checked out, and the only one its Mac commit is kept for", async () => {
    git(mac, "switch", "-q", "-c", "master", "main");
    const old = commit(mac, "old.txt", "on master\n");
    expect(await takeBranch(copy, (await send(null, "master")).file, "master", ORIGIN)).toEqual({ macHead: old, head: old });
    git(mac, "switch", "-q", "main");
    git(mac, "merge", "-q", "--ff-only", "master");
    const now = commit(mac, "new.txt", "on main\n");
    expect(await takeBranch(copy, (await send(old, "main")).file, "main", ORIGIN)).toEqual({ macHead: now, head: now });
    expect(git(copy, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(readFileSync(path.join(copy, "new.txt"), "utf8")).toBe("on main\n");
    expect(git(copy, "for-each-ref", "--format=%(refname)", "refs/openorc/mac/")).toBe("refs/openorc/mac/main");
    expect(await copyHeads(copy)).toEqual({ macHead: now, head: now });
    // Threads that started from the old branch keep it.
    expect(git(copy, "rev-parse", "master")).toBe(old);
  });

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

describe("a copy caught up with its origin before a thread starts from it", () => {
  let origin: string;

  /** The copy as the Mac sent it, its origin a GitHub stand-in that had the Mac's branch pushed. */
  async function copyWithOrigin(): Promise<void> {
    await takeBranch(copy, (await send(null)).file, "main", ORIGIN);
    origin = path.join(base, "github.git");
    git(base, "clone", "-q", "--bare", mac, origin);
    git(copy, "remote", "set-url", "origin", origin);
  }

  /** A commit someone pushed to the origin, made in a clone of it. */
  function pushed(name: string): string {
    const clone = path.join(base, `clone-${Math.random().toString(36).slice(2)}`);
    git(base, "clone", "-q", "-b", "main", origin, clone);
    const made = commit(clone, name, `${name}\n`);
    git(clone, "push", "-q", "origin", "main");
    return made;
  }

  it("fast-forwards to the origin when it is ahead and the copy has nothing of its own, its files too", async () => {
    await copyWithOrigin();
    const ahead = pushed("from-github.txt");
    expect(await catchUpWithOrigin(copy, "main")).toBe("updated");
    expect(git(copy, "rev-parse", "main")).toBe(ahead);
    expect(readFileSync(path.join(copy, "from-github.txt"), "utf8")).toBe("from-github.txt\n");
    expect(await catchUpWithOrigin(copy, "main")).toBe("current");
  });

  it("keeps a copy with commits its origin lacks, as the Mac's unpushed work, ahead or diverged", async () => {
    await copyWithOrigin();
    git(mac, "switch", "-q", "main");
    const unpushed = commit(mac, "unpushed.txt", "only on the Mac\n");
    await takeBranch(copy, (await send(first)).file, "main", origin);
    expect(await catchUpWithOrigin(copy, "main")).toBe("kept");
    pushed("elsewhere.txt");
    expect(await catchUpWithOrigin(copy, "main")).toBe("kept");
    expect(git(copy, "rev-parse", "main")).toBe(unpushed);
  });

  it("gives up on an origin that never answers within its time, and leaves the copy be", async () => {
    await copyWithOrigin();
    const held: Socket[] = [];
    const silent = createServer((socket) => void held.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as { port: number };
    git(copy, "remote", "set-url", "origin", `http://127.0.0.1:${port}/app.git`);
    const before = git(copy, "rev-parse", "main");
    const began = Date.now();
    try {
      expect(await catchUpWithOrigin(copy, "main", 500)).toBe("unreachable");
      expect(Date.now() - began).toBeLessThan(5_000);
    } finally {
      held.forEach((socket) => socket.destroy());
      silent.close();
    }
    expect(git(copy, "rev-parse", "main")).toBe(before);
    git(copy, "remote", "remove", "origin");
    expect(await catchUpWithOrigin(copy, "main")).toBe("no-origin");
  });

  it("says when the copy last took the Mac's branch or heard its origin's, and nothing for a folder that is no copy", async () => {
    const began = Date.now();
    await takeBranch(copy, (await send(null)).file, "main", ORIGIN);
    const taken = await copySyncedAt(copy);
    expect(taken).toBeGreaterThanOrEqual(began);
    expect(await copySyncedAt(mac)).toBeNull();
  });
});
